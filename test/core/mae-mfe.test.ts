import { test, expect } from "bun:test";
import { computeExcursion, heldAdverseExcursion } from "../../src/core/mae-mfe";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, candle } from "../helpers";
import type { RawFill } from "../../src/domain/types";

const RES = 60_000; // 1-minute bars in these fixtures

// Build a trade AND keep the fills — computeExcursion anchors on the real fill prices.
function trade(fills: RawFill[]) {
  return { trade: buildTrades(fills)[0]!, fills };
}

function longTrade() {
  // BUY 100 @ 10 at t=60000, SELL 100 @ 12 at t=180000 → window [60000, 180000).
  return trade([
    fill("BUY", 100, 10, { time: 60_000 }),
    fill("SELL", 100, 12, { time: 180_000 }),
  ]);
}

test("long: MFE from highest high, MAE from lowest low", () => {
  const { trade: t, fills } = longTrade();
  const candles = [candle(60_000, 9, 11), candle(120_000, 8, 13)];
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(3); // 13 - 10
  expect(r.mae).toBe(2); // 10 - 8
});

test("short: MFE from lowest low, MAE from highest high", () => {
  const { trade: t, fills } = trade([
    fill("SELL", 100, 20, { time: 60_000 }),
    fill("BUY", 100, 18, { time: 180_000 }),
  ]);
  const candles = [candle(120_000, 17, 23)]; // low 17, high 23; entry 20
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(3); // 20 - 17
  expect(r.mae).toBe(3); // 23 - 20
});

test("candles fully outside the trade window are ignored", () => {
  const { trade: t, fills } = longTrade(); // window [60000, 180000), entry 10, exit 12
  const candles = [
    candle(0, 1, 100), // bar [0, 60000) ends at open, not fully inside → ignored
    candle(240_000, 1, 100), // well after close → ignored
    candle(120_000, 9, 11),
  ];
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(2); // exit fill at 12 is a real favorable point, above the bar high of 11
  expect(r.mae).toBe(1); // 10 - 9
});

test("a boundary bar straddling entry is EXCLUDED — its extremes may predate the fill", () => {
  // The ANET bug: enter mid-bar at 90000 AFTER an early spike. The 60000 bar [60000,120000) straddles
  // openTime, so its high/low can be pre-entry price the trade never held → it must not count.
  const { trade: t, fills } = trade([
    fill("BUY", 100, 10, { time: 90_000 }),
    fill("SELL", 100, 9, { time: 150_000 }), // straddles close too; window [90000,150000)
  ]);
  const candles = [candle(60_000, 8, 20)]; // spike to 20 lives in the straddling entry bar
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(0); // NOT 10 — the 20 high predates entry; no in-hold bar shows a gain
  expect(r.mae).toBe(1); // 10 - 9, from the exit fill (the 8 low is also outside the hold)
});

test("a boundary bar straddling exit is EXCLUDED — its extremes may postdate the fill", () => {
  // The AMD bug: the exit bar's low happened AFTER the exit fill and must not inflate MAE.
  const { trade: t, fills } = longTrade(); // window [60000, 180000), entry 10, exit 12
  const candles = [candle(120_000, 9, 11), candle(150_000, 1, 100)]; // 150000 bar straddles close 180000
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(2); // exit at 12; the 100 high in the straddling bar is ignored
  expect(r.mae).toBe(1); // 10 - 9; the post-exit 1 low is ignored
});

test("scale-out fills anchor the range — the averaged avgExit would hide a leg's excursion", () => {
  // BUY 100@10, SELL 50@15, SELL 50@5 → avgExit is 10 (hides both extremes). The real fills reached
  // +5 and −5, and there is no fully-inside bar to reveal them, so the fills must be the anchors.
  const { trade: t, fills } = trade([
    fill("BUY", 100, 10, { time: 90_000 }),
    fill("SELL", 50, 15, { time: 120_000 }),
    fill("SELL", 50, 5, { time: 150_000 }),
  ]);
  expect(t.avgExit).toBe(10); // the trap: the volume-weighted exit sits between the fills
  const candles = [candle(60_000, 1, 100)]; // one straddling bar → no fully-inside bar
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mfe).toBe(5); // 15 - 10, the winning scale-out leg
  expect(r.mae).toBe(5); // 10 - 5, the losing scale-out leg
});

