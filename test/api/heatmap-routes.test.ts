import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { DEFAULT_RULE_CONFIG, type Candle } from "../../src/domain/types";
import { DEFAULT_HEATMAP_GROUPS, DEFAULT_THEMATIC_UNIVERSE } from "../../src/store/config";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 17);

/** Two daily bars: yesterday close 100 → today close 110 (+10% day). */
function twoBars(): Candle[] {
  return [
    { time: NOW - DAY, open: 100, high: 100, low: 100, close: 100, volume: 0 },
    { time: NOW, open: 100, high: 110, low: 100, close: 110, volume: 0 },
  ];
}

function harness(candles: (symbol: string) => Promise<Candle[]>) {
  const db = new Database(":memory:");
  runMigrations(db);
  const app = buildApi(db, {
    candles: { getCandles: (symbol) => candles(symbol) },
    config: DEFAULT_RULE_CONFIG,
    sync: null,
    now: () => NOW,
  });
  return { db, app };
}

test("GET /api/market/symbols returns the defaults when nothing is stored", async () => {
  const { app } = harness(async () => []);
  const body: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(body.groups).toEqual(DEFAULT_HEATMAP_GROUPS);
});

test("PUT /api/market/symbols normalizes (uppercase, trim, in-group dedupe, labels) and persists", async () => {
  const { app } = harness(async () => []);
  const put = await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({
        groups: [
          {
            name: "  Mine ",
            // plain strings (legacy shape) and labeled entries both accepted; a dupe keeps the label
            symbols: ["us.spy", { symbol: "US.SPY", label: " S&P 500 " }, { symbol: " us.qqq ", label: null }],
          },
        ],
      }),
    }),
  );
  expect(put.status).toBe(200);
  const body: any = await put.json();
  expect(body.groups).toEqual([
    // US.QQQ was stored label-less, but it's a known default ticker → its industry label backfills
    // on read (this is what upgrades a config written before labels existed).
    { name: "Mine", symbols: [{ symbol: "US.SPY", label: "S&P 500" }, { symbol: "US.QQQ", label: "Nasdaq 100" }] },
  ]);
  // survives a re-read
  const again: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(again.groups).toEqual(body.groups);
  // an UNKNOWN label-less ticker stays label-less (nothing to backfill from)
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({ groups: [{ name: "X", symbols: ["US.ZZZZ"] }] }),
    }),
  );
  const custom: any = await (await app(new Request("http://x/api/market/symbols"))).json();
  expect(custom.groups).toEqual([{ name: "X", symbols: [{ symbol: "US.ZZZZ", label: null }] }]);
});

test("DELETE /api/market/symbols resets to the built-in defaults (labels, EW group, ordering)", async () => {
  const { app } = harness(async () => []);
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({ groups: [{ name: "Custom", symbols: ["US.SPY"] }] }),
    }),
  );
  const res = await app(new Request("http://x/api/market/symbols", { method: "DELETE" }));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.groups).toEqual(DEFAULT_HEATMAP_GROUPS);
  // and the EW group sits directly after the cap-weighted sectors
  const names = body.groups.map((g: any) => g.name);
  expect(names.indexOf("S&P EW sectors")).toBe(names.indexOf("S&P sectors") + 1);
});

test("reset also restores the default thematic universe", async () => {
  const { app } = harness(async () => []);
  await app(
    new Request("http://x/api/market/thematic", { method: "PUT", body: JSON.stringify({ symbols: ["US.SMH"] }) }),
  );
  await app(new Request("http://x/api/market/symbols", { method: "DELETE" }));
  const body: any = await (await app(new Request("http://x/api/market/thematic"))).json();
  expect(body.symbols).toEqual(DEFAULT_THEMATIC_UNIVERSE);
});

test("heatmap ranks the thematic universe by 5-day change desc, no-data last", async () => {
  const DAY = 86_400_000;
  const series = (lastClose: number): Candle[] =>
    Array.from({ length: 7 }, (_, i) => {
      const close = i === 6 ? lastClose : 100;
      return { time: NOW - (6 - i) * DAY, open: close, high: close, low: close, close, volume: 0 };
    });
  const { app } = harness(async (symbol) => {
    if (symbol === "US.HOT") return series(150); // +50% over 5 sessions
    if (symbol === "US.MID") return series(120); // +20%
    return []; // US.NONE → no data → sinks to the bottom
  });
  await app(
    new Request("http://x/api/market/thematic", {
      method: "PUT",
      body: JSON.stringify({ symbols: ["US.NONE", { symbol: "US.MID", label: "Mid" }, "US.HOT"] }),
    }),
  );
  const body: any = await (await app(new Request("http://x/api/market/heatmap"))).json();
  expect(body.thematic.rankedBy).toBe("p5dPct");
  expect(body.thematic.topN).toBe(10);
  expect(body.thematic.universeSize).toBe(3);
  expect(body.thematic.rows.map((r: any) => r.symbol)).toEqual(["US.HOT", "US.MID", "US.NONE"]);
  expect(body.thematic.rows[0].p5dPct).toBeCloseTo(0.5, 10);
  expect(body.thematic.rows[1].label).toBe("Mid");
  expect(body.thematic.rows[2].p5dPct).toBeNull();
});

