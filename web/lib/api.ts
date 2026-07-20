// Typed API client. Base domain types are shared verbatim with the backend (src/domain/types) so
// the currency-segmented shapes are the SAME types across the wire.
import type {
  Breakdown,
  Candle,
  Flag,
  RawFill,
  RawOrder,
  Stats,
  StopInfo,
  Trade,
} from "../../src/domain/types";
import type { DailyEntry, Journal, MarketRegime, WeeklyEntry, WatchlistItem } from "../../src/domain/journal-types";
import type { Drawing } from "../../src/store/drawings";
import type { Res } from "../../src/core/candle-res"; // single source of truth for the resolution union

export type { Breakdown, Candle, Flag, Stats, Trade, StopInfo, RawFill, RawOrder, Journal, WeeklyEntry, WatchlistItem, Drawing, Res, DailyEntry, MarketRegime };

/** A trade row from GET /api/trades — base Trade plus embedded journal/flags for the list. */
export interface TradeRow extends Trade {
  flags: Flag[];
  setup: string | null;
  tags: string[];
  sizePct: number | null; // position size as a fraction of account equity ("≈" when basis is "latest")
  equityBasis: "at_open" | "latest" | "none";
}

export interface TradeDetail {
  trade: Trade;
  fills: RawFill[];
  orders: RawOrder[];
  flags: Flag[];
  stop: StopInfo;
  journal: Journal | null;
  riskPct: number | null;
  accountEquity: number | null;
  equityBasis: "at_open" | "latest" | "none";
  positionSize: number; // capital committed at max size (avgEntry × maxQty)
  sizePct: number | null; // positionSize / account equity
  currentQty: number; // signed current holding from the latest snapshot (0 when flat/closed)
  positionAsOf: number; // that snapshot's clock (how fresh the holding/stop are)
  // The user's flag corrections (already merged into `flags`): which shown flags are manual, and
  // which computed ones are dismissed (so the editor can offer restore).
  flagOverrides: { added: string[]; dismissed: string[] };
}

// ---- Daily market heatmap ----
export interface HeatmapRow {
  symbol: string;
  label: string | null; // user-editable industry/name shown beside the ticker
  last: number | null;
  dayPct: number | null;
  p5dPct: number | null;
  p20dPct?: number | null; // 20-session return (RS ingredient); optional: pre-feature snapshots lack it
  p1mPct?: number | null; // ~21-session "1-month" return
  rs20Pct?: number | null; // 20-session return vs SPY, ratio-based excess
  ma20Pct?: number | null; // close vs 20-session SMA
  ma50Pct?: number | null; // close vs 50-session SMA
  volVs20d?: number | null; // latest volume ÷ prior-20-session average (ratio, 1 = normal)
  off52wPct: number | null; // ≤ 0: distance below the trailing-52-week high
  ytdPct: number | null;
}
export interface HeatmapGroupRows {
  name: string;
  rows: HeatmapRow[];
}
/** The auto-ranked thematic list: the FULL universe sorted by 5-day % change (descending, no-data
 * last). Display slices the top N; edit mode shows the whole thing. */
export interface ThematicRanking {
  rankedBy: "p5dPct";
  topN: number;
  universeSize: number;
  rows: HeatmapRow[];
  // The user's CONFIG order (related narratives adjacent) — what edit mode shows and reorders.
  // Optional: snapshots frozen before this feature don't carry it.
  universe?: HeatmapSymbolEntry[];
}
export interface HeatmapResponse {
  asOf: number;
  groups: HeatmapGroupRows[];
  thematic?: ThematicRanking; // optional: snapshots frozen before this feature don't have it
}
export interface HeatmapSymbolEntry {
  symbol: string;
  label: string | null;
}
export interface HeatmapGroups {
  groups: Array<{ name: string; symbols: HeatmapSymbolEntry[] }>;
}

/** Daily journal view: the entry plus its frozen heatmap (null until a today-save captures one) and
 * the trades opened/closed that local day (associated at read time, like the weekly view). */
export interface DailyView extends DailyEntry {
  snapshot: HeatmapResponse | null;
  trades: Trade[];
}

export interface OpenPosition {
  account: string;
  symbol: string;
  currency: string;
  qty: number;
  avgCost: number;
  price: number | null; // current market price (snapshot); null when unknown
  liveStop: number | null; // the stop still working now (excludes cancelled/filled); null when unprotected
  realizedSoFar: number; // profit already banked from partial exits (0 when none); counts toward the cushion
  stopOutcome: number | null; // remaining shares only, if stopped (− loss / + locked); null when no stop
  cushion: number | null; // TOTAL if stopped = banked + stopOutcome; null when no stop
  openRisk: number | null; // loss still exposed net of banked (0 = free trade); null when no stop
  lockedProfit: number | null; // profit locked in if stopped (incl. banked)
  unrealized: number | null; // paper P&L on the remaining shares
  totalPnl: number | null; // whole trade so far = banked + unrealized; null when price unknown
  initialRisk: number | null; // 1R in this currency
  cushionR: number | null; // cushion / initialRisk (signed; ≥ 0 ⇒ free trade)
  totalPnlR: number | null; // totalPnl / initialRisk
  freeTrade: boolean; // cushion locks in ≥ breakeven (banked profit included)
  breakevenStop: number | null; // stop PRICE that brings the cushion to 0 (where to move the stop for net breakeven); null when qty is 0
  accountEquity: number | null; // latest equity for this account+currency (the % denominator)
  cushionPct: number | null; // cushion / equity — % of account at stake if stopped now (signed)
  totalPnlPct: number | null; // totalPnl / equity — whole-trade P&L as % of account (signed)
  tradeId: string | null;
}
export interface CurrencyPositions {
  currency: string;
  positions: OpenPosition[];
  totalOpenRisk: number | null;
  totalLockedProfit: number | null;
  totalPnl: number | null; // whole-trade P&L (banked + unrealized) summed over the currency
  positionsWithoutStop: number; // excluded from totalOpenRisk (no live stop)
  positionsWithoutPrice: number; // excluded from totalPnl (no price)
  deployed: number;
  equity: number | null;
  riskPct: number | null;
  totalPnlPct: number | null;
  deployedPct: number | null;
}
/** Portfolio totals in R — dimensionless, so these sum across currencies (unlike dollars). */
export interface RTotals {
  openRisk: number | null;
  totalPnl: number | null; // whole-trade P&L in R (banked + unrealized), summed across the book
  unprotected: number; // positions with no live stop (understate risk); subset of openRiskOmitted
  openRiskOmitted: number; // positions excluded from openRisk (no live stop OR no 1R basis)
  totalPnlOmitted: number; // positions excluded from totalPnl (no price OR no 1R basis)
}
export interface PositionsResponse {
  byCurrency: CurrencyPositions[];
  rTotals: RTotals;
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

export interface SyncStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: { accounts: number; fills: number; orders: number; trades: number; flags: number } | null;
  lastError: string | null;
}

