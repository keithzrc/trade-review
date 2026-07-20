import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { openPositions, openPositionsByCurrency, metaView, latestSnapshotTime, tradeDetail, tradeSizing } from "../../src/api/views";
import { allTrades, insertPositionSnapshot } from "../../src/store/repos";
import { insertFunds } from "../../src/store/funds";
import { setConfigValue, LAST_SNAPSHOT_TIME } from "../../src/store/config";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

test("openPositions joins snapshot + open trade and computes open risk per currency", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
  ]);
  const pos = openPositions(d, 5000);
  expect(pos).toHaveLength(1);
  expect(pos[0]!.currency).toBe("USD");
  expect(pos[0]!.openRisk).toBeCloseTo(50); // (100-95)*10
});

test("openPositions leaves open risk null when the open trade has no effective stop", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
  ]);
  expect(openPositions(d, 5000)[0]!.openRisk).toBeNull();
});

test("openPositions: a stop above entry is a free trade — zero open risk, locked profit, R cushion + unrealized R", () => {
  const d = db();
  // Entry 100, stop 103 (above entry → locked profit), initial risk (1R) = 50, current price 110.
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.SNOW','USD','LONG','open', 1000, 100, 10, 0, 1, 103, 50)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.SNOW", qty: 10, avgCost: 100, price: 110, currency: "USD", time: 5000 },
  ]);
  const p = openPositions(d, 5000)[0]!;
  expect(p.openRisk).toBe(0); // the bug fix: stop above entry ⇒ no downside risk
  expect(p.lockedProfit).toBeCloseTo(30); // (103-100)*10
  expect(p.freeTrade).toBe(true);
  expect(p.cushionR).toBeCloseTo(0.6); // +30 / 50
  expect(p.unrealized).toBeCloseTo(100); // (110-100)*10
  expect(p.totalPnlR).toBeCloseTo(2); // 100 / 50
});

test("openPositionsByCurrency: rTotals sum open-risk and unrealized in R across currencies", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.SNOW','USD','LONG','open', 1000, 100, 10, 0, 1, 103, 50)`, // free trade, +2R unrealized
  );
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t2','a','HK.700','HKD','LONG','open', 1000, 100, 10, 0, 1, 95, 50)`, // -1R at risk, flat
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.SNOW", qty: 10, avgCost: 100, price: 110, currency: "USD", time: 5000 },
    { account: "a", symbol: "HK.700", qty: 10, avgCost: 100, price: 100, currency: "HKD", time: 5000 },
  ]);
  const { rTotals } = openPositionsByCurrency(d, 5000);
  expect(rTotals.openRisk).toBeCloseTo(1); // USD free(0) + HKD at-risk(1R)
  expect(rTotals.totalPnl).toBeCloseTo(2); // USD +2R + HKD 0R
});

test("openPositions uses the LIVE stop — a cancelled stop (effective but not live) is not shown as protection", () => {
  const d = db();
  // effective_stop 103 was the last stop ever seen, but it was cancelled → live_stop is NULL. The live
  // readout must treat this position as UNPROTECTED, never as a free trade with zero downside risk.
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, effective_stop, live_stop, risk)
     VALUES ('t1','a','US.SNOW','USD','LONG','open', 1000, 100, 10, 0, 1, 103, NULL, 50)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.SNOW", qty: 10, avgCost: 100, price: 110, currency: "USD", time: 5000 },
  ]);
  const p = openPositions(d, 5000)[0]!;
  expect(p.liveStop).toBeNull();
  expect(p.stopOutcome).toBeNull(); // no working stop ⇒ outcome-if-stopped is unknown, not zero
  expect(p.openRisk).toBeNull();
  expect(p.freeTrade).toBe(false); // the bug: a cancelled profit-side stop must NOT read as FREE
});

