import type { Candle, RawFill, Trade } from "../domain/types";

/** Bars that closed strictly DURING the hold: start at/after openTime AND end at/before closeTime.
 * These are the bars in which the trade was demonstrably still open (entry done, exit not yet) — the
 * straddling entry/exit boundary bars are excluded. Timestamps are bar-START times, so a bar spans
 * [time, time + resolution). */
function fullyInsideBars(trade: Trade, candles: Candle[], resolution: number): Candle[] {
  const end = trade.closeTime ?? Number.POSITIVE_INFINITY;
  return candles.filter((c) => c.time >= trade.openTime && c.time + resolution <= end);
}

/**
 * Worst ADVERSE excursion (per share, >= 0) reached in a bar that closed DURING the hold — i.e. from
 * a fully-inside bar in which NO fill of the trade executed. Distinct from `computeExcursion`'s `mae`
 * (which folds in the exit fill): this answers "how far did price go against the trade while it was
 * demonstrably still open and NOT trading?", used to tell a trade that SURVIVED a breach of its stop
 * (adverse low in a clean mid-hold bar) from one that closed AT the breach.
 *
 * Excluding EVERY bar that contains a fill (not just the closeTime bar) is what makes this correct for
 * a split/scaled exit: a genuine stop-out can liquidate across two bars straddling a candle boundary,
 * and the EARLIER closing fill's bar is still fully inside [openTime, closeTime) — counting its
 * stop-out low would fake a survived breach and wrongly flag the stop unreliable. A bar with any fill
 * is an execution bar; only fill-free mid-hold bars are unambiguously "held, not trading".
 *
 * null when no such clean mid-hold bar exists (too short, all inside bars held a fill, or an outage).
 */
export function heldAdverseExcursion(
  trade: Trade,
  fills: RawFill[],
  candles: Candle[],
  resolution: number,
): number | null {
  const inside = fullyInsideBars(trade, candles, resolution).filter(
    (c) => !fills.some((f) => f.time >= c.time && f.time < c.time + resolution),
  );
  if (inside.length === 0) return null;
  if (trade.direction === "LONG") {
    const lo = Math.min(...inside.map((c) => c.low));
    return Math.max(0, trade.avgEntry - lo);
  }
  const hi = Math.max(...inside.map((c) => c.high));
  return Math.max(0, hi - trade.avgEntry);
}

/**
 * Max adverse/favorable excursion in price points per share, from the trade's avgEntry.
 *
 * `resolution` is the candle bar duration in ms; candle timestamps are bar-START times, so a bar
 * covers [time, time + resolution).
 *
 * Only bars FULLY inside the hold [openTime, end) count. A bar that STRADDLES either boundary would
 * fold in price the trade never experienced: the entry bar's high/low can predate the fill (you
 * bought after an early spike), and the exit bar's can postdate it (price kept moving after you were
 * out). Counting those over-states excursion — a real defect that mis-fired MFE-based flags (e.g. a
 * loss tagged "round-tripped a gain" off a spike that happened before entry). Instead the trade's
 * own fills anchor the range: every entry/exit fill is a real price the trade traded at, inside the
 * window. (avgEntry/avgExit are volume-weighted and can sit BETWEEN fills — a scale-out `50@15, 50@5`
 * averages to 10 and would hide both the +5 high and −5 low.) The fills also bound the excluded
 * boundary bars and cover a trade too short to contain a whole bar.
 *
 * Returns nulls only when NO candles were supplied (a fetch failure), so the caller can keep any
 * previously-computed excursion rather than overwrite it with an anchors-only degrade. Both values >= 0.
 */
export function computeExcursion(
  trade: Trade,
  fills: RawFill[],
  candles: Candle[],
  resolution: number,
): { mae: number | null; mfe: number | null } {
  if (candles.length === 0) return { mae: null, mfe: null };
  // Straddling boundary bars (entry/exit bars) are dropped — the fills cover those edges.
  const inside = fullyInsideBars(trade, candles, resolution);

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const f of fills) {
    if (f.price > hi) hi = f.price;
    if (f.price < lo) lo = f.price;
  }
  for (const c of inside) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  // A real trade always has >=1 fill; guard the fill-less call so hi/lo stay finite.
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return { mae: null, mfe: null };

  const clamp = (n: number) => Math.max(0, n);
  if (trade.direction === "LONG") {
    return { mfe: clamp(hi - trade.avgEntry), mae: clamp(trade.avgEntry - lo) };
  }
  return { mfe: clamp(trade.avgEntry - lo), mae: clamp(hi - trade.avgEntry) };
}
