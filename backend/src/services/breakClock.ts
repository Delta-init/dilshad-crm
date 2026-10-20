import { Types } from "mongoose";
import { BreakLog } from "../models/BreakLog.js";
import { User } from "../models/User.js";
import { workingMinutesBetween, type WorkingHours } from "../utils/workingHours.js";
import type { BreakKind } from "../types/index.js";

/*
 * Breaks as time spans (as the Sales CRM, brought here 2026-10-20): the
 * inactive-lead clock stops while a lead's owner is on a break ("Take break" in
 * the header), and nothing of theirs moves while they are on one.
 */

/** [start, end] in ms; the break going on now ends at `now`. */
export type Span = [number, number];

const GST_OFFSET_MS = 4 * 3_600_000;

/** The GST (UTC+4, all year) midnight that started the day `at` falls in. */
export function gstMidnight(at = new Date()): Date {
  const gst = new Date(at.getTime() + GST_OFFSET_MS);
  return new Date(Date.UTC(gst.getUTCFullYear(), gst.getUTCMonth(), gst.getUTCDate()) - GST_OFFSET_MS);
}

/** A break taken today (GST) and not ended. One left from an earlier day has ended with it. */
export const onBreak = (breakSince: Date | string | null | undefined, at = new Date()): boolean =>
  !!breakSince && new Date(breakSince).getTime() >= gstMidnight(at).getTime();

/** When a break started at `since` ends if nobody ends it: the GST midnight after it. */
const dayEndOf = (since: Date): number => gstMidnight(since).getTime() + 86_400_000;

/**
 * Writes down a break that is over — ended at `at`, or at the end of its GST day when it ran on past it. A break
 * already written (two presses at once) is written once.
 */
export async function logBreak(
  userId: Types.ObjectId | string,
  since: Date,
  at = new Date(),
  kind: BreakKind | null = null,
): Promise<void> {
  const end = Math.min(at.getTime(), dayEndOf(since));
  if (end <= since.getTime()) return;
  await BreakLog.updateOne(
    { user: new Types.ObjectId(String(userId)), start: since },
    { $setOnInsert: { end: new Date(end), kind } },
    { upsert: true },
  ).catch((err: { code?: number }) => {
    if (err?.code !== 11000) throw err;
  });
}

export interface Breaks {
  /** Each person's breaks that ended after `from`, and the one going on now (to `now`). */
  spans: Map<string, Span[]>;
  /** Who is on a break right now. */
  onBreakNow: Set<string>;
}

/** The breaks of these people since `from`. */
export async function breaksOf(userIds: string[], from: Date, now = new Date()): Promise<Breaks> {
  const spans = new Map<string, Span[]>();
  const onBreakNow = new Set<string>();
  const ids = [...new Set(userIds)].filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return { spans, onBreakNow };
  const oids = ids.map((id) => new Types.ObjectId(id));
  const [logged, users] = await Promise.all([
    BreakLog.find({ user: { $in: oids }, end: { $gt: from } }).select("user start end").lean(),
    User.find({ _id: { $in: oids }, breakSince: { $ne: null } }).select("breakSince").lean<Array<{ _id: Types.ObjectId; breakSince: Date }>>(),
  ]);
  const add = (id: string, s: Span) => spans.set(id, [...(spans.get(id) ?? []), s]);
  for (const b of logged) add(String(b.user), [new Date(b.start).getTime(), new Date(b.end).getTime()]);
  for (const u of users) {
    const since = new Date(u.breakSince);
    if (onBreak(since, now)) {
      onBreakNow.add(String(u._id));
      add(String(u._id), [since.getTime(), now.getTime()]);
    } else if (!logged.some((b) => String(b.user) === String(u._id) && new Date(b.start).getTime() === since.getTime())) {
      // Left on from an earlier day and never ended: it ended with that day.
      add(String(u._id), [since.getTime(), Math.min(dayEndOf(since), now.getTime())]);
    }
  }
  return { spans, onBreakNow };
}

/** Minutes of `hours` between `from` and `now`, less those spent on the breaks given. */
export function minutesOffBreak(hours: WorkingHours, spans: Span[] | undefined, from: Date, now: Date): number {
  let total = workingMinutesBetween(hours, from, now);
  for (const [s, e] of spans ?? []) {
    const a = Math.max(s, from.getTime()), b = Math.min(e, now.getTime());
    if (b > a) total -= workingMinutesBetween(hours, new Date(a), new Date(b));
  }
  return Math.max(0, total);
}
