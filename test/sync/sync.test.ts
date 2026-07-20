import { test, expect } from "bun:test";
import { openTestDb } from "../helpers";
import { runSync, deriveSeeds } from "../../src/sync/sync";
import type { RawFill, RawPosition } from "../../src/domain/types";
import { DEFAULT_RULE_CONFIG, type Candle } from "../../src/domain/types";
import type { Account, CandleSource, FutuClient } from "../../src/domain/ports";
import { allTrades, flagsForTrade, positionsAt } from "../../src/store/repos";
import { getSyncState } from "../../src/store/sync-state";
import { upsertJournal } from "../../src/store/journal";
import { tradeDetail } from "../../src/api/views";

const ACC: Account = { id: "acc1", trdEnv: 1, markets: [2] };

function stubClient(over: Partial<FutuClient> = {}): FutuClient {
  return {
    getAccounts: async () => [ACC],
    getHistoryFills: async () => [],
    getHistoryOrders: async () => [],
    getPositions: async () => [],
    getFunds: async () => null,
    close: () => {},
    ...over,
  };
}
const noCandles: CandleSource = { getCandles: async () => [] };

test("runSync pulls fills, rebuilds a closed round-trip trade, persists it", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  const res = await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.trades).toBe(1);
  expect(res.fills).toBe(2);
  const t = allTrades(db)[0]!;
  expect(t.status).toBe("closed");
  expect(t.realizedPnl).toBe(200);
  const s = getSyncState(db, "acc1", "US")!; // market 2 → "US"
  expect(s.lastSyncedTime).toBe(10_000);
});

test("runSync enriches stop/risk from orders and MAE/MFE from candles", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 11, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 9, status: "SUBMITTED", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    getCandles: async (): Promise<Candle[]> => [
      // 1h bar (start 1000) sits fully inside the 2h hold [1000, 7.2M) → high 13 → mfe 3; low 8 → mae 2.
      { time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 },
    ],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.effectiveStop).toBe(9);
  expect(t.risk).toBe(100); // |10-9| * 100
  expect(t.rMultiple).toBeCloseTo(1, 5); // pnl 100 / risk 100
  expect(t.mae).toBe(2);
  expect(t.mfe).toBe(3);
});

test("runSync flags unreliable_stop (R kept visible, suppresses R-based flags) when price ran past the stop mid-hold and the trade survived", async () => {
  // AMD shape: tiny inferred stop (0.2 below entry); price fell to 90 in a bar that CLOSED during the
  // hold (a survived breach), then the trade exited later at 98. heldMae 10 ≫ the 0.2 stop → unreliable.
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 98, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 99.8, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    // Fill-free 1h bar [3.6M, 7.2M) closes inside the 2h hold (entry@1000, exit@7.2M are in other
    // bars) → its low 90 is a clean mid-hold breach of the 99.8 stop.
    getCandles: async (): Promise<Candle[]> => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 98, volume: 1 }],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.effectiveStop).toBe(99.8); // the stop is still recorded/drawn
  expect(t.risk).toBeCloseTo(20, 5); // |100-99.8| * 100 — still computed and shown per-trade
  expect(t.rMultiple).toBeCloseTo(-10, 5); // −200 / 20 — visible, but flagged suspect
  expect(t.stopUnreliable).toBe(true); // drives the flag + the R-average exclusion downstream
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).toContain("unreliable_stop");
  expect(flags).not.toContain("no_stop"); // risk is non-null, so no_stop never applies
  expect(flags).not.toContain("excess_loss"); // suppressed: the −10R risk basis isn't trusted
});

