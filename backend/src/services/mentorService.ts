import { callLms } from "./lmsClient.js";
import { env } from "../config/env.js";

/**
 * When the academy's mentors are free, and what is already in the diary.
 *
 * Ported from the Root portal, which reads the same LMS the same way. The
 * LMS is the only system that knows this, so both are a pass-through rather
 * than anything clever: ask, check the shape, hand it on. Nothing is cached —
 * a calendar showing yesterday's bookings is worse than one that takes a
 * second, and somebody here is deciding whether a slot is free.
 *
 * Read-only where the portal's is. Availability itself is edited in the LMS,
 * where the people whose time it is can see and change it.
 */

export interface MentorClass {
  id: string;
  /** Null when the class belongs to another academy — the time is shared, the subject is not. */
  title: string | null;
  startsAt: string;
  durationMins: number;
  status: string;
  booked: number;
  capacity: number;
  mine: boolean;
}

export interface MentorMeeting {
  id: string;
  title: string;
  kind: string;
  startsAt: string;
  durationMins: number;
  /** Names only — the calendar says who, not how to reach them. */
  attendeeNames: string[];
  /** Who arranged it; the screen decides from this who may change it. */
  bookedByEmail: string;
}

export interface Mentor {
  id: string;
  name: string;
  email: string;
  /** Lent to this academy rather than belonging to it. */
  shared: boolean;
  /** The academy the mentor belongs to (absent from an older LMS). */
  academy?: { id: string; name: string } | null;
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
  classes: MentorClass[];
  /** Time booked with them that is not a class. */
  meetings: MentorMeeting[];
}

export interface MentorSchedule {
  /**
   * The zone the recurring slots are in, as the LMS reports it.
   *
   * Carried rather than assumed here. Those slots are stored as bare "HH:MM"
   * strings with no zone attached, so the only honest way to render them is
   * to be told which one they mean and to say so on screen.
   */
  timezone: string;
  from: string;
  to: string;
  mentors: Mentor[];
}

const httpError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

/** Longest window the LMS will answer for, matched here so a request this
 *  CRM allows is never one the far side refuses. */
const MAX_WINDOW_DAYS = 62;

/**
 * "Administers the mentor calendar", as the LMS's cross-system meeting
 * endpoints ask every caller to say for themselves.
 *
 * The LMS was built for one such person per caller — the portal's root
 * admin. This CRM has no equivalent role; what it has, already load-bearing
 * elsewhere in this codebase, is a single named super-admin account. Used
 * the same way here: everyone may book and read their own meetings, and this
 * one address may also move or cancel somebody else's.
 */
const isSuperAdmin = (email: string) =>
  email.trim().toLowerCase() === env.SUPER_ADMIN_EMAIL.toLowerCase();

export const mentorService = {
  async schedule(input: { from?: string; to?: string }): Promise<MentorSchedule> {
    const from = input.from ? new Date(input.from) : new Date();
    if (Number.isNaN(from.getTime())) throw httpError("from is not a date", 400);

    const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * 864e5);
    if (Number.isNaN(to.getTime())) throw httpError("to is not a date", 400);
    if (to <= from) throw httpError("to must be after from", 400);
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 864e5) {
      throw httpError(`At most ${MAX_WINDOW_DAYS} days at a time`, 400);
    }

    /* Both academies' mentors, each with its academy, and every class with its title (2026-10-17: one company
       runs Dubai and Bangalore, and the staff here book either — as Root's calendar does). */
    const data = await callLms<MentorSchedule>("/mentors", {
      query: { from: from.toISOString(), to: to.toISOString(), allAcademies: "1" },
      verb: "list its mentors",
    });

    return {
      timezone: data.timezone || "",
      from: data.from || from.toISOString(),
      to: data.to || to.toISOString(),
      mentors: (data.mentors ?? []).map((m) => ({ ...m, meetings: m.meetings ?? [] })),
    };
  },

  /**
   * One live class in full.
   *
   * The academy's own only — the LMS refuses anybody else's, and the calendar
   * already shows those as an hour that is taken rather than a subject
   * anybody may read.
   */
  async classDetail(classId: string) {
    return callLms<Record<string, unknown>>(`/classes/${encodeURIComponent(classId)}`, {
      verb: "describe that class",
    });
  },

  /**
   * Book time with a mentor.
   *
   * Passed through rather than decided here. Whether the hour is free,
   * whether the mentor belongs to this academy, whether a joining link can be
   * made — all of that is the LMS's to answer, and a second opinion here
   * would go stale the moment somebody books through the portal or the LMS
   * instead.
   *
   * Open to anybody signed in to this CRM — booking an hour with a mentor is
   * work the people doing the work do, not something to gate behind a
   * permission first.
   */
  async scheduleMeeting(input: {
    mentorEmail: string;
    title: string;
    kind: string;
    scheduledStart: string;
    durationMins: number;
    meetingUrl?: string;
    attendees: { name: string; email?: string }[];
    notes?: string;
    bookedByEmail: string;
  }): Promise<{ meeting: MentorMeeting & { meetingUrl: string }; linkNote: string | null }> {
    return callLms("/mentor-meetings", {
      method: "POST",
      verb: "book that meeting",
      // Any academy's mentor, as the calendar lists both (2026-10-17).
      body: { ...input, allAcademies: true },
    });
  },

  /**
   * One meeting in full, for whoever may change it.
   *
   * Who is asking travels with the request, because the LMS has no idea who
   * is signed in here. Everybody else is told the meeting does not exist
   * rather than that they may not look — the same answer they would get for
   * one in another academy.
   */
  async getMeeting(input: { meetingId: string; actorEmail: string }) {
    return callLms<{
      id: string; title: string; kind: string; startsAt: string; durationMins: number;
      meetingUrl: string; notes: string; bookedByEmail: string;
      mentorEmail: string; mentorName: string; timezone: string;
      attendees: { name: string; email: string }[];
    }>(`/mentor-meetings/${encodeURIComponent(input.meetingId)}`, {
      query: { actorEmail: input.actorEmail, actorIsRootAdmin: String(isSuperAdmin(input.actorEmail)) },
      verb: "describe that meeting",
    });
  },

  /** Move it, or change who is on it. */
  async updateMeeting(input: Record<string, unknown> & { meetingId: string; actorEmail: string }) {
    const { meetingId, actorEmail, ...rest } = input;
    return callLms<{ id: string; notified: boolean }>(`/mentor-meetings/${encodeURIComponent(meetingId)}`, {
      method: "PATCH",
      verb: "change that meeting",
      body: { ...rest, actorEmail, actorIsRootAdmin: isSuperAdmin(actorEmail) },
    });
  },

  /** Call it off. */
  async cancelMeeting(input: { meetingId: string; actorEmail: string }) {
    return callLms<{ id: string; cancelled: boolean }>(`/mentor-meetings/${encodeURIComponent(input.meetingId)}/cancel`, {
      method: "POST",
      verb: "cancel that meeting",
      body: { actorEmail: input.actorEmail, actorIsRootAdmin: isSuperAdmin(input.actorEmail) },
    });
  },
};
