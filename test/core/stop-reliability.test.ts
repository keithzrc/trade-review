import { test, expect } from "bun:test";
import { isUnreliableStop } from "../../src/core/stop-reliability";

// Base = the real AMD case: LONG, entry 511.17, exit 508.36 (loss), inferred stop 510.89 (0.28 away),
// mae 13.02 (price fell to 498.15 while the trade stayed open, then recovered to exit at 508.36).
function amd(over: Partial<Parameters<typeof isUnreliableStop>[0]> = {}) {
  return isUnreliableStop({
    direction: "LONG",
    avgEntry: 511.17,
    avgExit: 508.36,
    realizedPnl: -11.24,
    stop: 510.89,
    mae: 13.02,
    manual: false,
    recoverMult: 1,
    ...over,
  });
}

test("AMD case: breached the stop AND recovered from the low → unreliable", () => {
  expect(amd()).toBe(true);
});

test("gap/slippage stop-out: exited AT the adverse low (no recovery) → reliable", () => {
  // Entry 100, stop 95, gapped down and filled at 90 = the low. mae 10, realized loss 10.
  expect(
    isUnreliableStop({
      direction: "LONG",
      avgEntry: 100,
      avgExit: 90,
      realizedPnl: -1000,
      stop: 95,
      mae: 10, // breached the 5-wide stop...
      manual: false,
      recoverMult: 1,
    }),
  ).toBe(false); // ...but recovery = 10 - 10 = 0, not > stopDistance → excess_loss stays
});

test("never breached the stop → reliable (a clean ~1R loss like ANET)", () => {
  // ANET: entry 173.42, exit 170.305, stop 170.21 (dist 3.21), mae 3.11 (< dist) → not breached.
  expect(
    isUnreliableStop({
      direction: "LONG",
      avgEntry: 173.42,
      avgExit: 170.305,
      realizedPnl: -46.72,
      stop: 170.21,
      mae: 3.11,
      manual: false,
      recoverMult: 1,
    }),
  ).toBe(false);
});

test("a winner is never flagged (losers only)", () => {
  expect(amd({ realizedPnl: 50, avgExit: 520 })).toBe(false);
});

test("a manual stop is the user's explicit assertion — never second-guessed", () => {
  expect(amd({ manual: true })).toBe(false);
});

test("no stop / no mae / no exit / open trade → reliable (nothing to judge)", () => {
  expect(amd({ stop: null })).toBe(false);
  expect(amd({ mae: null })).toBe(false);
  expect(amd({ avgExit: null })).toBe(false);
  expect(amd({ realizedPnl: null })).toBe(false);
});

test("recoverMult raises the bar: a marginal recovery below the threshold stays reliable", () => {
  // Entry 100, stop 98 (dist 2), fell to 95 (mae 5, breached), exited 96 (loss 4) → recovery = 1.
  const args = {
    direction: "LONG" as const,
    avgEntry: 100,
    avgExit: 96,
    realizedPnl: -400,
    stop: 98,
    mae: 5,
    manual: false,
  };
  expect(isUnreliableStop({ ...args, recoverMult: 0.4 })).toBe(true); // 1 > 2*0.4=0.8
  expect(isUnreliableStop({ ...args, recoverMult: 1 })).toBe(false); // 1 > 2*1=2 is false
});

test("SHORT mirror: price rose past the stop then fell back to a smaller loss → unreliable", () => {
  // SHORT entry 100, stop 102 (dist 2), price spiked to 110 (mae 10, breached), covered at 101 (loss 1).
  expect(
    isUnreliableStop({
      direction: "SHORT",
      avgEntry: 100,
      avgExit: 101,
      realizedPnl: -100,
      stop: 102,
      mae: 10,
      manual: false,
      recoverMult: 1,
    }),
  ).toBe(true); // recovery = 10 - (101-100) = 9 > 2
});

test("SHORT gap-through: covered AT the high (no recovery) → reliable", () => {
  expect(
    isUnreliableStop({
      direction: "SHORT",
      avgEntry: 100,
      avgExit: 110,
      realizedPnl: -1000,
      stop: 102,
      mae: 10,
      manual: false,
      recoverMult: 1,
    }),
  ).toBe(false); // recovery = 10 - (110-100) = 0
});
