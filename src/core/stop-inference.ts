import type { RawOrder, StopInfo, Trade } from "../domain/types";

const STOP_TYPES = new Set(["STOP", "STOP_LIMIT", "TRAILING_STOP"]);
const EPS = 1e-9;

/** Substrings of FUTU statuses meaning the order never rested in the book — not a real stop. */
const DEAD_STATUS = ["FAIL", "REJECT", "DISABLED", "DELETED", "TIMEOUT", "EXPIRED", "INVALID"];

function isDead(status: string): boolean {
  const s = status.toUpperCase();
  return DEAD_STATUS.some((d) => s.includes(d));
}

/** Substrings meaning a once-resting order is no longer working: the user cancelled it (CANCELLING_*,
 * CANCELLED_*, FILL_CANCELLED) or it fully executed (FILLED_ALL). A FILLED_PART stop still rests for
 * its remainder, so it stays "working". Used only to pick the currently-live stop, never the post-hoc
 * effective one. */
const GONE_STATUS = ["CANCEL", "FILLED_ALL"];

function isGone(status: string): boolean {
  const s = status.toUpperCase();
  return GONE_STATUS.some((g) => s.includes(g));
}

/** The side of an order that would REDUCE this trade's position. */
function closingSide(trade: Trade): "BUY" | "SELL" {
  return trade.direction === "LONG" ? "SELL" : "BUY";
}

/** Recency of an order — a modified stop bumps updateTime but not createTime. */
function orderTime(o: RawOrder): number {
  return Math.max(o.createTime, o.updateTime ?? o.createTime);
}

/** An order that plausibly protected this trade: same instrument/account, closing side,
 * not dead-on-arrival, size within the position, and live during the trade's window. */
function isProtective(trade: Trade, o: RawOrder): boolean {
  if (o.account !== trade.account || o.symbol !== trade.symbol) return false;
  if (o.side !== closingSide(trade)) return false;
  if (isDead(o.status)) return false;
  if (o.qty > trade.maxQty + EPS) return false;
  if (orderTime(o) < trade.openTime) return false;
  if (trade.closeTime !== null && o.createTime > trade.closeTime) return false;
  return true;
}

function byTime(a: RawOrder, b: RawOrder): number {
  return orderTime(a) - orderTime(b) || a.id.localeCompare(b.id); // stable tie-break
}

/** Protective stop-type orders for this trade, earliest → latest. Any closing-side stop-type order
 * counts — regardless of whether the trigger is below entry (a loss stop) or at/above it (breakeven
 * or trailed-into-profit stop). Shared by inferStops and protectiveStopTimeline. */
function protectiveStops(trade: Trade, orders: RawOrder[]): RawOrder[] {
  return orders
    .filter((o) => isProtective(trade, o))
    .filter((o) => STOP_TYPES.has(o.type) && o.triggerPrice !== null)
    .sort(byTime);
}

export function inferStops(trade: Trade, orders: RawOrder[]): StopInfo {
  const protective = orders.filter((o) => isProtective(trade, o));

  const stops = protectiveStops(trade, orders);

  // Take-profit: a closing-side limit resting on the profit side of entry.
  const tps = protective
    .filter(
      (o) =>
        o.type === "LIMIT" &&
        o.price !== null &&
        (trade.direction === "LONG" ? o.price > trade.avgEntry : o.price < trade.avgEntry),
    )
    .sort(byTime);

  const initial = stops[0] ?? null;
  const effective = stops[stops.length - 1] ?? null;
  const tp = tps[tps.length - 1] ?? null;
  // The latest stop that hasn't been cancelled or fully filled — the one actually protecting right now.
  const liveStops = stops.filter((o) => !isGone(o.status));
  const live = liveStops[liveStops.length - 1] ?? null;

  return {
    initialStop: initial?.triggerPrice ?? null,
    initialStopType: initial?.type ?? null,
    effectiveStop: effective?.triggerPrice ?? null,
    effectiveTp: tp?.price ?? null,
    stopOrderId: effective?.id ?? null,
    stopQty: effective?.qty ?? null,
    receipt: effective
      ? `${effective.side} ${effective.type} ${effective.qty} @ ${effective.triggerPrice} (order ${effective.id})`
      : null,
    liveStop: live?.triggerPrice ?? null,
    liveStopQty: live?.qty ?? null,
  };
}