test("rTotals flags unprotected positions excluded from the whole-book R risk total (no silent partial)", () => {
  const d = db();
  // One protected at −1R, one UNPROTECTED (no live stop) — the scariest case, yet it can't enter the
  // R total. The total must not be presented as the whole book; the count of omissions is surfaced.
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95, 50)`, // −1R at risk
  );
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, risk)
     VALUES ('t2','a','US.TSLA','USD','LONG','open', 1000, 200, 5, 0, 1, 40)`, // no stop at all → unprotected
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
    { account: "a", symbol: "US.TSLA", qty: 5, avgCost: 200, price: null, currency: "USD", time: 5000 },
  ]);
  const { rTotals, byCurrency } = openPositionsByCurrency(d, 5000);
  expect(rTotals.openRisk).toBeCloseTo(1); // only the protected −1R position; NOT the whole book
  expect(rTotals.unprotected).toBe(1); // the caveat: one unprotected position is omitted
  expect(rTotals.openRiskOmitted).toBe(1); // stopOutcomeR unknown for that row → excluded from openRisk
  expect(byCurrency[0]!.positionsWithoutStop).toBe(1); // surfaced per-currency too
});

test("R total omissions distinguish no-stop (unprotected) from no-1R basis, and no-price from no-1R", () => {
  const d = db();
  // p1 AAPL: fully known (stop 95, risk 50, price 100). p2 MSFT: stop 190 but NO 1R basis (risk null),
  // yet a KNOWN price 210 → excluded from BOTH R totals for lack of 1R, NOT for a missing price. p3
  // TSLA: no stop (unprotected) and no price.
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95, 50),
            ('t2','a','US.MSFT','USD','LONG','open', 1000, 200, 5, 0, 1, 190, NULL)`,
  );
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, risk)
     VALUES ('t3','a','US.TSLA','USD','LONG','open', 1000, 300, 2, 0, 1, 60)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: 100, currency: "USD", time: 5000 },
    { account: "a", symbol: "US.MSFT", qty: 5, avgCost: 200, price: 210, currency: "USD", time: 5000 }, // KNOWN price
    { account: "a", symbol: "US.TSLA", qty: 2, avgCost: 300, price: null, currency: "USD", time: 5000 },
  ]);
  const { rTotals } = openPositionsByCurrency(d, 5000);
  expect(rTotals.unprotected).toBe(1); // only TSLA has no live stop
  expect(rTotals.openRiskOmitted).toBe(2); // TSLA (no stop) + MSFT (stop but no 1R) both drop from openRisk
  // unrealizedOmitted = MSFT (no 1R, though price known) + TSLA (no price) — so it is NOT "missing price":
  expect(rTotals.totalPnlOmitted).toBe(2);
});

test("openPositionsByCurrency totals open risk and computes risk % of latest equity, per currency", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
  ]);
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 5000 });
  const { byCurrency } = openPositionsByCurrency(d, 5000);
  expect(byCurrency).toHaveLength(1);
  expect(byCurrency[0]!.totalOpenRisk).toBeCloseTo(50); // (100-95)*10
  expect(byCurrency[0]!.equity).toBe(10_000);
  expect(byCurrency[0]!.riskPct).toBeCloseTo(0.005); // 50 / 10000
  expect(byCurrency[0]!.deployed).toBeCloseTo(1000); // 10 × 100 avg cost
  expect(byCurrency[0]!.deployedPct).toBeCloseTo(0.1); // 1000 / 10000 = 10% of equity
});

test("openPositionsByCurrency leaves % null when a contributing account lacks equity (no partial denominator)", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95),
            ('t2','b','US.MSFT','USD','LONG','open', 1000, 200, 5, 0, 1, 190)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
    { account: "b", symbol: "US.MSFT", qty: 5, avgCost: 200, price: null, currency: "USD", time: 5000 },
  ]);
  // Only account a has equity; account b (same USD group) does not → denominator incomplete.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 5000 });
  const { byCurrency } = openPositionsByCurrency(d, 5000);
  const usd = byCurrency.find((c) => c.currency === "USD")!;
  expect(usd.deployed).toBeCloseTo(2000); // 10×100 + 5×200 — full exposure still reported
  expect(usd.equity).toBeNull(); // incomplete → not a partial sum
  expect(usd.deployedPct).toBeNull();
  expect(usd.riskPct).toBeNull();
});

test("openPositionsByCurrency leaves risk % null when no equity snapshot exists", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
  ]);
  const { byCurrency } = openPositionsByCurrency(d, 5000);
  expect(byCurrency[0]!.totalOpenRisk).toBeCloseTo(50);
  expect(byCurrency[0]!.equity).toBeNull();
  expect(byCurrency[0]!.riskPct).toBeNull();
});

test("openPositions expresses each position's if-stopped outcome and P&L as % of its account equity", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95, 50)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: 110, currency: "USD", time: 5000 },
  ]);
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 5000 });
  const p = openPositions(d, 5000)[0]!;
  expect(p.accountEquity).toBe(10_000);
  expect(p.cushionPct).toBeCloseTo(-0.005); // stopOutcome (95−100)×10 = −50 / 10000 = 0.5% at risk
  expect(p.totalPnlPct).toBeCloseTo(0.01); // unrealized (110−100)×10 = 100 / 10000 = +1%
});

test("openPositions leaves % of account null when the account has no equity snapshot", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
  ]);
  const p = openPositions(d, 5000)[0]!;
  expect(p.accountEquity).toBeNull();
  expect(p.cushionPct).toBeNull(); // no denominator → no %, never a partial/guessed figure
});

test("tradeSizing: position size as % of account equity, with basis fallback (none → latest → at_open)", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1, 95, 50, 2)`,
  );
  const trade = allTrades(d)[0]!;

  // No funds → no denominator.
  const none = tradeSizing(d, trade);
  expect(none.equityBasis).toBe("none");
  expect(none.sizePct).toBeNull();
  expect(none.riskPct).toBeNull();
  expect(none.positionSize).toBeCloseTo(1000); // 100 × 10
  // Return % needs no equity — it's P&L over capital committed, so it's known even with basis "none".
  expect(none.returnPct).toBeCloseTo(0.1); // realizedPnl 100 / positionSize 1000

  // Snapshot AFTER the open (t=1500 > 1000) → approximate "latest" basis.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 20_000, cash: 0, marketVal: 0, time: 1500 });
  const latest = tradeSizing(d, trade);
  expect(latest.equityBasis).toBe("latest");
  expect(latest.sizePct).toBeCloseTo(0.05); // 1000 / 20000

  // Snapshot at/before the open → precise "at_open" basis takes precedence.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 900 });
  const atOpen = tradeSizing(d, trade);
  expect(atOpen.equityBasis).toBe("at_open");
  expect(atOpen.sizePct).toBeCloseTo(0.1); // 1000 / 10000
  expect(atOpen.riskPct).toBeCloseTo(0.005); // 50 / 10000
});

