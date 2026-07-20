// Pure math for the Daily market heatmap: turn one symbol's DAILY candle series into the four
// percentages the page shows (mirroring a classic daily-plan sheet): % day change, % 5-day change,
// % off the 52-week high, and % YTD. No I/O — candle fetching lives in the API layer.
import type { Candle } from "../domain/types";

export interface HeatmapMetrics {
  last: number | null; // latest close (null when the series is empty)
  dayPct: number | null; // last close vs previous session's close
  p5dPct: number | null; // last close vs the close 5 SESSIONS earlier (bars, not calendar days)
  p20dPct: number | null; // last close vs the close 20 sessions earlier (the RS-vs-SPY ingredient)
  p1mPct: number | null; // "1-month" return: last close vs the close 21 sessions earlier
  ma20Pct: number | null; // last close vs its 20-session SMA (needs a full 20 bars, else null)
  ma50Pct: number | null; // last close vs its 50-session SMA (needs a full 50 bars, else null)
  volVs20d: number | null; // latest volume ÷ average volume of the PRIOR 20 sessions (a ratio, 1 = normal)
  off52wPct: number | null; // last close vs the max HIGH over the trailing 365 calendar days (≤ 0)
  ytdPct: number | null; // last close vs the final close of the previous calendar year
}

const EMPTY: HeatmapMetrics = {
  last: null, dayPct: null, p5dPct: null, p20dPct: null, p1mPct: null,
  ma20Pct: null, ma50Pct: null, volVs20d: null, off52wPct: null, ytdPct: null,
};

const YEAR_MS = 365 * 86_400_000;

function pctFrom(base: number | undefined, last: number): number | null {
  return base !== undefined && base > 0 ? last / base - 1 : null;
}

/** Compute the heatmap row from ascending daily candles. Every metric degrades to null when its
 * baseline isn't in the series (new listing, short fetch window) — never a throw, never a fake 0.
 * The YTD baseline is the LAST bar strictly before Jan 1 (UTC) of the latest bar's year, the common
 * "close of prior year" convention; a symbol listed this year has no such bar → null. */
export function heatmapMetrics(candles: Candle[]): HeatmapMetrics {
  if (candles.length === 0) return EMPTY;
  const bars = candles.slice().sort((a, b) => a.time - b.time);
  const lastBar = bars[bars.length - 1]!;
  const last = lastBar.close;

  const closeBack = (sessions: number) => bars[bars.length - 1 - sessions]?.close;
  const dayPct = pctFrom(closeBack(1), last);
  const p5dPct = pctFrom(closeBack(5), last);
  const p20dPct = pctFrom(closeBack(20), last);
  const p1mPct = pctFrom(closeBack(21), last); // ~21 trading sessions per calendar month

  // Distance from the 20/50-session SMAs (including today's close). A short series gives null rather
  // than a misleading average over fewer bars.
  const sma = (n: number): number | null => {
    if (bars.length < n) return null;
    let sum = 0;
    for (let i = bars.length - n; i < bars.length; i++) sum += bars[i]!.close;
    return sum / n;
  };
  const ma20 = sma(20);
  const ma50 = sma(50);
  const ma20Pct = ma20 !== null && ma20 > 0 ? last / ma20 - 1 : null;
  const ma50Pct = ma50 !== null && ma50 > 0 ? last / ma50 - 1 : null;

  // Today's volume vs the average of the PRIOR 20 sessions (today excluded, so a volume spike is
  // measured against normal days, not against itself).
  let volVs20d: number | null = null;
  if (bars.length >= 21) {
    let vsum = 0;
    for (let i = bars.length - 21; i < bars.length - 1; i++) vsum += bars[i]!.volume;
    const avg = vsum / 20;
    volVs20d = avg > 0 ? lastBar.volume / avg : null;
  }

  // 52-week high: intraday highs (not closes) over the trailing 365 calendar days, INCLUDING today's
  // own high — so a fresh breakout correctly reads ~0% off high, not a positive %.
  let hi = 0;
  for (const b of bars) {
    if (b.time >= lastBar.time - YEAR_MS && b.high > hi) hi = b.high;
  }
  const off52wPct = hi > 0 ? last / hi - 1 : null;

  const jan1 = Date.UTC(new Date(lastBar.time).getUTCFullYear(), 0, 1);
  let prevYearClose: number | undefined;
  for (const b of bars) {
    if (b.time < jan1) prevYearClose = b.close;
    else break;
  }
  const ytdPct = pctFrom(prevYearClose, last);

  return { last, dayPct, p5dPct, p20dPct, p1mPct, ma20Pct, ma50Pct, volVs20d, off52wPct, ytdPct };
}
