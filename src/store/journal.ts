import type { Database } from "bun:sqlite";
import type { DailyEntry, Journal, WatchlistItem, WeeklyEntry } from "../domain/journal-types";
import type { Trade } from "../domain/types";
import { allTrades } from "./repos";

// ---- per-trade journal --------------------------------------------------------

export function getJournal(db: Database, tradeId: string): Journal | null {
  const row = db
    .query(
      `SELECT trade_id, thesis, emotion, conviction, rating, notes, manual_stop, setup, updated_at
       FROM journal WHERE trade_id = ?`,
    )
    .get(tradeId) as any;
  if (!row) return null;
  const tags = (
    db.query(`SELECT tag FROM journal_tags WHERE trade_id = ? ORDER BY tag ASC`).all(tradeId) as any[]
  ).map((r) => r.tag as string);
  return {
    tradeId: row.trade_id,
    thesis: row.thesis,
    emotion: row.emotion,
    conviction: row.conviction,
    rating: row.rating,
    notes: row.notes,
    manualStop: row.manual_stop,
    setup: row.setup,
    tags,
    updatedAt: row.updated_at,
  };
}

/** Upsert the journal row and REPLACE its tag set (not append), in one transaction. */
export function upsertJournal(db: Database, j: Journal): void {
  const upsertRow = db.prepare(
    `INSERT INTO journal (trade_id, thesis, emotion, conviction, rating, notes, manual_stop, setup, updated_at)
     VALUES ($id, $thesis, $emotion, $conviction, $rating, $notes, $manualStop, $setup, $updatedAt)
     ON CONFLICT(trade_id) DO UPDATE SET
       thesis=$thesis, emotion=$emotion, conviction=$conviction, rating=$rating, notes=$notes,
       manual_stop=$manualStop, setup=$setup, updated_at=$updatedAt`,
  );
  const delTags = db.prepare(`DELETE FROM journal_tags WHERE trade_id = ?`);
  const insTag = db.prepare(`INSERT OR IGNORE INTO journal_tags (trade_id, tag) VALUES (?, ?)`);
  db.transaction(() => {
    upsertRow.run({
      $id: j.tradeId,
      $thesis: j.thesis,
      $emotion: j.emotion,
      $conviction: j.conviction,
      $rating: j.rating,
      $notes: j.notes,
      $manualStop: j.manualStop,
      $setup: j.setup,
      $updatedAt: j.updatedAt,
    });
    delTags.run(j.tradeId);
    for (const tag of j.tags) insTag.run(j.tradeId, tag);
  })();
}

/** Manual stops keyed by trade id — consumed by rebuildDerived to override inferred stops. */
export function manualStops(db: Database): Map<string, number> {
  const rows = db
    .query(`SELECT trade_id, manual_stop FROM journal WHERE manual_stop IS NOT NULL`)
    .all() as any[];
  return new Map(rows.map((r) => [r.trade_id as string, r.manual_stop as number]));
}

export function distinctSetups(db: Database): string[] {
  return (
    db.query(`SELECT DISTINCT setup FROM journal WHERE setup IS NOT NULL ORDER BY setup ASC`).all() as any[]
  ).map((r) => r.setup as string);
}

export function distinctTags(db: Database): string[] {
  return (db.query(`SELECT DISTINCT tag FROM journal_tags ORDER BY tag ASC`).all() as any[]).map(
    (r) => r.tag as string,
  );
}

export function distinctEmotions(db: Database): string[] {
  return (
    db
      .query(`SELECT DISTINCT emotion FROM journal WHERE emotion IS NOT NULL AND emotion <> '' ORDER BY emotion ASC`)
      .all() as any[]
  ).map((r) => r.emotion as string);
}

// ---- weekly entry + watchlist -------------------------------------------------

export function getWeeklyEntry(db: Database, id: string): WeeklyEntry | null {
  const row = db
    .query(
      `SELECT id, period_start, period_end, market_read, traded_vs_plan, updated_at
       FROM journal_entries WHERE id = ?`,
    )
    .get(id) as any;
  if (!row) return null;
  const watchlist = (
    db
      .query(`SELECT symbol, note, key_level FROM watchlist_items WHERE entry_id = ? ORDER BY symbol ASC`)
      .all(id) as any[]
  ).map((r) => ({ symbol: r.symbol, note: r.note, keyLevel: r.key_level }) as WatchlistItem);
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    marketRead: row.market_read,
    tradedVsPlan: row.traded_vs_plan,
    watchlist,
    updatedAt: row.updated_at,
  };
}

export function upsertWeeklyEntry(db: Database, w: WeeklyEntry): void {
  const upsertRow = db.prepare(
    `INSERT INTO journal_entries (id, period_start, period_end, market_read, traded_vs_plan, updated_at)
     VALUES ($id, $start, $end, $marketRead, $tradedVsPlan, $updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       period_start=$start, period_end=$end, market_read=$marketRead,
       traded_vs_plan=$tradedVsPlan, updated_at=$updatedAt`,
  );
  const delItems = db.prepare(`DELETE FROM watchlist_items WHERE entry_id = ?`);
  const insItem = db.prepare(
    `INSERT OR IGNORE INTO watchlist_items (entry_id, symbol, note, key_level) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    upsertRow.run({
      $id: w.id,
      $start: w.periodStart,
      $end: w.periodEnd,
      $marketRead: w.marketRead,
      $tradedVsPlan: w.tradedVsPlan,
      $updatedAt: w.updatedAt,
    });
    delItems.run(w.id);
    for (const item of w.watchlist) insItem.run(w.id, item.symbol, item.note, item.keyLevel);
  })();
}

/** Trades whose open OR close falls in [startMs, endMs). Reuses allTrades' tested row mapper. */
export function tradesInRange(db: Database, startMs: number, endMs: number): Trade[] {
  return allTrades(db).filter(
    (t) =>
      (t.openTime >= startMs && t.openTime < endMs) ||
      (t.closeTime !== null && t.closeTime >= startMs && t.closeTime < endMs),
  );
}

// ---- daily entry --------------------------------------------------------------
// The snapshot stays a raw JSON string at this layer (parsed/validated at the API edge) — the store
// doesn't care about its shape, and re-serializing on every read would be wasted work.

export interface DailyEntryRow extends DailyEntry {
  snapshotJson: string | null;
}

export function getDailyEntry(db: Database, id: string): DailyEntryRow | null {
  const row = db
    .query(
      `SELECT id, regime, market_read, notes, snapshot, snapshot_at, updated_at
       FROM daily_entries WHERE id = ?`,
    )
    .get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    regime: row.regime,
    marketRead: row.market_read,
    notes: row.notes,
    snapshotJson: row.snapshot,
    snapshotAt: row.snapshot_at,
    updatedAt: row.updated_at,
  };
}

export function upsertDailyEntry(db: Database, e: DailyEntryRow): void {
  db.run(
    `INSERT INTO daily_entries (id, regime, market_read, notes, snapshot, snapshot_at, updated_at)
     VALUES ($id, $regime, $read, $notes, $snap, $snapAt, $updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       regime=$regime, market_read=$read, notes=$notes, snapshot=$snap, snapshot_at=$snapAt,
       updated_at=$updatedAt`,
    {
      $id: e.id,
      $regime: e.regime,
      $read: e.marketRead,
      $notes: e.notes,
      $snap: e.snapshotJson,
      $snapAt: e.snapshotAt,
      $updatedAt: e.updatedAt,
    } as any,
  );
}
