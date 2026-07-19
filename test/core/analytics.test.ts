import { test, expect } from "bun:test";
import { computeStats, breakdown } from "../../src/core/analytics";
import type { Trade } from "../../src/domain/types";

// Minimal closed-trade factory (only the fields analytics reads).
function tr(over: Partial<Trade>): Trade {
  return {
    id: over.id ?? "t",
    account: "acc1",
    symbol: over.symbol ?? "AAPL",
    currency: over.currency ?? "USD",
    direction: "LONG",
    status: "closed",
    openTime: over.openTime ?? 1000,
    closeTime: over.closeTime ?? 2000,
    avgEntry: over.avgEntry ?? 10,
    avgExit: 11,
    maxQty: over.maxQty ?? 100,
    realizedPnl: over.realizedPnl ?? 0,
    realizedSoFar: over.realizedSoFar ?? 0,
    fees: 0,
    holdSeconds: 0,
    coverageOk: over.coverageOk ?? true,
    fillIds: [],
    effectiveStop: null,
    liveStop: null,
    effectiveTp: null,
    risk: over.risk ?? null,
    rMultiple: over.rMultiple ?? null,
    mae: over.mae ?? null,
    mfe: over.mfe ?? null,
    stopUnreliable: over.stopUnreliable ?? false,
  };
}

test("segments P&L by currency; never sums across currencies", () => {
  const s = computeStats([
    tr({ currency: "USD", realizedPnl: 100 }),
    tr({ currency: "USD", realizedPnl: -40 }),
    tr({ currency: "HKD", realizedPnl: 500 }),
  ]);
  const usd = s.byCurrency.find((c) => c.currency === "USD")!;
  const hkd = s.byCurrency.find((c) => c.currency === "HKD")!;
  expect(usd.netPnl).toBe(60);
  expect(usd.tradeCount).toBe(2);
  expect(hkd.netPnl).toBe(500);
});

