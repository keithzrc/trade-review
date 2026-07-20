# Unreliable-stop detection — design

## Problem

FUTU stores one row per order carrying its **current** trigger, not its history. When a stop is
trailed or manually moved, we only see the final trigger. `stop-inference` then treats that final
value as the trade's *initial* planned stop, and `risk.ts` computes `1R = |entry − stop| × qty` from
it.

Observed on the real **AMD** trade: entry 511.17, a stop recorded at **510.89** (only $0.28 below
entry), so `risk = 1.12` and the −$11.24 loss reads as **R = −10** — firing a false `excess_loss`
(and a hypersensitive `round_tripped_gain`). It cannot have been the resting stop: the price hit
**498.15 on day 2** while the position stayed open for 9 days. The true initial stop is
unrecoverable from the data.

The user asked for automatic detection (not just the manual-stop override), scoped to **losers**,
surfaced via a **dedicated flag**.

## Core idea — "breached mid-hold but survived"

A resting stop order triggers *intrabar* the moment price touches its trigger. So if a candle that
**closed while the trade was still open** printed a low past the inferred stop, that stop cannot have
been protecting the trade at that level — it was trailed, moved, cancelled, or simply isn't the real
initial stop. That physical fact is the whole signal, and it needs no exit-price reasoning (earlier
attempts compared `avgExit`/closing-fill prices and kept misreading multi-fill and split stop-outs).

`heldAdverseExcursion` (in `core/mae-mfe.ts`) computes the worst adverse move over the **fully-inside
bars** — candles that both opened and closed within `[openTime, closeTime)`, excluding the exit bar
and the fills themselves. A genuine stop-out's adverse low lives in the *exit* bar (excluded), so a
split/gap/multi-fill close can't fake a breach.

For a closed **losing** trade with an order-inferred (non-manual) stop, let
`stopDistance = |avgEntry − stop|`. The stop is **unreliable** when
`heldMae > stopDistance × recoverMult` (default `recoverMult = 1`): price ran at least a full
stop-width past the stop in a bar that closed mid-hold, yet the trade lived on.

### Validation against real trades
- **AMD**: stopDistance 0.28, mid-hold low 498.15 → heldMae ≈ 12.7 ≫ 0.28 → **unreliable**.
- **ANET** (a clean −0.97R loss): it exited just above its stop; no fully-inside bar breached the
  stop → heldMae stays shallow → **untouched**, keeps its R.
- **INTC** (live DB): entry 120.61, stop 119.46 (stopDistance 1.15); a mid-hold bar closed at 118.06
  (heldMae 2.55 > 1.15) yet the trade exited at 119.52 for −0.95R → **unreliable**. A textbook
  survived breach: the recorded stop plainly wasn't protecting at 119.46.

## Behavior when detected — flag for input, don't rewrite the money

We **do not** void `risk`/`rMultiple`. We can't be certain a stop was *trailed* versus simply *blown
through*, and the user is the one who set the stop — so the tool should not authoritatively rewrite
its money math. Instead:

- **Keep `risk`/`rMultiple` computed and visible per-trade**, with a caveat in the risk-basis panel
  prompting the user to enter a **Manual stop** (the authoritative override) if the inferred one is
  wrong. Manual stops are exempt from detection.
- **Persist a derived `stopUnreliable: boolean` on the Trade** (new stored column, migration v11),
  rebuilt every sync alongside `risk`/`mae`. This is what analytics and the rule-engine read.
- **Exclude flagged trades from every stop-derived aggregate** — `avgR`, `avgWinR`/`avgLossR`,
  `payoutRatio`, `breakevenWinRate`, `rCount`, `avgRisk`, `avgRiskPct` — so a fabricated −10R can't
  poison the averages. Their **P&L, win rate, position size, and MAE/MFE still count** (none depend on
  the stop), so realized results stay whole.
- **Suppress the R/risk-derived judgement flags** on the flagged trade — `excess_loss`,
  `round_tripped_gain`, `wide_stop`, `oversized` — via a `riskBasisTrusted` guard in the rule-engine.
  Asserting "loss reached −10R" off a suspect 1R would mislead even though R is shown.
- Fire the dedicated **`unreliable_stop`** flag (kind `hygiene`, severity `warn`) explaining it and
  pointing at the Manual-stop remedy. `no_stop` is untouched — an unreliable stop still yields a
  non-null risk, so it never lands there.

The `effectiveStop`/`liveStop` are **kept** — the stop is real and still drawn on the chart.