test("tradeSizing: returnPct is P&L over capital committed, direction-agnostic, null while open", () => {
  const d = db();
  // Winning SHORT (the reported screenshot case): entry 4.05, covered 3.79, tiny 25-share sliver.
  // realizedPnl already carries direction, so returnPct just divides it by positionSize (4.05 × 25).
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('s1','a','US.SOXS','USD','SHORT','closed', 1000, 2000, 4.05, 3.79, 25, 6.5, 0, 1, NULL, NULL, NULL)`,
  );
  const short = allTrades(d).find((t) => t.id === "s1")!;
  expect(tradeSizing(d, short).returnPct).toBeCloseTo(6.5 / (4.05 * 25)); // ≈ +6.4%, tracks the price move

  // Still-open trade has no realizedPnl → no return yet.
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('o1','a','US.AAPL','USD','LONG','open', 1000, NULL, 100, NULL, 10, NULL, 0, 1, NULL, NULL, NULL)`,
  );
  const open = allTrades(d).find((t) => t.id === "o1")!;
  expect(tradeSizing(d, open).returnPct).toBeNull();
});

test("tradeDetail expresses planned risk as % of equity at open (same currency), null without a snapshot", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1, 95, 50, 2)`,
  );
  // No funds yet → riskPct null, basis "none".
  const bare = tradeDetail(d, "t1")!;
  expect(bare.riskPct).toBeNull();
  expect(bare.equityBasis).toBe("none");
  // Snapshot BEFORE open (t=900 < 1000) → precise "at_open" basis.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 900 });
  const det = tradeDetail(d, "t1")!;
  expect(det.accountEquity).toBe(10_000);
  expect(det.equityBasis).toBe("at_open");
  expect(det.riskPct).toBeCloseTo(0.005); // risk 50 / equity 10000
  expect(det.positionSize).toBeCloseTo(1000); // avgEntry 100 × maxQty 10
  expect(det.sizePct).toBeCloseTo(0.1); // 1000 / 10000 = 10% of the account
});

test("tradeDetail falls back to latest equity (approximate) when none precedes the open", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok, effective_stop, risk, r_multiple)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1, 95, 50, 2)`,
  );
  // Only a snapshot AFTER the open exists → no at-open equity, approximate with latest.
  insertFunds(d, { account: "a", currency: "USD", totalAssets: 20_000, cash: 0, marketVal: 0, time: 5000 });
  const det = tradeDetail(d, "t1")!;
  expect(det.equityBasis).toBe("latest");
  expect(det.accountEquity).toBe(20_000);
  expect(det.riskPct).toBeCloseTo(50 / 20_000);
});

