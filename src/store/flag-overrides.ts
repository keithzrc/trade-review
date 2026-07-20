// User flag overrides: per-trade "dismiss this computed flag" / "add this flag manually".
// USER data (like journal/drawings) — lives apart from the derived `flags` table, which every sync
// rebuild deletes and reinserts. flagsForTrade (store/repos) merges these at read time, so every
// consumer (trade lists, detail, weekly rows, dashboard flagged list) sees the overridden set.
import type { Database } from "bun:sqlite";

export interface FlagOverrides {
  added: string[]; // rule ids flagged manually
  dismissed: string[]; // computed rule ids the user rejected
}

export function getFlagOverrides(db: Database, tradeId: string): FlagOverrides {
  const rows = db
    .query(`SELECT rule_id, mode FROM flag_overrides WHERE trade_id = ? ORDER BY rule_id ASC`)
    .all(tradeId) as Array<{ rule_id: string; mode: string }>;
  return {
    added: rows.filter((r) => r.mode === "add").map((r) => r.rule_id),
    dismissed: rows.filter((r) => r.mode === "dismiss").map((r) => r.rule_id),
  };
}

/** Replace-set for one trade (same write pattern as journal tags). A rule id can't be both added and
 * dismissed — the PK enforces one mode per (trade, rule); the API validates before calling. */
export function setFlagOverrides(db: Database, tradeId: string, ov: FlagOverrides, updatedAt: number): void {
  db.transaction(() => {
    db.run(`DELETE FROM flag_overrides WHERE trade_id = ?`, [tradeId]);
    const ins = db.prepare(
      `INSERT INTO flag_overrides (trade_id, rule_id, mode, updated_at) VALUES (?, ?, ?, ?)`,
    );
    for (const id of ov.added) ins.run(tradeId, id, "add", updatedAt);
    for (const id of ov.dismissed) ins.run(tradeId, id, "dismiss", updatedAt);
  })();
}
