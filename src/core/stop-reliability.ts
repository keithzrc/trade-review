const EPS = 1e-9;

/**
 * True when an ORDER-INFERRED stop can't be the trade's real initial-risk basis — the price ran PAST
 * the stop while the trade was demonstrably still open (a bar that closed DURING the hold traded past
 * it). A stop resting at that level would have closed the trade there; surviving it means the reported
 * trigger is a later, trailed/moved value, so `|entry − stop|` is a bogus 1R (FUTU stores only an
 * order's current trigger, not its history — see docs/superpowers/specs/…-unreliable-stop-detection).
 *
 * `heldMae` is the mid-hold adverse excursion (`heldAdverseExcursion` — from bars that closed inside
 * the hold, EXCLUDING the exit bar and the fills). Keying off it, not exit prices, is what makes a
 * multi-fill stop-out read correctly: a genuine stop-out's adverse low sits in the excluded EXIT bar,
 * so `heldMae` doesn't see it — no matter how the closing prints are split or ordered.
 *
 * Scoped to closed LOSERS: that's where a trailed-to-breakeven stop produces the alarming
 * large-magnitude R. A MANUAL stop is the user's explicit assertion, so it is never second-guessed.
 * `recoverMult` (× stop distance) is the margin the mid-hold low must clear past the stop, guarding
 * against an intrabar wick that merely grazed it.
 */
export function isUnreliableStop(args: {
  avgEntry: number;
  realizedPnl: number | null;
  stop: number | null;
  heldMae: number | null;
  manual: boolean;
  recoverMult: number;
}): boolean {
  const { avgEntry, realizedPnl, stop, heldMae, manual, recoverMult } = args;
  if (manual || stop === null || heldMae === null || realizedPnl === null) return false;
  if (realizedPnl >= 0) return false; // losers only

  const stopDistance = Math.abs(avgEntry - stop);
  if (stopDistance <= EPS) return false;

  // Price went more than `recoverMult` stop-widths past the stop in a bar that closed while the trade
  // was still open → the stop wasn't resting there. (A stop-out's low lives in the excluded exit bar.)
  return heldMae > stopDistance * recoverMult;
}
