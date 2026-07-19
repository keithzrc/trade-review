import { test, expect } from "bun:test";
import { inferStops } from "../../src/core/stop-inference";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, order } from "../helpers";

// A long trade opened at t=60000 (BUY 100 @ 10), still open.
function longTrade() {
  return buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
}

test("detects a separate protective SELL STOP for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBe(9);
});

test("detects a take-profit limit above entry for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "LIMIT", 100, { price: 13, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveTp).toBe(13);
});

test("short: take-profit is a BUY limit below entry", () => {
  const short = buildTrades([fill("SELL", 100, 20, { time: 60_000 })])[0]!;
  const orders = [order("BUY", "LIMIT", 100, { price: 18, createTime: 120_000 })];
  expect(inferStops(short, orders).effectiveTp).toBe(18);
});

test("initialStop is the earliest, effectiveStop the latest (stop trailed up)", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 }),
    order("SELL", "STOP", 100, { triggerPrice: 9.5, createTime: 180_000 }),
  ];
  const s = inferStops(t, orders);
  expect(s.initialStop).toBe(9); // planned risk
  expect(s.effectiveStop).toBe(9.5); // what was protecting at the end
});

test("a stop trailed to/above entry is still captured (breakeven / profit stop)", () => {
  // Previously wrongly discarded as 'wrong price side'. A closing-side stop is a stop.
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 11, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBe(11);
});

test("a modified stop's updateTime (not createTime) drives recency", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { id: "new", triggerPrice: 9.5, createTime: 200_000 }),
    order("SELL", "STOP", 100, {
      id: "moved",
      triggerPrice: 9.8,
      createTime: 120_000,
      updateTime: 300_000,
    }),
  ];
  // "moved" was created earlier but modified last → it is the effective stop.
  expect(inferStops(t, orders).effectiveStop).toBe(9.8);
});

test("ignores a rejected/failed stop order", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, status: "FAILED" }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("a cancelled stop still counts (reveals the intended risk level)", () => {
  // v1 choice: a placed-then-cancelled stop tells us the trader's planned risk, which is
  // exactly what a review wants (e.g. 'you cancelled your stop and it ran against you').
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, status: "CANCELLED_ALL" }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBe(9);
});

test("ignores a BUY stop (wrong side for a long)", () => {
  const t = longTrade();
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores a stop on a bigger qty than the position", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 500, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order on a different symbol/account", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, symbol: "TSLA" }),
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, account: "other" }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order placed before the trade opened", () => {
  const t = longTrade(); // opens at 60000
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 30_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("short trade: BUY stop above entry is the stop-loss", () => {
  const short = buildTrades([fill("SELL", 100, 20, { time: 60_000 })])[0]!;
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 22, createTime: 120_000 })];
  expect(inferStops(short, orders).effectiveStop).toBe(22);
});

test("populates provenance (order id, qty, receipt) for the effective stop", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { id: "stopX", triggerPrice: 9, createTime: 120_000 }),
  ];
  const s = inferStops(t, orders);
  expect(s.stopOrderId).toBe("stopX");
  expect(s.stopQty).toBe(100);
  expect(s.receipt).toContain("stopX");
  expect(s.receipt).toContain("@ 9");
});

test("no orders → all-null StopInfo", () => {
  const t = longTrade();
  expect(inferStops(t, [])).toEqual({
    initialStop: null,
    initialStopType: null,
    effectiveStop: null,
    effectiveTp: null,
    stopOrderId: null,
    stopQty: null,
    receipt: null,
    liveStop: null,
    liveStopQty: null,
  });
});

test("liveStop is the newest WORKING stop; a cancelled newest stop falls back to the older working one", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, status: "SUBMITTED" }),
    // A newer stop the user placed then cancelled — it's the effective (last-seen) stop but not live.
    order("SELL", "STOP", 100, { triggerPrice: 9.5, createTime: 180_000, status: "CANCELLED_ALL" }),
  ];
  const s = inferStops(t, orders);
  expect(s.effectiveStop).toBe(9.5); // last-seen protective stop (post-hoc)
  expect(s.liveStop).toBe(9); // the still-working one
});

test("liveStop is null when the only protective stop has been cancelled (position unprotected)", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, status: "CANCELLED_ALL" }),
  ];
  const s = inferStops(t, orders);
  expect(s.effectiveStop).toBe(9); // still reported for post-hoc review
  expect(s.liveStop).toBeNull(); // but nothing is working now
});

test("a fully-filled stop is not live; a partially-filled stop still is", () => {
  const t = longTrade();
  expect(
    inferStops(t, [order("SELL", "STOP", 100, { triggerPrice: 9, status: "FILLED_ALL" })]).liveStop,
  ).toBeNull();
  const part = inferStops(t, [
    order("SELL", "STOP", 100, { triggerPrice: 9, status: "FILLED_PART" }),
  ]);
  expect(part.liveStop).toBe(9);
  expect(part.liveStopQty).toBe(100);
});
