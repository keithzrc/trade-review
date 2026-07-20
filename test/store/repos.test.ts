import { test, expect } from "bun:test";
import { openTestDb, fill, order, rawPos } from "../helpers";
import {
  upsertRawFills,
  upsertRawOrders,
  insertPositionSnapshot,
  allRawFills,
  allRawOrders,
  positionsAt,
  replaceDerived,
  allTrades,
  flagsForTrade,
} from "../../src/store/repos";
import type { Flag, Trade } from "../../src/domain/types";

test("upsertRawFills inserts and reads back, ordered by time", () => {
  const db = openTestDb();
  upsertRawFills(db, [
    fill("BUY", 100, 10, { id: "f2", time: 2000 }),
    fill("SELL", 100, 11, { id: "f1", time: 1000 }),
  ]);
  const rows = allRawFills(db);
  expect(rows.map((r) => r.id)).toEqual(["f1", "f2"]); // time-ordered
  expect(rows[0]!.side).toBe("SELL");
  expect(rows[1]!.price).toBe(10);
});

test("upsertRawFills round-trips every field (guards the snake_case mapping boundary)", () => {
  const db = openTestDb();
  const f = fill("BUY", 100, 10, {
    id: "f1", orderId: "o9", fee: 1.25, currency: "HKD", account: "acc2", time: 4000, symbol: "0700",
  });
  upsertRawFills(db, [f]);
  expect(allRawFills(db)).toEqual([f]);
});

test("upsertRawFills is idempotent — re-inserting the same id updates, never duplicates", () => {
  const db = openTestDb();
  upsertRawFills(db, [fill("BUY", 100, 10, { id: "f1" })]);
  upsertRawFills(db, [fill("BUY", 100, 12, { id: "f1" })]); // same id, new price
  const rows = allRawFills(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.price).toBe(12); // last write wins
});

test("upsertRawOrders round-trips every field", () => {
  const db = openTestDb();
  const o = order("SELL", "STOP_LIMIT", 100, {
    id: "o1", price: 9.5, triggerPrice: 9, status: "SUBMITTED",
    createTime: 1000, updateTime: 2000, account: "acc2", symbol: "0700",
  });
  upsertRawOrders(db, [o]);
  expect(allRawOrders(db)).toEqual([o]);
});

test("upsertRawOrders round-trips nullable price/triggerPrice/updateTime", () => {
  const db = openTestDb();
  upsertRawOrders(db, [
    order("SELL", "STOP", 100, { id: "o1", price: null, triggerPrice: 9, updateTime: null, createTime: 1000 }),
    order("BUY", "LIMIT", 50, { id: "o2", price: 8, triggerPrice: null, updateTime: 2000, createTime: 1500 }),
  ]);
  const rows = allRawOrders(db);
  expect(rows.map((r) => r.id)).toEqual(["o1", "o2"]); // createTime-ordered
  expect(rows[0]!.price).toBeNull();
  expect(rows[0]!.triggerPrice).toBe(9);
  expect(rows[0]!.updateTime).toBeNull();
  expect(rows[1]!.updateTime).toBe(2000);
});

test("insertPositionSnapshot round-trips every field", () => {
  const db = openTestDb();
  const p = rawPos(-20, 305.5, { symbol: "0700", currency: "HKD", account: "acc2", time: 7000 });
  insertPositionSnapshot(db, [p]);
  expect(positionsAt(db, 7000)).toEqual([p]);
});

test("positionsAt returns exactly the batch recorded at that time", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { symbol: "AAPL", time: 1000 })]); // sync 1
  // sync 2 @2000: one coherent batch — same time — holds AAPL 150 + TSLA -20
  insertPositionSnapshot(db, [
    rawPos(150, 10.5, { symbol: "AAPL", time: 2000 }),
    rawPos(-20, 300, { symbol: "TSLA", time: 2000 }),
  ]);
  const batch = positionsAt(db, 2000);
  expect(batch.map((p) => p.symbol)).toEqual(["AAPL", "TSLA"]); // only the 2000 batch
  expect(batch.find((p) => p.symbol === "AAPL")!.qty).toBe(150);
  expect(batch.find((p) => p.symbol === "AAPL")!.avgCost).toBe(10.5);
  expect(positionsAt(db, 1000).map((p) => p.symbol)).toEqual(["AAPL"]); // the older batch
});

test("positionsAt of an all-flat snapshot is empty — no stale phantom positions (P1)", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { symbol: "AAPL", time: 1000 })]); // sync 1: held AAPL
  insertPositionSnapshot(db, []); // sync 2 @3000: account went flat — zero positions
  // The caller (sync) knows the snapshot time it just wrote and asks for exactly that instant.
  expect(positionsAt(db, 3000)).toEqual([]); // flat, not the stale AAPL batch
  expect(positionsAt(db, 1000).map((p) => p.symbol)).toEqual(["AAPL"]); // history still queryable
});

