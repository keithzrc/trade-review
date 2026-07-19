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
 *   - recovered: the CLOSING exit sat more than `stopDistance × recoverMult` above the adverse low,
 *     so the trade didn't close at the breach. A genuine gap/slippage stop-out fails this (it closes
 *     AT the low, recovery ≈ 0) and therefore keeps its excess_loss flag.
 *
 * `closingExit` is the price of the fill that actually CLOSED the position (the last exit), NOT the
 * volume-weighted avgExit: a trade that scales out at a profit early and is then stopped on the rest
 * has an avgExit well above its low, which would fake a recovery — the closing fill is what tells us
 * whether the final shares were stopped at the low or exited higher.
 */
export function isUnreliableStop(args: {
  direction: Trade["direction"];
  avgEntry: number;
  closingExit: number | null;
  realizedPnl: number | null;
  stop: number | null;
  mae: number | null;
  manual: boolean;
  recoverMult: number;
}): boolean {
  const { direction, avgEntry, closingExit, realizedPnl, stop, mae, manual, recoverMult } = args;
  if (manual || stop === null || mae === null || closingExit === null || realizedPnl === null) return false;
  if (realizedPnl >= 0) return false; // losers only

  const stopDistance = Math.abs(avgEntry - stop);
  if (stopDistance <= EPS) return false;

  const breached = mae > stopDistance;
  // How adverse the CLOSING price was vs entry; the rest of `mae` is how far the close sat above the
  // adverse low (a genuine post-breach recovery, not an early profit-taking leg inflating avgExit).
  const adverseAtClose = direction === "LONG" ? avgEntry - closingExit : closingExit - avgEntry;
  const recovery = mae - adverseAtClose;
  const recovered = recovery > stopDistance * recoverMult;

  return breached && recovered;
}