test("win rate, avg win/loss, expectancy", () => {
  const s = computeStats([
    tr({ realizedPnl: 200 }),
    tr({ realizedPnl: 100 }),
    tr({ realizedPnl: -100 }),
    tr({ realizedPnl: -50 }),
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.winRate).toBe(0.5);
  expect(usd.avgWin).toBe(150);
  expect(usd.avgLoss).toBe(75); // positive magnitude
  expect(usd.expectancy).toBe(0.5 * 150 - 0.5 * 75); // 37.5
});

test("avg/max position size = entry notional (avgEntry × maxQty), per currency", () => {
  const s = computeStats([
    tr({ currency: "USD", avgEntry: 10, maxQty: 100, realizedPnl: 5 }), // notional 1,000
    tr({ currency: "USD", avgEntry: 20, maxQty: 150, realizedPnl: 5 }), // notional 3,000
    tr({ currency: "HKD", avgEntry: 50, maxQty: 40, realizedPnl: 5 }), // notional 2,000 (separate currency)
  ]);
  const usd = s.byCurrency.find((c) => c.currency === "USD")!;
  expect(usd.avgPositionSize).toBe(2000); // (1,000 + 3,000) / 2
  expect(usd.maxPositionSize).toBe(3000);
  expect(s.byCurrency.find((c) => c.currency === "HKD")!.avgPositionSize).toBe(2000);
});

test("avg risk % / size % use the injected equity resolver; null without equity", () => {
  const trades = [
    tr({ currency: "USD", avgEntry: 10, maxQty: 100, risk: 50, realizedPnl: 5 }), // notional 1,000
    tr({ currency: "USD", avgEntry: 20, maxQty: 100, risk: 150, realizedPnl: 5 }), // notional 2,000
  ];
  // No resolver → % are null, dollar averages still computed.
  const bare = computeStats(trades).byCurrency[0]!;
  expect(bare.avgRiskPct).toBeNull();
  expect(bare.avgSizePct).toBeNull();
  expect(bare.avgRisk).toBe(100); // (50 + 150) / 2
  expect(bare.sizingApprox).toBe(false);

  // Equity 10,000 (exact) for every trade → riskPct = {0.5%, 1.5%} avg 1%; sizePct = {10%, 20%} avg 15%.
  const s = computeStats(trades, () => ({ equity: 10_000, approx: false })).byCurrency[0]!;
  expect(s.avgRiskPct).toBeCloseTo(0.01);
  expect(s.avgSizePct).toBeCloseTo(0.15);
  expect(s.sizingApprox).toBe(false);
});

test("sizingApprox is true when any contributing trade used a fallback (approximate) equity", () => {
  const trades = [
    tr({ id: "a", currency: "USD", avgEntry: 10, maxQty: 100, risk: 50, realizedPnl: 5 }),
    tr({ id: "b", currency: "USD", avgEntry: 20, maxQty: 100, risk: 150, realizedPnl: 5 }),
  ];
  // Trade b's equity is a latest-fallback (approx) → the aggregate is flagged approximate.
  const s = computeStats(trades, (t) => ({ equity: 10_000, approx: t.id === "b" })).byCurrency[0]!;
  expect(s.avgRiskPct).toBeCloseTo(0.01);
  expect(s.sizingApprox).toBe(true);
});

test("avg risk % skips trades whose equity is unknown (null resolver result)", () => {
  const trades = [
    tr({ id: "a", currency: "USD", avgEntry: 10, maxQty: 100, risk: 50, realizedPnl: 5 }), // equity known
    tr({ id: "b", currency: "USD", avgEntry: 20, maxQty: 100, risk: 400, realizedPnl: 5 }), // equity unknown → skipped
  ];
  const s = computeStats(trades, (t) => ({ equity: t.id === "a" ? 10_000 : null, approx: false })).byCurrency[0]!;
  expect(s.avgRiskPct).toBeCloseTo(0.005); // only trade a: 50 / 10,000
  expect(s.avgSizePct).toBeCloseTo(0.1); // only trade a: 1,000 / 10,000
});

test("avgR/avgMae/avgMfe ignore trades that lack them; null when none", () => {
  const s = computeStats([
    tr({ realizedPnl: 10, rMultiple: 2, mae: 1, mfe: 3 }),
    tr({ realizedPnl: 10, rMultiple: 4, mae: 3, mfe: 5 }),
    tr({ realizedPnl: 10 }), // no R/mae/mfe
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.avgR).toBe(3); // (2+4)/2
  expect(usd.avgMae).toBe(2);
  expect(usd.avgMfe).toBe(4);

  const none = computeStats([tr({ realizedPnl: 10 })]).byCurrency[0]!;
  expect(none.avgR).toBeNull();
});

test("splits R by outcome; payout ratio and breakeven win rate", () => {
  // Three winners at +3R and one loser at −1R (the 'small losses, big wins' shape).
  const s = computeStats([
    tr({ realizedPnl: 30, rMultiple: 3 }),
    tr({ realizedPnl: 30, rMultiple: 3 }),
    tr({ realizedPnl: 30, rMultiple: 3 }),
    tr({ realizedPnl: -10, rMultiple: -1 }),
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.avgWinR).toBe(3);
  expect(usd.avgLossR).toBe(1); // positive magnitude
  expect(usd.payoutRatio).toBe(3); // 3R ÷ 1R
  expect(usd.breakevenWinRate).toBeCloseTo(0.25); // 1/(1+3) — need to win 25% to break even
});

test("R split ignores trades without an R basis; payout null when a side is missing", () => {
  const s = computeStats([
    tr({ realizedPnl: 20, rMultiple: 2 }),
    tr({ realizedPnl: 10 }), // no stop → excluded from R split
  ]);
  const usd = s.byCurrency[0]!;
  expect(usd.avgWinR).toBe(2);
  expect(usd.avgLossR).toBeNull(); // no losers with an R
  expect(usd.payoutRatio).toBeNull(); // can't form a ratio without a loss side
  expect(usd.breakevenWinRate).toBeNull();
});

test("stopUnreliable trades drop out of the R/risk aggregates but stay in P&L and size", () => {
  // An unreliable-stop trade has a suspect risk basis (its fabricated −10R would poison the averages),
  // so it's excluded from every stop-derived stat — yet it's a real closed trade, so its money still
  // counts. Two clean trades set the trusted averages; the flagged one must not move them.
  const s = computeStats([
    tr({ realizedPnl: 30, rMultiple: 3, risk: 100, maxQty: 100, avgEntry: 10 }),
    tr({ realizedPnl: -10, rMultiple: -1, risk: 100, maxQty: 100, avgEntry: 10 }),
    tr({ realizedPnl: -200, rMultiple: -10, risk: 20, maxQty: 100, avgEntry: 10, stopUnreliable: true }),
  ]);
  const usd = s.byCurrency[0]!;
  // R/risk aggregates: only the two trusted trades.
  expect(usd.avgR).toBe(1); // (3 + −1) / 2 — the −10R is excluded
  expect(usd.rCount).toBe(2);
  expect(usd.avgWinR).toBe(3);
  expect(usd.avgLossR).toBe(1); // only the trusted −1R loser
  expect(usd.payoutRatio).toBe(3);
  expect(usd.avgRisk).toBe(100); // (100 + 100) / 2 — the suspect $20 risk is excluded
  // P&L / size aggregates: all three real trades count.
  expect(usd.netPnl).toBe(-180); // 30 − 10 − 200
  expect(usd.tradeCount).toBe(3);
  expect(usd.avgPositionSize).toBe(1000); // 10 × 100, identical across all three
});

test("excludes open and non-coverage trades", () => {
  const open = tr({ realizedPnl: 999 });
  open.status = "open";
  const s = computeStats([
    tr({ realizedPnl: 100 }),
    open,
    tr({ realizedPnl: 5, coverageOk: false }),
  ]);
  expect(s.byCurrency[0]!.tradeCount).toBe(1);
  expect(s.byCurrency[0]!.netPnl).toBe(100);
});

test("equity curve is cumulative in time order", () => {
  const s = computeStats([
    tr({ realizedPnl: 100, closeTime: 3000 }),
    tr({ realizedPnl: -30, closeTime: 1000 }),
    tr({ realizedPnl: 50, closeTime: 2000 }),
  ]);
  expect(s.byCurrency[0]!.equityCurve).toEqual([
    { time: 1000, cumPnl: -30 },
    { time: 2000, cumPnl: 20 },
    { time: 3000, cumPnl: 120 },
  ]);
});

test("empty input → no currency rows", () => {
  expect(computeStats([]).byCurrency).toEqual([]);
});

test("breakdown groups by a key function and skips null keys", () => {
  const rows = breakdown(
    [
      tr({ symbol: "AAPL", realizedPnl: 100 }),
      tr({ symbol: "AAPL", realizedPnl: -20 }),
      tr({ symbol: "TSLA", realizedPnl: 50 }),
      tr({ symbol: "SKIP", realizedPnl: 999 }),
    ],
    (t) => (t.symbol === "SKIP" ? null : t.symbol),
  );
  const aapl = rows.find((r) => r.key === "AAPL")!;
  expect(aapl.currency).toBe("USD");
  expect(aapl.netPnl).toBe(80);
  expect(aapl.tradeCount).toBe(2);
  expect(aapl.winRate).toBe(0.5);
  expect(rows.find((r) => r.key === "SKIP")).toBeUndefined();
});

test("breakdown keeps currencies separate under the same key", () => {
  const rows = breakdown(
    [
      tr({ symbol: "X", currency: "USD", realizedPnl: 100 }),
      tr({ symbol: "X", currency: "HKD", realizedPnl: 500 }),
    ],
    (t) => t.symbol,
  );
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.currency === "USD" && r.key === "X")!.netPnl).toBe(100);
  expect(rows.find((r) => r.currency === "HKD" && r.key === "X")!.netPnl).toBe(500);
});
