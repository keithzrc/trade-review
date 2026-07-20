// Read-model assemblers over the existing repos + pure core. No I/O beyond the local DB; these
// feed the JSON API. Money is NEVER summed across currencies — each row keeps its own currency and
// the API groups per currency.
import type { Database } from "bun:sqlite";
import type { Flag, RawFill, RawOrder, StopInfo, Trade } from "../domain/types";
import type { Journal } from "../domain/journal-types";
import { inferStops } from "../core/stop-inference";
import { positionMetrics } from "../core/position-metrics";
import {
  allRawFills,
  allRawOrders,
  allTrades,
  flagsForTrade,
  positionsAt,
  snapshotClock,
} from "../store/repos";
import { distinctEmotions, distinctSetups, distinctTags, getJournal } from "../store/journal";
import { getFlagOverrides, type FlagOverrides } from "../store/flag-overrides";
import { equityAsOf, latestEquityByCurrency } from "../store/funds";
import pkg from "../../package.json";

export interface OpenPosition {
  account: string;
  symbol: string;
  currency: string;
  qty: number; // signed
  avgCost: number;
  price: number | null; // current market price from the latest snapshot (FUTU's mark); null when unknown
  liveStop: number | null; // the stop STILL WORKING now (excludes cancelled/filled); null when unprotected
  realizedSoFar: number; // profit already BANKED from partial exits (0 when none); counts toward the cushion
  // "If stopped at the current stop" — a signed outcome (own currency). The cushion is the TOTAL floor
  // (banked profit + the remaining shares' outcome); openRisk / lockedProfit are its two sides.
  stopOutcome: number | null; // remaining shares only: (stop − avgCost) × qty; null when no stop
  cushion: number | null; // TOTAL if stopped = realizedSoFar + stopOutcome (banked + remaining); null when no stop
  openRisk: number | null; // loss still exposed net of banked = max(0, −cushion); 0 on a free trade; null when no stop
  lockedProfit: number | null; // guaranteed profit if stopped = max(0, cushion)
  unrealized: number | null; // paper P&L on the remaining shares = (price − avgCost) × qty; null when price unknown
  totalPnl: number | null; // whole trade so far = realizedSoFar + unrealized; null when price unknown
  initialRisk: number | null; // the trade's 1R in this currency (its initial dollar risk); null when unknown
  cushionR: number | null; // cushion ÷ initialRisk (signed; ≥ 0 ⇒ free trade)
  totalPnlR: number | null; // totalPnl ÷ initialRisk — "how many R is the whole trade up now"
  freeTrade: boolean; // the cushion locks in ≥ breakeven — no downside left (banked profit included)
  breakevenStop: number | null; // stop PRICE that brings the cushion to 0 (where to move the stop for net breakeven); null when qty is 0
  // As a fraction of THIS position's account equity (same currency — never mixed), so the row reads
  // "risking 0.4% of the account" (sizing preference: lead with % of account, not raw $). Signed to
  // match its dollar figure: cushionPct is − when at risk / + when locked; null when equity unknown.
  accountEquity: number | null; // latest equity for this account+currency (the % denominator)
  cushionPct: number | null; // cushion ÷ equity — % of account at stake if stopped now
  totalPnlPct: number | null; // totalPnl ÷ equity — whole-trade P&L as % of account
  tradeId: string | null; // the open trade this holding belongs to → deep-link to its detail page
}

/** Current holdings from the snapshot at `snapshotTime`, joined to the open trade's stop + initial
 * risk to produce R-framed open-risk / locked-profit / unrealized metrics. Each row keeps its own
 * currency (callers group per currency; never sum dollars across — R is unitless and may). */
