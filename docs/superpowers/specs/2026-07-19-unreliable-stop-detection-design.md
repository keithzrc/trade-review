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

## Core idea — "breached but survived"

After the MAE/MFE boundary-bleed fix, `trade.mae` is a trustworthy worst-adverse-excursion. That
lets us separate a trailed/unreliable stop from a legitimate gap/slippage stop-out **without any
candle re-analysis** — using only values already on the enriched trade:

For a closed **losing** trade with an order-inferred (non-manual) stop, let
`stopDistance = |avgEntry − stop|` and `realizedLossPerShare = avgEntry − avgExit` (LONG; mirrored
for SHORT). The stop is **unreliable** when BOTH hold:

1. **Breached** — `mae > stopDistance`: the price ran past where a resting stop would have triggered.
2. **Recovered** — `mae − realizedLossPerShare > stopDistance × recoverMult`: the trade exited well
   *above* its adverse low, i.e. it did **not** close at the breach.

A real gap/slippage stop-out **fails (2)** — it closes *at* the adverse extreme, so recovery ≈ 0 —
and therefore keeps its `excess_loss` flag. AMD passes both (breached by 12.7, recovered by 10.2).

### Validation against the two real trades
- **AMD**: stopDistance 0.28, mae 13.02, realizedLoss 2.81 → breached (13.02 > 0.28) ✓, recovered
  (10.21 > 0.28) ✓ → **unreliable**. R voided; `excess_loss`/`round_tripped_gain` gone.
- **ANET** (a clean −0.97R loss): stopDistance 3.21, mae 3.11 → breached? 3.11 > 3.21 is **false** →
  **untouched**, keeps its R. (It exited just above its stop — a normal ~1R loss.)

## Behavior when detected

Void the risk basis: set `risk = null` and `rMultiple = null` on the enriched trade. This
automatically:
- hides R in the UI (`—`) and excludes the trade from R- and risk-based analytics (`avgR`,
  `avgWinR`/`avgLossR`, `rCount`, `avgRisk`, …) — an untrustworthy basis shouldn't pollute stats;
- suppresses every R/risk-dependent flag (`excess_loss`, `round_tripped_gain`, `wide_stop`,
  `oversized`) since they require non-null `risk`/`rMultiple`.

The `effectiveStop`/`liveStop` are **kept** — the stop is real and still drawn on the chart; we just
don't trust it as 1R.

A new **`unreliable_stop`** flag explains why. Because voiding risk would otherwise trip `no_stop`
("No loss-limiting stop was found"), `no_stop` is suppressed when this fires — they're mutually
exclusive.

## Components & data flow

Pipeline is unchanged in order (`trade-builder → stop-inference → risk → mae-mfe → analytics →
rule-engine`); the detection slots into the sync enrichment loop after `mae` is known.

- **`src/core/stop-reliability.ts`** (new, pure): `isUnreliableStop({ direction, avgEntry, avgExit,
  realizedPnl, stop, mae, manual, recoverMult }) → boolean`. Returns false unless a non-manual stop,
  a closed loss, and both breached+recovered conditions hold. Exhaustively fixture-tested.
- **`src/sync/sync.ts`** enrichment loop: after computing `risk`, `rMultiple`, and `mae`, call
  `isUnreliableStop(...)` with `initialStop` and `ms != null` (manual). If true, override
  `risk`/`rMultiple` to null and pass `stopUnreliable: true` in the `RuleContext`.
- **`src/core/rule-engine.ts`**: (a) guard `no_stop` with `!ctx.stopUnreliable`; (b) add the
  `unreliable_stop` rule firing on `ctx.stopUnreliable`.
- **`src/domain/types.ts`**: add `stopUnreliable?: boolean` to `RuleContext`; add
  `unreliableStopRecoverR: number` (default **1**) to `RuleConfig` + `DEFAULT_RULE_CONFIG`.
- **`src/domain/flag-defs.ts`**: add the `unreliable_stop` def — category `stop-risk`, kind
  `hygiene` (a data-quality caveat, not a behavior mistake), severity `warn`, with summary/why copy.

No API, migration, or frontend-code changes: the flag registry and types flow to the SPA
automatically; the flag renders through the existing flag UI.

## Thresholds

- **Breach**: `mae > stopDistance` (strict; the price must actually pass the stop).
- **Recovery**: `mae − realizedLossPerShare > stopDistance × unreliableStopRecoverR`, default
  `recoverMult = 1` (the trade came back at least one stop-width from its low). This is the primary
  false-positive guard: normal stop-outs and gap-throughs exit at their low (recovery ≈ 0) and never
  clear it. Tunable via config without code changes.

## Testing

- `test/core/stop-reliability.test.ts`: AMD-like (breached+recovered → true); gap-through / exit-at-low
  (breached, not recovered → false); never-breached (false); winner (false, losers-only); manual stop
  (false); SHORT mirror; null inputs (false).
- `test/core/rule-engine.test.ts`: `unreliable_stop` fires on `ctx.stopUnreliable`; `no_stop`
  suppressed when it does; R/risk-dependent flags don't fire once risk is nulled.
- `test/sync/sync.test.ts`: an AMD-shaped trade (tiny inferred stop, deep MAE, recovered exit) ends
  with `risk`/`rMultiple` null and the `unreliable_stop` flag; a normal stop-out keeps its R.

## Out of scope
- Recovering the true initial stop (impossible from FUTU's single-row order data).
- Winners (kept per the losers-only decision).
- Any change to the manual-stop override, which remains the precise per-trade escape hatch.