test("no fully-inside bar → excursion falls back to the fills", () => {
  const { trade: short, fills } = trade([
    fill("SELL", 100, 20, { time: 90_000 }),
    fill("BUY", 100, 22, { time: 150_000 }), // loss: covered higher
  ]);
  const candles = [candle(60_000, 5, 40)]; // one bar straddling the whole hold
  const r = computeExcursion(short, fills, candles, RES);
  expect(r.mfe).toBe(0); // never went favorable (below 20) on any in-hold evidence
  expect(r.mae).toBe(2); // 22 - 20, the adverse move to the exit fill
});

test("MAE/MFE clamp to >= 0 when price never went adverse/favorable", () => {
  const { trade: t, fills } = longTrade(); // entry 10
  const candles = [candle(120_000, 11, 12)]; // price stayed above entry the whole time
  const r = computeExcursion(t, fills, candles, RES);
  expect(r.mae).toBe(0); // would be -1 unclamped (exit fill 12 is above entry too)
  expect(r.mfe).toBe(2); // 12 - 10
});

test("no candles supplied → null (degrade-safe carry-forward in sync)", () => {
  const { trade: t, fills } = longTrade();
  expect(computeExcursion(t, fills, [], RES)).toEqual({ mae: null, mfe: null });
});

test("open trade uses all candles from openTime onward", () => {
  const { trade: openT, fills } = trade([fill("BUY", 100, 10, { time: 60_000 })]);
  const candles = [candle(600_000, 8, 15)];
  const r = computeExcursion(openT, fills, candles, RES);
  expect(r.mfe).toBe(5); // 15 - 10
  expect(r.mae).toBe(2); // 10 - 8
});

// heldAdverseExcursion — the mid-hold adverse move used to detect a survived stop breach. Only bars
// that closed DURING the hold AND contain no fill count (fills and the entry/exit boundary bars are
// excluded).

test("heldAdverseExcursion (long): worst low among fill-free fully-inside bars, vs entry", () => {
  const { trade: t, fills } = longTrade(); // entry 10, window [60000, 180000)
  expect(heldAdverseExcursion(t, fills, [candle(120_000, 7, 11)], RES)).toBe(3); // 10 - 7
});

test("heldAdverseExcursion excludes the exit bar — a stop-out low there does NOT count", () => {
  const { trade: t, fills } = longTrade(); // closes at 180000
  // A deep low that lives in the straddling exit bar (start 150000) must be ignored → no inside bar.
  expect(heldAdverseExcursion(t, fills, [candle(150_000, 1, 100)], RES)).toBeNull();
});

test("heldAdverseExcursion excludes a bar holding an EARLIER split-exit fill (straddling boundary)", () => {
  // A genuine stop-out liquidates across two bars: 50 @ 8 at t=120000 (bar [120000,180000)) and the
  // rest 50 @ 8 at t=180000. closeTime is the LAST fill (240000 window end here), so the 120000 bar is
  // fully inside — but it holds a closing fill, so its stop-out low (8) must NOT count as a survived
  // breach. Without the fill-in-bar exclusion this would return 2 and wrongly flag the stop unreliable.
  const fills = [
    fill("BUY", 100, 10, { time: 60_000 }),
    fill("SELL", 50, 8, { time: 120_000 }),
    fill("SELL", 50, 8, { time: 180_000 }),
  ];
  const t = buildTrades(fills)[0]!; // window [60000, 180000)
  // Only the 120000 bar is fully inside, and it holds the first stop fill → excluded → null.
  expect(heldAdverseExcursion(t, fills, [candle(120_000, 8, 11)], RES)).toBeNull();
});

test("heldAdverseExcursion (short): worst high among fill-free fully-inside bars, vs entry", () => {
  const shortFills = [
    fill("SELL", 100, 20, { time: 60_000 }),
    fill("BUY", 100, 21, { time: 180_000 }),
  ];
  const short = buildTrades(shortFills)[0]!;
  expect(heldAdverseExcursion(short, shortFills, [candle(120_000, 19, 26)], RES)).toBe(6); // 26 - 20
});

test("heldAdverseExcursion clamps to >= 0 and is null with no fully-inside bar", () => {
  const { trade: t, fills } = longTrade();
  expect(heldAdverseExcursion(t, fills, [candle(120_000, 11, 12)], RES)).toBe(0); // never went below entry
  expect(heldAdverseExcursion(t, fills, [], RES)).toBeNull(); // outage / too short
});
