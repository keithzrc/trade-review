import type { Database } from "bun:sqlite";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "../domain/types";

const RULES_KEY = "rules";

/** Read the rule config, shallow-merging any stored overrides onto the current defaults so a
 * config written by an older version still gains newly-added default fields. */
export function getRuleConfig(db: Database): RuleConfig {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(RULES_KEY) as
    | { value: string }
    | null;
  if (!row) return { ...DEFAULT_RULE_CONFIG, enabled: { ...DEFAULT_RULE_CONFIG.enabled } };
  const stored = JSON.parse(row.value) as Partial<RuleConfig>;
  return {
    ...DEFAULT_RULE_CONFIG,
    ...stored,
    enabled: { ...DEFAULT_RULE_CONFIG.enabled, ...(stored.enabled ?? {}) },
  };
}

export function setRuleConfig(db: Database, config: RuleConfig): void {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [RULES_KEY, JSON.stringify(config)],
  );
}

// ---- generic config KV --------------------------------------------------------

/** Marker for the timestamp of the most recent position-snapshot batch (written by pullRaw). It is
 * the reconciliation clock for seed derivation and the "current holdings" batch — NOT wall-clock
 * time. Using it (instead of `now`) lets a standalone rebuild reconcile against the last real
 * snapshot, and lets an all-flat sync correctly report zero open positions. */
export const LAST_SNAPSHOT_TIME = "last_snapshot_time";