test("insertPositionSnapshot re-inserting the same (account,symbol,time) replaces, not duplicates", () => {
  const db = openTestDb();
  insertPositionSnapshot(db, [rawPos(100, 10, { time: 1000 })]);
  insertPositionSnapshot(db, [rawPos(120, 10, { time: 1000 })]); // same key
  expect(positionsAt(db, 1000)).toHaveLength(1);
  expect(positionsAt(db, 1000)[0]!.qty).toBe(120);
});

test("empty reads return empty arrays", () => {
  const db = openTestDb();
  expect(allRawFills(db)).toEqual([]);
  expect(allRawOrders(db)).toEqual([]);
  expect(positionsAt(db, 1000)).toEqual([]);
});

function tradeFixture(over: Partial<Trade> = {}): Trade {
  return {
    id: over.id ?? "acc1:AAPL:1000:f1",
    account: "acc1", symbol: "AAPL", currency: "USD", direction: "LONG", status: "closed",
    openTime: 1000, closeTime: 2000, avgEntry: 10, avgExit: 11, maxQty: 100,
    realizedPnl: 100, realizedSoFar: 100, fees: 1, holdSeconds: 1, coverageOk: true, fillIds: ["f1", "f2"],
    effectiveStop: 9, liveStop: 9, effectiveTp: null, risk: 100, rMultiple: 1, mae: 0.5, mfe: 2,
    stopUnreliable: false,
    ...over,
  };
}

test("replaceDerived writes trades, their fill links, and flags", () => {
  const db = openTestDb();
  const t = tradeFixture();
  const flags: Flag[] = [{ ruleId: "cut_winner_early", severity: "warn", reason: "left money" }];
  replaceDerived(db, [t], new Map([[t.id, flags]]));

  // Full-object equality guards every field across the `as any[]` read boundary. fillIds come
  // back in insertion order (rowid), so no .sort() — a scrambled order would (correctly) fail here.
  expect(allTrades(db)).toEqual([t]);
  expect(flagsForTrade(db, t.id)).toEqual(flags);
});

test("replaceDerived fully replaces prior derived data (idempotent rebuild)", () => {
  const db = openTestDb();
  const a = tradeFixture({ id: "a", fillIds: ["fa"] });
  replaceDerived(db, [a], new Map([["a", [{ ruleId: "oversized", severity: "warn", reason: "big" }]]]));
  // Second rebuild with a different trade set — the first must be gone entirely.
  const b = tradeFixture({ id: "b", fillIds: ["fb"] });
  replaceDerived(db, [b], new Map());

  expect(allTrades(db).map((t) => t.id)).toEqual(["b"]);
  expect(flagsForTrade(db, "a")).toEqual([]); // old flags wiped
  expect(flagsForTrade(db, "b")).toEqual([]);
});

test("replaceDerived rolls back fully if the batch throws mid-transaction", () => {
  const db = openTestDb();
  const good = tradeFixture({ id: "a", fillIds: ["fa"] });
  const flag = { ruleId: "oversized", severity: "warn" as const, reason: "big" };
  replaceDerived(db, [good], new Map([["a", [flag]]]));
  // A batch with a duplicate trade id violates the trades PK on the second insert, after the
  // DELETEs have run — the whole transaction must roll back, leaving the prior data intact.
  const dup = tradeFixture({ id: "dup", fillIds: ["fd"] });
  expect(() => replaceDerived(db, [dup, dup], new Map())).toThrow();
  expect(allTrades(db).map((t) => t.id)).toEqual(["a"]);
  expect(flagsForTrade(db, "a")).toEqual([flag]);
});

test("replaceDerived round-trips an open trade with null exit/pnl/enrichment", () => {
  const db = openTestDb();
  const open = tradeFixture({
    id: "open", status: "open", closeTime: null, avgExit: null, realizedPnl: null,
    holdSeconds: null, coverageOk: false, effectiveStop: null, risk: null, rMultiple: null,
    mae: null, mfe: null, fillIds: ["fo"],
  });
  replaceDerived(db, [open], new Map());
  const got = allTrades(db)[0]!;
  expect(got.status).toBe("open");
  expect(got.closeTime).toBeNull();
  expect(got.realizedPnl).toBeNull();
  expect(got.coverageOk).toBe(false);
  expect(got.mae).toBeNull();
});

test("allTrades returns trades ordered by open_time then id", () => {
  const db = openTestDb();
  replaceDerived(
    db,
    [tradeFixture({ id: "late", openTime: 5000 }), tradeFixture({ id: "early", openTime: 1000 })],
    new Map(),
  );
  expect(allTrades(db).map((t) => t.id)).toEqual(["early", "late"]);
});
