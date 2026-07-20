// The JSON API as a plain fetch handler: buildApi(db, deps) → (Request) => Promise<Response>.
// Kept framework-free and server-free so tests call it directly against an in-memory DB. Money
// aggregates always cross the wire under a `byCurrency` shape — never a bare top-level total.
import type { Database } from "bun:sqlite";
import type { CandleSource } from "../domain/ports";
import type { RuleConfig, Trade } from "../domain/types";
import { computeStats, breakdown } from "../core/analytics";
import { type Res, windowFor } from "../core/candle-res";
import { allTrades, flagsForTrade } from "../store/repos";
import { dayKeyOf, dayRange, holdBucket, isValidDayKey, isValidIsoWeek, weekRange } from "../domain/time";
import type { Journal, MarketRegime, WatchlistItem } from "../domain/journal-types";
import {
  getDailyEntry,
  getJournal,
  getWeeklyEntry,
  tradesInRange,
  upsertDailyEntry,
  upsertJournal,
  upsertWeeklyEntry,
} from "../store/journal";
import { getDrawings, upsertDrawings, type Drawing } from "../store/drawings";
import { setFlagOverrides, type FlagOverrides } from "../store/flag-overrides";
import {
  getStoredOpend,
  setStoredOpend,
  opendConnection,
  clearHeatmapGroups,
  clearThematicUniverse,
  getHeatmapGroups,
  getThematicUniverse,
  setHeatmapGroups,
  setThematicUniverse,
  type HeatmapGroup,
  type HeatmapSymbol,
} from "../store/config";
import { heatmapMetrics } from "../core/heatmap";
import type { UpdateStatus } from "./update";
import { equityAsOf, latestEquityByCurrency } from "../store/funds";
import { rebuildDerived } from "../sync/sync";
import {
  latestSnapshotTime,
  metaView,
  openPositionsByCurrency,
  tradeDetail,
  tradeSizing,
} from "./views";
import type { SyncRunner } from "./sync-runner";
import { Mutex } from "./mutex";

/** Coarser fallback for each intraday res, tried in order when a fetch comes back empty (e.g. the
 * trade predates Yahoo's retention at that resolution). "1d" has nothing coarser to fall back to. */
// Coarsen-on-empty ladder for the INTRADAY resolutions only (they can legitimately come back empty
// past Yahoo's retention). Daily and the higher timeframes (weekly/monthly/quarterly) have unbounded
// history — if they're empty the market is simply unsupported, so there's nothing coarser to try.
const COARSER: Record<Res, Res | null> = {
  "15m": "1h",
  "1h": "1d",
  "1d": null,
  "1wk": null,
  "1mo": null,
  "3mo": null,
};

const RESOLUTIONS: Res[] = ["15m", "1h", "1d", "1wk", "1mo", "3mo"];

function parseRes(v: string | null): Res {
  return v !== null && (RESOLUTIONS as string[]).includes(v) ? (v as Res) : "1d"; // unknown/absent → 1d
}