export function openPositions(db: Database, snapshotTime: number): OpenPosition[] {
  const snap = positionsAt(db, snapshotTime);
  const tradeBy = new Map<string, Trade>();
  for (const t of allTrades(db)) {
    if (t.status === "open") tradeBy.set(`${t.account}|${t.symbol}`, t);
  }
  // Latest equity per account (currency → equity), fetched once per account and reused across its rows.
  const equityByAccount = new Map<string, Map<string, number>>();
  const equityFor = (account: string, currency: string): number | null => {
    let m = equityByAccount.get(account);
    if (!m) {
      m = latestEquityByCurrency(db, account);
      equityByAccount.set(account, m);
    }
    const e = m.get(currency);
    return e !== undefined && e > 0 ? e : null;
  };
  return snap.map((p) => {
    const trade = tradeBy.get(`${p.account}|${p.symbol}`);
    // Live risk readout: the stop STILL WORKING now (not the effective/ever-seen stop, which may have
    // been cancelled — that would show a cancelled profit-side stop as a "free trade" with zero risk).
    const liveStop = trade?.liveStop ?? null;
    const initialRisk = trade?.risk ?? null;
    const realizedSoFar = trade?.realizedSoFar ?? 0; // banked profit from partial exits (0 if none)
    const m = positionMetrics({ avgCost: p.avgCost, qty: p.qty, price: p.price, stop: liveStop, initialRisk, realizedSoFar });
    // % of account: this position's own account equity, in its own currency (never mixed).
    const accountEquity = equityFor(p.account, p.currency);
    const pctOf = (n: number | null): number | null =>
      n !== null && accountEquity !== null ? n / accountEquity : null;
    return {
      account: p.account,
      symbol: p.symbol,
      currency: p.currency,
      qty: p.qty,
      avgCost: p.avgCost,
      price: p.price,
      liveStop,
      realizedSoFar: m.realizedSoFar,
      stopOutcome: m.stopOutcome,
      cushion: m.cushion,
      openRisk: m.openRisk,
      lockedProfit: m.lockedProfit,
      unrealized: m.unrealized,
      totalPnl: m.totalPnl,
      initialRisk,
      cushionR: m.cushionR,
      totalPnlR: m.totalPnlR,
      freeTrade: m.freeTrade,
      breakevenStop: m.breakevenStop,
      accountEquity,
      cushionPct: pctOf(m.cushion),
      totalPnlPct: pctOf(m.totalPnl),
      tradeId: trade?.id ?? null,
    };
  });
}

/** The latest position-snapshot time (0 if none) — the batch a caller renders as "current". Uses
 * the persisted snapshot marker (so an all-flat sync, which writes no rows, correctly reports zero
 * holdings instead of a stale prior batch); snapshotClock backfills a pre-marker migrated DB. */
export function latestSnapshotTime(db: Database): number {
  return snapshotClock(db, 0);
}

export type EquityBasis = "at_open" | "latest" | "none";
export interface TradeSizing {
  accountEquity: number | null; // denominator, in the trade's currency
  equityBasis: EquityBasis;
  riskPct: number | null; // planned risk / equity
  positionSize: number; // capital committed at max size (avgEntry × maxQty)
  sizePct: number | null; // positionSize / equity
}

/** Per-trade sizing as a fraction of account equity (SAME currency — never mix). `equityBasis`:
 * "at_open" when a funds snapshot at/before the open exists (precise), else "latest" (approximate),
 * else "none". Shared by the trade-detail view and the trades-list rows so both read identical
 * numbers. */
export function tradeSizing(db: Database, trade: Trade): TradeSizing {
  const atOpen = equityAsOf(db, trade.account, trade.currency, trade.openTime);
  const latest =
    atOpen === null ? latestEquityByCurrency(db, trade.account).get(trade.currency) ?? null : null;
  const equity = atOpen ?? latest;
  const equityBasis: EquityBasis = atOpen !== null ? "at_open" : latest !== null ? "latest" : "none";
  const usable = equity !== null && equity > 0;
  const riskPct = trade.risk !== null && usable ? trade.risk / equity : null;
  const positionSize = trade.avgEntry * trade.maxQty;
  const sizePct = usable ? positionSize / equity : null;
  return { accountEquity: equity, equityBasis, riskPct, positionSize, sizePct };
}

