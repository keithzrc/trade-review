import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { cachedCandles } from "../../src/store/candles-cache";
import type { Candle } from "../../src/domain/types";

function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}
const DAY = 86_400_000;
const bars = (times: number[]): Candle[] =>
  times.map((t) => ({ time: t, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }));

test("first call hits the source and caches; second identical call serves from cache (no source hit)", async () => {
  const d = db();
  let hits = 0;
  const src = {
    getCandles: async (_s: string, from: number) => {
      hits++;
      return bars([from, from + DAY]);
    },
  };
  const c = cachedCandles(d, src, { now: 100 * DAY }); // old range → fully cacheable, no tail refetch
  const from = 1 * DAY,
    to = 3 * DAY,
    res = DAY;
  const a = await c.getCandles("US.AAPL", from, to, res);
  const b = await c.getCandles("US.AAPL", from, to, res);
  expect(a.length).toBeGreaterThan(0);
  expect(b).toEqual(a);
  expect(hits).toBe(1); // second call served from cache
});

test("a range ending near now refetches the tail (partial last bar)", async () => {
  const d = db();
  let hits = 0;
  const now = 100 * DAY;
  const src = {
    getCandles: async (_s: string, from: number) => {
      hits++;
      return bars([from]);
    },
  };
  const c = cachedCandles(d, src, { now });
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY);
  await c.getCandles("US.AAPL", now - 3 * DAY, now, DAY); // still near now → refetch tail
  expect(hits).toBe(2);
});

test("a near-now window reuses its cached prefix and refetches only the gap — even as the clock advances", async () => {
  const d = db();
  let now = 100 * DAY; // LIVE clock: advances between views (the production shape, not a frozen instant)
  const calls: Array<[number, number]> = [];
  const src = {
    getCandles: async (_s: string, from: number, to: number) => {
      calls.push([from, to]);
      return bars([from, to]);
    },
  };
  const c = cachedCandles(d, src, { now: () => now });
  // First view of a window reaching into the future (bounded post-trade context): cold, full fetch.
  await c.getCandles("US.X", 1 * DAY, now + 30 * DAY, DAY);
  now += 2 * DAY; // time passes between views
  // Second view: the immutable prefix is served from cache; only the gap-since-last-view + tail is pulled.
  await c.getCandles("US.X", 1 * DAY, now + 30 * DAY, DAY);
  expect(calls.length).toBe(2);
  expect(calls[0]![0]).toBe(1 * DAY); // first fetch spans from the window start
  expect(calls[1]![0]).toBeGreaterThan(50 * DAY); // second starts near the prior covered end, not the start
  expect(calls[1]![0]).toBeLessThan(100 * DAY);
});

test("two DISJOINT ranges do not mark the gap between them as covered", async () => {
  const d = db();
  let hits = 0;
  const now = 100 * DAY;
  const src = {
    getCandles: async (_s: string, from: number, to: number) => {
      hits++;
      return bars([from, to]);
    },
  };
  const c = cachedCandles(d, src, { now });
  await c.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // range A (Jan-ish)
  await c.getCandles("US.AAPL", 40 * DAY, 42 * DAY, DAY); // range B, disjoint from A
  expect(hits).toBe(2);
  // A request spanning the GAP between A and B must refetch (not be served as falsely covered).
  await c.getCandles("US.AAPL", 10 * DAY, 12 * DAY, DAY);
  expect(hits).toBe(3);
  // But BOTH disjoint windows stay covered (multi-interval): with the source down, range A is still
  // served from cache — its coverage wasn't overwritten by range B.
  const bad = {
    getCandles: async () => {
      throw new Error("down");
    },
  };
  const a = await cachedCandles(d, bad, { now }).getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  expect(a.length).toBeGreaterThan(0);
});

