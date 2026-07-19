import type { Trade } from "../domain/types";

const EPS = 1e-9;

/**
 * True when an ORDER-INFERRED stop can't be the trade's real initial-risk basis — the price ran PAST
 * the stop yet the trade stayed open and RECOVERED (it did not close at that adverse extreme). A stop
 * resting at that level would have closed the trade at the breach; surviving it means the reported
 * trigger is a later, trailed/moved value, so `|entry − stop|` is a bogus 1R (FUTU stores only an
 * order's current trigger, not its history — see docs/superpowers/specs/…-unreliable-stop-detection).
 *
 * Scoped to closed LOSERS: that's where a trailed-to-breakeven stop produces the alarming
 * large-magnitude R. A MANUAL stop is the user's explicit assertion, so it is never second-guessed.
 * Reads `mae` (worst adverse excursion, already boundary-correct), so no candle re-analysis is needed.
 *
 * Two conditions (LONG; SHORT mirrors via the magnitudes below):
 *   - breached: `mae > stopDistance` — the worst excursion passed where a resting stop would trigger;
 *   - recovered: `mae − realizedLossPerShare > stopDistance × recoverMult` — the trade exited well
 *     above its low, so it didn't close at the breach. A genuine gap/slippage stop-out fails this
 *     (it exits AT the low, recovery ≈ 0) and therefore keeps its excess_loss flag.
 */
export function isUnreliableStop(args: {
  direction: Trade["direction"];
  avgEntry: number;
  avgExit: number | null;
  realizedPnl: number | null;
  stop: number | null;
  mae: number | null;
  manual: boolean;
  recoverMult: number;
}): boolean {
  const { direction, avgEntry, avgExit, realizedPnl, stop, mae, manual, recoverMult } = args;
  if (manual || stop === null || mae === null || avgExit === null || realizedPnl === null) return false;
  if (realizedPnl >= 0) return false; // losers only

  const stopDistance = Math.abs(avgEntry - stop);
  if (stopDistance <= EPS) return false;

  const breached = mae > stopDistance;
  // Adverse move that was actually realized at exit; the rest of `mae` is what the trade gave back.
  const realizedLossPerShare = direction === "LONG" ? avgEntry - avgExit : avgExit - avgEntry;
  const recovery = mae - realizedLossPerShare;
  const recovered = recovery > stopDistance * recoverMult;

  return breached && recovered;
}
