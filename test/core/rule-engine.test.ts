import { test, expect } from "bun:test";
import { evaluate } from "../../src/core/rule-engine";
import { buildTrades } from "../../src/core/trade-builder";
import { fill } from "../helpers";
import { DEFAULT_RULE_CONFIG, type RuleContext, type Trade } from "../../src/domain/types";

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    fills: over.fills ?? [],
    recentClosedTrades: over.recentClosedTrades ?? [],
    recentOpens: over.recentOpens,
  };
}
function ids(flags: { ruleId: string }[]): string[] {
  return flags.map((f) => f.ruleId).sort();
}

test("added_to_loser: a long adds while underwater", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 9, { time: 2000 }), // adding at 9 < avg 10 → adding to a loser
    fill("SELL", 200, 9.5, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("added_to_loser");
});

test("added_to_loser: adding to a winner does NOT fire", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 100, 11, { time: 2000 }), // adding higher — not underwater
    fill("SELL", 200, 12, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  const flags = evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("added_to_loser");
});

test("added_to_loser: partial fills of ONE entry order are not an add-to-loser", () => {
  // FUTU splits a single BUY into two partial fills (same orderId), the second printing below the
  // first. That is one order finishing at a blended cost — NOT a scale-in while underwater. The
  // running-average walk must operate on per-order tranches, not raw fills, so it must not fire.
  const fills = [
    fill("BUY", 100, 10, { time: 1000, orderId: "entry1" }),
    fill("BUY", 100, 9, { time: 1001, orderId: "entry1" }), // same order, later partial below the first
    fill("SELL", 200, 9.5, { time: 3000, orderId: "exit1" }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).not.toContain("added_to_loser");
});

test("cut_winner_early: closed winner under 1R", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("cut_winner_early");
});

test("cut_winner_early: a 2R winner does NOT fire", () => {
  const trade = { ...base(), realizedPnl: 200, rMultiple: 2 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("cut_winner_early");
});

test("held_past_stop is retired — a wick past the stop no longer flags", () => {
  // The exact NBIS shape: exited ~ −1R at the stop, MAE poked just past it. No warn flag.
  const trade = { ...base(), effectiveStop: 9, mae: 1.02, rMultiple: -1.0, risk: 100 };
  const flags = ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG));
  expect(flags).not.toContain("held_past_stop");
  expect(flags).not.toContain("excess_loss"); // −1.0R is within plan, not excess
});

test("excess_loss: a loss materially deeper than 1R fires", () => {
  const trade = { ...base(), realizedPnl: -150, rMultiple: -1.5, risk: 100 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("excess_loss");
});

test("excess_loss: a clean −1R stop-out does NOT fire", () => {
  const trade = { ...base(), realizedPnl: -100, rMultiple: -1.0, risk: 100 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("excess_loss");
});

test("no_stop: a trade with no risk basis (no loss-limiting stop) fires", () => {
  const trade = { ...base(), risk: null };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("no_stop");
});

test("no_stop: a trade with a loss-limiting stop does NOT fire", () => {
  const trade = { ...base(), risk: 100 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("no_stop");
});

test("unreliable_stop: fires when the trade is flagged unreliable (R still visible)", () => {
  // Risk/R stay computed and visible; the engine surfaces the dedicated caveat flag from the trade.
  const trade = { ...base(), risk: 1.12, rMultiple: -10, stopUnreliable: true };
  const flags = ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG));
  expect(flags).toContain("unreliable_stop");
});

test("an unreliable stop suppresses the R/risk-dependent judgement flags", () => {
  // A would-be excess_loss (−10R) / round-trip shape, but the stop is suspect → no R-based mistake
  // flag fires (the risk basis isn't trusted). Only the unreliable_stop caveat is surfaced.
  const trade = {
    ...base(),
    realizedPnl: -1124,
    risk: 1.12,
    rMultiple: -10,
    avgEntry: 10,
    maxQty: 100,
    mfe: 5,
    stopUnreliable: true,
  };
  const flags = ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG));
  expect(flags).not.toContain("excess_loss");
  expect(flags).not.toContain("round_tripped_gain");
  expect(flags).not.toContain("wide_stop");
  expect(flags).not.toContain("oversized");
});