export interface TradeDetail {
  trade: Trade;
  fills: RawFill[];
  orders: RawOrder[];
  flags: Flag[];
  stop: StopInfo; // inferred provenance (the stored trade already reflects any manual override)
  journal: Journal | null;
  // Planned risk as a fraction of account equity, same currency. `equityBasis` says which equity:
  //  - "at_open": a snapshot preceded the trade open — precise (the norm for trades opened after a
  //    prior sync captured funds);
  //  - "latest": no snapshot preceded the open, so we approximate with the newest equity snapshot
  //    (OpenD has no historical-funds query — this is the honest fallback for older trades);
  //  - "none": no equity snapshot at all → riskPct null.
  riskPct: number | null;
  accountEquity: number | null; // equity used as the denominator, in the trade's currency
  equityBasis: "at_open" | "latest" | "none";
  // Capital committed at max size (avgEntry × maxQty), in the trade's currency, and as a fraction of
  // account equity (same `equityBasis` as riskPct) — "this trade was N% of the account".
  positionSize: number;
  sizePct: number | null;
  // Current signed holding for an OPEN trade, from the latest positions snapshot (FUTU's own ground
  // truth) — reversal-safe, unlike summing this trade's fills (a flip-through-zero fill is split across
  // two trades but returned at full qty). 0 when flat / no snapshot. `positionAsOf` is that snapshot's
  // clock, so the UI can say how fresh the holding/stop are (they only move on sync).
  currentQty: number;
  positionAsOf: number;
  // The user's flag corrections (already merged into `flags`); surfaced so the editor can tell a
  // manual flag from a computed one and offer to restore dismissed ones.
  flagOverrides: FlagOverrides;
}

export function tradeDetail(db: Database, id: string): TradeDetail | null {
  const trade = allTrades(db).find((t) => t.id === id);
  if (!trade) return null;
  const fillSet = new Set(trade.fillIds);
  const fills = allRawFills(db).filter((f) => fillSet.has(f.id));
  const orders = allRawOrders(db).filter(
    (o) => o.account === trade.account && o.symbol === trade.symbol,
  );
  const { accountEquity: equity, equityBasis, riskPct, positionSize, sizePct } = tradeSizing(db, trade);
  // Current holding from the latest snapshot (only meaningful while open; a closed trade is flat).
  const positionAsOf = latestSnapshotTime(db);
  const held =
    trade.status === "open"
      ? positionsAt(db, positionAsOf).find(
          (p) => p.account === trade.account && p.symbol === trade.symbol,
        )
      : undefined;
  return {
    trade,
    fills,
    orders,
    flags: flagsForTrade(db, id),
    stop: inferStops(trade, orders),
    journal: getJournal(db, id),
    riskPct,
    accountEquity: equity,
    equityBasis,
    positionSize,
    sizePct,
    currentQty: held?.qty ?? 0,
    positionAsOf,
    flagOverrides: getFlagOverrides(db, id),
  };
}

/** Open positions grouped per currency, with each currency's total open risk vs latest account
 * equity. Equity/risk are compared within a single currency only (never summed across). */
export interface CurrencyPositions {
  currency: string;
  positions: OpenPosition[];
  totalOpenRisk: number | null; // sum of openRisk (net of banked profit) over rows that have a stop
  totalLockedProfit: number | null; // sum of lockedProfit (incl. banked) over rows that have a stop
  totalPnl: number | null; // sum of whole-trade P&L (banked + unrealized) over rows with a known price
  // Honesty flags for the sums above — a total silently omits rows it can't quantify, so surface how
  // many were left out. An UNPROTECTED position (no live stop) is the highest-risk case, yet it
  // contributes nothing to totalOpenRisk; without this the total reads as the whole book when it isn't.
  positionsWithoutStop: number; // rows with no live stop → excluded from totalOpenRisk
  positionsWithoutPrice: number; // rows with no price → excluded from totalPnl
  deployed: number; // capital deployed = Σ |qty| × avgCost across this currency's holdings
  equity: number | null; // latest equity snapshot in this currency
  riskPct: number | null; // totalOpenRisk / equity
  totalPnlPct: number | null; // totalPnl / equity
  deployedPct: number | null; // deployed / equity — how much of the account is committed
}

/** Portfolio totals in R. R is dimensionless (P&L ÷ the trade's own initial risk), so unlike dollars
 * these DO sum across currencies — the honest whole-book "how much am I risking / up, in R". */
export interface RTotals {
  openRisk: number | null; // Σ over positions of the loss-side R still at stake, net of banked profit (0 on free trades)
  totalPnl: number | null; // Σ of whole-trade R (banked + unrealized) across the book
  // How many open positions each R total could NOT include, so the UI never presents a partial sum as
  // the whole book. `openRiskOmitted` / `totalPnlOmitted` count EXACTLY what their total drops (R is
  // unknown when the 1R basis is missing, on top of a missing stop / price). `unprotected` is the
  // subset of openRiskOmitted with NO live stop — real but unquantified risk — which the UI flags loudest.
  unprotected: number; // positions with no live stop (understate risk); subset of openRiskOmitted
  openRiskOmitted: number; // positions excluded from openRisk (no live stop OR no 1R basis)
  totalPnlOmitted: number; // positions excluded from totalPnl (no price OR no 1R basis)
}

