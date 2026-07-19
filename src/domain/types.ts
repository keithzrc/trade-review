export type Side = "BUY" | "SELL";
export type Direction = "LONG" | "SHORT";
export type TradeStatus = "open" | "closed";

/** One execution as returned by FUTU (a "deal"/fill). qty is always positive. */
export interface RawFill {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  currency: string;
  time: number; // epoch milliseconds
  account: string;
}

/** A position already open before our fill history begins (from a positions snapshot). */
export interface SeedPosition {
  account: string;
  symbol: string;
  qty: number; // signed: positive = long, negative = short
  avgCost: number; // cost basis per share from the snapshot (so seeded PnL/avgEntry are sane)
  currency: string;
  time: number; // epoch ms of the snapshot (used as openTime when there are no fills)
}

/** A stored position snapshot row (raw_positions). One per (account, symbol, snapshot time). */
export interface RawPosition {
  account: string;
  symbol: string;
  qty: number; // signed: positive = long, negative = short
  avgCost: number;
  price: number | null; // current market price at the snapshot (FUTU's mark); null when unknown
  currency: string;
  time: number; // epoch ms of the snapshot
}

/** Account equity snapshot (Trd_GetFunds), denominated in ONE currency (FUTU does the FX on request).
 * Used to express a trade's planned risk as a % of account equity — never mix currencies. */
export interface AccountFunds {
  account: string;
  currency: string; // the denomination we requested (comprehensive accounts require a currency)
  totalAssets: number; // net asset value in `currency`
  cash: number;
  marketVal: number;
  time: number; // epoch ms of the snapshot (sync stamps its snapshot clock)
}

/** Sync cursor for one (account, market). Persisted so re-syncs are incremental. */
export interface SyncState {
  account: string;
  market: string;
  lastSyncedTime: number | null; // epoch ms of the newest raw row pulled so far
  coverageStart: number | null; // epoch ms of the oldest raw row we have (history floor)
}

/** A reconstructed round-trip trade. */
export interface Trade {
  id: string; // deterministic: `${account}:${symbol}:${openTime}:${openingFillId}` (collision-safe)
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  status: TradeStatus;
  openTime: number;
  closeTime: number | null;
  avgEntry: number;
  avgExit: number | null;
  maxQty: number;
  realizedPnl: number | null; // net realized P&L; null until the trade is fully CLOSED (analytics sums only these)
  realizedSoFar: number; // profit banked from exits SO FAR (partial or full); 0 when nothing sold; == realizedPnl at close
  fees: number;
  holdSeconds: number | null;
  coverageOk: boolean; // false when the trade began before our data coverage (seeded)
  fillIds: string[];
  // Enrichment fields — null from trade-builder; populated by the sync pipeline (Plan 2+ modules).
  effectiveStop: number | null; // latest protective stop EVER seen (may since be cancelled) — post-hoc review
  liveStop: number | null; // latest protective stop STILL WORKING (excludes cancelled/filled) — live risk readout
  effectiveTp: number | null;
  risk: number | null;
  rMultiple: number | null;
  mae: number | null;
  mfe: number | null;
  // True when the inferred initial stop can't be the real risk basis (price ran past it while the
  // trade was demonstrably still open — a trailed/moved stop reported by FUTU as the initial trigger).
  // R stays VISIBLE per-trade, but the trade is flagged (unreliable_stop) for manual input and
  // EXCLUDED from the R averages. Derived + stored; rebuilt every sync. See sync.ts / stop-reliability.
  stopUnreliable: boolean;
}

/** FUTU order type (normalized). Stop/stop-limit/trailing are protective-stop candidates. */
export type OrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP"
  | "STOP_LIMIT"
  | "TRAILING_STOP"
  | "OTHER";

/** An order as returned by FUTU (including cancelled ones). Used to infer protective stops. */
export interface RawOrder {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price: number | null; // limit price; null for market/stop-market
  triggerPrice: number | null; // stop trigger; null for non-stop orders
  status: string; // raw FUTU status string (e.g. "FILLED_ALL", "CANCELLED_ALL")
  createTime: number; // epoch ms
  updateTime: number | null; // epoch ms of last modification (a moved stop bumps this, not createTime)
  account: string;
}

