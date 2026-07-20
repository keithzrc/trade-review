import { test, expect } from "bun:test";
import { money, price, pct, pctSigned, ratio, rMultiple, signClass, holdTime } from "../../web/lib/format";

test("money shows sign + currency symbol, never converts", () => {
  expect(money(1234.5, "USD")).toBe("+$1,234.50");
  expect(money(-88.99, "USD")).toBe("−$88.99");
  expect(money(0, "USD")).toBe("$0.00");
  expect(money(100, "HKD")).toBe("+HK$100.00");
  expect(money(50, "CNH")).toBe("+¥50.00");
});

test("unknown/crypto currency falls back to the code, never a bare number", () => {
  expect(money(123.45, "USDT")).toBe("+USDT 123.45");
  expect(price(1.5, "USDT")).toBe("USDT 1.50");
  expect(price(1.5)).toBe("1.50"); // empty currency stays bare (used where currency is implicit)
});

test("pct and rMultiple", () => {
  expect(pct(0.615)).toBe("61.5%");
  expect(rMultiple(2.4)).toBe("+2.40R");
  expect(rMultiple(-1)).toBe("−1.00R");
  expect(rMultiple(null)).toBe("—");
});

test("pctSigned shows an explicit sign and dashes when null", () => {
  expect(pctSigned(0.064)).toBe("+6.4%");
  expect(pctSigned(-0.021)).toBe("−2.1%");
  expect(pctSigned(0)).toBe("0.0%");
  expect(pctSigned(null)).toBe("—");
});

test("ratio", () => {
  expect(ratio(3)).toBe("3.0×");
  expect(ratio(0.75)).toBe("0.8×");
  expect(ratio(null)).toBe("—");
});

test("signClass colors by sign", () => {
  expect(signClass(5)).toBe("pos");
  expect(signClass(-5)).toBe("neg");
  expect(signClass(0)).toBe("");
  expect(signClass(null)).toBe("");
});

test("holdTime buckets seconds; null is open", () => {
  expect(holdTime(null)).toBe("open");
  expect(holdTime(1800)).toBe("30m");
  expect(holdTime(3 * 3600)).toBe("3h");
  expect(holdTime(2 * 86400)).toBe("2d");
  expect(holdTime(21 * 86400)).toBe("3w");
});