test("a near-now fetch is NOT recorded as covered past the closed boundary (no stale partial bar)", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number, to: number) => bars([from, to]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 97 * DAY, 100 * DAY, DAY); // ends in tail
  // A later run (now advanced well past the tail) with the source down must NOT serve the tail from
  // stale coverage — the near-now portion was never marked covered, so it degrades to [].
  const bad = {
    getCandles: async () => {
      throw new Error("down");
    },
  };
  const out = await cachedCandles(d, bad, { now: 200 * DAY }).getCandles("US.AAPL", 97 * DAY, 100 * DAY, DAY);
  expect(out).toEqual([]);
});

test("the closed-bar tail scales with resolution — a coarse (quarterly) partial bar isn't frozen in cache", async () => {
  const d = db();
  const QUARTER = 91 * DAY;
  // A quarterly window ending ~30 days ago: WELL past the fixed 2-day tail, but the last quarterly bar
  // is still in progress (a 91-day bar that started <91 days ago). With the fixed-2d tail this got
  // marked covered and served frozen; with the resMs-aware tail (now − 2d − 91d) it must NOT be covered.
  const now = 200 * DAY;
  const toMs = now - 30 * DAY; // inside now − TAIL − resMs, so still "near now" for a quarterly bar
  const good = { getCandles: async (_s: string, from: number, to: number) => bars([from, to]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 10 * DAY, toMs, QUARTER);
  // Source down on a re-request of the same range: if the tail had been (wrongly) marked covered it
  // would serve stale bars; because it wasn't, it degrades to [].
  const bad = {
    getCandles: async () => {
      throw new Error("down");
    },
  };
  const out = await cachedCandles(d, bad, { now: now + 5 * DAY }).getCandles("US.AAPL", 10 * DAY, toMs, QUARTER);
  expect(out).toEqual([]);
});

test("source failure with a warm cache still returns cached bars", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  const c1 = cachedCandles(d, good, { now });
  await c1.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  const bad = {
    getCandles: async () => {
      throw new Error("network down");
    },
  };
  const c2 = cachedCandles(d, bad, { now });
  const out = await c2.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  expect(out.length).toBeGreaterThan(0); // served from cache despite source throwing (fully covered)
});

test("source failure on a NOT-fully-covered range degrades to [] (no partial-window bars)", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // covers [1,3]d only
  const bad = {
    getCandles: async () => {
      throw new Error("network down");
    },
  };
  // Request a wider range the cache only partially covers; on failure it must NOT return the [1,3]d
  // overlap (which would be a wrong excursion window), but degrade to no bars.
  const out = await cachedCandles(d, bad, { now }).getCandles("US.AAPL", 1 * DAY, 50 * DAY, DAY);
  expect(out).toEqual([]);
});

test("a SILENTLY-EMPTY source (returns [] not throws) on a partial range also degrades to []", async () => {
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // covers [1,3]d
  // yahooCandles returns [] on failure rather than throwing — the empty-fetch path must behave like
  // the catch path: no partial cache leak for a not-fully-covered range.
  const empty = { getCandles: async () => [] };
  const out = await cachedCandles(d, empty, { now }).getCandles("US.AAPL", 1 * DAY, 50 * DAY, DAY);
  expect(out).toEqual([]);
});

test("a cache-only source (empty inner) SERVES a fully-covered warm range — the offline-upgrade path", async () => {
  // app.ts drives the one-time upgrade rebuild with cachedCandles(db, {()=>[]}) so cached bars activate
  // candle-dependent derivations (unreliable-stop detection, MAE/MFE) with zero network. That hinges on
  // a fully-covered range being served even though the inner source returns nothing.
  const d = db();
  const now = 100 * DAY;
  const good = { getCandles: async (_s: string, from: number) => bars([from, from + DAY]) };
  await cachedCandles(d, good, { now }).getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY); // warm + cover [1,3]d
  const cacheOnly = cachedCandles(d, { getCandles: async () => [] }, { now });
  const out = await cacheOnly.getCandles("US.AAPL", 1 * DAY, 3 * DAY, DAY);
  expect(out.length).toBeGreaterThan(0); // served from cache, no network
});