/** An OHLC candle. Used for MAE/MFE and (later) charts. */
export interface Candle {
  time: number; // epoch ms, bar start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Output of stop inference for one trade. */
export interface StopInfo {
  initialStop: number | null; // earliest protective stop — the planned risk (use for R-multiple)
  initialStopType: OrderType | null; // type of the order behind initialStop (STOP_LIMIT may not fill)
  effectiveStop: number | null; // latest protective stop — what was actually protecting at the end
  effectiveTp: number | null;
  stopOrderId: string | null; // id of the order behind effectiveStop (provenance)
  stopQty: number | null; // qty that stop covered (may be < position size)
  receipt: string | null; // plain-English explanation of the matched stop (spec §6)
  // The latest protective stop that is STILL WORKING (resting in the book) as of the data we have —
  // distinct from effectiveStop, which is the latest protective stop ever seen (it may since have been
  // cancelled or filled). Use liveStop for a LIVE open-position readout so a cancelled stop is never
  // shown as active protection; use effectiveStop for post-hoc review of what protected the trade.
  liveStop: number | null;
  liveStopQty: number | null;
}

/** A fired mistake-rule result, with a plain-English reason. */
export interface Flag {
  ruleId: string;
  severity: "info" | "warn";
  reason: string;
}

/** Tunable thresholds + per-rule on/off. Loaded from the config file (no settings UI in v1). */
export interface RuleConfig {
  cutWinnerR: number; // flag a winner exited for less than this R (default 1)
  oversizedMult: number; // flag risk above this multiple of recent-average risk (default 1.5)
  roundTripR: number; // flag a give-back when peak gain reached this many R (default 1)
  revengeMinutes: number; // flag a new trade opened within this many minutes of a losing exit (default 30)
  excessLossR: number; // flag a realized loss worse than this many R — deeper than plan (default 1.3)
  maxStopPct: number; // flag an initial stop wider than this fraction of entry (default 0.08 = 8%)
  pyramidExtendedPct: number; // flag a pyramid add priced above first entry by more than this (default 0.05)
  overtradeWindowDays: number; // window for the overtrading-frequency count (default 1 day)
  overtradeMaxOpens: number; // flag when opens within the window exceed this count (default 3)
  // unreliable_stop: a losing trade's price ran past its inferred stop by more than this many
  // stop-widths back from its low (i.e. it recovered, so the stop wasn't the resting initial one).
  unreliableStopRecoverR: number; // default 1
  enabled: Record<string, boolean>; // ruleId → enabled; missing key = enabled
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  cutWinnerR: 1,
  oversizedMult: 1.5,
  roundTripR: 1,
  revengeMinutes: 30,
  excessLossR: 1.3,
  maxStopPct: 0.08,
  pyramidExtendedPct: 0.05,
  overtradeWindowDays: 1,
  overtradeMaxOpens: 3,
  unreliableStopRecoverR: 1,
  enabled: {},
};

/** Everything a rule may need beyond the trade itself. `recentClosedTrades` are PRIOR closed
 * trades in the same account (excluding this one) — used for recent-average risk and revenge timing. */
export interface RuleContext {
  fills: RawFill[]; // the fills composing THIS trade
  recentClosedTrades: Trade[];
  // Open times of PRIOR coverage-ok trades in the same account — used by overtrading_freq to count
  // opens in a rolling window regardless of whether those trades have closed (a swing trader holds
  // many positions open at once, so closed-before-open would never catch the churn). Undefined = none.
  recentOpens?: number[];
}

/** Per-currency aggregate stats (P&L is never summed across currencies). */
export interface CurrencyStats {
  currency: string;
  netPnl: number;
  tradeCount: number;
  winRate: number; // 0..1
  avgWin: number;
  avgLoss: number; // positive magnitude of the average loss
  expectancy: number; // winRate*avgWin - lossRate*avgLoss
  avgR: number | null; // mean rMultiple over trades that have one
  rCount: number; // how many of tradeCount have an R basis (a known stop) — avgR is over these only
  // Win/loss asymmetry in R. All over the R-eligible subset (rCount trades): a strategy of many small
  // losses + few large winners shows a big avgWinR, small avgLossR, and a high payout ratio.
  avgWinR: number | null; // mean rMultiple of R-eligible winners (positive)
  avgLossR: number | null; // mean magnitude of rMultiple of R-eligible losers (positive)
  payoutRatio: number | null; // avgWinR / avgLossR — realized reward-to-risk (null when either side is absent)
  breakevenWinRate: number | null; // avgLossR / (avgWinR + avgLossR) = 1/(1+payout) — win rate needed to net zero R
  avgMae: number | null;
  avgMfe: number | null;
  // Position sizing. The % figures are the headline (1% vs 0.5% of the account per trade is a very
  // different risk posture); the dollar figures are context. % is null until a funds snapshot exists.
  avgRisk: number | null; // mean planned risk ($ = 1R) over trades that have one
  avgRiskPct: number | null; // mean of per-trade (risk / account equity) — typical risk per trade, in %
  avgPositionSize: number; // mean entry notional (avgEntry × maxQty) — your typical trade size ($)
  maxPositionSize: number; // largest single-trade entry notional ($)
  avgSizePct: number | null; // mean of per-trade (notional / account equity) — typical size, in %
  sizingApprox: boolean; // true when any % here used a fallback (latest, not at-open) equity → show "≈"
  equityCurve: Array<{ time: number; cumPnl: number }>;
}

/** One row of a grouped breakdown (by symbol, setup, tag, hold-time bucket, …), per currency. */
export interface Breakdown {
  currency: string;
  key: string;
  netPnl: number;
  tradeCount: number;
  winRate: number;
  avgR: number | null;
}

export interface Stats {
  byCurrency: CurrencyStats[];
}