test("wide_stop: a stop wider than 8% of entry fires", () => {
  // entry 10, maxQty 100, risk 100 → stop distance (100/100)/10 = 10% > 8% cap.
  const trade = { ...base(), avgEntry: 10, maxQty: 100, risk: 100 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("wide_stop");
});

test("wide_stop: a tight stop does NOT fire", () => {
  // entry 10, maxQty 100, risk 50 → stop distance 5% < 8% cap.
  const trade = { ...base(), avgEntry: 10, maxQty: 100, risk: 50 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("wide_stop");
});

test("wide_stop: a profit-side / split-corrupted stop (risk null) never fires", () => {
  // risk.ts nulls risk for profit-side or split-corrupted stops — wide_stop must inherit that guard.
  const trade = { ...base(), avgEntry: 10, maxQty: 100, risk: null };
  const flags = ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG));
  expect(flags).not.toContain("wide_stop");
});

test("improper_pyramid: an add bigger than the first tranche fires", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 200, 10.1, { time: 2000 }), // larger add, still near the buy point
    fill("SELL", 300, 11, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).toContain("improper_pyramid");
});

test("improper_pyramid: partial fills of ONE entry order are not pyramid adds", () => {
  // FUTU splits a single 100-share BUY into 30 then 70 (same orderId). The 70 is not an 'add'
  // bigger than a 30-share first tranche — it's the same order finishing. Must not flag.
  const fills = [
    fill("BUY", 30, 10, { time: 1000, orderId: "entry1" }),
    fill("BUY", 70, 10.01, { time: 1001, orderId: "entry1" }),
    fill("SELL", 100, 11, { time: 3000, orderId: "exit1" }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).not.toContain("improper_pyramid");
});

test("improper_pyramid: a proper decreasing add near the pivot does NOT fire", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("BUY", 50, 10.2, { time: 2000 }), // smaller add, within 5% of first entry
    fill("SELL", 150, 11, { time: 3000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).not.toContain("improper_pyramid");
});

test("overtrading_freq: too many opens within the window fires — even when still held", () => {
  // Four positions opened the same morning and HELD (none closed) — recentOpens counts opens by
  // time, so the churn is caught where recentClosedTrades would have missed it entirely.
  const opens = [1_000_000, 1_000_000 + 1000, 1_000_000 + 2000];
  const trade = { ...base(), id: "o4", openTime: 1_000_000 + 3000 }; // 4th open same day > max 3
  const flags = ids(evaluate(trade, ctx({ recentOpens: opens }), DEFAULT_RULE_CONFIG));
  expect(flags).toContain("overtrading_freq");
});

test("overtrading_freq: opens outside the window do NOT count", () => {
  const twoDays = 2 * 24 * 60 * 60_000;
  const opens = [1_000_000, 1_000_000 + twoDays, 1_000_000 + 2 * twoDays];
  const trade = { ...base(), id: "spread", openTime: 1_000_000 + 3 * twoDays };
  expect(ids(evaluate(trade, ctx({ recentOpens: opens }), DEFAULT_RULE_CONFIG))).not.toContain("overtrading_freq");
});

test("overtrading_freq: a lone trade in the window does NOT fire", () => {
  const trade = { ...base(), id: "solo", openTime: 1_000_000 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).not.toContain("overtrading_freq");
});

test("oversized: risk above 1.5x recent average", () => {
  const recent = [
    { ...base(), risk: 100 },
    { ...base(), risk: 100 },
  ];
  const trade = { ...base(), risk: 200 }; // 2x avg 100
  const flags = evaluate(trade, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("oversized");
});

test("oversized: an unreliable prior stop's suspect risk is excluded from the baseline", () => {
  // Two trusted trades set a 100 baseline; a prior unreliable trade with a fabricated tiny 2 risk must
  // NOT drag the average down (which would make an otherwise-normal 200 risk look 3x+ oversized).
  const recent = [
    { ...base(), risk: 100 },
    { ...base(), risk: 100 },
    { ...base(), risk: 2, stopUnreliable: true }, // suspect 1R — must not poison the baseline
  ];
  const trade = { ...base(), risk: 200 }; // 2x the trusted avg 100 → oversized on merit, not distortion
  const flags = ids(evaluate(trade, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG));
  expect(flags).toContain("oversized");
  // And a normal 120 risk (1.2x the trusted avg) must NOT fire — it only would if the suspect 2 pulled
  // the baseline down to ~67.
  const normal = { ...base(), risk: 120 };
  expect(ids(evaluate(normal, ctx({ recentClosedTrades: recent }), DEFAULT_RULE_CONFIG))).not.toContain("oversized");
});

test("round_tripped_gain: peak >= 1R then closed red", () => {
  // risk 100, mfe 2/share * 100 qty = 200 peak gain (2R), exited at -10.
  const trade = { ...base(), risk: 100, maxQty: 100, mfe: 2, realizedPnl: -10 };
  expect(ids(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG))).toContain("round_tripped_gain");
});

test("overtrading_revenge: opened soon after a losing exit", () => {
  const loser = { ...base(), id: "prior", realizedPnl: -50, closeTime: 1_000_000 };
  const trade = { ...base(), id: "current", openTime: 1_000_000 + 5 * 60_000 }; // 5 min later
  const flags = evaluate(trade, ctx({ recentClosedTrades: [loser] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).toContain("overtrading_revenge");
});

test("overtrading_revenge: after a WINNER does not fire", () => {
  const winner = { ...base(), id: "prior", realizedPnl: 50, closeTime: 1_000_000 };
  const trade = { ...base(), id: "current", openTime: 1_000_000 + 5 * 60_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [winner] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("overtrading_revenge: a trade does not flag itself", () => {
  // Same id in recentClosedTrades must be ignored (the self-exclusion guard).
  const trade = { ...base(), id: "same", realizedPnl: -50, closeTime: 1_000_000, openTime: 1_000_000 };
  const flags = evaluate(trade, ctx({ recentClosedTrades: [{ ...trade }] }), DEFAULT_RULE_CONFIG);
  expect(ids(flags)).not.toContain("overtrading_revenge");
});

test("a disabled rule never fires", () => {
  const trade = { ...base(), realizedPnl: 50, rMultiple: 0.4 };
  const cfg = { ...DEFAULT_RULE_CONFIG, enabled: { cut_winner_early: false } };
  expect(ids(evaluate(trade, ctx(), cfg))).not.toContain("cut_winner_early");
});

test("no rules fire on a coverage-incomplete (seeded) trade", () => {
  const trade = { ...base(), coverageOk: false, realizedPnl: 50, rMultiple: 0.4 };
  expect(evaluate(trade, ctx(), DEFAULT_RULE_CONFIG)).toEqual([]);
});

test("oversized ignores recent trades in a different currency", () => {
  const hkd = [
    { ...base(), id: "h1", currency: "HKD", risk: 8000 },
    { ...base(), id: "h2", currency: "HKD", risk: 8000 },
  ];
  const trade = { ...base(), currency: "USD", risk: 1500 };
  // No USD history → oversized can't fire (avg is null); HKD sizes must not suppress or trigger it.
  expect(
    ids(evaluate(trade, ctx({ recentClosedTrades: hkd }), DEFAULT_RULE_CONFIG)),
  ).not.toContain("oversized");
});

test("added_to_loser tracks cost basis correctly after a partial reduce", () => {
  const fills = [
    fill("BUY", 100, 10, { time: 1000 }),
    fill("SELL", 50, 12, { time: 2000 }), // reduce — avg cost stays 10, not 10.33
    fill("BUY", 50, 11, { time: 3000 }), // re-add at 11 → avg becomes 10.5, not a loser add
    fill("BUY", 50, 10.4, { time: 4000 }), // 10.4 < 10.5 → added to loser (missed if basis is stale)
    fill("SELL", 150, 10.5, { time: 5000 }),
  ];
  const trade = buildTrades(fills)[0]!;
  expect(ids(evaluate(trade, ctx({ fills }), DEFAULT_RULE_CONFIG))).toContain("added_to_loser");
});

// A closed LONG trade with no enrichment set; individual tests override fields.
function base(): Trade {
  return {
    id: "t",
    account: "acc1",
    symbol: "AAPL",
    currency: "USD",
    direction: "LONG",
    status: "closed",
    openTime: 1000,
    closeTime: 2000,
    avgEntry: 10,
    avgExit: 11,
    maxQty: 100,
    realizedPnl: 100,
    realizedSoFar: 100,
    fees: 0,
    holdSeconds: 1,
    coverageOk: true,
    fillIds: [],
    effectiveStop: null,
    liveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: null,
    mae: null,
    mfe: null,
    stopUnreliable: false,
  };
}
