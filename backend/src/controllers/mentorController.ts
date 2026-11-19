import type { Response, NextFunction } from "express";
import { Types } from "mongoose";
import { mentorService } from "../services/mentorService.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";
import type { AuthenticatedRequest } from "../types/index.js";

/**
 * Ported from the Root portal, which reads the same LMS for the same reason:
 * the people who need an hour with a mentor are the people doing the work,
 * and a calendar only somebody else can see is one they have to ask another
 * person to read for them.
 *
 * Nothing here reaches into another system on the caller's behalf — it lists
 * one academy's mentors and books time with them, both of which the LMS
 * authorises for itself.
 */

/**
 * GET /mentors/held-meetings?leadId= (2026-11-18) — for the close form's "Meeting done by": the meetings the person
 * closing booked with a mentor (and the lead's owner, where that is somebody else) that have been held, the client's
 * first. Nothing is written.
 */
export const heldMeetings = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const leadId = typeof req.query["leadId"] === "string" ? req.query["leadId"] : "";
    const lead = Types.ObjectId.isValid(leadId) ? await Lead.findById(leadId).select("name assignedTo").lean() : null;
    const owner = lead?.assignedTo ? await User.findById(lead.assignedTo).select("email").lean() : null;
    const bookers = [req.user?.email ?? "", (owner as { email?: string } | null)?.email ?? ""];
    sendSuccess(res, "Held meetings", { meetings: await mentorService.heldMeetings({ bookers, clientName: lead?.name ?? "" }) });
  } catch (error) {
    next(error);
  }
};

/** The academy's mentors across a window of days. */
export const mentorSchedule = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    sendSuccess(res, "Mentor schedule", await mentorService.schedule({ from, to }));
  } catch (error) {
    next(error);
  }
};

/** One live class in full, for the calendar's detail panel. */
export const classDetail = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { classId } = req.params as { classId: string };
    sendSuccess(res, "Class", await mentorService.classDetail(classId));
  } catch (error) {
    next(error);
  }
};

/**
 * Book time with a mentor.
 *
 * Who booked it is never taken from the request body — whoever is signed in
 * is who booked it, the same rule the portal holds.
 */
export const scheduleMeeting = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mentorEmail = String(b["mentorEmail"] ?? "").trim();
    if (!mentorEmail) { sendError(res, "Choose a mentor", 400); return; }

    const result = await mentorService.scheduleMeeting({
      mentorEmail,
      title: String(b["title"] ?? ""),
      kind: String(b["kind"] ?? ""),
      scheduledStart: String(b["scheduledStart"] ?? ""),
      durationMins: Number(b["durationMins"] ?? 0),
      meetingUrl: b["meetingUrl"] ? String(b["meetingUrl"]) : undefined,
      // Taken as a list, filtered to the rows somebody actually filled in. A
      // half-typed row left behind in the form is not a person to invite.
      attendees: (Array.isArray(b["attendees"]) ? b["attendees"] : [])
        .map((a) => {
          const row = (a ?? {}) as { name?: unknown; email?: unknown };
          return { name: String(row.name ?? "").trim(), email: String(row.email ?? "").trim() };
        })
        .filter((a) => a.name.length > 0),
      notes: b["notes"] ? String(b["notes"]) : undefined,
      bookedByEmail: req.user!.email,
    });

    sendSuccess(res, "Meeting booked", result);
  } catch (error) {
    next(error);
  }
};

/** One meeting in full — only for whoever may change it, as the LMS decides. */
export const meetingDetail = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { meetingId } = req.params as { meetingId: string };
    sendSuccess(res, "Meeting", await mentorService.getMeeting({ meetingId, actorEmail: req.user!.email }));
  } catch (error) {
    next(error);
  }
};

/** Move it, or change who is on it. */
export const updateMeeting = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { meetingId } = req.params as { meetingId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;

    const attendees = Array.isArray(b["attendees"])
      ? (b["attendees"] as unknown[])
          .map((a) => {
            const row = (a ?? {}) as { name?: unknown; email?: unknown };
            return { name: String(row.name ?? "").trim(), email: String(row.email ?? "").trim() };
          })
          .filter((a) => a.name.length > 0)
      : undefined;

    const result = await mentorService.updateMeeting({
      meetingId,
      actorEmail: req.user!.email,
      ...(b["title"] !== undefined ? { title: String(b["title"]) } : {}),
      ...(b["kind"] !== undefined ? { kind: String(b["kind"]) } : {}),
      ...(b["scheduledStart"] !== undefined ? { scheduledStart: String(b["scheduledStart"]) } : {}),
      ...(b["durationMins"] !== undefined ? { durationMins: Number(b["durationMins"]) } : {}),
      ...(b["meetingUrl"] !== undefined ? { meetingUrl: String(b["meetingUrl"]) } : {}),
      ...(b["notes"] !== undefined ? { notes: String(b["notes"]) } : {}),
      ...(attendees ? { attendees } : {}),
    });

    sendSuccess(res, "Meeting updated", result);
  } catch (error) {
    next(error);
  }
};

/** Call it off. */
export const cancelMeeting = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { meetingId } = req.params as { meetingId: string };
    const result = await mentorService.cancelMeeting({ meetingId, actorEmail: req.user!.email });
    sendSuccess(res, "Meeting cancelled", result);
  } catch (error) {
    next(error);
  }
};
