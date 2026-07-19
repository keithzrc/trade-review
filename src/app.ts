// Single-binary bootstrap: backup → migrate → serve API + SPA shell on 127.0.0.1 → open browser.
// The compiled binary is the *program*; the DB in the user-data dir is the *save file* — updating
// the program never touches it (spec §14).
import { spawn } from "node:child_process";
import { openDb } from "./store/db";
import { runMigrations } from "./store/migrations";
import { backupDb, backupStamp } from "./store/backup";
import { dbPath, dataDir } from "./store/paths";
import { join } from "node:path";
import { getRuleConfig, getStoredOpend, opendConnection } from "./store/config";
import { cachedCandles } from "./store/candles-cache";
import { yahooCandles } from "./candles/yahoo";
import { buildApi } from "./api/routes";
import { SyncRunner } from "./api/sync-runner";
import { Mutex } from "./api/mutex";
import { runSync, rebuildDerived, type SyncResult } from "./sync/sync";
import { connectFutu } from "./futu/client";
import { checkForUpdate, type UpdateStatus } from "./api/update";
import { performInstall, consumeSilentRelaunchMarker, sweepUpdateArtifacts } from "./api/self-update";
import pkg from "../package.json";
// Bun fullstack HTML import: Bun bundles the referenced React/TS/CSS in dev (with HMR) and EMBEDS the
// built assets under `bun build --compile`. This is what replaces a separate Vite toolchain.
import index from "../web/index.html";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    // A missing opener (e.g. headless Linux with no xdg-open) emits an ASYNC 'error' event after
    // spawn returns — the try/catch can't see it, and an unhandled 'error' would crash the process.
    child.on("error", () => {}); // best-effort: the URL is printed to the console regardless
    child.unref();
  } catch {
    // best-effort: the URL is printed to the console regardless
  }
}

