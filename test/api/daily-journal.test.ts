import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";
import { dayKeyOf } from "../../src/domain/time";

const NOW = Date.UTC(2026, 6, 17, 12); // midday so the local day key is stable across timezones
const TODAY = dayKeyOf(NOW);
const SNAP = { asOf: NOW, groups: [{ name: "G", rows: [{ symbol: "US.SPY", last: 100, dayPct: 0.01, p5dPct: null, off52wPct: -0.02, ytdPct: 0.1 }] }] };

function harness(now = NOW) {
  const db = new Database(":memory:");
  runMigrations(db);
  const app = buildApi(db, { candles: { getCandles: async () => [] }, config: DEFAULT_RULE_CONFIG, sync: null, now: () => now });
  const get = async (key: string) => (await (await app(new Request(`http://x/api/journal/days/${key}`))).json()) as any;
  const put = (key: string, body: unknown) =>
    app(new Request(`http://x/api/journal/days/${key}`, { method: "PUT", body: JSON.stringify(body) }));
  return { app, get, put };
}

test("GET an unwritten day returns an empty default (never 404)", async () => {
  const { get } = harness();
  const e = await get("2026-07-01");
  expect(e).toEqual({ id: "2026-07-01", regime: null, marketRead: null, notes: null, snapshot: null, snapshotAt: null, updatedAt: 0, trades: [] });
});

test("the day view lists trades opened or closed that local day", async () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const { upsertRawFills } = await import("../../src/store/repos");
  const { rebuildDerived } = await import("../../src/sync/sync");
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: NOW - 3_600_000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: NOW, account: "a" },
  ]);
  await rebuildDerived(db, { candles: { getCandles: async () => [] }, config: DEFAULT_RULE_CONFIG, now: NOW });
  const app = buildApi(db, { candles: { getCandles: async () => [] }, config: DEFAULT_RULE_CONFIG, sync: null, now: () => NOW });
  const today: any = await (await app(new Request(`http://x/api/journal/days/${TODAY}`))).json();
  expect(today.trades).toHaveLength(1);
  expect(today.trades[0].symbol).toBe("US.AAPL");
  const other: any = await (await app(new Request("http://x/api/journal/days/2026-01-05"))).json();
  expect(other.trades).toHaveLength(0);
});

test("PUT saves regime + texts, and freezes the snapshot only for TODAY", async () => {
  const { get, put } = harness();
  const res = await put(TODAY, { regime: "DOWNTREND", marketRead: "wheels off", notes: "stayed patient", snapshot: SNAP });
  expect(res.status).toBe(200);
  const e = await get(TODAY);
  expect(e.regime).toBe("DOWNTREND");
  expect(e.marketRead).toBe("wheels off");
  expect(e.snapshot).toEqual(SNAP);
  expect(e.snapshotAt).toBe(NOW);
});

test("a snapshot sent for a PAST day is ignored (history is never rewritten with today's market)", async () => {
  const { get, put } = harness();
  await put("2026-07-01", { marketRead: "back-filled thoughts", snapshot: SNAP });
  const e = await get("2026-07-01");
  expect(e.marketRead).toBe("back-filled thoughts");
  expect(e.snapshot).toBeNull();
  expect(e.snapshotAt).toBeNull();
});

test("a later text-only PUT preserves the day's existing snapshot", async () => {
  const { get, put } = harness();
  await put(TODAY, { marketRead: "v1", snapshot: SNAP });
  await put(TODAY, { marketRead: "v2" }); // no snapshot field at all
  const e = await get(TODAY);
  expect(e.marketRead).toBe("v2");
  expect(e.snapshot).toEqual(SNAP);
});

test("validation: bad date keys and bad regime 400", async () => {
  const { app, put } = harness();
  expect((await app(new Request("http://x/api/journal/days/2026-02-30"))).status).toBe(400); // not a real date
  expect((await app(new Request("http://x/api/journal/days/17-07-2026"))).status).toBe(400);
  expect((await put(TODAY, { regime: "SIDEWAYS" })).status).toBe(400);
  expect((await put(TODAY, { snapshot: "not an object" })).status).toBe(400);
});