export interface PositionsResponse {
  byCurrency: CurrencyPositions[];
  rTotals: RTotals;
}

function sumOrNull(xs: (number | null)[]): number | null {
  const present = xs.filter((x): x is number => x !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

export function openPositionsByCurrency(db: Database, snapshotTime: number): PositionsResponse {
  const positions = openPositions(db, snapshotTime);
  const equityByCcy = new Map<string, Map<string, number>>(); // account → (currency → equity)
  const groups = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const arr = groups.get(p.currency) ?? [];
    arr.push(p);
    groups.set(p.currency, arr);
    if (!equityByCcy.has(p.account)) equityByCcy.set(p.account, latestEquityByCurrency(db, p.account));
  }
  const byCurrency = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, ps]) => {
      const totalOpenRisk = sumOrNull(ps.map((p) => p.openRisk));
      const totalLockedProfit = sumOrNull(ps.map((p) => p.lockedProfit));
      const totalPnl = sumOrNull(ps.map((p) => p.totalPnl));
      const positionsWithoutStop = ps.filter((p) => p.cushion === null).length;
      const positionsWithoutPrice = ps.filter((p) => p.totalPnl === null).length;
      // Deployed capital: sum notional (|qty| × avgCost) — same currency only, an exposure sum (not P&L).
      const deployed = ps.reduce((a, p) => a + Math.abs(p.qty) * p.avgCost, 0);
      // Sum equity for this currency across the DISTINCT accounts holding it (each account's own
      // snapshot counted once). If ANY contributing account lacks an equity snapshot the denominator is
      // incomplete — leave equity null (→ % null, shown as "equity n/a") rather than dividing this
      // currency's full deployed/risk by a partial equity, which would overstate exposure.
      let equity: number | null = 0;
      for (const account of new Set(ps.map((p) => p.account))) {
        const e = equityByCcy.get(account)?.get(currency);
        if (e === undefined) {
          equity = null;
          break;
        }
        equity += e;
      }
      const pct = (n: number | null) => (n !== null && equity !== null && equity > 0 ? n / equity : null);
      return {
        currency,
        positions: ps,
        totalOpenRisk,
        totalLockedProfit,
        totalPnl,
        positionsWithoutStop,
        positionsWithoutPrice,
        deployed,
        equity,
        riskPct: pct(totalOpenRisk),
        totalPnlPct: pct(totalPnl),
        deployedPct: pct(deployed),
      };
    });
  // R totals across the whole book (R is unitless, so cross-currency summing is valid).
  const rTotals: RTotals = {
    openRisk: sumOrNull(positions.map((p) => (p.cushionR === null ? null : Math.max(0, -p.cushionR)))),
    totalPnl: sumOrNull(positions.map((p) => p.totalPnlR)),
    unprotected: positions.filter((p) => p.cushion === null).length,
    openRiskOmitted: positions.filter((p) => p.cushionR === null).length,
    totalPnlOmitted: positions.filter((p) => p.totalPnlR === null).length,
  };
  return { byCurrency, rTotals };
}

export interface Meta {
  accounts: string[];
  currencies: string[];
  setups: string[];
  tags: string[];
  emotions: string[];
  coverageStart: number | null;
  appVersion: string;
}

export function metaView(db: Database): Meta {
  const accounts = (
    db
      .query(`SELECT account FROM trades UNION SELECT account FROM raw_fills ORDER BY account ASC`)
      .all() as any[]
  ).map((r) => r.account as string);
  const currencies = (
    db.query(`SELECT DISTINCT currency FROM trades ORDER BY currency ASC`).all() as any[]
  ).map((r) => r.currency as string);
  const cov = db.query(`SELECT MIN(coverage_start) AS c FROM sync_state`).get() as {
    c: number | null;
  };
  return {
    accounts,
    currencies,
    setups: distinctSetups(db),
    tags: distinctTags(db),
    emotions: distinctEmotions(db),
    coverageStart: cov?.c ?? null,
    appVersion: (pkg as { version?: string }).version ?? "0.0.0",
  };
}