export async function main(): Promise<void> {
  const path = dbPath();
  backupDb(path, backupStamp()); // no-op on first run; cheap insurance now that journal data is precious
  const db = openDb(path);
  runMigrations(db);
  const config = getRuleConfig(db);
  const candles = cachedCandles(db, yahooCandles, { now: Date.now }); // live clock (long-lived server)

  // One-time local rebuild after a migration introduces a DERIVED column (v9 live_stop, v10
  // realized_so_far, v11 stop_unreliable): those are NULL on existing trades until re-derived, and the
  // UI would otherwise show stale live stops / zero banked profit / stale risk flags until the first
  // sync. Rebuild from local data only — NO network — but drive it with a CACHE-ONLY candle source
  // (cachedCandles over an empty inner source): locally-cached bars activate the candle-dependent
  // derivations (unreliable-stop detection, MAE/MFE) offline, while a cache miss or the live tail
  // degrades to no bars. This immediately clears the stale excess_loss/round_tripped flags on trades
  // whose candles are already cached, instead of waiting for a candle-backed sync. The NULL guard runs
  // this at most once per upgrade (replaceDerived then writes a value for every trade).
  const needsBackfill = db
    .query(`SELECT 1 FROM trades WHERE realized_so_far IS NULL OR stop_unreliable IS NULL LIMIT 1`)
    .get() != null;
  if (needsBackfill) {
    const cachedOnly = cachedCandles(db, { getCandles: async () => [] }, { now: Date.now });
    await rebuildDerived(db, { candles: cachedOnly, config, now: Date.now() });
  }

  // Shared by the sync job and journal-triggered rebuilds so the two rebuilds never interleave.
  const rebuildLock = new Mutex();
  // The sync job holds the OpenD socket only for its own duration. Only the derived rebuild is
  // serialized (rebuildGuard) — the network pull runs unlocked, so a journal edit never blocks
  // behind slow/unreachable OpenD.
  const syncJob = async (): Promise<SyncResult> => {
    // Read fresh each sync so a key saved in Settings takes effect without a restart.
    const { key, port } = opendConnection(getStoredOpend(db));
    const client = await connectFutu({ port, key });
    try {
      return await runSync({
        db,
        client,
        candles,
        config,
        now: Date.now(),
        rebuildGuard: (fn) => rebuildLock.runExclusive(fn),
      });
    } finally {
      client.close();
    }
  };
  const sync = new SyncRunner(db, syncJob, Date.now);
  // Graceful shutdown for the in-app Quit button. Deferred a beat so the 202 flushes to the browser
  // before we stop serving; then close the DB and exit. `server` is assigned just below (closure).
  const quit = () => {
    console.log("Quit requested — shutting down.");
    setTimeout(() => {
      try {
        server.stop(true); // close in-flight connections
        db.close();
      } finally {
        process.exit(0);
      }
    }, 150);
  };
  // A compiled binary embeds the bundled SPA, so Bun.embeddedFiles is non-empty; a `bun run src/app.ts`
  // dev process has none. The released binary keeps the canonical 8123; local dev uses 8124 so both can
  // run side by side (download a release AND hack on source without a port clash). PORT overrides either.
  const runningFromSource = Bun.embeddedFiles.length === 0;
  const defaultPort = runningFromSource ? 8124 : 8123;

  // Update check, cached so navigating around doesn't hammer the GitHub API (unauth = 60 req/hr).
  // Failed checks aren't cached, so a transient outage doesn't suppress checks for hours.
  const REPO = "keithzrc/trade-review";
  const UPDATE_TTL_MS = 6 * 60 * 60_000;
  const appVersion = (pkg as { version?: string }).version ?? "0.0.0";
  // In-place update needs the compiled binary (it swaps the packaged app/exe) on a supported platform.
  // A `bun run src/app.ts` dev process has no artifact to swap, so it keeps the plain download link.
  const compiled = !runningFromSource;
  const installSupported = compiled && (process.platform === "darwin" || process.platform === "win32");
  let updateCache: { at: number; status: UpdateStatus } | null = null;
  // `force` skips the cache — the Settings "Check for updates" button uses it so a user doesn't wait
  // out the 6h TTL to see a release that landed after the app started.
  const checkUpdate = async (force = false): Promise<UpdateStatus> => {
    const nowMs = Date.now();
    if (!force && updateCache && !updateCache.status.error && nowMs - updateCache.at < UPDATE_TTL_MS) {
      return updateCache.status;
    }
    const status = await checkForUpdate({ current: appVersion, platform: process.platform, arch: process.arch, repo: REPO, installSupported });
    updateCache = { at: nowMs, status };
    return status;
  };
  // Download the new build, hand the swap off to a detached helper, then shut down so it can run. The
  // helper waits for this process to exit, replaces the app/exe, and relaunches (silently — see the
  // marker below). Returns the install result to the caller; only shuts down when it actually started.
  const reopenMarker = join(dataDir(), ".reopen-silent");
  const installUpdate = async (): Promise<{ ok: boolean; error?: string }> => {
    const status = await checkUpdate(true); // force a fresh check so we never install a superseded "latest"
    const result = await performInstall({
      status,
      platform: process.platform,
      execPath: process.execPath,
      pid: process.pid,
      port: Number(process.env.PORT ?? defaultPort),
      marker: reopenMarker,
      compiled,
    });
    if (result.ok) quit(); // deferred shutdown (the 202 flushes first); the helper then swaps + relaunches
    return result;
  };
  const api = buildApi(db, { candles, config, sync, now: Date.now, rebuildLock, quit, checkUpdate, installUpdate, appVersion });

  // In the compiled binary we serve the bundled SPA ourselves so we control cache headers. Bun's HTML
  // route emits only an ETag (no Cache-Control — see oven-sh/bun#19198), which lets a browser pin a
  // STALE index.html that points at hashed chunk names a newer build no longer has → the chunk 404s →
  // React never mounts → blank screen. Fix: hashed chunks are content-addressed so they're immutable
  // (cache forever); index.html must always revalidate (no-cache) so a reload always lands the current
  // chunk names. Bun.embeddedFiles holds the built assets (chunk-*.js/.css + index-*.html); it's empty
  // when running from source, where we keep Bun's `index` route for HMR instead.
  const spaAssets = new Map<string, Blob>();
  let spaIndexHtml: Blob | null = null;
  for (const f of Bun.embeddedFiles) {
    const blob = f as unknown as Blob & { name: string };
    if (blob.name.endsWith(".html")) spaIndexHtml = blob;
    else spaAssets.set("/" + blob.name, blob);
  }
  const serveSpa = (req: Request): Response => {
    const pathname = new URL(req.url).pathname;
    const asset = spaAssets.get(pathname);
    if (asset) {
      return new Response(asset, {
        headers: { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    // A missing file-looking path (has an extension) is a real 404 — don't hand back HTML for a .js.
    if (/\.[a-z0-9]+$/i.test(pathname.split("/").pop() ?? "")) return new Response("not found", { status: 404 });
    // Otherwise this is a SPA route: return the document, which must always revalidate so the browser
    // never runs a stale index.html against a newer build's chunks.
    if (spaIndexHtml) {
      return new Response(spaIndexHtml, {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", // localhost bind is the entire security model (single local user)
    port: Number(process.env.PORT ?? defaultPort),
    // Dev mode (HMR + rich errors) only when running from source; the compiled binary serves the SPA
    // via serveSpa above (Bun would otherwise run the binary in dev mode, since NODE_ENV isn't
    // "production" there). NODE_ENV can still force production for a source run.
    development: runningFromSource && process.env.NODE_ENV !== "production",
    routes: {
      // Most-specific first: API paths hit the JSON handler; everything else serves the bundled SPA.
      // From source we hand the SPA (+ HMR) to Bun's `index`; the compiled binary uses serveSpa so it
      // controls cache headers (Bun emits none — a stale index.html would blank the screen).
      "/api/*": (req) => api(req),
      "/api": (req) => api(req),
      "/*": runningFromSource ? index : serveSpa,
    },
  });

  const openUrl = `http://127.0.0.1:${server.port}`;
  console.log(`Trade Review on ${openUrl}`);
  // Skip opening a browser when NO_OPEN=1, or when this launch was triggered by the in-place updater
  // (the swap helper leaves a one-shot marker): the user's existing tab reloads itself onto the new
  // version, so a second tab would be noise.
  const silentRelaunch = consumeSilentRelaunchMarker(reopenMarker);
  if (process.env.NO_OPEN !== "1" && !silentRelaunch) openBrowser(openUrl);
  // Reaching here means this build launched cleanly, so a prior update's Windows rollback copy
  // (`<exe>.old`) is no longer needed — remove it best-effort.
  sweepUpdateArtifacts(process.platform, process.execPath);
}

if (import.meta.main) void main();