test("tradeDetail reports the current holding from the latest snapshot for an open trade", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop, risk)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95, 50)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 6, avgCost: 100, price: null, currency: "USD", time: 5000 }, // scaled out to 6
  ]);
  const det = tradeDetail(d, "t1")!;
  expect(det.currentQty).toBe(6); // from the snapshot, NOT max_qty (10)
  expect(det.positionAsOf).toBe(5000);
});

test("tradeDetail current holding is 0 for a closed trade and when no snapshot matches", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, close_time, avg_entry, avg_exit, max_qty, realized_pnl, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 2000, 100, 110, 10, 100, 0, 1)`,
  );
  // A snapshot exists for a DIFFERENT symbol; the closed trade must still report flat.
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.MSFT", qty: 3, avgCost: 300, price: null, currency: "USD", time: 5000 },
  ]);
  expect(tradeDetail(d, "t1")!.currentQty).toBe(0);
});

test("latestSnapshotTime prefers the marker, backfilling from stored snapshots when it's absent", () => {
  const d = db();
  // Migrated (pre-marker) DB: no marker, but raw_positions has the last sync batch → use MAX(time).
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 1, avgCost: 1, price: null, currency: "USD", time: 4000 },
  ]);
  expect(latestSnapshotTime(d)).toBe(4000);
  // A migrated DB whose LAST sync was all-flat wrote no raw_positions row for that batch — prefer the
  // sync clock (sync_state) so we don't resurrect the older non-empty snapshot at t=4000.
  d.run(
    `INSERT INTO sync_state (account, market, last_synced_time, coverage_start) VALUES ('a','US',7000,0)`,
  );
  expect(latestSnapshotTime(d)).toBe(7000);
  // Once a sync writes the marker, it wins (so an all-flat sync can report zero holdings).
  setConfigValue(d, LAST_SNAPSHOT_TIME, "9000");
  expect(latestSnapshotTime(d)).toBe(9000);
});

test("metaView surfaces currencies, setups, tags, accounts, coverage window", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok)
     VALUES ('t1','a','US.AAPL','USD','LONG','closed', 1000, 100, 10, 0, 1)`,
  );
  d.run(`INSERT INTO journal (trade_id, setup, emotion, updated_at) VALUES ('t1','breakout','FOMO',1)`);
  d.run(`INSERT INTO journal_tags (trade_id, tag) VALUES ('t1','earnings')`);
  const m = metaView(d);
  expect(m.currencies).toContain("USD");
  expect(m.setups).toContain("breakout");
  expect(m.tags).toContain("earnings");
  expect(m.emotions).toContain("FOMO"); // fed the emotion datalist / quick-pick chips
  expect(m.accounts).toContain("a");
  expect(typeof m.appVersion).toBe("string");
});

test("openPositions carries the open trade's id so the row can deep-link to its detail page", () => {
  const d = db();
  d.run(
    `INSERT INTO trades (id, account, symbol, currency, direction, status, open_time, avg_entry, max_qty, fees, coverage_ok, live_stop)
     VALUES ('t1','a','US.AAPL','USD','LONG','open', 1000, 100, 10, 0, 1, 95)`,
  );
  insertPositionSnapshot(d, [
    { account: "a", symbol: "US.AAPL", qty: 10, avgCost: 100, price: null, currency: "USD", time: 5000 },
    { account: "a", symbol: "US.NVDA", qty: 5, avgCost: 500, price: null, currency: "USD", time: 5000 }, // no trade → null
  ]);
  const pos = openPositions(d, 5000);
  expect(pos.find((p) => p.symbol === "US.AAPL")!.tradeId).toBe("t1");
  expect(pos.find((p) => p.symbol === "US.NVDA")!.tradeId).toBeNull();
});
