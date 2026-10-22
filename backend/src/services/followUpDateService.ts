import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";

/*
 * Changing a lead's next follow-up date (the user, 2026-10-22: "follow-up date editing we need"). Until now the date
 * only moved by logging a follow-up or by setting Follow Up again. Changing it here:
 *   - sets the lead's nextFollowUpAt, and clears the missed-follow-up stamp so the warning can fire for the new date;
 *   - moves the open "Follow-up due" reminder made with the old date to the new one (its alerts re-armed), or makes one
 *     for the lead's owner when there isn't one — the date and its reminder stay one thing on the Reminders page;
 *   - notes the move in the lead's activity.
 * The other way round, editing that reminder's time moves the date (syncFollowUpDateWithReminder, from updateReminder).
 */

export const FOLLOW_UP_REMINDER_TITLE = "Follow-up due";
/** A reminder this close to the follow-up date is the one made with it. */
const SAME_MS = 60_000;
/** A date further ahead than this is a typo. */
const MAX_AHEAD_MS = 366 * 86_400_000;

const sameTime = (a: Date | null | undefined, b: Date | null | undefined) =>
  !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= SAME_MS;

const gst = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(d);

type ReminderLike = { _id: unknown; title?: string; remindAt?: Date; isDone?: boolean; notifiedAt?: Date | null; warnedAt?: Date | null; createdBy?: unknown };

/** Why a date can't be used, or null. */
export function followUpDateProblem(at: Date, now = Date.now()): string | null {
  if (Number.isNaN(at.getTime())) return "Pick a valid date and time";
  if (at.getTime() < now - SAME_MS) return "The follow-up time must be in the future (GST)";
  if (at.getTime() > now + MAX_AHEAD_MS) return "The follow-up time is more than a year ahead";
  return null;
}

export async function changeFollowUpDate(leadId: string, userId: string, at: Date, note?: string) {
  const problem = followUpDateProblem(at);
  if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
  if (!mongoose.isValidObjectId(leadId)) throw Object.assign(new Error("Invalid ID format"), { statusCode: 400 });
  const lead = await Lead.findById(leadId);
  if (!lead) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

  const doc = lead as unknown as Record<string, unknown> & {
    reminders: ReminderLike[] & { push: (v: object) => number };
    activityLogs: { push: (v: object) => number };
    assignedTo?: unknown;
  };
  const before = (doc.nextFollowUpAt as Date | null | undefined) ?? null;
  doc.nextFollowUpAt = at;
  doc.missedFollowUpWarnedAt = null;

  const open = doc.reminders.filter((r) => !r.isDone && r.title === FOLLOW_UP_REMINDER_TITLE);
  const reminder = open.find((r) => sameTime(r.remindAt, before)) ?? (before ? null : open.find((r) => sameTime(r.remindAt, at)));
  const cleanNote = note?.trim() ?? "";
  if (reminder) {
    reminder.remindAt = at;
    reminder.notifiedAt = null;
    reminder.warnedAt = null;
  } else {
    doc.reminders.push({
      title: FOLLOW_UP_REMINDER_TITLE,
      note: cleanNote.slice(0, 1000),
      remindAt: at,
      createdBy: doc.assignedTo ?? userId,
      isDone: false,
    });
  }

  doc.activityLogs.push({
    action: "lead_updated",
    description: (before
      ? `Next follow-up moved from ${gst(before)} to ${gst(at)} (GST)`
      : `Next follow-up set for ${gst(at)} (GST)`) + (cleanNote ? ` — ${cleanNote}` : ""),
    performedBy: userId,
    createdAt: new Date(),
  });

  await lead.save();
  return { nextFollowUpAt: at.toISOString(), previous: before ? new Date(before).toISOString() : null };
}

/**
 * A reminder's time was edited from `from` to `to`: if it is the lead's open "Follow-up due" reminder for its next
 * follow-up date, the date moves with it (and its missed stamp goes). Call before saving the lead.
 */
export function syncFollowUpDateWithReminder(lead: unknown, reminder: ReminderLike, from: Date | null | undefined, to: Date): void {
  const doc = lead as Record<string, unknown>;
  if (reminder.isDone || reminder.title !== FOLLOW_UP_REMINDER_TITLE) return;
  if (!sameTime(doc.nextFollowUpAt as Date | null | undefined, from)) return;
  doc.nextFollowUpAt = to;
  doc.missedFollowUpWarnedAt = null;
}
