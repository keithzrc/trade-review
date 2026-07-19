import type { Database } from "bun:sqlite";

/** Ordered list of migrations. Append new ones; never edit or reorder shipped entries. */
export const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  // v1 — initial schema
  (db) => {
    db.run(`
      CREATE TABLE raw_fills (
        id TEXT PRIMARY KEY, order_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
        qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL, time INTEGER NOT NULL, account TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE trades (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, symbol TEXT NOT NULL, currency TEXT NOT NULL,
        direction TEXT NOT NULL, status TEXT NOT NULL,
        open_time INTEGER NOT NULL, close_time INTEGER,
        avg_entry REAL NOT NULL, avg_exit REAL, max_qty REAL NOT NULL,
        realized_pnl REAL, fees REAL NOT NULL DEFAULT 0, hold_seconds INTEGER,
        coverage_ok INTEGER NOT NULL DEFAULT 1
      );
    `);
    db.run(`
      CREATE TABLE trade_fills (
        trade_id TEXT NOT NULL, fill_id TEXT NOT NULL,
        PRIMARY KEY (trade_id, fill_id)
      );
    `);
  },
  // v2 — enrichment columns on trades + raw orders/positions + sync state
  (db) => {
    for (const col of [
      "effective_stop REAL",
      "effective_tp REAL",
      "risk REAL",
      "r_multiple REAL",
      "mae REAL",
      "mfe REAL",
    ]) {
      db.run(`ALTER TABLE trades ADD COLUMN ${col};`);
    }
    db.run(`
      CREATE TABLE raw_orders (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, type TEXT NOT NULL,
        qty REAL NOT NULL, price REAL, trigger_price REAL,
        status TEXT NOT NULL, create_time INTEGER NOT NULL, update_time INTEGER, account TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE raw_positions (
        account TEXT NOT NULL, symbol TEXT NOT NULL, qty REAL NOT NULL,
        avg_cost REAL NOT NULL, currency TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (account, symbol, time)
      );
    `);
    db.run(`
      CREATE TABLE sync_state (
        account TEXT NOT NULL, market TEXT NOT NULL,
        last_synced_time INTEGER, coverage_start INTEGER,
        PRIMARY KEY (account, market)
      );
    `);
  },
  // v3 — computed flags + config key/value store
  (db) => {
    db.run(`
      CREATE TABLE flags (
        trade_id TEXT NOT NULL, rule_id TEXT NOT NULL,
        severity TEXT NOT NULL, reason TEXT NOT NULL,
        PRIMARY KEY (trade_id, rule_id)
      );
    `);
    db.run(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
  },
  // v4 — user-written journaling (orphan-tolerant: NO FK to trades, which is rebuilt every sync)
  //      + candle cache (immutable closed bars) with range-coverage bookkeeping.
  (db) => {
    db.run(`
      CREATE TABLE journal (
        trade_id TEXT PRIMARY KEY,
        thesis TEXT, emotion TEXT,
        conviction INTEGER, rating INTEGER,
        notes TEXT, manual_stop REAL, setup TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE journal_tags (
        trade_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY (trade_id, tag)
      );
    `);
    db.run(`
      CREATE TABLE journal_entries (
        id TEXT PRIMARY KEY,            -- ISO week key, e.g. "2026-W28"
        period_start INTEGER NOT NULL,  -- epoch ms, inclusive
        period_end INTEGER NOT NULL,    -- epoch ms, exclusive
        market_read TEXT, traded_vs_plan TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE watchlist_items (
        entry_id TEXT NOT NULL, symbol TEXT NOT NULL,
        note TEXT, key_level REAL,
        PRIMARY KEY (entry_id, symbol)
      );
    `);
    db.run(`
      CREATE TABLE candles_cache (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL, time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol, res_ms, time)
      );
    `);
    db.run(`
      CREATE TABLE candle_coverage (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL,
        from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, res_ms)
      );
    `);
  },
  // v5 — candle_coverage becomes MULTI-INTERVAL: PK (symbol,res_ms,from_ms) so two disjoint fetched
  // windows for the same symbol coexist instead of one overwriting the other. Coverage is a pure
  // cache index (bars live in candles_cache), so dropping/recreating it only re-accumulates on the
  // next fetch — never loses candles.
  (db) => {
    db.run(`DROP TABLE IF EXISTS candle_coverage;`);
    db.run(`
      CREATE TABLE candle_coverage (
        symbol TEXT NOT NULL, res_ms INTEGER NOT NULL,
        from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, res_ms, from_ms)
      );
    `);
  },
  // v6 — account equity snapshots (Trd_GetFunds), per (account, currency) at a snapshot time.
  // Lets a trade's planned risk be shown as a % of account equity. One row per denomination we
  // requested; equity/risk are compared same-currency only (money-math invariant).
  (db) => {
    db.run(`
      CREATE TABLE account_funds (
        account TEXT NOT NULL,
        time INTEGER NOT NULL,
        currency TEXT NOT NULL,
        total_assets REAL NOT NULL,
        cash REAL NOT NULL,
        market_val REAL NOT NULL,
        PRIMARY KEY (account, time, currency)
      );
    `);
  },
  // v7 — per-trade chart drawings (orphan-tolerant: NO FK to trades, which is rebuilt every sync).
  // `data` is our own minimal JSON shape (see Drawing in src/store/drawings.ts), never raw
  // chart-library internals — that keeps the format our contract, not a third party's.
  (db) => {
    db.run(`
      CREATE TABLE chart_drawings (
        trade_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // v8 — capture the current market price FUTU already returns in each position snapshot (we only
  // stored avg cost + qty). Powers unrealized-P&L / R on open positions. Nullable: rows written by an
  // older app, and any snapshot where FUTU omits the price, stay NULL.
  (db) => {
    db.run(`ALTER TABLE raw_positions ADD COLUMN price REAL;`);
  },
  // v9 — persist the LIVE stop (latest still-working protective stop) alongside the effective stop.
  // The effective stop is the latest ever seen and may since have been cancelled; the open-positions
  // risk readout must use the live one so a cancelled stop is never shown as active protection.
  // Derived column: rebuilt every sync from raw orders, so NULL until the next sync re-derives trades.
  (db) => {
    db.run(`ALTER TABLE trades ADD COLUMN live_stop REAL;`);
  },
  // v10 — persist realized-so-far: profit BANKED from partial exits while a trade is still open (the
  // full realized_pnl stays NULL until close). Lets the open-positions cushion count money already taken
  // off the table. Derived column: rebuilt every sync; NULL until re-derived → the reader treats it as 0
  // (degrades to "nothing banked", the prior behavior — safe, unlike the live-stop case).
  (db) => {
    db.run(`ALTER TABLE trades ADD COLUMN realized_so_far REAL;`);
  },
  // v11 — persist the unreliable-stop verdict: the inferred initial stop can't be the real risk basis
  // (price ran past it while the trade was still open — a trailed stop reported by FUTU as the initial
  // trigger). Drives the unreliable_stop flag and the R-average exclusion. Derived column, and
  // deliberately NULLABLE (no DEFAULT): NULL means "not yet re-derived", which the reader treats as
  // reliable (safe — R stays counted) AND which triggers the one-time upgrade rebuild in app.ts (see
  // needsBackfill) so migrated trades re-derive from cached candles instead of showing stale flags.
  (db) => {
    db.run(`ALTER TABLE trades ADD COLUMN stop_unreliable INTEGER;`);
  },
];

export function currentVersion(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const row = db.query("SELECT version FROM schema_version LIMIT 1;").get() as
    | { version: number }
    | null;
  return row?.version ?? 0;
}

function setVersion(db: Database, version: number): void {
  db.run("DELETE FROM schema_version;");
  db.run("INSERT INTO schema_version (version) VALUES (?);", [version]);
}

/** Apply every migration whose 1-based index exceeds the current version. */
export function runMigrations(db: Database): void {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    // An older binary opened a DB written by a newer one (possible with self-update).
    // Refuse rather than run against an unknown schema.
    throw new Error(
      `Database schema version ${from} is newer than this app supports (${MIGRATIONS.length}). Please update the app.`,
    );
  }
  for (let i = from; i < MIGRATIONS.length; i++) {
    const migrate = MIGRATIONS[i]!;
    db.transaction(() => {
      migrate(db);
      setVersion(db, i + 1);
    })();
  }
}
