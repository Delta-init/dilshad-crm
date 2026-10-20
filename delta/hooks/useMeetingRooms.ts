import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import type { ApiResponse } from "@/types";

/*
 * Meeting rooms (2026-10-19): the office's rooms, kept in the HRMS, one Dubai
 * day at a time. The server books and cancels as whoever is signed in; the
 * HRMS says no in its own words ("Meeting Room 1 is already booked then …"),
 * which is what the page shows.
 */

const KEY = ["meeting-rooms"] as const;

export interface MeetingRoom { id: string; name: string; capacity?: number | null; location?: string | null }

export interface MeetingRoomBooking {
  id: string;
  roomId: string;
  roomName: string;
  /** ISO instants. */
  start: string;
  end: string;
  title: string;
  /** Who holds it, as the HRMS names them (and where it was booked from). */
  holder: string;
  /** Booked by the person signed in. */
  mine: boolean;
  /** Booked from this CRM — a super admin may cancel these. */
  fromThisCrm: boolean;
}

export interface MeetingRoomDay {
  day: string;
  timeZone: string;
  /** "10:00" / "19:00", Dubai time. */
  open: string;
  close: string;
  rooms: MeetingRoom[];
  bookings: MeetingRoomBooking[];
  /** Added by this CRM's server: a super admin (not while viewing as someone), and "View as". */
  you?: { superAdmin: boolean; viewOnly: boolean };
}

export interface BookRoomInput { roomId: string; start: string; end: string; title: string }

/** The server's sentence for a failed request, else `fallback`. */
export function meetingRoomError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

/** One Dubai day's rooms and bookings (YYYY-MM-DD). Refreshed every minute while open. */
export const useMeetingRoomsDay = (date: string) =>
  useQuery({
    queryKey: [...KEY, date],
    queryFn: async () => {
      const res = await api.get<ApiResponse<MeetingRoomDay>>("/meeting-rooms/day", { params: { date } });
      return res.data.data!;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    retry: (count, err) => {
      // A refusal (not set up, a bad day) won't change by asking again.
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
      return count < 1 && (status === 0 || status === 502);
    },
  });

/** Book a room. Errors are left to the dialog, which shows the server's sentence. */
export function useBookMeetingRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BookRoomInput) => {
      const res = await api.post<ApiResponse<MeetingRoomBooking>>("/meeting-rooms/bookings", input);
      return res.data.data!;
    },
    onSuccess: (b) => {
      toast.success(`${b?.roomName || "Room"} booked`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCancelMeetingRoomBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete<ApiResponse<{ cancelled: boolean }>>(`/meeting-rooms/bookings/${encodeURIComponent(id)}`);
      return res.data.data!;
    },
    onSuccess: () => toast.success("Booking cancelled"),
    onError: (err) => toast.error(meetingRoomError(err, "Could not cancel the booking")),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