test("runSync keeps R/excess_loss for a stop-out (incl. split-fill) whose low is in the EXIT bar", async () => {
  // The stop fires at the end and liquidates in two prints (90 then 97). The adverse low lives in the
  // EXIT bar; the only mid-hold bar never breached the stop → heldMae stays shallow → R is kept. This
  // is the case exit-price comparisons misread (the 97 print looks like a recovery) but timing doesn't.
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "s1", symbol: "US.AAPL", side: "SELL", qty: 50, price: 90, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
      { id: "f3", orderId: "s1", symbol: "US.AAPL", side: "SELL", qty: 50, price: 97, fee: 0, currency: "USD", time: 7_200_001, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 98, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    // Mid-hold bar (low 99, no breach of the 98 stop); the drop to 90 is in the straddling exit bar.
    getCandles: async (): Promise<Candle[]> => [
      { time: 1000, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: 7_200_000, open: 97, high: 97, low: 90, close: 97, volume: 1 },
    ],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.risk).toBe(200); // |100-98| * 100 — NOT voided
  expect(t.rMultiple).toBeCloseTo(-3.25, 5); // pnl (4500+4850-10000) = -650 / 200
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).toContain("excess_loss");
  expect(flags).not.toContain("unreliable_stop");
});

test("runSync carries the unreliable-stop flag across a candle outage (no transient flag flicker)", async () => {
  const db = openTestDb();
  const fills = [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 98, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
  ];
  const orders = [
    { id: "s1", symbol: "US.AAPL", side: "SELL" as const, type: "STOP" as const, qty: 100, price: null, triggerPrice: 99.8, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
  ];
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 98, volume: 1 }],
  };
  // sync 1: candles present → stop judged unreliable (R stays visible, but flagged).
  await runSync({ db, client: stubClient({ getHistoryFills: async () => fills, getHistoryOrders: async () => orders }), candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(allTrades(db)[0]!.stopUnreliable).toBe(true);
  // sync 2: candle outage (no bars) on the unchanged trade → the flag (and its R-average exclusion)
  // must persist, not flicker off until candles return. R remains visible throughout.
  await runSync({ db, client: stubClient({ getHistoryFills: async () => fills, getHistoryOrders: async () => orders }), candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.stopUnreliable).toBe(true);
  expect(t.risk).toBeCloseTo(20, 5); // still shown, not nulled by the outage
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).toContain("unreliable_stop");
  expect(flags).not.toContain("no_stop");
  expect(flags).not.toContain("excess_loss");
});

test("a manual stop clears the unreliable flag even during a candle outage (carry must not override it)", async () => {
  const db = openTestDb();
  const fills = [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 98, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
  ];
  const orders = [
    { id: "s1", symbol: "US.AAPL", side: "SELL" as const, type: "STOP" as const, qty: 100, price: null, triggerPrice: 99.8, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
  ];
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 98, volume: 1 }],
  };
  // sync 1: candles present → unreliable.
  const client = stubClient({ getHistoryFills: async () => fills, getHistoryOrders: async () => orders });
  await runSync({ db, client, candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const id = allTrades(db)[0]!.id;
  expect(allTrades(db)[0]!.stopUnreliable).toBe(true);
  // The user asserts the real stop via a Manual override — set to the SAME price as the effective stop,
  // the exact case where the outage carry (keyed on effectiveStop) could wrongly keep the flag stuck.
  upsertJournal(db, {
    tradeId: id, thesis: null, emotion: null, conviction: null, rating: null,
    notes: null, manualStop: 99.8, setup: null, tags: [], updatedAt: 1,
  });
  // sync 2: candle outage. The manual stop is authoritative → the flag must clear NOW, not wait for candles.
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.stopUnreliable).toBe(false); // manual override wins over the carry
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).not.toContain("unreliable_stop");
  // With the user's own stop honored, the −10R loss is now a genuine excess_loss by their own basis.
  expect(flags).toContain("excess_loss");
});

