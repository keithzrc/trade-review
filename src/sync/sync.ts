import type { Database } from "bun:sqlite";
import type { CandleSource, FutuClient } from "../domain/ports";
import type {
  AccountFunds,
  Candle,
  Flag,
  RawFill,
  RawOrder,
  RawPosition,
  RuleConfig,
  SeedPosition,
  SyncState,
  Trade,
} from "../domain/types";
import { buildTrades } from "../core/trade-builder";
import { inferStops } from "../core/stop-inference";
import { computeRisk } from "../core/risk";
import { isUnreliableStop } from "../core/stop-reliability";
import { computeExcursion, heldAdverseExcursion } from "../core/mae-mfe";
import { evaluate } from "../core/rule-engine";
import { currencyEnumFor, currencyForMarket, knownMarket, marketName, TRD_ENV_REAL } from "../futu/map";
import { insertFunds } from "../store/funds";
import {
  allRawFills,
  allRawOrders,
  allTrades,
  flagsForTrade,
  insertPositionSnapshot,
  positionsAt,
  replaceDerived,
  snapshotClock,
  upsertRawFills,
  upsertRawOrders,
} from "../store/repos";
import { manualStops } from "../store/journal";
import { LAST_SNAPSHOT_TIME, setConfigValue } from "../store/config";
import { coverageFloor, getSyncState, upsertSyncState } from "../store/sync-state";

const DAY_MS = 86_400_000;
const PAD_MS = 2 * DAY_MS; // context padding around the trade window for candles

