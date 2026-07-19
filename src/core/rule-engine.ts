import type { Flag, RawFill, RuleConfig, RuleContext, Trade } from "../domain/types";

const EPS = 1e-9;
const DAY_MS = 24 * 60 * 60_000;

function on(config: RuleConfig, ruleId: string): boolean {
  return config.enabled[ruleId] !== false; // missing = enabled
}

interface Tranche {
  side: "BUY" | "SELL";
  qty: number;
  price: number; // notional-weighted average across the order's fills
  time: number; // earliest fill time of the order
  id: string; // orderId, for a stable tie-break
}

/** Collapse fills into one tranche per order — FUTU splits a single order into multiple fills, and a
 * partial fill is NOT a separate scale-in. Grouping by orderId is what makes the position's real
 * add/reduce structure visible to the pyramid/size rules. Sorted earliest → latest. */
function orderTranches(fills: RawFill[]): Tranche[] {
  const byOrder = new Map<string, { side: "BUY" | "SELL"; qty: number; notional: number; time: number }>();
  for (const f of fills) {
    const cur = byOrder.get(f.orderId);
    if (cur === undefined) {
      byOrder.set(f.orderId, { side: f.side, qty: f.qty, notional: f.qty * f.price, time: f.time });
    } else {
      cur.qty += f.qty;
      cur.notional += f.qty * f.price;
      if (f.time < cur.time) cur.time = f.time;
    }
  }
  return [...byOrder.entries()]
    .map(([id, o]) => ({ side: o.side, qty: o.qty, price: o.notional / o.qty, time: o.time, id }))
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** Did the trader add to the position while it was underwater? Walks per-ORDER tranches, not raw
 * fills — FUTU splits one order into several fills at slightly different prices, and a partial fill
 * printing below the running average is that order finishing, NOT a scale-in into a loser.
 *
 * Known limitation (rare, both directions): a tranche carries its order's notional-weighted price
 * stamped at the order's EARLIEST fill time. When two partials of one order bracket a separate order
 * (A-partial, B, A-remainder), B is compared against A's fully-blended basis — fills that hadn't yet
 * printed when B was placed — so an interleaved add can spuriously fire or an underwater add can be
 * masked. The alternative (grouping only consecutive same-order fills) reintroduces the very false
 * positive this rule fixes. Recovering decision-time basis needs order placement timestamps FUTU
 * doesn't expose; deferred rather than trade one failure mode for another. Same tranche semantics as
 * improperPyramid. */
function addedToLoser(trade: Trade, fills: RawFill[]): boolean {
  let qty = 0; // signed
  let costQty = 0;
  let costVal = 0;
  for (const tr of orderTranches(fills)) {
    const signed = tr.side === "BUY" ? tr.qty : -tr.qty;
    const isAdd = qty === 0 ? true : Math.sign(signed) === Math.sign(qty);
    if (isAdd && qty !== 0) {
      const avg = costVal / costQty;
      // Long underwater when the add price is below avg cost; short when above.
      if (trade.direction === "LONG" ? tr.price < avg - EPS : tr.price > avg + EPS) return true;
    }
    if (isAdd) {
      costQty += tr.qty;
      costVal += tr.qty * tr.price;
      qty += signed;
    } else {
      // reducing — remove shares at the running average cost (avg is unchanged),
      // so a later re-add is compared against the correct basis.
      if (costQty > EPS) {
        const avg = costVal / costQty;
        costQty -= tr.qty;
        costVal -= avg * tr.qty;
      }
      qty += signed;
    }
  }
  return false;
}

/** Did the trader pyramid the wrong way? O'Neil: add only in DECREASING size and near the buy point.
 * Fires if any add is larger than the opening tranche, or priced more than `extendedPct` past the
 * first entry (too extended). Works on per-ORDER tranches so partial fills aren't mistaken for adds.
 *
 * Known limitation (false-negative only): for a trade OPENED by a reversal fill (a single fill that
 * flips through zero), buildTrades links the whole reversal fill to this trade, so the opening
 * tranche's qty is overstated (the real opening is only the post-flip remainder). An oversized later
 * add can then escape the size check. Rare — swing/position traders close then re-enter rather than
 * flip — and never a false POSITIVE. A proper fix needs apportioned per-trade fill quantities from
 * the trade builder; deferred rather than clamp to a wrong number. */
function improperPyramid(trade: Trade, fills: RawFill[], extendedPct: number): boolean {
  let qty = 0; // signed
  let firstQty = 0;
  let firstPrice = 0;
  for (const tr of orderTranches(fills)) {
    const signed = tr.side === "BUY" ? tr.qty : -tr.qty;
    const isAdd = qty === 0 ? true : Math.sign(signed) === Math.sign(qty);
    if (qty === 0) {
      firstQty = tr.qty;
      firstPrice = tr.price;
    } else if (isAdd) {
      if (tr.qty > firstQty + EPS) return true; // add bigger than the initial tranche
      const tooExtended =
        trade.direction === "LONG"
          ? tr.price > firstPrice * (1 + extendedPct) + EPS
          : tr.price < firstPrice * (1 - extendedPct) - EPS;
      if (tooExtended) return true;
    }
    qty += signed;
  }
  return false;
}

/** Average risk of recent closed trades IN THE SAME CURRENCY (never mix HKD and USD sizes). Trades
 * with an unreliable stop are skipped — their risk is a suspect (often fabricated tiny/huge) 1R, so
 * letting it into the baseline would trip or mask `oversized` on a later, trusted trade. */
function avgRecentRisk(recent: Trade[], currency: string): number | null {
  const risks = recent
    .filter((t) => t.currency === currency && t.risk !== null && !t.stopUnreliable)
    .map((t) => t.risk as number);
  if (risks.length === 0) return null;
  return risks.reduce((a, b) => a + b, 0) / risks.length;
}

export function evaluate(trade: Trade, ctx: RuleContext, config: RuleConfig): Flag[] {
  // Seeded trades have incomplete fill history; their enrichment is approximate, so — like
  // analytics — we don't run rules on them (avoids false flags on partial data).
  if (!trade.coverageOk) return [];

  const flags: Flag[] = [];
  const add = (ruleId: string, severity: "info" | "warn", reason: string) => {
    if (on(config, ruleId)) flags.push({ ruleId, severity, reason });
  };

  // added_to_loser
  if (on(config, "added_to_loser") && addedToLoser(trade, ctx.fills)) {
    add("added_to_loser", "warn", "Increased size while the position was underwater.");
  }

  // cut_winner_early
  if (
    on(config, "cut_winner_early") &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl > 0 &&
    trade.rMultiple !== null &&
    trade.rMultiple < config.cutWinnerR
  ) {
    add(
      "cut_winner_early",
      "info",
      `Exited a winner for ${trade.rMultiple.toFixed(2)}R (< ${config.cutWinnerR}R).`,
    );
  }

  // A trade whose inferred stop was judged unreliable has a suspect risk basis: its risk/R are still
  // SHOWN for transparency, but every risk/R-derived judgement flag below (excess_loss, wide_stop,
  // oversized, round_tripped_gain) is suppressed — asserting "loss reached −10R" off a fabricated 1R
  // would mislead. unreliable_stop fires instead, prompting the user to set a Manual stop.
  const riskBasisTrusted = !trade.stopUnreliable;

  // excess_loss — realized loss deeper than the plan (gap, slippage, or a stop not honored).
  if (
    on(config, "excess_loss") &&
    riskBasisTrusted &&
    trade.status === "closed" &&
    trade.rMultiple !== null &&
    trade.rMultiple < -config.excessLossR - EPS
  ) {
    add(
      "excess_loss",
      "warn",
      // The line is the configured excess-loss threshold (default 1.3R), not a flat 1R — say so, or
      // a −1.2R loss looks like it should have flagged when it deliberately doesn't.
      `Loss reached ${trade.rMultiple.toFixed(2)}R — past your ${config.excessLossR}R excess-loss line (planned risk is 1R).`,
    );
  }

  // unreliable_stop — the inferred stop was breached yet the trade stayed open (price ran past it and
  // recovered), so its trigger isn't the real initial risk. R stays visible but the trade is dropped
  // from the R averages; prompt the user to set the stop they actually had so R can be trusted.
  if (on(config, "unreliable_stop") && trade.stopUnreliable) {
    add(
      "unreliable_stop",
      "warn",
      "Price ran past your stop while the trade stayed open — its trigger isn't your initial risk. Set a Manual stop for an accurate R (this trade is excluded from your R averages).",
    );
  }

  // no_stop — no loss-limiting stop basis (risk is null: no stop, profit-side stop, or split-corrupt).
  // (An unreliable stop still yields a non-null risk, so it never lands here.)
  if (on(config, "no_stop") && trade.risk === null) {
    add("no_stop", "warn", "No loss-limiting stop was found for this trade.");
  }

  // wide_stop — the planned stop sits further than the max-loss cap from entry. Reads `trade.risk`
  // (= |entry−stop| × size, and null for profit-side/split-corrupted stops) so it inherits risk.ts's
  // guard and never fires on a profit-protecting stop.
  if (
    on(config, "wide_stop") &&
    riskBasisTrusted &&
    trade.risk !== null &&
    trade.maxQty > EPS &&
    trade.avgEntry > EPS
  ) {
    const stopPct = trade.risk / trade.maxQty / trade.avgEntry;
    if (stopPct > config.maxStopPct + EPS) {
      add("wide_stop", "warn", `Stop was ${(stopPct * 100).toFixed(1)}% from entry — wider than your ${config.maxStopPct * 100}% cap.`);
    }
  }

  // improper_pyramid — added in increasing size, or too far past the initial buy point.
  if (on(config, "improper_pyramid") && improperPyramid(trade, ctx.fills, config.pyramidExtendedPct)) {
    add("improper_pyramid", "info", "Pyramided in increasing size or well past your initial entry.");
  }

  // overtrading_freq — more new positions opened in the trailing window than the churn threshold.
  // Counts PRIOR opens by time (ctx.recentOpens), so positions still being held are counted too.
  if (on(config, "overtrading_freq")) {
    const windowMs = config.overtradeWindowDays * DAY_MS;
    const opensInWindow =
      1 + // this trade
      (ctx.recentOpens ?? []).filter(
        (openTime) => trade.openTime - openTime >= 0 && trade.openTime - openTime <= windowMs,
      ).length;
    if (opensInWindow > config.overtradeMaxOpens) {
      add(
        "overtrading_freq",
        "info",
        `${opensInWindow} positions opened within ${config.overtradeWindowDays} day(s).`,
      );
    }
  }

  // oversized
  if (on(config, "oversized") && riskBasisTrusted && trade.risk !== null) {
    const avg = avgRecentRisk(ctx.recentClosedTrades, trade.currency);
    if (avg !== null && avg > EPS && trade.risk > config.oversizedMult * avg) {
      add(
        "oversized",
        "warn",
        `Risk was ${(trade.risk / avg).toFixed(1)}x your recent average.`,
      );
    }
  }

  // round_tripped_gain
  if (
    on(config, "round_tripped_gain") &&
    riskBasisTrusted &&
    trade.status === "closed" &&
    trade.realizedPnl !== null &&
    trade.realizedPnl <= 0 &&
    trade.mfe !== null &&
    trade.risk !== null &&
    trade.risk > EPS &&
    trade.mfe * trade.maxQty >= config.roundTripR * trade.risk
  ) {
    add("round_tripped_gain", "info", "Gave back a gain that reached your target and closed flat/red.");
  }

  // overtrading_revenge
  if (on(config, "overtrading_revenge")) {
    const windowMs = config.revengeMinutes * 60_000;
    const revenge = ctx.recentClosedTrades.some(
      (p) =>
        p.id !== trade.id && // never let a trade flag itself
        p.realizedPnl !== null &&
        p.realizedPnl < 0 &&
        p.closeTime !== null &&
        trade.openTime - p.closeTime >= 0 &&
        trade.openTime - p.closeTime <= windowMs,
    );
    if (revenge) {
      add(
        "overtrading_revenge",
        "warn",
        `Opened within ${config.revengeMinutes} min of closing a losing trade.`,
      );
    }
  }

  return flags;
}