test("rs20Pct is the 20-session return vs SPY; SPY is fetched even when it's in no list", async () => {
  const DAY = 86_400_000;
  const series = (lastClose: number): Candle[] =>
    Array.from({ length: 22 }, (_, i) => {
      const close = i === 21 ? lastClose : 100;
      return { time: NOW - (21 - i) * DAY, open: close, high: close, low: close, close, volume: 0 };
    });
  const fetched: string[] = [];
  const { app } = harness(async (symbol) => {
    fetched.push(symbol);
    if (symbol === "US.SPY") return series(110); // +10% over 20 sessions
    return series(120); // +20%
  });
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({ groups: [{ name: "G", symbols: ["US.GRW"] }] }),
    }),
  );
  await app(
    new Request("http://x/api/market/thematic", { method: "PUT", body: JSON.stringify({ symbols: ["US.GRW"] }) }),
  );
  const body: any = await (await app(new Request("http://x/api/market/heatmap"))).json();
  expect(fetched).toContain("US.SPY"); // the benchmark rides along regardless of the lists
  expect(body.groups[0].rows[0].rs20Pct).toBeCloseTo(1.2 / 1.1 - 1, 10);
  expect(body.thematic.rows[0].rs20Pct).toBeCloseTo(1.2 / 1.1 - 1, 10);
  // and the config-order universe travels with the ranking for the edit view
  expect(body.thematic.universe).toEqual([{ symbol: "US.GRW", label: null }]);
});

test("PUT /api/market/thematic validates entries", async () => {
  const { app } = harness(async () => []);
  const bad = async (symbols: unknown) =>
    (await app(new Request("http://x/api/market/thematic", { method: "PUT", body: JSON.stringify({ symbols }) }))).status;
  expect(await bad(["SPY"])).toBe(400); // missing market prefix
  expect(await bad("nope")).toBe(400);
  expect(await bad(Array.from({ length: 81 }, (_, i) => `US.S${i}`))).toBe(400); // > 80
});

test("PUT /api/market/symbols rejects malformed symbols and oversized bodies", async () => {
  const { app } = harness(async () => []);
  const bad = async (groups: unknown) =>
    (
      await app(new Request("http://x/api/market/symbols", { method: "PUT", body: JSON.stringify({ groups }) }))
    ).status;
  expect(await bad([{ name: "g", symbols: ["SPY"] }])).toBe(400); // missing market prefix
  expect(await bad([{ name: "g", symbols: ["US.SPY; DROP"] }])).toBe(400);
  expect(await bad([{ name: "", symbols: ["US.SPY"] }])).toBe(400);
  expect(await bad("nope")).toBe(400);
  const many = Array.from({ length: 61 }, (_, i) => `US.S${i}`);
  expect(await bad([{ name: "g", symbols: many }])).toBe(400); // > 60 symbols total
});

test("GET /api/market/heatmap computes rows per stored group and degrades bad symbols to nulls", async () => {
  const { app } = harness(async (symbol) => {
    if (symbol === "US.BAD") throw new Error("boom"); // a throwing fetch must not 500 the page
    if (symbol === "US.EMPTY") return [];
    return twoBars();
  });
  await app(
    new Request("http://x/api/market/symbols", {
      method: "PUT",
      body: JSON.stringify({
        groups: [{ name: "G", symbols: [{ symbol: "US.OK", label: "Okay Industries" }, "US.EMPTY", "US.BAD"] }],
      }),
    }),
  );
  const res = await app(new Request("http://x/api/market/heatmap"));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body.asOf).toBe(NOW);
  expect(body.groups).toHaveLength(1);
  const rows = body.groups[0].rows;
  expect(rows.map((r: any) => r.symbol)).toEqual(["US.OK", "US.EMPTY", "US.BAD"]);
  expect(rows[0].label).toBe("Okay Industries"); // the stored industry label rides along per row
  expect(rows[1].label).toBeNull();
  expect(rows[0].last).toBe(110);
  expect(rows[0].dayPct).toBeCloseTo(0.1, 10);
  expect(rows[1].last).toBeNull();
  expect(rows[2].dayPct).toBeNull();
});