export interface WeeklyView extends WeeklyEntry {
  trades: Trade[];
}

/** Update check against GitHub Releases. `downloadUrl` is the asset for this platform (or null);
 * `canInstall` is true when the app can update itself in place (compiled binary on a supported
 * platform with an asset) — the banner then offers "Update & Restart" instead of a download link.
 * `error` is set when the check couldn't complete. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  downloadUrl: string | null;
  releaseUrl: string | null;
  canInstall: boolean;
  checksumsUrl: string | null;
  error: string | null;
}

/** OpenD connection settings. The key is write-only over the wire — the server returns `hasKey`, never
 * the key itself. Set entirely in the app (config DB); there is no environment override. */
export interface OpendSettings {
  port: number;
  hasKey: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => get<Stats>("/api/stats"),
  breakdowns: (by: string) => get<Breakdown[]>(`/api/breakdowns?by=${by}`),
  trades: () => get<TradeRow[]>("/api/trades"),
  trade: (id: string) => get<TradeDetail>(`/api/trades/${encodeURIComponent(id)}`),
  candles: (id: string, res: Res = "1d") =>
    get<{ res: Res; resMs: number; focusFrom: number; focusTo: number; candles: Candle[] }>(
      `/api/trades/${encodeURIComponent(id)}/candles?res=${res}`,
    ),
  positions: () => get<PositionsResponse>("/api/positions"),
  meta: () => get<Meta>("/api/meta"),
  syncStatus: () => get<SyncStatus>("/api/sync/status"),
  startSync: () => send<SyncStatus>("/api/sync", "POST"),
  quit: () => send<{ quitting: boolean }>("/api/quit", "POST"),
  // `force` bypasses the server's 6h cache — used by the Settings "Check for updates" button.
  updateCheck: (force = false) => get<UpdateStatus>(`/api/update/check${force ? "?force=1" : ""}`),
  installUpdate: () => send<{ installing: boolean }>("/api/update/install", "POST"),
  version: () => get<{ version: string }>("/api/version"),
  opendSettings: () => get<OpendSettings>("/api/settings/opend"),
  putOpendSettings: (body: { key?: string; port?: number }) =>
    send<OpendSettings>("/api/settings/opend", "PUT", body),
  putJournal: (id: string, body: Record<string, unknown>) =>
    send<TradeDetail>(`/api/trades/${encodeURIComponent(id)}/journal`, "PUT", body),
  putFlags: (id: string, body: { added: string[]; dismissed: string[] }) =>
    send<TradeDetail>(`/api/trades/${encodeURIComponent(id)}/flags`, "PUT", body),
  heatmap: () => get<HeatmapResponse>("/api/market/heatmap"),
  heatmapGroups: () => get<HeatmapGroups>("/api/market/symbols"),
  putHeatmapGroups: (groups: Array<{ name: string; symbols: HeatmapSymbolEntry[] }>) =>
    send<HeatmapGroups>("/api/market/symbols", "PUT", { groups }),
  resetHeatmapGroups: () => send<HeatmapGroups>("/api/market/symbols", "DELETE"),
  putThematic: (symbols: HeatmapSymbolEntry[]) =>
    send<{ symbols: HeatmapSymbolEntry[] }>("/api/market/thematic", "PUT", { symbols }),
  day: (dayKey: string) => get<DailyView>(`/api/journal/days/${dayKey}`),
  putDay: (dayKey: string, body: Record<string, unknown>) =>
    send<DailyView>(`/api/journal/days/${dayKey}`, "PUT", body),
  drawings: (id: string) => get<{ drawings: Drawing[] }>(`/api/trades/${encodeURIComponent(id)}/drawings`),
  putDrawings: (id: string, drawings: Drawing[]) =>
    send<{ drawings: Drawing[] }>(`/api/trades/${encodeURIComponent(id)}/drawings`, "PUT", { drawings }),
  week: (isoWeek: string) => get<WeeklyView>(`/api/journal/weeks/${isoWeek}`),
  putWeek: (isoWeek: string, body: Record<string, unknown>) =>
    send<WeeklyView>(`/api/journal/weeks/${isoWeek}`, "PUT", body),
};
