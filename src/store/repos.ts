import type { Database } from "bun:sqlite";
import type { Flag, RawFill, RawOrder, RawPosition, Trade } from "../domain/types";
import { getConfigValue, LAST_SNAPSHOT_TIME } from "./config";

/** The clock of the current position snapshot, in preference order: the persisted marker; else the
 * latest sync clock from sync_state (backfills a DB migrated before the marker existed — and stays
 * correct even when that last sync was all-flat, which writes NO raw_positions row); else the latest
 * stored snapshot time; else `fallback` (fresh DB). pullRaw stamps snapshots and sync_state with the
 * same `now`, so the sync clock equals the snapshot batch time. Reconciles seeds + "current" holdings. */
export function snapshotClock(db: Database, fallback: number): number {
  const marker = getConfigValue(db, LAST_SNAPSHOT_TIME);
  if (marker !== null) return Number(marker);
  const sync = db.query(`SELECT MAX(last_synced_time) AS t FROM sync_state`).get() as {
    t: number | null;
  };
  if (sync?.t != null) return sync.t;
  const pos = db.query(`SELECT MAX(time) AS t FROM raw_positions`).get() as { t: number | null };
  return pos?.t ?? fallback;
}

// ---- raw_fills ----------------------------------------------------------------

export function upsertRawFills(db: Database, fills: RawFill[]): void {
  const stmt = db.prepare(
    `INSERT INTO raw_fills (id, order_id, symbol, side, qty, price, fee, currency, time, account)
     VALUES ($id, $orderId, $symbol, $side, $qty, $price, $fee, $currency, $time, $account)
     ON CONFLICT(id) DO UPDATE SET
       order_id=$orderId, symbol=$symbol, side=$side, qty=$qty, price=$price, fee=$fee,
       currency=$currency, time=$time, account=$account`,
  );
  db.transaction(() => {
    for (const f of fills) {
      stmt.run({
        $id: f.id, $orderId: f.orderId, $symbol: f.symbol, $side: f.side, $qty: f.qty,
        $price: f.price, $fee: f.fee, $currency: f.currency, $time: f.time, $account: f.account,
      });
    }
  })();
}

export function allRawFills(db: Database): RawFill[] {
  const rows = db
    .query(`SELECT id, order_id, symbol, side, qty, price, fee, currency, time, account
            FROM raw_fills ORDER BY time ASC, id ASC`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id, orderId: r.order_id, symbol: r.symbol, side: r.side, qty: r.qty, price: r.price,
    fee: r.fee, currency: r.currency, time: r.time, account: r.account,
  }));
}

// ---- raw_orders ---------------------------------------------------------------

export function upsertRawOrders(db: Database, orders: RawOrder[]): void {
  const stmt = db.prepare(
    `INSERT INTO raw_orders (id, symbol, side, type, qty, price, trigger_price, status, create_time, update_time, account)
     VALUES ($id, $symbol, $side, $type, $qty, $price, $trigger, $status, $create, $update, $account)
     ON CONFLICT(id) DO UPDATE SET
       symbol=$symbol, side=$side, type=$type, qty=$qty, price=$price, trigger_price=$trigger,
       status=$status, create_time=$create, update_time=$update, account=$account`,
  );
  db.transaction(() => {
    for (const o of orders) {
      stmt.run({
        $id: o.id, $symbol: o.symbol, $side: o.side, $type: o.type, $qty: o.qty,
        $price: o.price, $trigger: o.triggerPrice, $status: o.status,
        $create: o.createTime, $update: o.updateTime, $account: o.account,
      });
    }
  })();
}

export function allRawOrders(db: Database): RawOrder[] {
  const rows = db
    .query(`SELECT id, symbol, side, type, qty, price, trigger_price, status, create_time, update_time, account
            FROM raw_orders ORDER BY create_time ASC, id ASC`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, side: r.side, type: r.type, qty: r.qty, price: r.price,
    triggerPrice: r.trigger_price, status: r.status, createTime: r.create_time,
    updateTime: r.update_time, account: r.account,
  }));
}

// ---- raw_positions ------------------------------------------------------------

