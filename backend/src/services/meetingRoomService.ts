import { env } from "../config/env.js";
import { HrmsError, hrmsConfigured, hrmsDelete, hrmsPost, hrmsRequest } from "../lib/hrms.js";

/*
 * Meeting rooms (2026-10-19): the office's rooms are the HRMS's — it keeps the
 * rooms, the bookings and the rules (10:00–19:00 Dubai, one day, not in the
 * past, nobody double-booked). This CRM only shows a day and books or cancels
 * on its people's behalf, through the HRMS's signed integration API, naming
 * itself by CRM so the HRMS can say where a booking came from. Who books or
 * cancels is always the signed-in person — the controller passes their email,
 * never one from the request.
 */

/** This CRM, as the HRMS knows it. */
export const MEETING_ROOMS_CRM = "remote";

export const MEETING_ROOMS_NOT_SET_UP = "Meeting rooms aren't set up on this server (HRMS settings missing)";

export interface MeetingRoom { id: string; name: string; capacity?: number | null; location?: string | null }
export interface MeetingRoomBooking {
  id: string; roomId: string; roomName: string; start: string; end: string; title: string; holder: string;
  mine: boolean; fromThisCrm: boolean;
}
export interface MeetingRoomDay {
  day: string; timeZone: string; open: string; close: string; rooms: MeetingRoom[]; bookings: MeetingRoomBooking[];
}

/** Every HRMS setting the rooms need — the organization too, which each call names. */
export const meetingRoomsConfigured = (): boolean => hrmsConfigured() && !!env.HRMS_ORG_ID;

function ensureConfigured(): void {
  if (!meetingRoomsConfigured()) throw new HrmsError(MEETING_ROOMS_NOT_SET_UP, 503);
}

/** Today on the Dubai calendar, YYYY-MM-DD. */
export const dubaiToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function roomsDay(day: string, viewerEmail: string): Promise<MeetingRoomDay> {
  ensureConfigured();
  return hrmsRequest<MeetingRoomDay>("GET", "/meetings/crm-rooms", {
    organizationId: env.HRMS_ORG_ID, crm: MEETING_ROOMS_CRM, day, viewerEmail,
  });
}

export async function bookRoom(input: {
  roomId: string; start: string; end: string; title: string; bookerEmail: string; bookerName: string;
}): Promise<MeetingRoomBooking> {
  ensureConfigured();
  return hrmsPost<MeetingRoomBooking>("/meetings/crm-bookings", {
    organizationId: env.HRMS_ORG_ID,
    crm: MEETING_ROOMS_CRM,
    roomId: input.roomId,
    start: new Date(input.start).toISOString(),
    end: new Date(input.end).toISOString(),
    title: input.title,
    bookerEmail: input.bookerEmail,
    bookerName: input.bookerName,
  });
}

/** `any` (a super admin): any booking made from this CRM; otherwise only the booker's own — the HRMS checks. */
export async function cancelBooking(id: string, bookerEmail: string, any: boolean): Promise<{ cancelled: boolean }> {
  ensureConfigured();
  return hrmsDelete<{ cancelled: boolean }>(`/meetings/crm-bookings/${encodeURIComponent(id)}`, {
    organizationId: env.HRMS_ORG_ID, crm: MEETING_ROOMS_CRM, bookerEmail, ...(any ? { any: "1" } : {}),
  });
}
