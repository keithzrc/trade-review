import type { Direction, RawFill, SeedPosition, Trade } from "../domain/types";

/** Tolerance for position comparisons — fractional shares make exact 0 unreliable. */
const EPS = 1e-9;

interface Acc {
  account: string;
  symbol: string;
  currency: string;
  direction: Direction;
  openTime: number;
  openId: string; // id of the opening fill (or "seed") — makes the trade id collision-safe
  entryQty: number; // LIFETIME shares entered (never reduced) — feeds avgEntry + closed realizedPnl
  entryValue: number; // LIFETIME entry notional (never reduced)
  exitQty: number;
  exitValue: number;
  // Moving-average basis of the shares STILL HELD (fees folded in), reduced as shares are sold — the
  // correct cost basis for realized-so-far, independent of the lifetime entry totals above.
  remainingQty: number;
  remainingBasis: number;
  realizedSoFar: number; // profit BOOKED at each exit against the remaining basis as-of that exit (see applyExit)
  fees: number;
  maxQty: number;
  position: number; // signed
  fillIds: string[];
  lastTime: number;
  coverageOk: boolean;
}

function isZero(n: number): boolean {
  return Math.abs(n) < EPS;
}

function sign(n: number): number {
  return isZero(n) ? 0 : n > 0 ? 1 : -1;
}

function groupKey(f: { account: string; symbol: string }): string {
  return `${f.account}|${f.symbol}`;
}

function newAcc(f: RawFill, direction: Direction, coverageOk: boolean): Acc {
  return {
    account: f.account,
    symbol: f.symbol,
    currency: f.currency,
    direction,
    openTime: f.time,
    openId: f.id,
    entryQty: 0,
    entryValue: 0,
    exitQty: 0,
    exitValue: 0,
    remainingQty: 0,
    remainingBasis: 0,
    realizedSoFar: 0,
    fees: 0,
    maxQty: 0,
    position: 0,
    fillIds: [],
    lastTime: f.time,
    coverageOk,
  };
}

/** Build an accumulator seeded from a pre-existing position snapshot (coverage is incomplete). */
function seedAcc(seed: SeedPosition): Acc {
  const qtyAbs = Math.abs(seed.qty);
  return {
    account: seed.account,
    symbol: seed.symbol,
    currency: seed.currency,
    direction: seed.qty > 0 ? "LONG" : "SHORT",
    openTime: seed.time,
    openId: "seed",
    entryQty: qtyAbs,
    entryValue: qtyAbs * seed.avgCost, // real cost basis → sane avgEntry/PnL
    exitQty: 0,
    exitValue: 0,
    remainingQty: qtyAbs,
    remainingBasis: qtyAbs * seed.avgCost, // held shares carry the seed cost basis (no known fees)
    realizedSoFar: 0,
    fees: 0,
    maxQty: qtyAbs,
    position: seed.qty,
    fillIds: [],
    lastTime: seed.time,
    coverageOk: false,
  };
}

