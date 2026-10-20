import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { User } from "../models/User.js";
import { HrmsError } from "../lib/hrms.js";
import { isSuperAdmin } from "../services/commissionService.js";
import { bookRoom, cancelBooking, dubaiToday, roomsDay } from "../services/meetingRoomService.js";
import { meetingRoomBookingBody, meetingRoomBookingId, meetingRoomDayQuery } from "../validations/meetingRoomValidation.js";
import { sendError, sendSuccess } from "../utils/response.js";

/*
 * Meeting rooms — open to everyone signed in, no module on the Roles screen.
 * The HRMS's refusals (taken, outside hours, not your booking) reach the
 * person in the HRMS's own words and status; the HRMS out of reach is a 503.
 */

const VIEW_ONLY = "View only: you are viewing the CRM as someone else. Go back to your own account to make changes.";

/** The signed-in person as the database has them — their email and name, never the request's. */
async function signedInPerson(req: AuthenticatedRequest): Promise<{ email: string; name: string } | null> {
  const u = await User.findById(req.user!.userId).select("name email").lean<{ name?: string; email?: string } | null>();
  const email = String(u?.email ?? "").trim().toLowerCase();
  return email ? { email, name: String(u?.name ?? "").trim() || email } : null;
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof HrmsError) { sendError(res, err.message, err.status); return; }
  next(err);
}

// GET /meeting-rooms/day?date=YYYY-MM-DD
export async function meetingRoomsDay(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = meetingRoomDayQuery.safeParse(req.query);
    if (!q.success) { sendError(res, q.error.issues[0]?.message ?? "Invalid date", 400); return; }
    const me = await signedInPerson(req);
    if (!me) { sendError(res, "Your account has no email to book rooms with", 400); return; }
    const data = await roomsDay(q.data.date ?? dubaiToday(), me.email);
    const viewOnly = !!req.user!.impersonatedBy;
    sendSuccess(res, "Meeting rooms", { ...data, you: { superAdmin: !viewOnly && isSuperAdmin(req.user!.role), viewOnly } });
  } catch (err) {
    fail(res, next, err);
  }
}

// POST /meeting-rooms/bookings { roomId, start, end, title }
export async function bookMeetingRoom(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user!.impersonatedBy) { sendError(res, VIEW_ONLY, 403); return; }
    const b = meetingRoomBookingBody.safeParse(req.body ?? {});
    if (!b.success) { sendError(res, b.error.issues[0]?.message ?? "Check the booking", 400); return; }
    const me = await signedInPerson(req);
    if (!me) { sendError(res, "Your account has no email to book rooms with", 400); return; }
    const booking = await bookRoom({ ...b.data, bookerEmail: me.email, bookerName: me.name });
    sendSuccess(res, "Room booked", booking, 201);
  } catch (err) {
    fail(res, next, err);
  }
}

// DELETE /meeting-rooms/bookings/:id
export async function cancelMeetingRoomBooking(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user!.impersonatedBy) { sendError(res, VIEW_ONLY, 403); return; }
    const id = meetingRoomBookingId.safeParse(req.params.id);
    if (!id.success) { sendError(res, "Invalid booking id", 400); return; }
    const me = await signedInPerson(req);
    if (!me) { sendError(res, "Your account has no email to book rooms with", 400); return; }
    const result = await cancelBooking(id.data, me.email, isSuperAdmin(req.user!.role));
    sendSuccess(res, "Booking cancelled", result);
  } catch (err) {
    fail(res, next, err);
  }
}
