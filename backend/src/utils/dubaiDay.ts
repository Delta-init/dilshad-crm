/**
 * Whole days on the Dubai calendar (UTC+4, no daylight saving) — what the web's
 * date filters mean. The web sends "2026-10-08" for today in Dubai; reading
 * that as a UTC day ran "today" from 04:00 to 04:00 Dubai time, so the leads
 * that came in overnight were missing from Today's Leads.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function bound(value: string, end: boolean): Date | null {
  const v = value.trim();
  const d = DAY.test(v)
    ? new Date(`${v}T${end ? "23:59:59.999" : "00:00:00.000"}+04:00`)
    : new Date(v); // a full timestamp is taken as given
  return isNaN(d.getTime()) ? null : d;
}

/** A Mongo range from the start of `from` to the end of `to` (Dubai days); null when neither is usable. */
export function dubaiDayRange(from?: string, to?: string): { $gte?: Date; $lte?: Date } | null {
  const range: { $gte?: Date; $lte?: Date } = {};
  const start = from ? bound(from, false) : null;
  const finish = to ? bound(to, true) : null;
  if (start) range.$gte = start;
  if (finish) range.$lte = finish;
  return start || finish ? range : null;
}

/** Today on the Dubai calendar, "YYYY-MM-DD" (the 3CX Calls page and the Leaderboard, 2026-10-14). */
export function dubaiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
}

/** When the Dubai day a value names begins — "YYYY-MM-DD" as written, a timestamp by its Dubai day; null if neither. */
export function dubaiDayStart(value: string): Date | null {
  const v = value.trim();
  const day = DAY.test(v) ? v : (() => { const at = new Date(v); return isNaN(at.getTime()) ? null : dubaiToday(at); })();
  return day ? new Date(`${day}T00:00:00.000+04:00`) : null;
}