export function insertPositionSnapshot(db: Database, rows: RawPosition[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO raw_positions (account, symbol, qty, avg_cost, price, currency, time)
     VALUES ($account, $symbol, $qty, $avgCost, $price, $currency, $time)`,
  );
  db.transaction(() => {
    for (const p of rows) {
      stmt.run({
        $account: p.account, $symbol: p.symbol, $qty: p.qty, $avgCost: p.avgCost,
        $price: p.price, $currency: p.currency, $time: p.time,
      });
    }
  })();
}

/** Position rows recorded at exactly `snapshotTime` — the batch a sync wrote at that instant.
 * The caller owns the timestamp (from its sync clock, also persisted in sync_state), so an
 * all-flat account correctly yields `[]` rather than a stale earlier batch. Deriving "the latest
 * snapshot" from the rows themselves is unsound: an empty snapshot writes no rows, so MAX(time)
 * would silently return the previous, non-empty batch. */
export function positionsAt(db: Database, snapshotTime: number): RawPosition[] {
  const rows = db
    .query(`SELECT account, symbol, qty, avg_cost, price, currency, time FROM raw_positions
            WHERE time = ? ORDER BY account ASC, symbol ASC`)
    .all(snapshotTime) as any[];
  return rows.map((r) => ({
    account: r.account, symbol: r.symbol, qty: r.qty, avgCost: r.avg_cost,
    price: r.price ?? null, currency: r.currency, time: r.time,
  }));
}

// ---- derived: trades + trade_fills + flags ------------------------------------

/** Fully replace all derived data. Derived tables are rebuildable from raw, so each sync
 * wipes and re-writes them in a single transaction — no partial/stale rows can survive. */
export function replaceDerived(db: Database, trades: Trade[], flags: Map<string, Flag[]>): void {
  const insTrade = db.prepare(
    `INSERT INTO trades
       (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry,
        avg_exit, max_qty, realized_pnl, realized_so_far, fees, hold_seconds, coverage_ok,
        effective_stop, live_stop, effective_tp, risk, r_multiple, mae, mfe, stop_unreliable)
     VALUES
       ($id, $account, $symbol, $currency, $direction, $status, $openTime, $closeTime, $avgEntry,
        $avgExit, $maxQty, $realizedPnl, $realizedSoFar, $fees, $holdSeconds, $coverageOk,
        $effectiveStop, $liveStop, $effectiveTp, $risk, $rMultiple, $mae, $mfe, $stopUnreliable)`,
  );
  const insLink = db.prepare(`INSERT INTO trade_fills (trade_id, fill_id) VALUES ($t, $f)`);
  const insFlag = db.prepare(
    `INSERT INTO flags (trade_id, rule_id, severity, reason) VALUES ($t, $rule, $sev, $reason)`,
  );

  db.transaction(() => {
    db.run("DELETE FROM flags;");
    db.run("DELETE FROM trade_fills;");
    db.run("DELETE FROM trades;");
    for (const t of trades) {
      insTrade.run({
        $id: t.id, $account: t.account, $symbol: t.symbol, $currency: t.currency,
        $direction: t.direction, $status: t.status, $openTime: t.openTime, $closeTime: t.closeTime,
        $avgEntry: t.avgEntry, $avgExit: t.avgExit, $maxQty: t.maxQty, $realizedPnl: t.realizedPnl,
        $realizedSoFar: t.realizedSoFar,
        $fees: t.fees, $holdSeconds: t.holdSeconds, $coverageOk: t.coverageOk ? 1 : 0,
        $effectiveStop: t.effectiveStop, $liveStop: t.liveStop, $effectiveTp: t.effectiveTp, $risk: t.risk,
        $rMultiple: t.rMultiple, $mae: t.mae, $mfe: t.mfe,
        $stopUnreliable: t.stopUnreliable ? 1 : 0,
      });
      for (const fid of t.fillIds) insLink.run({ $t: t.id, $f: fid });
      for (const fl of flags.get(t.id) ?? []) {
        insFlag.run({ $t: t.id, $rule: fl.ruleId, $sev: fl.severity, $reason: fl.reason });
      }
    }
  })();
}

export function allTrades(db: Database): Trade[] {
  const rows = db.query(`SELECT * FROM trades ORDER BY open_time ASC, id ASC`).all() as any[];
  // ORDER BY rowid preserves insertion order, which is the builder's chronological fill order
  // (replaceDerived inserts t.fillIds in order). Without it SQLite may return PK-index order.
  const links = db.query(`SELECT trade_id, fill_id FROM trade_fills ORDER BY rowid ASC`).all() as any[];
  const byTrade = new Map<string, string[]>();
  for (const l of links) {
    let arr = byTrade.get(l.trade_id);
    if (!arr) { arr = []; byTrade.set(l.trade_id, arr); }
    arr.push(l.fill_id);
  }
  return rows.map((r) => ({
    id: r.id, account: r.account, symbol: r.symbol, currency: r.currency, direction: r.direction,
    status: r.status, openTime: r.open_time, closeTime: r.close_time, avgEntry: r.avg_entry,
    avgExit: r.avg_exit, maxQty: r.max_qty, realizedPnl: r.realized_pnl, realizedSoFar: r.realized_so_far ?? 0,
    fees: r.fees,
    holdSeconds: r.hold_seconds, coverageOk: r.coverage_ok === 1,
    fillIds: byTrade.get(r.id) ?? [],
    effectiveStop: r.effective_stop, liveStop: r.live_stop, effectiveTp: r.effective_tp, risk: r.risk,
    rMultiple: r.r_multiple, mae: r.mae, mfe: r.mfe,
    stopUnreliable: r.stop_unreliable === 1,
  }));
}

export function flagsForTrade(db: Database, tradeId: string): Flag[] {
  const rows = db
    .query(`SELECT rule_id, severity, reason FROM flags WHERE trade_id = ? ORDER BY rule_id ASC`)
    .all(tradeId) as any[];
  return rows.map((r) => ({ ruleId: r.rule_id, severity: r.severity, reason: r.reason }));
}
