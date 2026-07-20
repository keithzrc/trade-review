import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/store/migrations";
import { buildApi } from "../../src/api/routes";
import { upsertRawFills } from "../../src/store/repos";
import { rebuildDerived } from "../../src/sync/sync";
import { DEFAULT_RULE_CONFIG } from "../../src/domain/types";

const noCandles = { getCandles: async () => [] };

/** One closed AAPL trade (no stop → the engine fires at least no_stop). */
async function harness() {
  const db = new Database(":memory:");
  runMigrations(db);
  upsertRawFills(db, [
    { id: "f1", orderId: "o1", symbol: "US.AAPL", side: "BUY", qty: 10, price: 100, fee: 0, currency: "USD", time: 1000, account: "a" },
    { id: "f2", orderId: "o2", symbol: "US.AAPL", side: "SELL", qty: 10, price: 110, fee: 0, currency: "USD", time: 2000, account: "a" },
  ]);
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 3000 });
  const app = buildApi(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, sync: null, now: () => 3000 });
  const id = ((await app(new Request("http://x/api/trades")).then((r) => r.json())) as any)[0].id as string;
  const put = (body: unknown) =>
    app(new Request(`http://x/api/trades/${encodeURIComponent(id)}/flags`, { method: "PUT", body: JSON.stringify(body) }));
  const get = async () =>
    (await (await app(new Request(`http://x/api/trades/${encodeURIComponent(id)}`))).json()) as any;
  return { db, app, id, put, get };
}

test("PUT flags adds a manual flag (registry default severity) and it shows in lists too", async () => {
  const { app, put, get } = await harness();
  const res = await put({ added: ["added_to_loser"], dismissed: [] });
  expect(res.status).toBe(200);
  const detail: any = await res.json();
  const manual = detail.flags.find((f: any) => f.ruleId === "added_to_loser");
  expect(manual).toBeDefined();
  expect(manual.severity).toBe("warn"); // registry default for added_to_loser
  expect(manual.reason).toBe("Flagged manually.");
  expect(detail.flagOverrides).toEqual({ added: ["added_to_loser"], dismissed: [] });
  // the merged set also flows through GET /api/trades (dashboard/table lists)
  const rows: any = await (await app(new Request("http://x/api/trades"))).json();
  expect(rows[0].flags.some((f: any) => f.ruleId === "added_to_loser")).toBe(true);
  expect((await get()).flags.some((f: any) => f.ruleId === "added_to_loser")).toBe(true);
});

test("PUT flags dismisses a computed flag; clearing the override restores it", async () => {
  const { put, get } = await harness();
  const before = await get();
  const computed = before.flags[0];
  expect(computed).toBeDefined(); // no-stop trade → the engine fired something
  const dismissedRes = await put({ added: [], dismissed: [computed.ruleId] });
  const after: any = await dismissedRes.json();
  expect(after.flags.some((f: any) => f.ruleId === computed.ruleId)).toBe(false);
  expect(after.flagOverrides.dismissed).toEqual([computed.ruleId]);
  // restore: replace-set with empty overrides brings the computed flag back
  await put({ added: [], dismissed: [] });
  expect((await get()).flags.some((f: any) => f.ruleId === computed.ruleId)).toBe(true);
});

test("PUT flags validation: bad ids, overlap, unknown trade", async () => {
  const { app, put } = await harness();
  expect((await put({ added: ["Not A Rule!"] })).status).toBe(400);
  expect((await put({ added: "no_stop" })).status).toBe(400);
  expect((await put({ added: ["no_stop"], dismissed: ["no_stop"] })).status).toBe(400); // one mode per rule
  const missing = await app(
    new Request("http://x/api/trades/nope/flags", { method: "PUT", body: JSON.stringify({ added: [] }) }),
  );
  expect(missing.status).toBe(404);
});

test("overrides survive a derived rebuild (sync wipes the flags table, not the user's corrections)", async () => {
  const { db, put, get } = await harness();
  const before = await get();
  const computed = before.flags[0].ruleId as string;
  await put({ added: ["overtrading_revenge"], dismissed: [computed] });
  // A sync's rebuild deletes + reinserts every computed flag; the user's corrections must hold.
  await rebuildDerived(db, { candles: noCandles, config: DEFAULT_RULE_CONFIG, now: 4000 });
  const d = await get();
  expect(d.flags.some((f: any) => f.ruleId === "overtrading_revenge")).toBe(true);
  expect(d.flags.some((f: any) => f.ruleId === computed)).toBe(false);
});
