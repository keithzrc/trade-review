import { test, expect } from "bun:test";
import { isUnreliableStop } from "../../src/core/stop-reliability";

// Base = the real AMD case: LONG, entry 511.17 (loss), inferred stop 510.89 (0.28 away). Mid-hold the
// price fell to 498.15 in a bar that closed DURING the hold → heldMae 13.02, far past the 0.28 stop.
function amd(over: Partial<Parameters<typeof isUnreliableStop>[0]> = {}) {
  return isUnreliableStop({
    avgEntry: 511.17,
    realizedPnl: -11.24,
    stop: 510.89,
    heldMae: 13.02,
    manual: false,
    recoverMult: 1,
    ...over,
  });
}

test("AMD case: price ran past the stop in a mid-hold bar → unreliable", () => {
  expect(amd()).toBe(true);
});

test("stop-out (single, gap, or split-fill): the low is in the EXIT bar → heldMae stays small → reliable", () => {
  // A stop-out's adverse low sits in the excluded exit bar, so heldMae only reflects a shallow mid-hold
  // dip (here 0.5, inside the 2-wide stop) — no matter how the closing prints split. excess_loss stays.
  expect(
    isUnreliableStop({ avgEntry: 100, realizedPnl: -1000, stop: 98, heldMae: 0.5, manual: false, recoverMult: 1 }),
  ).toBe(false);
});

test("never breached mid-hold (heldMae within the stop) → reliable", () => {
  // ANET-like: stop distance 3.21, deepest mid-hold dip 3.11 → didn't clear the stop.
  expect(
    isUnreliableStop({ avgEntry: 173.42, realizedPnl: -46.72, stop: 170.21, heldMae: 3.11, manual: false, recoverMult: 1 }),
  ).toBe(false);
});

test("a winner is never flagged (losers only)", () => {
  expect(amd({ realizedPnl: 50 })).toBe(false);
});

test("a manual stop is the user's explicit assertion — never second-guessed", () => {
  expect(amd({ manual: true })).toBe(false);
});

test("no stop / no held excursion (too short, or candle outage) / open trade → reliable", () => {
  expect(amd({ stop: null })).toBe(false);
  expect(amd({ heldMae: null })).toBe(false);
  expect(amd({ realizedPnl: null })).toBe(false);
});

test("recoverMult sets the margin the mid-hold low must clear past the stop", () => {
  // Stop distance 2, mid-hold low went 3 past it (heldMae 3).
  const args = { avgEntry: 100, realizedPnl: -400, stop: 98, heldMae: 3, manual: false };
  expect(isUnreliableStop({ ...args, recoverMult: 1 })).toBe(true); // 3 > 2 * 1
  expect(isUnreliableStop({ ...args, recoverMult: 2 })).toBe(false); // 3 > 2 * 2 = 4 is false
});

test("a zero-width stop (stop at entry) is not a risk basis → reliable", () => {
  expect(amd({ stop: 511.17 })).toBe(false);
});