### Degrade-safe carry across a candle outage
The verdict needs candles; on an outage (no bars) `heldMae` is null and the check reads reliable. To
stop the flag (and its R-average exclusion) flickering off until candles return, carry the **prior**
`stopUnreliable` verdict when nothing that feeds it changed: same fills AND the same present
loss-side stop basis (a newly-added manual/order stop recomputes normally). Mirrors the mae carry.

## Components & data flow

Pipeline order is unchanged (`trade-builder → stop-inference → risk → mae-mfe → analytics →
rule-engine`); detection slots into the sync enrichment loop after `heldMae` is known.

- **`src/core/stop-reliability.ts`** (pure): `isUnreliableStop({ avgEntry, realizedPnl, stop,
  heldMae, manual, recoverMult }) → boolean`. False unless a non-manual stop, a closed loss, a
  positive stopDistance, and `heldMae > stopDistance × recoverMult`. Exhaustively fixture-tested.
- **`src/core/mae-mfe.ts`**: `heldAdverseExcursion(trade, candles, resolution)` over fully-inside bars.
- **`src/sync/sync.ts`** enrichment loop: compute `stopUnreliable` (live verdict, or carried across an
  outage); set it on the enriched Trade. `risk`/`rMultiple` are left as computed.
- **`src/store/migrations.ts` / `repos.ts`**: migration v11 adds `stop_unreliable INTEGER NOT NULL
  DEFAULT 0`; `replaceDerived` writes it, `allTrades` reads it.
- **`src/domain/types.ts`**: add `stopUnreliable: boolean` to `Trade`; `unreliableStopRecoverR: number`
  (default **1**) on `RuleConfig` + `DEFAULT_RULE_CONFIG`. (`RuleContext` carries no stop signal now.)
- **`src/core/analytics.ts`**: `summarize()` builds the stop-derived aggregates from
  `trades.filter(t => !t.stopUnreliable)`; P&L/size/excursion use all eligible trades.
- **`src/core/rule-engine.ts`**: `riskBasisTrusted = !trade.stopUnreliable` guards the four R/risk
  flags; `unreliable_stop` fires on `trade.stopUnreliable`.
- **`src/domain/flag-defs.ts`**: the `unreliable_stop` def (category `stop-risk`, kind `hygiene`, warn).
- **`web/screens/TradeDetail.tsx`**: a caveat under the (visible) risk formula when `t.stopUnreliable`
  and no manual stop, prompting a Manual stop and noting the R-average exclusion.

## Thresholds
- **Breach/recovery (single test)**: `heldMae > stopDistance × unreliableStopRecoverR`, default
  `recoverMult = 1` (price cleared a full stop-width past the stop in a bar that closed mid-hold).
  Tunable via config without code changes. Normal stop-outs put their adverse low in the excluded exit
  bar, so `heldMae` stays shallow and never clears it.

## Testing
- `test/core/stop-reliability.test.ts`: breached mid-hold → true; shallow/exit-bar-only → false;
  winner (losers-only); manual stop; null inputs; SHORT mirror.
- `test/core/mae-mfe.test.ts`: `heldAdverseExcursion` over fully-inside bars (excludes exit bar/fills).
- `test/core/rule-engine.test.ts`: `unreliable_stop` fires from `trade.stopUnreliable`; the four
  R/risk flags are suppressed on a flagged trade (R still present).
- `test/core/analytics.test.ts`: a flagged trade drops out of the R/risk aggregates but stays in
  netPnl/tradeCount/position-size.
- `test/sync/sync.test.ts`: an AMD-shaped trade ends `stopUnreliable` with R **visible** and
  `excess_loss` suppressed; a split-fill exit-bar stop-out keeps its R; the flag carries across a
  candle outage.

## Out of scope
- Recovering the true initial stop (impossible from FUTU's single-row order data).
- Winners (kept per the losers-only decision).
- Any change to the manual-stop override, which remains the precise per-trade escape hatch.

## Design note — why flag-for-input, not auto-void
Earlier iterations auto-voided `risk`/`rMultiple` on detection. Repeated review surfaced edge cases in
authoritatively rewriting money math from an inference we can't fully trust (trailed vs blown-through
is genuinely ambiguous). The tool's job here is to *surface* the suspect basis and let the user
confirm it (they set the stop), not to silently overwrite R. Hence: detect → keep R visible → flag
for input → exclude from averages. The manual-stop override then produces a trustworthy R on demand.