/** Apply a quantity portion of a fill as an entry (increasing exposure). */
function applyEntry(acc: Acc, f: RawFill, qty: number): void {
  const feeShare = f.fee * (qty / f.qty);
  acc.entryQty += qty;
  acc.entryValue += qty * f.price;
  acc.fees += feeShare;
  // Grow the held-share basis. A LONG's fee raises its cost; a SHORT's fee lowers its net proceeds.
  acc.remainingQty += qty;
  acc.remainingBasis += acc.direction === "LONG" ? qty * f.price + feeShare : qty * f.price - feeShare;
  acc.position += acc.direction === "LONG" ? qty : -qty;
  acc.maxQty = Math.max(acc.maxQty, Math.abs(acc.position));
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

/** Apply a quantity portion of a fill as an exit (reducing exposure). */
function applyExit(acc: Acc, f: RawFill, qty: number): void {
  const feeShare = f.fee * (qty / f.qty);
  // Book profit for THIS exit against the moving-average basis of the shares CURRENTLY held — not the
  // lifetime entry average (a later add would otherwise re-price shares already sold). Then remove the
  // sold shares' basis at that same average. Summed over exits = profit banked so far; == realizedPnl
  // at a clean close, even for interleaved scale-out → add → exit sequences.
  const avg = acc.remainingQty > 0 ? acc.remainingBasis / acc.remainingQty : 0;
  acc.realizedSoFar +=
    acc.direction === "LONG"
      ? qty * (f.price - avg) - feeShare // sold above the held basis = profit
      : qty * (avg - f.price) - feeShare; // covered below the held net proceeds = profit
  acc.remainingBasis -= qty * avg;
  acc.remainingQty -= qty;
  acc.exitQty += qty;
  acc.exitValue += qty * f.price;
  acc.fees += feeShare;
  acc.position += acc.direction === "LONG" ? -qty : qty;
  acc.lastTime = f.time;
  if (!acc.fillIds.includes(f.id)) acc.fillIds.push(f.id);
}

function finalize(acc: Acc): Trade {
  const closed = isZero(acc.position);
  const avgEntry = acc.entryQty > 0 ? acc.entryValue / acc.entryQty : 0;
  const avgExit = acc.exitQty > 0 ? acc.exitValue / acc.exitQty : null;
  // Profit banked so far — accumulated per-exit at the cost basis then (see applyExit), so interleaved
  // adds never re-price an earlier sale. 0 when nothing has been sold; == realizedPnl at a clean close.
  const realizedSoFar = acc.realizedSoFar;
  let realizedPnl: number | null = null;
  if (closed) {
    realizedPnl =
      acc.direction === "LONG"
        ? acc.exitValue - acc.entryValue - acc.fees
        : acc.entryValue - acc.exitValue - acc.fees;
  }
  return {
    id: `${acc.account}:${acc.symbol}:${acc.openTime}:${acc.openId}`,
    account: acc.account,
    symbol: acc.symbol,
    currency: acc.currency,
    direction: acc.direction,
    status: closed ? "closed" : "open",
    openTime: acc.openTime,
    closeTime: closed ? acc.lastTime : null,
    avgEntry,
    avgExit,
    maxQty: acc.maxQty,
    realizedPnl,
    realizedSoFar,
    fees: acc.fees,
    holdSeconds: closed ? Math.round((acc.lastTime - acc.openTime) / 1000) : null,
    coverageOk: acc.coverageOk,
    fillIds: acc.fillIds,
    effectiveStop: null,
    liveStop: null,
    effectiveTp: null,
    risk: null,
    rMultiple: null,
    mae: null,
    mfe: null,
    stopUnreliable: false,
  };
}

export function buildTrades(fills: RawFill[], seeds: SeedPosition[] = []): Trade[] {
  const seedMap = new Map<string, SeedPosition>();
  for (const s of seeds) seedMap.set(groupKey(s), s);

  const groups = new Map<string, RawFill[]>();
  for (const f of fills) {
    if (f.qty <= 0) continue; // skip zero/negative-qty fills (would make fee proration NaN)
    const k = groupKey(f);
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(f);
  }

  // Process every symbol that has fills OR a seeded position (so held-but-inactive positions survive).
  const keys = new Set<string>([...groups.keys(), ...seedMap.keys()]);
  const trades: Trade[] = [];

  for (const key of keys) {
    const groupFills = (groups.get(key) ?? [])
      .slice()
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)); // stable tie-break
    const seed = seedMap.get(key);

    let position = 0;
    let acc: Acc | null = null;

    if (seed && !isZero(seed.qty)) {
      acc = seedAcc(seed);
      // Use the first fill's time as the (approximate) open time so hold time isn't negative.
      if (groupFills.length > 0) acc.openTime = groupFills[0]!.time;
      position = seed.qty;
    }

    for (const f of groupFills) {
      const signed = f.side === "BUY" ? f.qty : -f.qty;

      if (isZero(position)) {
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, f.qty);
        position = acc.position;
        continue;
      }

      if (sign(signed) === sign(position)) {
        applyEntry(acc!, f, f.qty); // adding in the same direction
        position = acc!.position;
        continue;
      }

      // reducing
      if (Math.abs(signed) <= Math.abs(position) + EPS) {
        applyExit(acc!, f, f.qty);
        position = acc!.position;
        if (isZero(position)) {
          trades.push(finalize(acc!));
          acc = null;
        }
      } else {
        // flip through zero: close current with the closing portion, open new with the rest
        const closingQty = Math.abs(position);
        const remaining = Math.abs(signed) - closingQty;
        applyExit(acc!, f, closingQty);
        trades.push(finalize(acc!));
        acc = newAcc(f, signed > 0 ? "LONG" : "SHORT", true);
        applyEntry(acc, f, remaining);
        position = acc.position;
      }
    }

    if (acc && !isZero(position)) trades.push(finalize(acc)); // leftover open trade
  }

  return trades;
}
