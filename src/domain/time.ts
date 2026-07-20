// The single home for calendar boundaries. Weeks and hold-time buckets use the MACHINE-LOCAL
// timezone (declared once here — Plan 6 decision 7) so weekly-journal date association is
// deterministic for a given install. Weeks are ISO-8601 (Monday start, week 1 contains Jan 4).

const DAY_MS = 86_400_000;

/** Mon=0 … Sun=6 for a local Date. */
function isoDayNum(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Thursday (00:00 local) of the ISO week containing `d`'s date. Thursday fixes the ISO year. */
function thursdayOfWeek(d: Date): Date {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - isoDayNum(t) + 3);
  return t;
}

/** ISO week key ("YYYY-Www") for an epoch-ms instant, in machine-local time. */
export function isoWeekOf(ms: number): string {
  const thu = thursdayOfWeek(new Date(ms));
  const isoYear = thu.getFullYear();
  const firstThu = thursdayOfWeek(new Date(isoYear, 0, 4)); // Thursday of ISO week 1
  const week = 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** [start, end) epoch-ms for an ISO week key: local Monday 00:00 to the next local Monday 00:00.
 * Advances the calendar with `setDate` (not fixed DAY_MS arithmetic) so a DST-observing timezone
 * still lands boundaries on local midnight rather than 23:00/01:00 — otherwise trades near a week
 * edge get assigned to the wrong weekly journal. `end - start` is ~7 days (±1h across a DST edge). */
export function weekRange(isoWeek: string): { start: number; end: number } {
  const [yStr, wStr] = isoWeek.split("-W");
  const isoYear = Number(yStr);
  const week = Number(wStr);
  const startDate = new Date(isoYear, 0, 4); // Jan 4 is always in ISO week 1
  startDate.setDate(startDate.getDate() - isoDayNum(startDate)); // back to that week's Monday
  startDate.setDate(startDate.getDate() + (week - 1) * 7); // forward to the target week's Monday
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 7); // the next local Monday (exclusive)
  return { start: startDate.getTime(), end: endDate.getTime() };
}

/** True only for a canonical ISO week key: `YYYY-Www` whose Monday round-trips back to the same key.
 * Rejects malformed (`2026-W1`), out-of-range (`2026-W99`), and non-existent (`2026-W53` in a
 * 52-week year) inputs, so a weekly entry can't be stored under an id a later read won't find. */
export function isValidIsoWeek(key: string): boolean {
  if (!/^\d{4}-W\d{2}$/.test(key)) return false;
  const { start } = weekRange(key);
  return !Number.isNaN(start) && isoWeekOf(start) === key;
}

/** Local-calendar day key ("YYYY-MM-DD") for an epoch-ms instant — the daily journal's id. Machine-
 * local like the week keys above (the app runs on the user's own machine), so "today" agrees between
 * the SPA and the server. */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True only for a canonical, EXISTING local calendar date ("2026-02-30" round-trips to Mar 2 →
 * rejected), so a daily entry can't be stored under an id a later read won't find. */
export function isValidDayKey(key: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKeyOf(d.getTime()) === key;
}

/** [start, end) epoch-ms for a day key: local midnight to the next local midnight. Advances with
 * setDate (like weekRange) so a DST edge still lands both boundaries on local midnight. */
export function dayRange(dayKey: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)!;
  const startDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  return { start: startDate.getTime(), end: endDate.getTime() };
}

/** Hold-time bucket for the "by hold-time" breakdown. The documented, gapless contract is
 * `intraday` (<1d), `2-5d` (1d–<6d), `1-2w` (6d–<15d), `2w+` (≥15d), `open` (still-open). */
export function holdBucket(holdSeconds: number | null): string {
  if (holdSeconds === null) return "open";
  const days = holdSeconds / 86_400;
  if (days < 1) return "intraday";
  if (days < 6) return "2-5d";
  if (days < 15) return "1-2w";
  return "2w+";
}