export interface SyncDeps {
  db: Database;
  client: FutuClient;
  candles: CandleSource;
  config: RuleConfig;
  now: number; // injected epoch ms (deterministic in tests)
  historyDays?: number; // first-sync lookback window (default 90)
  // Optional serializer wrapped around ONLY the derived rebuild (not the network pull), so a
  // long-lived server can share one lock between sync + journal-edit rebuilds without blocking
  // journal edits behind slow OpenD I/O. Defaults to running the rebuild directly.
  rebuildGuard?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface SyncResult {
  accounts: number;
  fills: number;
  orders: number;
  trades: number;
  flags: number;
}

/** Daily bars for swing trades; hourly for intraday (held < 2 days). Open trades → daily. */
function resolutionMs(t: Trade): number {
  const intraday = t.holdSeconds !== null && t.holdSeconds < 2 * (DAY_MS / 1000);
  return intraday ? 3_600_000 : DAY_MS;
}

const POS_EPS = 1e-9;

/**
 * Reconstruct the position that existed BEFORE our data window, per (account, symbol), so trades
 * touching pre-window shares are built as coverage-incomplete instead of phantom opposite-direction
 * trades (which would corrupt realized P&L — the non-negotiable money-math invariant).
 *
 * Identity: `startPos = currentSnapshotQty − Σ(all stored fills)`. If the fills fully explain the
 * current holding, startPos ≈ 0 and no seed is needed. A non-zero startPos means the holding predates
 * coverage; seed it (buildTrades marks seeded trades coverageOk:false → excluded from stats). avgCost
 * is best-effort (the snapshot's, or 0 when the lot was closed in-window) — it only affects the
 * excluded coverage-incomplete trade, never a stats-eligible one.
 */
export function deriveSeeds(fills: RawFill[], snapshots: RawPosition[], fallbackTime: number): SeedPosition[] {
  const net = new Map<string, number>();
  const currency = new Map<string, string>();
  const firstTime = new Map<string, number>();
  for (const f of fills) {
    const k = `${f.account}|${f.symbol}`;
    net.set(k, (net.get(k) ?? 0) + (f.side === "BUY" ? f.qty : -f.qty));
    if (!currency.has(k)) currency.set(k, f.currency);
    firstTime.set(k, Math.min(firstTime.get(k) ?? Number.POSITIVE_INFINITY, f.time));
  }
  const snap = new Map<string, RawPosition>();
  for (const s of snapshots) snap.set(`${s.account}|${s.symbol}`, s);

  const seeds: SeedPosition[] = [];
  for (const k of new Set([...net.keys(), ...snap.keys()])) {
    const idx = k.indexOf("|");
    const account = k.slice(0, idx);
    const symbol = k.slice(idx + 1);
    const s = snap.get(k);
    const startPos = (s?.qty ?? 0) - (net.get(k) ?? 0);
    if (Math.abs(startPos) < POS_EPS) continue; // fills fully explain the current holding
    seeds.push({
      account,
      symbol,
      qty: startPos,
      avgCost: s?.avgCost ?? 0,
      currency: s?.currency ?? currency.get(k) ?? "UNKNOWN",
      time: Number.isFinite(firstTime.get(k)) ? firstTime.get(k)! : fallbackTime,
    });
  }
  return seeds;
}

/** Prior closed, coverage-ok trades in the same account that closed no later than this one opened. */
function recentClosedTrades(prior: Trade[], t: Trade): Trade[] {
  return prior.filter(
    (p) =>
      p.account === t.account &&
      p.status === "closed" &&
      p.coverageOk &&
      p.closeTime !== null &&
      p.closeTime <= t.openTime,
  );
}

/**
 * Phase 1 — pull raw data from OpenD and persist it (raw upserts are keyed/idempotent). Touches
 * the network; does NOT rebuild derived data. Returns the count of real accounts pulled so the
 * `runSync` wrapper can assemble its summary.
 *
 * All network results are GATHERED first, then written in ONE transaction. This makes the raw store
 * update atomic: a concurrent (journal-triggered) rebuild only ever sees the pre-sync-complete or
 * post-sync-complete raw set — never a half-pulled one — and a mid-pull network failure writes
 * nothing (leaving derived data untouched). That is what lets `runSync` lock only the rebuild, not
 * the network pull, without a journal edit corrupting derived data from a partial raw store.
 */
export async function pullRaw(
  db: Database,
  client: FutuClient,
  opts: { now: number; historyDays?: number },
): Promise<{ accounts: number }> {
  const { now } = opts;
  const historyDays = opts.historyDays ?? 90;

  // FUTU returns real AND simulate accounts; only real ones have queryable history and belong in
  // the review DB. Sync only recognized markets (skip futures/funds/unknown).
  const accounts = (await client.getAccounts()).filter((a) => a.trdEnv === TRD_ENV_REAL);

  // ---- gather (network only, no writes) ----
  const allFills: RawFill[] = [];
  const allOrders: RawOrder[] = [];
  const cursors: SyncState[] = [];
  const snapshotBatches: RawPosition[][] = [];
  const allFunds: AccountFunds[] = [];
  for (const acc of accounts) {
    const snapshot: RawPosition[] = [];
    // Distinct currencies this account trades (one funds snapshot per denomination). FUTU converts
    // net assets into each requested currency, so equity/risk stay same-currency downstream.
    const currencies = new Map<string, number>(); // code → a representative market (for the header)
    for (const market of acc.markets) {
      if (!knownMarket(market)) continue;
      const ccy = currencyForMarket(market);
      if (ccy !== "UNKNOWN" && !currencies.has(ccy)) currencies.set(ccy, market);
    }
    for (const market of acc.markets) {
      if (!knownMarket(market)) continue;
      const mkt = marketName(market);
      const state = getSyncState(db, acc.id, mkt);
      const fullWindowBegin = now - historyDays * DAY_MS;
      const beginMs = state?.lastSyncedTime ?? fullWindowBegin;
      const endMs = now;

      allFills.push(...(await client.getHistoryFills(acc, market, beginMs, endMs)));

      // Orders MUTATE after creation (a trailed/cancelled stop changes status + auxPrice), and FUTU
      // filters history orders by CREATE time — so an incremental window would never refetch a moved
      // stop. Always pull the full window for orders (volume is low). Bound: orders older than
      // historyDays whose stop moved recently still won't refresh — acceptable for v1 swing horizons.
      allOrders.push(...(await client.getHistoryOrders(acc, market, fullWindowBegin, endMs)));

      const positions = await client.getPositions(acc, market);
      for (const p of positions) snapshot.push({ ...p, time: now }); // stamp one coherent batch time

      cursors.push({
        account: acc.id,
        market: mkt,
        lastSyncedTime: now,
        coverageStart: state?.coverageStart ?? beginMs,
      });
    }
    snapshotBatches.push(snapshot); // one batch per account (may be empty ⇒ flat account)

    // Equity snapshot per currency. Best-effort: a funds failure must not abort the whole sync (it
    // only disables the risk-% overlay), so swallow per-currency errors and stamp the batch time.
    for (const [ccy, market] of currencies) {
      try {
        const f = await client.getFunds(acc, market, currencyEnumFor(ccy));
        if (f) allFunds.push({ ...f, time: now });
      } catch {
        // OpenD may not support funds for this account/currency — skip, leave risk-% absent.
      }
    }
  }

  // ---- write (single atomic transaction) ----
  db.transaction(() => {
    if (allFills.length) upsertRawFills(db, allFills);
    if (allOrders.length) upsertRawOrders(db, allOrders);
    for (const c of cursors) upsertSyncState(db, c);
    for (const batch of snapshotBatches) insertPositionSnapshot(db, batch);
    for (const f of allFunds) insertFunds(db, f);
    // Persist the snapshot clock so a later standalone rebuild (journal/config edit) reconciles seeds
    // against THIS batch, and an all-flat sync (which writes no rows) still reports zero holdings.
    setConfigValue(db, LAST_SNAPSHOT_TIME, String(now));
  })();

  return { accounts: accounts.length };
}

/**
 * Phase 2 — rebuild ALL derived trades/flags from the full raw set. Pure of the network: it reads
 * only the local DB (+ candles) and fully replaces derived data, so it is also the recompute path
 * for a manual-stop or rule-config edit (no OpenD round-trip). Candle-fetch failure degrades to no
 * MAE/MFE. A user-entered manual stop (journal) overrides the order-inferred stop for risk/R/flags.
 */
export async function rebuildDerived(
  db: Database,
  opts: { candles: CandleSource; config: RuleConfig; now: number },
): Promise<void> {
  const { candles, config, now } = opts;

  // Prior derived trades, keyed by id — used to carry forward MAE/MFE if candles degrade this run,
  // so a transient Yahoo outage can't overwrite previously-correct excursions (and the flags that
  // depend on them) with nulls. Trade ids are deterministic, so an unchanged trade keeps its key.
  const prior = new Map(allTrades(db).map((t) => [t.id, t] as const));

  const allFills = allRawFills(db);
  const fillsById = new Map(allFills.map((f) => [f.id, f] as const));
  const allOrders = allRawOrders(db);
  const manual = manualStops(db); // trade id → user-entered stop (authoritative over inference)
  // Seed positions that predate our data window (reconciled against the current snapshot) so a
  // holding opened before coverage and sold inside it is built as coverage-incomplete rather than a
  // phantom opposite-direction trade with wrong P&L. Reconcile against the persisted SNAPSHOT clock,
  // not wall-clock `now`: a standalone rebuild (journal/config edit) uses a different `now` that
  // matches no snapshot batch, and positionsAt(now) would be empty → spurious/omitted seeds. See
  // deriveSeeds. snapshotClock backfills the latest stored snapshot for a pre-marker (migrated) DB,
  // and falls back to `now` only before the first sync (no snapshot, no fills → no seeds).
  const snapTime = snapshotClock(db, now);
  // Seed TIME (used in a seed-only trade's deterministic id) must be STABLE across syncs, else a
  // never-traded pre-window holding gets a new id each sync and orphans its journal/manual stop. Use
  // the fixed coverage floor, not the ever-advancing snapshot clock. (Positions with in-window fills
  // take their first fill time inside deriveSeeds; this fallback only bites pure seed-only holdings.)
  const seedTime = coverageFloor(db) ?? snapTime;
  const seeds = deriveSeeds(allFills, positionsAt(db, snapTime), seedTime);
  const built = buildTrades(allFills, seeds).sort(
    (a, b) => a.openTime - b.openTime || a.id.localeCompare(b.id),
  );

  const enrichedTrades: Trade[] = [];
  const flagMap = new Map<string, Flag[]>();

  for (const t of built) {
    const symbolOrders = allOrders.filter((o) => o.account === t.account && o.symbol === t.symbol);
    const stop = inferStops(t, symbolOrders);
    // Manual stop (if set) overrides inference for BOTH the planned-risk basis and the effective
    // stop, so risk/R and the stop-based rules all read the user's explicit stop. TP is still
    // inference-only (no manual TP field in v1).
    const ms = manual.get(t.id);
    const initialStop = ms ?? stop.initialStop; // initial = planned risk (spec §6)
    const effectiveStop = ms ?? stop.effectiveStop;
    // Live stop = the still-working protective stop (excludes cancelled/filled); a manual stop is the
    // user's explicit current stop, so it overrides here too. Powers the open-positions risk readout.
    const liveStop = ms ?? stop.liveStop;
    // A manual stop is the user asserting the risk basis explicitly — honor it even on a seeded /
    // split-affected trade (their escape hatch when the tool can't reconstruct the original stop).
    const { risk, rMultiple } = computeRisk(t, initialStop, { manual: ms != null });

    const resMs = resolutionMs(t);
    const from = t.openTime - PAD_MS;
    const to = (t.closeTime ?? now) + PAD_MS;
    let bars: Candle[] = [];
    try {
      bars = await candles.getCandles(t.symbol, from, to, resMs);
    } catch {
      bars = []; // a candle-source rejection must not abort the whole sync (contract: degrade to no MAE/MFE)
    }
    const tradeFills = t.fillIds.map((id) => fillsById.get(id)).filter((f) => f !== undefined);
    const excursion = computeExcursion(t, tradeFills, bars, resMs);
    // Degrade safely: if candles are unavailable this run, keep any excursion computed on a prior sync
    // rather than nulling it (which would silently drop mae/mfe-dependent flags). But ONLY when the
    // excursion INPUTS are unchanged. Those inputs are the fills — they fix the window [openTime,
    // closeTime], the avgEntry reference, and the price anchors (min/max fill price). We guard on both:
    //   - the fill-ID SET, so a gained/removed fill (open → closed, scale-in/out, a partial exit that
    //     leaves the trade open — none of which need move avgEntry/maxQty) forces a recompute; and
    //   - the derived window/size aggregates, so a raw fill CORRECTED in place (upsertRawFills reuses
    //     the ID but may change price/qty/time) is caught even though the ID set is identical.
    // Residual (accepted): an in-place correction that preserves avgEntry/avgExit yet moves the min/max
    // fill price (e.g. 15/5 → 20/0) during a candle outage would still carry a stale excursion. It needs
    // FUTU to re-send a corrected fill exactly as candles are down, and self-heals on the next candle
    // sync — not worth persisting a fill-price signature to close. See PR #38 follow-up.
    const priorT = prior.get(t.id);
    const sameInputs =
      priorT !== undefined &&
      priorT.openTime === t.openTime &&
      priorT.closeTime === t.closeTime &&
      priorT.avgEntry === t.avgEntry &&
      priorT.avgExit === t.avgExit &&
      priorT.maxQty === t.maxQty &&
      priorT.fillIds.length === t.fillIds.length &&
      priorT.fillIds.every((id, i) => id === t.fillIds[i]);
    const mae = excursion.mae ?? (sameInputs ? priorT.mae : null);
    const mfe = excursion.mfe ?? (sameInputs ? priorT.mfe : null);

    // Detect an UNRELIABLE stop: price ran past the inferred initial stop while the trade was
    // demonstrably still open (a trailed/moved stop whose only surviving record is its final
    // trigger, reported by FUTU as if it were the initial risk). We do NOT rewrite risk/R — we
    // can't be certain the stop was trailed vs simply blown through, and the user sets their own
    // stop. Instead we FLAG the trade for manual input (unreliable_stop) and EXCLUDE it from the R
    // averages downstream, while keeping its per-trade R visible.
    //
    // Non-candle preconditions for the verdict — everything EXCEPT the mid-hold breach itself (which
    // needs candles). Extracted so the live check and the outage carry share ONE definition: the carry
    // can then only ever preserve the candle-derived breach fact, never a verdict whose other inputs
    // have since changed (e.g. a fee correction flipping a loser to a winner). Each clause:
    //   - `risk !== null`: a valid loss-side R basis. computeRisk returns null for a profit-side or
    //     split-corrupted stop; without a real R there's nothing to flag, and firing here would emit
    //     unreliable_stop AND no_stop together. So an unreliable stop always implies a present R.
    //   - `ms == null`: a manual stop is the AUTHORITATIVE override (isUnreliableStop exempts it) — it
    //     must clear the flag immediately, never stay stuck behind the carry.
    //   - `initialStopType !== "STOP_LIMIT"`: a stop-limit can legitimately TRIGGER but not FILL on a
    //     gap, so a breach doesn't prove it moved — its trigger may be the real stop and the loss a
    //     genuine excess_loss. Only market stops (plain STOP / TRAILING_STOP) reliably fill on breach.
    //   - losers only: a winner can never be an unreliable-stop loss.
    const eligibleForUnreliable =
      risk !== null &&
      ms == null &&
      stop.initialStopType !== "STOP_LIMIT" &&
      t.realizedPnl !== null &&
      t.realizedPnl < 0;

    const liveUnreliable = eligibleForUnreliable && isUnreliableStop({
      avgEntry: t.avgEntry,
      realizedPnl: t.realizedPnl,
      stop: initialStop,
      // Mid-hold adverse excursion (bars that closed DURING the hold, excluding the exit bar/fills):
      // a genuine stop-out's low lives in the exit bar, so a split/gap stop can't fake a breach here.
      heldMae: heldAdverseExcursion(t, bars, resMs),
      manual: ms != null,
      recoverMult: config.unreliableStopRecoverR,
    });

    // The verdict needs candles; on an outage (no bars) heldMae is null → the live check reads reliable.
    // Carry the PRIOR verdict so the flag (and its R-average exclusion) doesn't flicker off until candles
    // return — mirrors the mae carry. Guarded by the SAME live preconditions (eligibleForUnreliable) so a
    // change to any of them clears it now, PLUS an unchanged trade shape: same fills (sameInputs), the
    // same initial risk basis (`priorT.risk === risk` — an unchanged stop distance given fixed
    // avgEntry/maxQty), and the same effective stop. Only the candle-derived breach is actually carried.
    const carriedUnreliable =
      bars.length === 0 &&
      eligibleForUnreliable &&
      sameInputs &&
      priorT !== undefined &&
      priorT.stopUnreliable &&
      priorT.risk === risk &&
      priorT.effectiveStop === effectiveStop;
    const stopUnreliable = bars.length === 0 ? carriedUnreliable : liveUnreliable;
    const enriched: Trade = {
      ...t,
      effectiveStop,
      liveStop,
      effectiveTp: stop.effectiveTp,
      risk,
      rMultiple,
      mae,
      mfe,
      stopUnreliable,
    };

    const fills = allFills.filter((f) => t.fillIds.includes(f.id));
    const recent = recentClosedTrades(enrichedTrades, enriched);
    // recentOpens: open times of prior coverage-ok trades (same account), for overtrading_freq —
    // by open time, so positions still being held are counted, not just ones closed before this open.
    const recentOpens = enrichedTrades
      .filter((p) => p.account === enriched.account && p.coverageOk)
      .map((p) => p.openTime);
    const flags = evaluate(enriched, { fills, recentClosedTrades: recent, recentOpens }, config);

    enrichedTrades.push(enriched);
    if (flags.length) flagMap.set(enriched.id, flags);
  }

  replaceDerived(db, enrichedTrades, flagMap);
}

/**
 * Full sync: pull raw from OpenD, then rebuild derived. Thin wrapper over pullRaw + rebuildDerived
 * used by the CLI and the "Sync now" job. Reports DISTINCT stored counts (OpenD returns an account's
 * rows across every market-header query, so a per-pull sum would double-count).
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, client, candles, config, now } = deps;
  const { accounts } = await pullRaw(db, client, { now, historyDays: deps.historyDays });
  const guard = deps.rebuildGuard ?? ((fn) => fn());
  await guard(() => rebuildDerived(db, { candles, config, now }));

  const trades = allTrades(db);
  let flagCount = 0;
  for (const t of trades) flagCount += flagsForTrade(db, t.id).length;
  return {
    accounts,
    fills: allRawFills(db).length,
    orders: allRawOrders(db).length,
    trades: trades.length,
    flags: flagCount,
  };
}