test("the outage carry re-checks losers-only: a fee correction flipping a loser to a winner clears the flag", async () => {
  // sameInputs doesn't cover fees/realizedPnl, so a fee-only correction leaves it true. The carry must
  // still drop the flag once the trade is no longer a loser — otherwise a winner keeps a bogus
  // unreliable_stop and loses its R from the aggregates. Small loser: gross +5, fee 10 → −5.
  const db = openTestDb();
  const entry = { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" };
  const exitLoser = { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 100.05, fee: 10, currency: "USD", time: 7_200_000, account: "acc1" };
  const orders = [
    { id: "s1", symbol: "US.AAPL", side: "SELL" as const, type: "STOP" as const, qty: 100, price: null, triggerPrice: 99.8, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
  ];
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 98, volume: 1 }],
  };
  // sync 1: candles present, small loser → unreliable.
  await runSync({ db, client: stubClient({ getHistoryFills: async () => [entry, exitLoser], getHistoryOrders: async () => orders }), candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(allTrades(db)[0]!.stopUnreliable).toBe(true);
  // sync 2: candle outage, and a fee CORRECTION (same fill id, fee 10 → 0) flips gross +5 into a +5
  // winner. avgEntry/avgExit/qty/fills are unchanged → sameInputs stays true, so only the losers-only
  // recheck can catch this.
  const exitWinner = { ...exitLoser, fee: 0 };
  await runSync({ db, client: stubClient({ getHistoryFills: async () => [entry, exitWinner], getHistoryOrders: async () => orders }), candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.realizedPnl).toBeCloseTo(5, 5); // now a winner
  expect(t.stopUnreliable).toBe(false); // carry dropped — not a loser anymore
  expect(flagsForTrade(db, t.id).map((f) => f.ruleId)).not.toContain("unreliable_stop");
});

test("a profit-side stop (no valid R) is never marked unreliable — no_stop fires, not unreliable_stop", async () => {
  // A losing LONG whose only inferred stop sits ABOVE entry (split-corrupted / un-adjusted): computeRisk
  // returns null (no loss-side basis). Price dips below entry mid-hold, which |avgEntry−stop| distance
  // alone could trip — but with no real R there's nothing suspect to flag. Must fall through to no_stop.
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 98, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      // Stop trigger 102 is ABOVE the 100 entry → profit-side → risk null.
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 102, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    // Mid-hold bar closes at 90 — a deep move below entry, but there is no valid stop distance to breach.
    getCandles: async () => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 92, volume: 1 }],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.risk).toBeNull(); // profit-side stop → no R basis
  expect(t.stopUnreliable).toBe(false); // ...so nothing to flag as suspect
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).toContain("no_stop");
  expect(flags).not.toContain("unreliable_stop"); // never both
});

test("a STOP_LIMIT initial stop is never marked unreliable — a gap-through is a genuine excess_loss", async () => {
  // Same breach-and-survive shape as the unreliable case, but the protective order is a STOP_LIMIT: it
  // can trigger yet fail to fill when price gaps past its limit, so the recorded 99.8 trigger really can
  // be the initial stop and the −10R a legitimate excess loss. Must keep R + fire excess_loss, not flag.
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 100, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 98, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP_LIMIT", qty: 100, price: 99.8, triggerPrice: 99.8, status: "FILLED_ALL", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  const candles: CandleSource = {
    getCandles: async () => [{ time: 3_600_000, open: 100, high: 101, low: 90, close: 98, volume: 1 }],
  };
  await runSync({ db, client, candles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.stopUnreliable).toBe(false); // stop-limit gap-through is not proof of a moved stop
  expect(t.risk).toBeCloseTo(20, 5); // R basis kept
  const flags = flagsForTrade(db, t.id).map((f) => f.ruleId);
  expect(flags).not.toContain("unreliable_stop");
  expect(flags).toContain("excess_loss"); // the −10R loss is real by this stop
});