export interface ApiDeps {
  candles: CandleSource;
  config: RuleConfig;
  sync: SyncRunner | null;
  now: () => number;
  /** Gracefully shut the app down (stop the server + exit the process). Only the real server wires
   * this; tests and any embedded use leave it undefined, so POST /api/quit 503s there. */
  quit?: () => void;
  /** Check GitHub Releases for a newer version (never touches the binary — that's installUpdate).
   * `force` bypasses the server-side cache (the Settings "Check for updates" button passes it).
   * Injected so tests don't hit the network; when absent, GET /api/update/check reports it disabled. */
  checkUpdate?: (force?: boolean) => Promise<UpdateStatus>;
  /** Perform the in-place update: download the new build, swap the app/exe, relaunch. Resolves after
   * the swap is handed off to a detached helper; the real server then shuts down so the swap can run.
   * Absent in tests/embedded → POST /api/update/install 503s. */
  installUpdate?: () => Promise<{ ok: boolean; error?: string }>;
  /** The running app version, served cheaply at GET /api/version so the UI can poll for the relaunched
   * server after an in-place update. Absent → the endpoint reports "unknown". */
  appVersion?: string;
  /** Shared with the sync job so journal-triggered rebuilds serialize with a running sync's rebuild
   * (both must not overwrite each other). Defaults to a fresh mutex when omitted (tests). */
  rebuildLock?: Mutex;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Guard a destructive, unauthenticated localhost endpoint against cross-site invocation. A bodyless
 * POST is a CORS *simple request* (no preflight), so without this any web page the user has open could
 * POST here and, e.g., kill the app. Two independent checks:
 *   - Sec-Fetch-Site: browsers always send it; a drive-by page arrives as "cross-site"/"same-site",
 *     our own SPA as "same-origin". Non-browser callers (curl, tests) omit it — not the CSRF threat.
 *   - Host must be loopback: defeats DNS-rebinding, where a rebound attacker host is same-origin to
 *     itself (so Sec-Fetch-Site passes) but its Host header is not 127.0.0.1/localhost. */
function sameOriginLocal(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const host = req.headers.get("host");
  if (host !== null && !LOOPBACK_HOSTS.has(host.split(":")[0]!)) return false;
  return true;
}

/** trade_id → setup (single) and trade_id → tags (multi), for embedding + breakdowns. */
function setupMap(db: Database): Map<string, string> {
  const rows = db.query(`SELECT trade_id, setup FROM journal WHERE setup IS NOT NULL`).all() as any[];
  return new Map(rows.map((r) => [r.trade_id as string, r.setup as string]));
}
function tagsMap(db: Database): Map<string, string[]> {
  const rows = db.query(`SELECT trade_id, tag FROM journal_tags`).all() as any[];
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const arr = m.get(r.trade_id) ?? [];
    arr.push(r.tag);
    m.set(r.trade_id, arr);
  }
  return m;
}

function tradesWithMeta(db: Database) {
  const setups = setupMap(db);
  const tags = tagsMap(db);
  return allTrades(db).map((t) => {
    const sizing = tradeSizing(db, t);
    return {
      ...t,
      flags: flagsForTrade(db, t.id),
      setup: setups.get(t.id) ?? null,
      tags: tags.get(t.id) ?? [],
      // Position size as % of account equity — the headline sizing metric (see sizing preference).
      sizePct: sizing.sizePct,
      equityBasis: sizing.equityBasis,
    };
  });
}

function breakdownBy(db: Database, by: string) {
  const trades = allTrades(db);
  if (by === "symbol") return breakdown(trades, (t) => t.symbol);
  if (by === "holdBucket") return breakdown(trades, (t) => holdBucket(t.holdSeconds));
  if (by === "setup") {
    const setups = setupMap(db);
    return breakdown(trades, (t) => setups.get(t.id) ?? null);
  }
  if (by === "tag") {
    // A trade can carry several tags → it must count in each tag's group. Expand to one distinct
    // trade-clone per tag so the tested breakdown() groups each (currency, tag) exactly once.
    const tags = tagsMap(db);
    const tagOf = new Map<Trade, string>();
    const expanded: Trade[] = [];
    for (const t of trades) {
      for (const tag of tags.get(t.id) ?? []) {
        const clone = { ...t };
        tagOf.set(clone, tag);
        expanded.push(clone);
      }
    }
    return breakdown(expanded, (t) => tagOf.get(t) ?? null);
  }
  return null;
}

/** A 1..5 score is valid, or null/absent (the field is optional). */
function validScore(v: unknown): boolean {
  return v == null || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5);
}

const MAX_DRAWINGS = 200;
const MAX_DRAWINGS_BYTES = 256 * 1024;

/** A drawing point is `{timestamp?: number, value?: number}` — both optional, but if present must
 * be numbers (never coerce a wrong-typed value; reject instead). */
function validPoint(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if ("timestamp" in p && p.timestamp !== undefined && typeof p.timestamp !== "number") return false;
  if ("value" in p && p.value !== undefined && typeof p.value !== "number") return false;
  return true;
}

function validDrawing(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  if (typeof d.name !== "string") return false;
  if (!Array.isArray(d.points)) return false;
  return d.points.every(validPoint);
}

/** Validate a PUT drawings body: an array of ≤200 well-shaped drawings, capped in serialized size. */
function validDrawings(v: unknown): v is Drawing[] {
  if (!Array.isArray(v)) return false;
  if (v.length > MAX_DRAWINGS) return false;
  if (!v.every(validDrawing)) return false;
  return JSON.stringify(v).length <= MAX_DRAWINGS_BYTES;
}

// ---- Daily journal ------------------------------------------------------------

