/**
 * Working-time arithmetic for the CRM's working hours (Settings → Automation & alerts).
 *
 * Everything is worked out in the working hours' own time zone, so "09:00"
 * means nine in Dubai whatever zone the server runs in. Each working day is
 * the window [start, end): a lead assigned at 18:00 on a 09:00–18:00 day
 * starts its clock at nine the next working morning.
 */

export interface WorkingHours {
  /** IANA zone, e.g. "Asia/Dubai". */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
}

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** How far either walk goes before giving up: ten years of calendar days. */
const MAX_DAYS = 3660;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock reading in `timeZone` at a whole second `at`, written as if it were UTC. */
function wallClockAsUtc(timeZone: string, at: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
}

/** How far `timeZone` is ahead of UTC at `at`, in ms. */
function offsetAt(timeZone: string, at: number): number {
  const t = Math.floor(at / 1000) * 1000;
  return wallClockAsUtc(timeZone, t) - t;
}

/** The instant a local date and minute of the day happen in `timeZone`. */
function zonedInstant(timeZone: string, day: CalendarDay, minuteOfDay: number): number {
  const local = Date.UTC(day.y, day.m - 1, day.d) + minuteOfDay * MINUTE;
  // Guess with the offset at that moment, then correct once — enough across a DST change. Working hours that take
  // in the very hour a DST change skips or repeats (01:00–03:00 in London, midnight in Santiago) are counted to
  // within that hour; office hours in the zones the Settings page offers never are.
  const guess = local - offsetAt(timeZone, local);
  return local - offsetAt(timeZone, guess);
}

const dayNumber = (day: CalendarDay): number => Date.UTC(day.y, day.m - 1, day.d) / DAY;

function fromDayNumber(n: number): CalendarDay {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function localDay(timeZone: string, at: number): CalendarDay {
  const w = new Date(wallClockAsUtc(timeZone, Math.floor(at / 1000) * 1000));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

const minuteOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** A calendar day's working window as instants, or null on a day off. */
function windowOf(wh: WorkingHours, day: CalendarDay): [number, number] | null {
  const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  if (!wh.days.includes(weekday)) return null;
  return [
    zonedInstant(wh.timezone, day, minuteOfDay(wh.start)),
    zonedInstant(wh.timezone, day, minuteOfDay(wh.end)),
  ];
}

/*
 * Each day's window, worked out once (2026-10-20): every window takes four time-zone readings, and the inactive-lead
 * pages count minutes for thousands of leads over the same days — day by day for each lead, that was seconds of work
 * that held the server up (2,000 leads a year old: 12 s). Kept per set of working hours, a day at a time; the windows
 * are the same numbers as before, read again. The arrays are shared — read, never changed.
 */
const windowCache = new Map<string, Map<number, [number, number] | null>>();
function windowsOf(wh: WorkingHours): Map<number, [number, number] | null> {
  const key = `${wh.timezone}|${wh.days.join(",")}|${wh.start}|${wh.end}`;
  let days = windowCache.get(key);
  if (!days) {
    if (windowCache.size >= 50) windowCache.clear();
    days = new Map();
    windowCache.set(key, days);
  }
  return days;
}
function windowOn(wh: WorkingHours, days: Map<number, [number, number] | null>, n: number): [number, number] | null {
  let w = days.get(n);
  if (w === undefined) {
    w = windowOf(wh, fromDayNumber(n));
    if (days.size >= 20_000) days.clear();
    days.set(n, w);
  }
  return w;
}

/** Working minutes between two moments — 0 when `to` is not after `from`. */
export function workingMinutesBetween(wh: WorkingHours, from: Date, to: Date): number {
  const a = from.getTime();
  const b = to.getTime();
  if (!(b > a) || !wh.days.length) return 0;

  const windows = windowsOf(wh);
  const first = dayNumber(localDay(wh.timezone, a));
  const last = Math.min(dayNumber(localDay(wh.timezone, b)), first + MAX_DAYS);
  let total = 0;
  for (let n = first; n <= last; n++) {
    const w = windowOn(wh, windows, n);
    if (!w) continue;
    const s = Math.max(w[0], a);
    const e = Math.min(w[1], b);
    if (e > s) total += e - s;
  }
  return total / MINUTE;
}

/**
 * The latest moment that is at least `minutes` of working time before `now`.
 *
 * Working time only grows the earlier something started, so "assigned at or
 * before this" is exactly "past the limit" — a plain date the database can
 * filter on. The epoch when the hours never add up (no working days).
 */
export function workingCutoff(wh: WorkingHours, now: Date, minutes: number): Date {
  const b = now.getTime();
  let remaining = minutes * MINUTE;
  if (remaining <= 0) return new Date(b);

  const windows = windowsOf(wh);
  const today = dayNumber(localDay(wh.timezone, b));
  for (let i = 0; i < MAX_DAYS; i++) {
    const w = windowOn(wh, windows, today - i);
    if (!w) continue;
    const end = Math.min(w[1], b);
    if (end <= w[0]) continue;
    const span = end - w[0];
    if (span >= remaining) return new Date(end - remaining);
    remaining -= span;
  }
  return new Date(0);
}

/** Midnight at the start of `at`'s calendar day, in the working hours' time zone. */
export function startOfLocalDay(timeZone: string, at: Date): Date {
  return new Date(zonedInstant(timeZone, localDay(timeZone, at.getTime()), 0));
}

/** "2026-09-30" — `at`'s calendar date in `timeZone`. Daily totals are keyed by it. */
export function localDayKey(timeZone: string, at: Date): string {
  const d = localDay(timeZone, at.getTime());
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** "45 min", "1 h", "2 h 30 min". */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.floor(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** The weekday (0 = Sunday) and minute of the day at `at`, in `timeZone`. */
export function localClock(timeZone: string, at: Date): { weekday: number; minutes: number; dayKey: string } {
  const w = new Date(wallClockAsUtc(timeZone, Math.floor(at.getTime() / 1000) * 1000));
  return {
    weekday: w.getUTCDay(),
    minutes: w.getUTCHours() * 60 + w.getUTCMinutes(),
    dayKey: localDayKey(timeZone, at),
  };
}