test("runSync snapshots account equity per currency and surfaces trade risk %", async () => {
  const db = openTestDb();
  const fundsCalls: Array<{ currency: number }> = [];
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 11, fee: 0, currency: "USD", time: 5000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 9, status: "SUBMITTED", createTime: 1500, updateTime: null, account: "acc1" },
    ],
    getFunds: async (_acc, _mkt, currency) => {
      fundsCalls.push({ currency });
      return { account: "acc1", currency: "USD", totalAssets: 10_000, cash: 0, marketVal: 0, time: 0 };
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(fundsCalls).toEqual([{ currency: 2 }]); // US market → USD enum 2, requested once
  const row = db.query(`SELECT account, currency, total_assets, time FROM account_funds`).get() as any;
  expect(row).toEqual({ account: "acc1", currency: "USD", total_assets: 10_000, time: 10_000 }); // stamped snapshot clock
  const t = allTrades(db)[0]!;
  const det = tradeDetail(db, t.id)!;
  // Trade opened (t=1000) before this sync's equity snapshot (t=10_000), so no at-open equity —
  // falls back to the latest snapshot, flagged approximate.
  expect(det.equityBasis).toBe("latest");
  expect(det.riskPct).toBeCloseTo(100 / 10_000); // risk 100 / equity 10k = 1%
});

test("runSync tolerates a getFunds failure without aborting the sync", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 11, fee: 0, currency: "USD", time: 5000, account: "acc1" },
    ],
    getFunds: async () => {
      throw new Error("OpenD funds unavailable");
    },
  });
  const res = await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.trades).toBe(1); // sync completed
  expect(db.query(`SELECT COUNT(*) c FROM account_funds`).get()).toEqual({ c: 0 }); // no equity, risk-% absent
});

test("runSync fires a mistake flag through the full pipeline", async () => {
  const db = openTestDb();
  // A winner cut for < 1R (risk 100, exit +40 → 0.4R) → cut_winner_early.
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 10.4, fee: 0, currency: "USD", time: 5000, account: "acc1" },
    ],
    getHistoryOrders: async () => [
      { id: "s1", symbol: "US.AAPL", side: "SELL", type: "STOP", qty: 100, price: null, triggerPrice: 9, status: "SUBMITTED", createTime: 1500, updateTime: null, account: "acc1" },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(flagsForTrade(db, t.id).map((f) => f.ruleId)).toContain("cut_winner_early");
});

