import { z } from "zod";

/** A real calendar day, YYYY-MM-DD (Dubai). */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "That isn't a date");

const instant = z
  .string()
  .trim()
  .min(1, "Choose a time")
  .refine((v) => !Number.isNaN(Date.parse(v)), "That isn't a time");

// GET /meeting-rooms/day?date=YYYY-MM-DD (today in Dubai when left out)
export const meetingRoomDayQuery = z.object({
  date: z.preprocess((v) => (v === "" ? undefined : v), day.optional()),
});

// POST /meeting-rooms/bookings — who books is the signed-in person, never the body.
export const meetingRoomBookingBody = z
  .object({
    roomId: z.string().trim().min(1, "Choose a room").max(100),
    start: instant,
    end: instant,
    title: z.string().trim().min(1, "Give the meeting a title").max(200, "Keep the title under 200 characters"),
  })
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), { message: "The meeting must end after it starts", path: ["end"] });

/** A booking id as the HRMS hands them out — nothing that could reshape the path. */
export const meetingRoomBookingId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid booking id");