const REGIMES: ReadonlyArray<MarketRegime> = ["UPTREND", "CHOP", "DOWNTREND"];
// A snapshot is ~60 symbols × 6 numbers — a few KB. 512KB is a generous ceiling that still stops a
// runaway client from bloating the DB.
const MAX_SNAPSHOT_BYTES = 512 * 1024;

/** The client's heatmap snapshot to freeze for the day: must be the response shape it renders
 * ({groups: [...]}) and reasonably sized. Loose on the row internals — it's display data from our
 * own local SPA, replayed verbatim; the renderer null-guards every field. */
function validSnapshot(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  if (!Array.isArray((v as any).groups)) return false;
  return JSON.stringify(v).length <= MAX_SNAPSHOT_BYTES;
}

// ---- Flag overrides -----------------------------------------------------------

const RULE_ID_RE = /^[a-z0-9_]{1,40}$/;
const MAX_FLAG_OVERRIDES = 30; // per list — there are ~10 rules; generous headroom, bounded storage

/** Validate a PUT flags body: {added: string[], dismissed: string[]}, deduped, ids snake_case, and
 * no id in both lists (one mode per rule — mirrors the storage PK). Null → caller 400s. */
function parseFlagOverrides(b: Record<string, unknown>): FlagOverrides | null {
  const list = (v: unknown): string[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_FLAG_OVERRIDES) return null;
    const out = new Set<string>();
    for (const s of v) {
      if (typeof s !== "string" || !RULE_ID_RE.test(s)) return null;
      out.add(s);
    }
    return [...out];
  };
  const added = list(b.added);
  const dismissed = list(b.dismissed);
  if (added === null || dismissed === null) return null;
  if (added.some((id) => dismissed.includes(id))) return null;
  return { added, dismissed };
}

// ---- Daily heatmap ------------------------------------------------------------

const DAY_MS = 86_400_000;
// ~430 days of daily bars: covers the trailing-365d high AND the prior-year close for YTD.
const HEATMAP_WINDOW_MS = 430 * DAY_MS;
const HEATMAP_FETCH_CONCURRENCY = 6; // be polite to the free candle source
const MAX_HEATMAP_GROUPS = 12;
const MAX_HEATMAP_SYMBOLS = 60; // total across groups — each is a candle fetch
const MAX_THEMATIC_SYMBOLS = 80; // the thematic ranking universe (candidates, not display rows)
const THEMATIC_TOP_N = 10;
const MAX_LABEL_LEN = 40; // industry/name shown beside the ticker
// Domain symbol: "<MKT>.<code>" (code may itself contain dots/dashes, e.g. US.BRK.B).
const SYMBOL_RE = /^[A-Z]{2,6}\.[A-Z0-9.\-]{1,15}$/;

/** Validate + normalize one symbol-entry list (uppercase symbols, trim labels, dedupe — a dupe keeps
 * the labeled entry; a plain-string entry is accepted as label-less). Null when invalid. */
function parseSymbolEntries(v: unknown): HeatmapSymbol[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Map<string, string | null>();
  for (const s of v) {
    let rawSym: unknown;
    let rawLabel: unknown = null;
    if (typeof s === "string") rawSym = s;
    else if (s !== null && typeof s === "object") {
      rawSym = (s as any).symbol;
      rawLabel = (s as any).label ?? null;
    } else return null;
    if (typeof rawSym !== "string") return null;
    const sym = rawSym.trim().toUpperCase();
    if (!SYMBOL_RE.test(sym)) return null;
    if (rawLabel !== null && typeof rawLabel !== "string") return null;
    const label = rawLabel === null ? null : rawLabel.trim().slice(0, MAX_LABEL_LEN) || null;
    if (!seen.has(sym) || label !== null) seen.set(sym, label);
  }
  return [...seen].map(([symbol, label]) => ({ symbol, label }));
}

/** Validate + normalize a PUT groups body. Null when invalid — caller 400s. */
function parseHeatmapGroups(v: unknown): HeatmapGroup[] | null {
  if (!Array.isArray(v) || v.length > MAX_HEATMAP_GROUPS) return null;
  const out: HeatmapGroup[] = [];
  let total = 0;
  for (const g of v) {
    if (g === null || typeof g !== "object") return null;
    const name = (g as any).name;
    if (typeof name !== "string" || name.trim() === "" || name.length > 40) return null;
    const entries = parseSymbolEntries((g as any).symbols);
    if (entries === null) return null;
    total += entries.length;
    out.push({ name: name.trim(), symbols: entries });
  }
  if (total > MAX_HEATMAP_SYMBOLS) return null;
  return out;
}