export function getConfigValue(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setConfigValue(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ---- OpenD connection (key + port) --------------------------------------------
// The single source of truth is the config table (set via the Settings screen) — so the packaged,
// double-clicked app is configured entirely in-app, with no environment variables or file editing.

const OPEND_KEY = "opend";
export const DEFAULT_OPEND_PORT = 33334;

export interface StoredOpend {
  key: string | null;
  port: number | null;
}

export function getStoredOpend(db: Database): StoredOpend {
  const raw = getConfigValue(db, OPEND_KEY);
  if (!raw) return { key: null, port: null };
  // Degrade to "nothing stored" on a malformed/legacy row rather than throwing — otherwise a corrupt
  // value would 500 the Settings GET *and* PUT (setStoredOpend reads first, so even the repair path
  // dies) and throw on every sync. Self-healing: the next successful PUT overwrites the bad row.
  let p: Partial<StoredOpend> | null;
  try {
    p = JSON.parse(raw) as Partial<StoredOpend>;
  } catch {
    p = null;
  }
  if (p === null || typeof p !== "object") return { key: null, port: null };
  return {
    key: typeof p.key === "string" ? p.key : null,
    port: typeof p.port === "number" ? p.port : null,
  };
}

/** Merge a partial patch onto the stored value — an undefined field is left unchanged (so saving the
 * port alone never wipes a previously-saved key). */
export function setStoredOpend(db: Database, patch: Partial<StoredOpend>): void {
  const cur = getStoredOpend(db);
  const next: StoredOpend = {
    key: patch.key !== undefined ? patch.key : cur.key,
    port: patch.port !== undefined ? patch.port : cur.port,
  };
  setConfigValue(db, OPEND_KEY, JSON.stringify(next));
}

/** The connection to hand OpenD: the stored key (undefined when unset) and the stored port (falling
 * back to the default). Pure, so it's unit tested directly. */
export function opendConnection(stored: StoredOpend): { key: string | undefined; port: number } {
  return { key: stored.key ?? undefined, port: stored.port ?? DEFAULT_OPEND_PORT };
}

// ---- Daily heatmap symbol groups ----------------------------------------------
// The Daily page's ETF/sector watch groups, user-editable in the UI. Domain symbol format
// ("US.SPY", "HK.00700") — the same format trades use, so the candle source maps them identically.
// Each entry carries an optional user-editable `label` (the industry/name shown beside the ticker).

const HEATMAP_KEY = "heatmap_groups";

export interface HeatmapSymbol {
  symbol: string;
  label: string | null; // "Technology", "China Internet", … — free text, user-editable
}

export interface HeatmapGroup {
  name: string;
  symbols: HeatmapSymbol[];
}

function g(name: string, entries: Array<[string, string]>): HeatmapGroup {
  return { name, symbols: entries.map(([symbol, label]) => ({ symbol, label })) };
}

export const DEFAULT_HEATMAP_GROUPS: HeatmapGroup[] = [
  g("Index / style", [
    ["US.SPY", "S&P 500"],
    ["US.RSP", "S&P 500 Equal Weight"],
    ["US.QQQ", "Nasdaq 100"],
    ["US.IWM", "Russell 2000"],
    ["US.DIA", "Dow 30"],
  ]),
  g("S&P sectors", [
    ["US.XLK", "Technology"],
    ["US.XLC", "Communication Services"],
    ["US.XLY", "Consumer Discretionary"],
    ["US.XLP", "Consumer Staples"],
    ["US.XLV", "Health Care"],
    ["US.XLF", "Financials"],
    ["US.XLI", "Industrials"],
    ["US.XLB", "Materials"],
    ["US.XLE", "Energy"],
    ["US.XLU", "Utilities"],
    ["US.XLRE", "Real Estate"],
  ]),
  // Equal-weight mirrors of the cap-weighted sectors above, in the same order — reading the two
  // tables against each other shows whether a sector's move is broad or just a few mega-caps.
  g("S&P EW sectors", [
    ["US.RSPT", "EW Technology"],
    ["US.RSPC", "EW Communication Services"],
    ["US.RSPD", "EW Consumer Discretionary"],
    ["US.RSPS", "EW Consumer Staples"],
    ["US.RSPH", "EW Health Care"],
    ["US.RSPF", "EW Financials"],
    ["US.RSPN", "EW Industrials"],
    ["US.RSPM", "EW Materials"],
    ["US.RSPG", "EW Energy"],
    ["US.RSPU", "EW Utilities"],
    ["US.RSPR", "EW Real Estate"],
  ]),
];

// ---- Thematic universe (the auto-ranked "Top 10 thematic") ---------------------
// A WIDE candidate list, not a display list: the heatmap endpoint ranks the whole universe by 5-day
// % change every load and surfaces the top 10 — so the leaders rotate in by themselves each day.
// User-editable like the groups (add/remove/label); stored under its own key.

const THEMATIC_KEY = "thematic_universe";

// Ordered by NARRATIVE, related themes adjacent (the user's curated map of the market): AI & digital
// infrastructure → crypto → healthcare → defense & space → industrials & transportation → housing &
// consumer → financials → traditional energy → power & new energy → metals & materials →
// agriculture & natural resources → international → rates & real estate.
export const DEFAULT_THEMATIC_UNIVERSE: HeatmapSymbol[] = [
  // — AI & Digital Infrastructure
  ["US.SMH", "Semiconductors"],
  ["US.IGV", "Software"],
  ["US.SKYY", "Cloud Computing"],
  ["US.HACK", "Cybersecurity"],
  ["US.FDN", "Internet Platforms"],
  ["US.AIQ", "Artificial Intelligence & Big Data"],
  ["US.BOTZ", "Robotics & Artificial Intelligence"],
  ["US.DTCR", "Data Centers & Digital Infrastructure"],
  ["US.QTUM", "Quantum Computing & Machine Learning"],
  // — Crypto & Blockchain
  ["US.IBIT", "Bitcoin"],
  ["US.ETHA", "Ethereum"],
  ["US.BLOK", "Blockchain & Crypto Equities"],
  // — Healthcare
  ["US.XLV", "Broad Healthcare"],
  ["US.IBB", "Large-Cap Biotechnology"],
  ["US.XBI", "Biotechnology - Equal Weight"],
  ["US.ARKG", "Genomics & Gene Technology"],
  ["US.IHI", "Medical Devices"],
  ["US.IHF", "Healthcare Providers & Insurers"],
  // — Defense & Space
  ["US.XAR", "Aerospace & Defense - Equal Weight"],
  ["US.SHLD", "Defense Technology"],
  ["US.UFO", "Space Economy & Satellites"],
  // — Industrials & Transportation
  ["US.XLI", "Broad Industrials"],
  ["US.PAVE", "US Infrastructure"],
  ["US.AIRR", "US Industrial Renaissance & Reshoring"],
  ["US.IYT", "Transportation"],
  ["US.JETS", "Airlines"],
  ["US.BOAT", "Global Maritime Shipping"],
  // — Housing & Consumer
  ["US.ITB", "Home Construction"],
  ["US.XRT", "Retail"],
  ["US.XLY", "Consumer Discretionary"],
  ["US.XLP", "Consumer Staples"],
  // — Financials
  ["US.XLF", "Broad Financials"],
  ["US.KRE", "Regional Banks"],
  ["US.IAI", "Broker-Dealers & Securities Exchanges"],
  ["US.FINX", "Financial Technology"],
  ["US.KIE", "Insurance"],
  // — Traditional Energy
  ["US.XLE", "Broad Energy"],
  ["US.XOP", "Oil & Gas Exploration and Production"],
  ["US.OIH", "Oil Services"],
  ["US.FCG", "Natural Gas Producers"],
  ["US.USO", "Crude Oil"],
  ["US.UNG", "Natural Gas"],
  // — Power & New Energy
  ["US.XLU", "Utilities"],
  ["US.ZAP", "US Electrification"],
  ["US.GRID", "Smart Grid Infrastructure"],
  ["US.URA", "Uranium & Nuclear Components"],
  ["US.NLR", "Nuclear Energy Ecosystem"],
  ["US.TAN", "Solar Energy"],
  ["US.LIT", "Lithium & Battery Technology"],
  ["US.DRIV", "Electric & Autonomous Vehicles"],
  // — Metals & Materials
  ["US.XLB", "Broad Materials"],
  ["US.GLD", "Gold"],
  ["US.SLV", "Silver"],
  ["US.GDX", "Gold Miners"],
  ["US.SIL", "Silver Miners"],
  ["US.COPX", "Copper Miners"],
  ["US.XME", "Metals & Mining"],
  ["US.REMX", "Rare Earths & Strategic Metals"],
  // — Agriculture & Natural Resources
  ["US.DBC", "Broad Commodities"],
  ["US.DBA", "Agricultural Commodities"],
  ["US.MOO", "Agribusiness"],
  ["US.WEAT", "Wheat"],
  ["US.CORN", "Corn"],
  ["US.PHO", "Water Resources & Infrastructure"],
  ["US.WOOD", "Timber & Forestry"],
  // — International Markets
  ["US.KWEB", "China Internet"],
  ["US.FXI", "China Large-Cap"],
  ["US.EEM", "Emerging Markets"],
  ["US.EWZ", "Brazil"],
  ["US.INDA", "India"],
  ["US.EWJ", "Japan"],
  ["US.EWT", "Taiwan"],
  ["US.EWY", "South Korea"],
  // — Rates & Real Estate
  ["US.TLT", "20+ Year US Treasuries"],
  ["US.IYR", "US Real Estate"],
].map(([symbol, label]) => ({ symbol: symbol as string, label: label as string }));

/** Known industry labels from the default groups AND the thematic universe, used to BACKFILL a
 * stored entry whose label is null — a config written before labels existed (or a ticker re-added
 * without one) shows the right industry automatically. The trade-off: clearing the label of one of
 * these tickers re-fills it on the next read; acceptable, since it's freely editable to anything. */
const DEFAULT_LABELS: ReadonlyMap<string, string> = new Map([
  ...DEFAULT_HEATMAP_GROUPS.flatMap((grp) =>
    grp.symbols.map((s) => [s.symbol, s.label as string] as [string, string]),
  ),
  ...DEFAULT_THEMATIC_UNIVERSE.map((s) => [s.symbol, s.label as string] as [string, string]),
]);

/** Parse a stored/PUT symbol-entry list: strings (legacy, label-less) or {symbol, label} objects.
 * Backfills known default labels onto label-less entries. Null when malformed. */
function readEntries(symbols: unknown): HeatmapSymbol[] | null {
  if (!Array.isArray(symbols)) return null;
  const entries: HeatmapSymbol[] = [];
  for (const s of symbols) {
    let entry: HeatmapSymbol;
    if (typeof s === "string") entry = { symbol: s, label: null }; // legacy shape
    else if (s !== null && typeof s === "object" && typeof (s as any).symbol === "string") {
      const label = (s as any).label;
      entry = { symbol: (s as any).symbol, label: typeof label === "string" ? label : null };
    } else return null;
    if (entry.label === null) entry.label = DEFAULT_LABELS.get(entry.symbol) ?? null;
    entries.push(entry);
  }
  return entries;
}

/** Read the stored groups; degrade to the defaults on a malformed/legacy row rather than throwing
 * (same self-healing posture as getStoredOpend — the next successful PUT overwrites the bad row).
 * Accepts the pre-label shape too (symbols as plain strings → label null), so a DB written by the
 * previous build upgrades losslessly on read. */
export function getHeatmapGroups(db: Database): HeatmapGroup[] {
  const raw = getConfigValue(db, HEATMAP_KEY);
  if (!raw) return DEFAULT_HEATMAP_GROUPS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_HEATMAP_GROUPS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_HEATMAP_GROUPS;
  const groups: HeatmapGroup[] = [];
  for (const grp of parsed) {
    if (grp === null || typeof grp !== "object") return DEFAULT_HEATMAP_GROUPS;
    const { name, symbols } = grp as Record<string, unknown>;
    if (typeof name !== "string" || !Array.isArray(symbols)) return DEFAULT_HEATMAP_GROUPS;
    const entries = readEntries(symbols);
    if (entries === null) return DEFAULT_HEATMAP_GROUPS;
    groups.push({ name, symbols: entries });
  }
  return groups;
}

/** Drop the stored groups so the (current) defaults apply again — the "Reset to defaults" button. */
export function clearHeatmapGroups(db: Database): void {
  db.run(`DELETE FROM config WHERE key = ?`, [HEATMAP_KEY]);
}

export function getThematicUniverse(db: Database): HeatmapSymbol[] {
  const raw = getConfigValue(db, THEMATIC_KEY);
  if (!raw) return DEFAULT_THEMATIC_UNIVERSE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_THEMATIC_UNIVERSE;
  }
  return readEntries(parsed) ?? DEFAULT_THEMATIC_UNIVERSE;
}

export function setThematicUniverse(db: Database, entries: HeatmapSymbol[]): void {
  setConfigValue(db, THEMATIC_KEY, JSON.stringify(entries));
}

export function clearThematicUniverse(db: Database): void {
  db.run(`DELETE FROM config WHERE key = ?`, [THEMATIC_KEY]);
}

export function setHeatmapGroups(db: Database, groups: HeatmapGroup[]): void {
  setConfigValue(db, HEATMAP_KEY, JSON.stringify(groups));
}
