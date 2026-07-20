import { describe, expect, test } from "bun:test";
import { heatmapMetrics } from "../../src/core/heatmap";
import type { Candle } from "../../src/domain/types";

const DAY = 86_400_000;

/** Daily bar helper: flat OHLC at `close` unless a high is given. */
function bar(time: number, close: number, high = close): Candle {
  return { time, open: close, high, low: close, close, volume: 0 };
}

/** N consecutive daily bars ending at `end`, all at `close`. */
function flatSeries(end: number, n: number, close: number): Candle[] {
  const out: Candle[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(bar(end - i * DAY, close));
  return out;
}

describe("heatmapMetrics", () => {
  test("empty series → all nulls", () => {
    expect(heatmapMetrics([])).toEqual({
      last: null, dayPct: null, p5dPct: null, p20dPct: null, p1mPct: null,
      ma20Pct: null, ma50Pct: null, volVs20d: null, off52wPct: null, ytdPct: null,
    });
  });

  test("20d / 1-month returns use sessions; short series → null", () => {
    const end = Date.UTC(2026, 6, 17);
    const bars = flatSeries(end, 22, 100);
    bars[0] = bar(end - 21 * DAY, 80); // 21 sessions back → the 1M baseline
    bars[1] = bar(end - 20 * DAY, 90); // 20 sessions back → the 20d baseline
    bars[bars.length - 1] = bar(end, 108);
    const m = heatmapMetrics(bars);
    expect(m.p20dPct).toBeCloseTo(108 / 90 - 1, 10);
    expect(m.p1mPct).toBeCloseTo(108 / 80 - 1, 10);
    const short = heatmapMetrics(flatSeries(end, 10, 100));
    expect(short.p20dPct).toBeNull();
    expect(short.p1mPct).toBeNull();
  });

  test("distance from the 20/50-session SMAs needs a full window", () => {
    const end = Date.UTC(2026, 6, 17);
    const bars = flatSeries(end, 20, 100);
    bars[bars.length - 1] = bar(end, 110); // 19×100 + 110 → SMA20 = 100.5
    const m = heatmapMetrics(bars);
    expect(m.ma20Pct).toBeCloseTo(110 / 100.5 - 1, 10);
    expect(m.ma50Pct).toBeNull(); // only 20 bars — no honest 50-SMA
  });

  test("volume vs 20d averages the PRIOR 20 sessions, excluding today's spike", () => {
    const end = Date.UTC(2026, 6, 17);
    const bars = flatSeries(end, 21, 100).map((b, i, all) => ({
      ...b,
      volume: i === all.length - 1 ? 3000 : 1000,
    }));
    expect(heatmapMetrics(bars).volVs20d).toBeCloseTo(3, 10); // 3000 vs avg 1000 — measured against normal days
    expect(heatmapMetrics(bars.slice(1)).volVs20d).toBeNull(); // 20 bars → only 19 prior — not a full window
  });

  test("single bar → last only; every % lacks a baseline", () => {
    const m = heatmapMetrics([bar(Date.UTC(2026, 6, 17), 100)]);
    expect(m.last).toBe(100);
    expect(m.dayPct).toBeNull();
    expect(m.p5dPct).toBeNull();
    expect(m.ytdPct).toBeNull();
    // its own high IS the 52w high → exactly at the high
    expect(m.off52wPct).toBe(0);
  });

  test("day / 5-day changes use sessions, not calendar days", () => {
    const end = Date.UTC(2026, 6, 17);
    const bars = flatSeries(end, 7, 100);
    bars[bars.length - 7] = bar(end - 6 * DAY, 80); // beyond the 5-session lookback — ignored
    bars[bars.length - 6] = bar(end - 5 * DAY, 90); // the 5-sessions-ago close
    bars[bars.length - 2] = bar(end - 1 * DAY, 96); // yesterday
    bars[bars.length - 1] = bar(end, 102);
    const m = heatmapMetrics(bars);
    expect(m.dayPct).toBeCloseTo(102 / 96 - 1, 10);
    expect(m.p5dPct).toBeCloseTo(102 / 90 - 1, 10);
  });

  test("off 52-wk high uses intraday highs within 365 days, including today's own", () => {
    const end = Date.UTC(2026, 6, 17);
    const bars = [
      bar(end - 400 * DAY, 100, 500), // spike OUTSIDE the trailing year — must not count
      bar(end - 100 * DAY, 100, 120),
      bar(end - 1 * DAY, 100),
      bar(end, 102, 105),
    ];
    const m = heatmapMetrics(bars);
    expect(m.off52wPct).toBeCloseTo(102 / 120 - 1, 10);
    // fresh breakout: today's high is the 52w high → ~0, never positive
    const b2 = [bar(end - 10 * DAY, 100), bar(end, 130, 131)];
    expect(heatmapMetrics(b2).off52wPct).toBeCloseTo(130 / 131 - 1, 10);
  });

  test("YTD baselines on the last close BEFORE Jan 1 of the latest bar's year", () => {
    const bars = [
      bar(Date.UTC(2025, 11, 30), 90),
      bar(Date.UTC(2025, 11, 31), 100), // prior-year close — the baseline
      bar(Date.UTC(2026, 0, 2), 104),
      bar(Date.UTC(2026, 6, 17), 125),
    ];
    expect(heatmapMetrics(bars).ytdPct).toBeCloseTo(0.25, 10);
  });

  test("listed this year → no prior-year close → ytd null", () => {
    const bars = [bar(Date.UTC(2026, 2, 1), 50), bar(Date.UTC(2026, 6, 17), 60)];
    expect(heatmapMetrics(bars).ytdPct).toBeNull();
  });

  test("unsorted input is tolerated (sorted internally, input not mutated)", () => {
    const a = bar(Date.UTC(2026, 6, 16), 100);
    const b = bar(Date.UTC(2026, 6, 17), 110);
    const input = [b, a];
    const m = heatmapMetrics(input);
    expect(m.last).toBe(110);
    expect(m.dayPct).toBeCloseTo(0.1, 10);
    expect(input[0]).toBe(b); // caller's array untouched
  });
});