/** Order-insensitive equality of two tag lists (getJournal returns tags sorted; a request may not). */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((t, i) => t === bs[i]);
}

/** Parse a JSON request body, requiring a non-null, non-array object. Returns `null` on malformed
 * JSON or a non-object body so the caller can 400 instead of 500-ing (or silently null-overwriting). */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    return null;
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) return null;
  return b as Record<string, unknown>;
}

export function buildApi(db: Database, deps: ApiDeps): (req: Request) => Promise<Response> {
  const rebuildLock = deps.rebuildLock ?? new Mutex();
  return async (req) => {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean); // ["api","trades","t1","candles"]
    const method = req.method;
    try {
      if (seg[0] !== "api") return json({ error: "not found" }, 404);

      // GET /api/stats
      if (seg.length === 2 && seg[1] === "stats" && method === "GET") {
        // Equity to size each trade's risk/notional against: the snapshot at its open (same currency),
        // falling back to the latest snapshot for trades that predate funds capture. Same at_open/latest
        // basis as the per-trade detail view. latest-per-account is memoized so this stays one pass.
        const latestCache = new Map<string, Map<string, number>>();
        const equityFor = (t: Trade) => {
          const atOpen = equityAsOf(db, t.account, t.currency, t.openTime);
          if (atOpen !== null) return { equity: atOpen, approx: false };
          let m = latestCache.get(t.account);
          if (!m) {
            m = latestEquityByCurrency(db, t.account);
            latestCache.set(t.account, m);
          }
          const latest = m.get(t.currency) ?? null;
          return { equity: latest, approx: latest !== null }; // latest-equity fallback → approximate
        };
        return json(computeStats(allTrades(db), equityFor));
      }
      // GET /api/breakdowns?by=setup|tag|symbol|holdBucket
      if (seg.length === 2 && seg[1] === "breakdowns" && method === "GET") {
        const by = url.searchParams.get("by") ?? "setup";
        const rows = breakdownBy(db, by);
        if (rows === null) return json({ error: `unknown breakdown: ${by}` }, 400);
        return json(rows);
      }
      // GET /api/trades
      if (seg.length === 2 && seg[1] === "trades" && method === "GET") {
        return json(tradesWithMeta(db));
      }
      // /api/trades/:id  and  /api/trades/:id/candles  and  PUT /api/trades/:id/journal
      if (seg.length >= 3 && seg[1] === "trades") {
        const id = decodeURIComponent(seg[2]!);
        if (seg.length === 3 && method === "GET") {
          const detail = tradeDetail(db, id);
          return detail ? json(detail) : json({ error: "trade not found" }, 404);
        }
        if (seg.length === 4 && seg[3] === "journal" && method === "PUT") {
          if (!allTrades(db).some((t) => t.id === id)) {
            return json({ error: "trade not found" }, 404);
          }
          const b = (await readJsonObject(req)) as any;
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          if (!validScore(b.conviction) || !validScore(b.rating)) {
            return json({ error: "conviction/rating must be an integer 1..5 or null" }, 400);
          }
          // Reject a wrong-typed manual stop (e.g. the string "95" from an HTML input) rather than
          // coercing it to null — that would SILENTLY CLEAR the authoritative risk basis on a 200.
          if (b.manualStop != null && typeof b.manualStop !== "number") {
            return json({ error: "manualStop must be a number or null" }, 400);
          }
          const journal: Journal = {
            tradeId: id,
            thesis: b.thesis ?? null,
            emotion: b.emotion ?? null,
            conviction: b.conviction ?? null,
            rating: b.rating ?? null,
            notes: b.notes ?? null,
            manualStop: typeof b.manualStop === "number" ? b.manualStop : null,
            setup: b.setup ?? null,
            tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
            updatedAt: deps.now(),
          };
          // Only manualStop/setup/tags feed derived data (risk/R/flags, breakdown keys); thesis/notes/
          // emotion/conviction/rating do not. Rebuild ONLY when a derived-affecting field changed, so a
          // routine note/rating save doesn't walk every trade + refetch candles.
          const prev = getJournal(db, id);
          const derivedChanged = prev
            ? prev.manualStop !== journal.manualStop ||
              prev.setup !== journal.setup ||
              !tagsEqual(prev.tags, journal.tags)
            : journal.manualStop !== null || journal.setup !== null || journal.tags.length > 0;
          upsertJournal(db, journal);
          if (derivedChanged) {
            // Serialized with a running sync's rebuild via the shared lock so the two can't interleave
            // and clobber each other's derived rows (no OpenD round-trip).
            await rebuildLock.runExclusive(() =>
              rebuildDerived(db, { candles: deps.candles, config: deps.config, now: deps.now() }),
            );
          }
          return json(tradeDetail(db, id));
        }
        // PUT /api/trades/:id/flags — the user's flag corrections. Flags are review annotations, not
        // inputs to risk/R/stats math, so no rebuildDerived here; reads merge overrides on the fly.
        if (seg.length === 4 && seg[3] === "flags" && method === "PUT") {
          if (!allTrades(db).some((t) => t.id === id)) return json({ error: "trade not found" }, 404);
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          const ov = parseFlagOverrides(b);
          if (ov === null) {
            return json(
              { error: "added/dismissed must be string arrays of rule ids, with no id in both" },
              400,
            );
          }
          setFlagOverrides(db, id, ov, deps.now());
          return json(tradeDetail(db, id));
        }
        if (seg.length === 4 && seg[3] === "drawings" && method === "GET") {
          return json({ drawings: getDrawings(db, id) });
        }
        if (seg.length === 4 && seg[3] === "drawings" && method === "PUT") {
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          if (!validDrawings(b.drawings)) {
            return json(
              { error: "drawings must be an array of ≤200 {name, points[, extendData]} entries" },
              400,
            );
          }
          // Sanitize each point down to {timestamp, value}: raw klinecharts points also carry a
          // `dataIndex`, and if that were persisted the overlay would re-anchor by bar index after a
          // resolution change (the exact drift the timestamp/value-only schema exists to prevent).
          // extendData lives at the drawing level (labels/metadata), isn't index-anchored, and is part
          // of the declared Drawing shape — carry it through when present.
          const sanitized: Drawing[] = b.drawings.map((d) => ({
            name: d.name,
            points: d.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
            ...(d.extendData !== undefined ? { extendData: d.extendData } : {}),
          }));
          // Drawings are user annotations, not derived data — no rebuildDerived here.
          upsertDrawings(db, id, sanitized, deps.now());
          return json({ drawings: getDrawings(db, id) });
        }
        if (seg.length === 4 && seg[3] === "candles" && method === "GET") {
          const trade = allTrades(db).find((t) => t.id === id);
          if (!trade) return json({ error: "trade not found" }, 404);
          let res = parseRes(url.searchParams.get("res"));
          let win = windowFor(trade.openTime, trade.closeTime, deps.now(), res);
          let bars: Awaited<ReturnType<CandleSource["getCandles"]>> = [];
          // Coarsen the resolution when the current one either comes back empty (the trade predates
          // Yahoo's retention there) OR its window was clamped forward past the trade's entry (an old
          // open/long trade: intraday reach can't reach back far enough, so Yahoo returns recent bars
          // that miss the entry/initial-stop entirely). In both cases step one res coarser — 1d has no
          // reach limit, so it always covers the entry and terminates the ladder.
          for (;;) {
            try {
              bars = await deps.candles.getCandles(trade.symbol, win.fromMs, win.toMs, win.resMs);
            } catch {
              bars = [];
            }
            const coversEntry = win.fromMs <= trade.openTime;
            if (bars.length > 0 && coversEntry) break;
            const next = COARSER[res];
            if (!next) break;
            res = next;
            win = windowFor(trade.openTime, trade.closeTime, deps.now(), res);
          }
          return json({ res, resMs: win.resMs, focusFrom: win.focusFrom, focusTo: win.focusTo, candles: bars });
        }
      }
      // GET /api/positions
      if (seg.length === 2 && seg[1] === "positions" && method === "GET") {
        return json(openPositionsByCurrency(db, latestSnapshotTime(db)));
      }
      // GET /api/meta
      if (seg.length === 2 && seg[1] === "meta" && method === "GET") {
        return json(metaView(db));
      }

      // /api/settings/opend — the OpenD connection (WebSocket key + port). Lets the packaged app be
      // configured by a non-technical user without env vars; the config table is the single source of
      // truth. The key is WRITE-ONLY over the wire: GET returns only the port + `hasKey`, never the key.
      if (seg.length === 3 && seg[1] === "settings" && seg[2] === "opend") {
        const view = () => {
          const c = opendConnection(getStoredOpend(db));
          return { port: c.port, hasKey: c.key !== undefined };
        };
        if (method === "GET") return json(view());
        if (method === "PUT") {
          if (!sameOriginLocal(req)) return json({ error: "forbidden" }, 403);
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          const patch: { key?: string; port?: number } = {};
          if (b.port !== undefined) {
            if (typeof b.port !== "number" || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) {
              return json({ error: "port must be an integer 1..65535" }, 400);
            }
            patch.port = b.port;
          }
          if (b.key !== undefined) {
            // Only a non-empty string sets the key; the UI omits the field to leave it unchanged.
            // Cap the length — an OpenD key is a short token, and readJsonObject has no size limit.
            if (typeof b.key !== "string" || b.key.length === 0 || b.key.length > 256) {
              return json({ error: "key must be a non-empty string ≤ 256 chars" }, 400);
            }
            patch.key = b.key;
          }
          setStoredOpend(db, patch);
          return json(view());
        }
      }

      // /api/market/heatmap (GET) + /api/market/symbols (GET/PUT) — the Daily page. Per-symbol daily
      // candles come through deps.candles (the SQLite-cached Yahoo source in the real app), so a
      // reload within the cache's tail window costs no network; metrics math is pure core.
      if (seg.length === 3 && seg[1] === "market" && seg[2] === "heatmap" && method === "GET") {
        const groups = getHeatmapGroups(db);
        const universe = getThematicUniverse(db);
        const now = deps.now();
        // ONE fan-out covers the display groups, the thematic ranking universe, AND the RS benchmark
        // (SPY is always fetched even if the user removed it from every list — the "vs SPY" column
        // needs it).
        const BENCHMARK = "US.SPY";
        const uniq = [
          ...new Set([
            ...groups.flatMap((g) => g.symbols.map((s) => s.symbol)),
            ...universe.map((s) => s.symbol),
            BENCHMARK,
          ]),
        ];
        const bySymbol = new Map<string, ReturnType<typeof heatmapMetrics>>();
        // Chunked fan-out: parallel enough to load fast, capped so ~30 symbols don't hammer Yahoo.
        for (let i = 0; i < uniq.length; i += HEATMAP_FETCH_CONCURRENCY) {
          await Promise.all(
            uniq.slice(i, i + HEATMAP_FETCH_CONCURRENCY).map(async (sym) => {
              let bars: Awaited<ReturnType<CandleSource["getCandles"]>> = [];
              try {
                bars = await deps.candles.getCandles(sym, now - HEATMAP_WINDOW_MS, now, DAY_MS);
              } catch {
                bars = []; // a single bad symbol degrades to a null row, never a 500
              }
              bySymbol.set(sym, heatmapMetrics(bars));
            }),
          );
        }
        // 20-session return relative to SPY, as a ratio-based excess return: (1+r)/(1+rSPY) − 1.
        // Positive = outperforming the index over the last month of sessions.
        const spy20 = bySymbol.get(BENCHMARK)?.p20dPct ?? null;
        const row = ({ symbol, label }: HeatmapSymbol) => {
          const m = bySymbol.get(symbol)!;
          const rs20Pct = m.p20dPct !== null && spy20 !== null ? (1 + m.p20dPct) / (1 + spy20) - 1 : null;
          return { symbol, label, ...m, rs20Pct };
        };
        // The thematic ranking: FULL universe sorted by 5-day % change, descending — the classic
        // daily-plan "where is money flowing this week" ordering. No-data symbols sink to the
        // bottom. The client shows the top N; edit mode uses `universe` (the user's CONFIG order,
        // related themes adjacent) joined with these rows. The daily snapshot freezes what was seen.
        const thematicRows = universe
          .map(row)
          .sort((a, b) => (b.p5dPct ?? -Infinity) - (a.p5dPct ?? -Infinity) || a.symbol.localeCompare(b.symbol));
        return json({
          asOf: now,
          groups: groups.map((g) => ({ name: g.name, rows: g.symbols.map(row) })),
          thematic: {
            rankedBy: "p5dPct",
            topN: THEMATIC_TOP_N,
            universeSize: universe.length,
            rows: thematicRows,
            universe,
          },
        });
      }
      // /api/market/thematic — the auto-ranked universe's candidate list (GET/PUT).
      if (seg.length === 3 && seg[1] === "market" && seg[2] === "thematic") {
        if (method === "GET") return json({ symbols: getThematicUniverse(db) });
        if (method === "PUT") {
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          const entries = parseSymbolEntries(b.symbols);
          if (entries === null || entries.length > MAX_THEMATIC_SYMBOLS) {
            return json({ error: `symbols must be ≤${MAX_THEMATIC_SYMBOLS} entries like US.SMH or {symbol, label}` }, 400);
          }
          setThematicUniverse(db, entries);
          return json({ symbols: getThematicUniverse(db) });
        }
      }
      if (seg.length === 3 && seg[1] === "market" && seg[2] === "symbols") {
        if (method === "GET") return json({ groups: getHeatmapGroups(db) });
        // DELETE = reset to defaults (drops the stored config — groups AND the thematic universe —
        // so future default improvements apply too).
        if (method === "DELETE") {
          clearHeatmapGroups(db);
          clearThematicUniverse(db);
          return json({ groups: getHeatmapGroups(db) });
        }
        if (method === "PUT") {
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          const groups = parseHeatmapGroups(b.groups);
          if (groups === null) {
            return json(
              { error: "groups must be ≤12 {name, symbols[]} entries, ≤60 symbols total, symbols like US.SPY" },
              400,
            );
          }
          setHeatmapGroups(db, groups);
          return json({ groups: getHeatmapGroups(db) });
        }
      }

      // GET /api/update/check — version check against GitHub Releases (never modifies the binary;
      // installUpdate does that). Reports "disabled" when no checker is wired (tests). Never throws.
      if (seg.length === 3 && seg[1] === "update" && seg[2] === "check" && method === "GET") {
        if (!deps.checkUpdate) {
          return json({ current: "", latest: null, updateAvailable: false, downloadUrl: null, releaseUrl: null, canInstall: false, checksumsUrl: null, error: "update check unavailable" });
        }
        // ?force=1 skips the cache for an on-demand check from Settings.
        return json(await deps.checkUpdate(url.searchParams.get("force") === "1"));
      }

      // POST /api/update/install — download the new build, swap the running app/exe, and relaunch.
      // CSRF-guarded like /api/quit (it shuts the app down). 503 when no installer is wired
      // (tests/embedded / unsupported platform). On success returns 202 and the app then restarts.
      if (seg.length === 3 && seg[1] === "update" && seg[2] === "install" && method === "POST") {
        if (!sameOriginLocal(req)) return json({ error: "forbidden" }, 403);
        if (!deps.installUpdate) return json({ error: "in-place update unavailable" }, 503);
        const r = await deps.installUpdate();
        if (!r.ok) return json({ error: r.error ?? "update failed" }, 500);
        return json({ installing: true }, 202);
      }

      // GET /api/version — the running app version, so the UI can poll for the relaunched server after
      // an in-place update (reload once it reports the new version).
      if (seg.length === 2 && seg[1] === "version" && method === "GET") {
        return json({ version: deps.appVersion ?? "unknown" });
      }

      // POST /api/quit — graceful shutdown for the "Quit" button (a windowless/hidden app has no
      // console to Ctrl+C). 503 when no shutdown is wired (tests, embedded). The dep defers the actual
      // server-stop/exit so this 202 response flushes to the browser first.
      if (seg.length === 2 && seg[1] === "quit" && method === "POST") {
        if (!sameOriginLocal(req)) return json({ error: "forbidden" }, 403);
        if (!deps.quit) return json({ error: "quit unavailable" }, 503);
        deps.quit();
        return json({ quitting: true }, 202);
      }

      // POST /api/sync (start; 409 if already running) + GET /api/sync/status
      if (seg[1] === "sync") {
        if (!deps.sync) return json({ error: "sync unavailable" }, 503);
        if (seg.length === 2 && method === "POST") {
          const started = deps.sync.start();
          return json(deps.sync.status(), started ? 202 : 409);
        }
        if (seg.length === 3 && seg[2] === "status" && method === "GET") {
          return json(deps.sync.status());
        }
      }

      // /api/journal/weeks/:isoWeek  (GET + PUT); trades are associated by date at read time.
      if (seg.length === 4 && seg[1] === "journal" && seg[2] === "weeks") {
        const isoWeek = decodeURIComponent(seg[3]!);
        if (!isValidIsoWeek(isoWeek)) return json({ error: "bad ISO week (want canonical YYYY-Www)" }, 400);
        const { start, end } = weekRange(isoWeek);
        if (method === "PUT") {
          const b = (await readJsonObject(req)) as any;
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          const watchlist: WatchlistItem[] = Array.isArray(b.watchlist)
            ? b.watchlist.map((w: any) => ({
                symbol: String(w.symbol),
                note: w.note ?? null,
                keyLevel: typeof w.keyLevel === "number" ? w.keyLevel : null,
              }))
            : [];
          upsertWeeklyEntry(db, {
            id: isoWeek,
            periodStart: start,
            periodEnd: end,
            marketRead: b.marketRead ?? null,
            tradedVsPlan: b.tradedVsPlan ?? null,
            watchlist,
            updatedAt: deps.now(),
          });
        }
        if (method === "GET" || method === "PUT") {
          const entry = getWeeklyEntry(db, isoWeek) ?? {
            id: isoWeek,
            periodStart: start,
            periodEnd: end,
            marketRead: null,
            tradedVsPlan: null,
            watchlist: [],
            updatedAt: 0,
          };
          return json({ ...entry, trades: tradesInRange(db, start, end) });
        }
      }

      // /api/journal/days/:date (GET + PUT) — the daily journal. On PUT the client may include its
      // current heatmap as `snapshot`; it's frozen ONLY when the entry is TODAY's (local clock, same
      // machine as the SPA) — a text edit to a past day must never overwrite that day's history with
      // today's market. Omitting `snapshot` always preserves whatever is stored.
      if (seg.length === 4 && seg[1] === "journal" && seg[2] === "days") {
        const dayKey = decodeURIComponent(seg[3]!);
        if (!isValidDayKey(dayKey)) return json({ error: "bad date (want a real YYYY-MM-DD)" }, 400);
        if (method === "PUT") {
          const b = await readJsonObject(req);
          if (!b) return json({ error: "body must be a JSON object" }, 400);
          if (b.regime != null && !REGIMES.includes(b.regime as MarketRegime)) {
            return json({ error: "regime must be UPTREND | CHOP | DOWNTREND | null" }, 400);
          }
          const prev = getDailyEntry(db, dayKey);
          const isToday = dayKey === dayKeyOf(deps.now());
          let snapshotJson = prev?.snapshotJson ?? null;
          let snapshotAt = prev?.snapshotAt ?? null;
          if (b.snapshot !== undefined && isToday) {
            if (!validSnapshot(b.snapshot)) {
              return json({ error: "snapshot must be a {groups: [...]} object ≤ 512KB" }, 400);
            }
            snapshotJson = JSON.stringify(b.snapshot);
            snapshotAt = deps.now();
          }
          upsertDailyEntry(db, {
            id: dayKey,
            regime: (b.regime as MarketRegime | null | undefined) ?? null,
            marketRead: (b.marketRead as string | null | undefined) ?? null,
            notes: (b.notes as string | null | undefined) ?? null,
            snapshotJson,
            snapshotAt,
            updatedAt: deps.now(),
          });
        }
        if (method === "GET" || method === "PUT") {
          // Trades opened OR closed that local day, associated at read time (same rule as weeks).
          const { start, end } = dayRange(dayKey);
          const trades = tradesInRange(db, start, end);
          const e = getDailyEntry(db, dayKey);
          if (!e) {
            return json({ id: dayKey, regime: null, marketRead: null, notes: null, snapshot: null, snapshotAt: null, updatedAt: 0, trades });
          }
          // A malformed stored snapshot degrades to null (self-healing on the next today-save).
          let snapshot: unknown = null;
          if (e.snapshotJson !== null) {
            try {
              snapshot = JSON.parse(e.snapshotJson);
            } catch {
              snapshot = null;
            }
          }
          return json({ id: e.id, regime: e.regime, marketRead: e.marketRead, notes: e.notes, snapshot, snapshotAt: e.snapshotAt, updatedAt: e.updatedAt, trades });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}