test("runSync writes an empty position snapshot for a flat account (no phantom holdings)", async () => {
  const db = openTestDb();
  await runSync({ db, client: stubClient(), candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(positionsAt(db, 10_000)).toEqual([]);
});

test("runSync snapshots current positions at the sync clock", async () => {
  const db = openTestDb();
  const client = stubClient({
    getPositions: async () => [
      { account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, price: null, currency: "USD", time: 0 },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const held = positionsAt(db, 10_000);
  expect(held).toEqual([{ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, price: null, currency: "USD", time: 10_000 }]);
});

test("runSync is incremental — second run pulls from the last cursor", async () => {
  const db = openTestDb();
  const seen: number[] = [];
  const client = stubClient({
    getHistoryFills: async (_a, _m, begin) => {
      seen.push(begin);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 100_000, historyDays: 1 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 200_000, historyDays: 1 });
  expect(seen[0]).toBe(100_000 - 86_400_000); // first: now - 1 day
  expect(seen[1]).toBe(100_000); // second: last cursor
});

test("runSync skips simulate accounts (only trdEnv real is queried)", async () => {
  const db = openTestDb();
  const queried: string[] = [];
  const client: FutuClient = {
    getAccounts: async () => [
      { id: "real", trdEnv: 1, markets: [2] },
      { id: "sim", trdEnv: 0, markets: [2] },
    ],
    getHistoryFills: async (a) => {
      queried.push(a.id);
      return [];
    },
    getHistoryOrders: async () => [],
    getPositions: async () => [],
    getFunds: async () => null,
    close: () => {},
  };
  const res = await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.accounts).toBe(1);
  expect(queried).toEqual(["real"]); // sim account never queried
});

test("runSync skips unknown markets (e.g. futures=5)", async () => {
  const db = openTestDb();
  const markets: number[] = [];
  const client = stubClient({
    getAccounts: async () => [{ id: "acc1", trdEnv: 1, markets: [2, 5] }], // US + futures
    getHistoryFills: async (_a, m) => {
      markets.push(m);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(markets).toEqual([2]); // futures (5) skipped
});

test("runSync pulls orders over the full window even on incremental fill syncs", async () => {
  const db = openTestDb();
  const orderBegins: number[] = [];
  const client = stubClient({
    getHistoryOrders: async (_a, _m, begin) => {
      orderBegins.push(begin);
      return [];
    },
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 100_000, historyDays: 1 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 200_000, historyDays: 1 });
  // Both runs pull orders from now - historyDays (mutable orders), NOT from the fills cursor.
  expect(orderBegins[0]).toBe(100_000 - 86_400_000);
  expect(orderBegins[1]).toBe(200_000 - 86_400_000);
});

test("runSync carries forward MAE/MFE when candles degrade (no silent regression)", async () => {
  const db = openTestDb();
  const fills = [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 11, fee: 0, currency: "USD", time: 7_200_000, account: "acc1" },
  ];
  const client = stubClient({ getHistoryFills: async () => fills });
  const withCandles: CandleSource = {
    // 1h bar (start 1000) fully inside the 2h hold → mae 2 (low 8), mfe 3 (high 13).
    getCandles: async () => [{ time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 }],
  };
  await runSync({ db, client, candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(allTrades(db)[0]!.mae).toBe(2);

  // Second sync during a Yahoo outage (getCandles → []): prior mae/mfe must survive, not go null.
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.mae).toBe(2);
  expect(t.mfe).toBe(3);
});

test("runSync does NOT carry forward MAE/MFE when the trade shape changed (open → closed)", async () => {
  const db = openTestDb();
  const buy = { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" };
  const sell = { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 100, price: 11, fee: 0, currency: "USD", time: 5000, account: "acc1" };
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 }],
  };
  const held: RawPosition[] = [
    { account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, price: null, currency: "USD", time: 0 },
  ];
  // sync 1: opening BUY, still holding (snapshot reflects the 100 long → no seed) → trade OPEN;
  // candles present → mae computed on the open window.
  await runSync({
    db,
    client: stubClient({ getHistoryFills: async () => [buy], getPositions: async () => held }),
    candles: withCandles,
    config: DEFAULT_RULE_CONFIG,
    now: 10_000,
  });
  expect(allTrades(db)[0]!.status).toBe("open");
  // sync 2: the exit arrives (same trade id, new shape), account now flat, during a candle outage →
  // must NOT reuse the open-window excursion; leave null until candles cover the closed window.
  await runSync({
    db,
    client: stubClient({ getHistoryFills: async () => [buy, sell], getPositions: async () => [] }),
    candles: noCandles,
    config: DEFAULT_RULE_CONFIG,
    now: 20_000,
  });
  const t = allTrades(db)[0]!;
  expect(t.status).toBe("closed");
  expect(t.mae).toBeNull();
  expect(t.mfe).toBeNull();
});

test("runSync does NOT carry forward MAE/MFE when a partial exit is added mid-outage (trade stays open)", async () => {
  // A gained fill shifts the excursion anchors even if the trade stays open and its avgEntry/maxQty
  // don't move — so the carry-forward guard keys on the fill SET, not just window shape.
  const db = openTestDb();
  const buy = { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY" as const, qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" };
  const partial = { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL" as const, qty: 40, price: 13, fee: 0, currency: "USD", time: 5000, account: "acc1" };
  const withCandles: CandleSource = {
    getCandles: async () => [{ time: 1000, open: 10, high: 13, low: 8, close: 11, volume: 1 }],
  };
  const held100: RawPosition[] = [{ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, price: null, currency: "USD", time: 0 }];
  const held60: RawPosition[] = [{ account: "acc1", symbol: "US.AAPL", qty: 60, avgCost: 10, price: null, currency: "USD", time: 0 }];
  // sync 1: just the BUY, holding 100 → OPEN, candles present → mae/mfe computed.
  await runSync({ db, client: stubClient({ getHistoryFills: async () => [buy], getPositions: async () => held100 }), candles: withCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(allTrades(db)[0]!.mae).not.toBeNull();
  // sync 2: a partial exit arrives (still holding 60 → still OPEN, same maxQty/avgEntry) during a
  // candle outage. The new 13 fill would move the anchors, so the stale excursion must NOT be reused.
  await runSync({ db, client: stubClient({ getHistoryFills: async () => [buy, partial], getPositions: async () => held60 }), candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  const t = allTrades(db)[0]!;
  expect(t.status).toBe("open");
  expect(t.mae).toBeNull();
  expect(t.mfe).toBeNull();
});

function rawFill(side: "BUY" | "SELL", qty: number, over: Partial<RawFill> = {}): RawFill {
  return {
    id: over.id ?? "f", orderId: over.orderId ?? "o", symbol: over.symbol ?? "US.AAPL", side, qty,
    price: over.price ?? 10, fee: 0, currency: over.currency ?? "USD", time: over.time ?? 1000,
    account: over.account ?? "acc1",
  };
}
function pos(qty: number, over: Partial<RawPosition> = {}): RawPosition {
  return {
    account: over.account ?? "acc1", symbol: over.symbol ?? "US.AAPL", qty,
    avgCost: over.avgCost ?? 10, price: over.price ?? null, currency: over.currency ?? "USD", time: over.time ?? 5000,
  };
}

test("deriveSeeds: no seed when in-window fills fully explain the current snapshot", () => {
  const fills = [rawFill("BUY", 100, { id: "f1" })];
  expect(deriveSeeds(fills, [pos(100)], 0)).toEqual([]); // 100 held, 100 bought → startPos 0
});

test("deriveSeeds: seeds the pre-window remainder (snapshot − net fills)", () => {
  const fills = [rawFill("SELL", 40, { id: "f1", time: 2000 })]; // net -40
  const seeds = deriveSeeds(fills, [pos(60)], 0); // still hold 60 → startPos 60 - (-40) = 100
  expect(seeds).toEqual([{ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, currency: "USD", time: 2000 }]);
});

test("deriveSeeds: a pre-window long fully sold in-window (flat snapshot) still seeds a long", () => {
  const fills = [rawFill("SELL", 100, { id: "f1" })]; // net -100
  const seeds = deriveSeeds(fills, [], 0); // flat now → startPos 0 - (-100) = 100
  expect(seeds[0]!.qty).toBe(100); // long, not a phantom short
  expect(seeds[0]!.avgCost).toBe(0); // no snapshot row → best-effort 0 (trade is coverageOk:false)
});

test("runSync seeds a pre-existing holding so a sold pre-window position isn't a phantom SHORT", async () => {
  const db = openTestDb();
  const client = stubClient({
    // Only a SELL in-window (the opening BUY predates coverage); account is flat afterward.
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  const t = allTrades(db)[0]!;
  expect(t.direction).toBe("LONG"); // seeded long that was sold — NOT a phantom short
  expect(t.coverageOk).toBe(false); // coverage-incomplete → excluded from P&L/stats
});

test("runSync survives a candle-source rejection (degrades to no MAE/MFE, doesn't abort)", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  const throwingCandles: CandleSource = {
    getCandles: async () => {
      throw new Error("provider down");
    },
  };
  const res = await runSync({ db, client, candles: throwingCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  expect(res.trades).toBe(1);
  expect(allTrades(db)[0]!.mae).toBeNull();
});

test("runSync is idempotent — re-running the same data yields the same single trade", async () => {
  const db = openTestDb();
  const client = stubClient({
    getHistoryFills: async () => [
      { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10, fee: 0, currency: "USD", time: 1000, account: "acc1" },
      { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 100, price: 12, fee: 0, currency: "USD", time: 2000, account: "acc1" },
    ],
  });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 10_000 });
  await runSync({ db, client, candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 20_000 });
  expect(allTrades(db)).toHaveLength(1); // upserts dedupe raw; derived fully replaced
});
