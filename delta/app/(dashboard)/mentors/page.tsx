"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Plus, Search, Users2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store/authStore";
import { ClassInfo } from "@/components/mentors/ClassInfo";
import { WhoIsFree } from "@/components/mentors/WhoIsFree";

/** Ported alongside this page rather than shared: the rest of this codebase
    keeps this same small helper private to whichever file needs it (see
    hooks/useLeads.ts's errMsg), rather than one import everybody reaches for. */
function apiErrorMessage(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
}

/**
 * When the academy's mentors are free, and what is already booked.
 *
 * Two things on one grid, because either alone answers half the question. The
 * muted band behind a day is the pattern somebody set — "Tuesdays, nine to
 * twelve" — and the solid blocks are what has actually been booked into it.
 * A mentor with a wide band and nothing in it is free; the same band full of
 * blocks is not, and the difference is the entire point of looking.
 *
 * A week at a time. A month of seven-day columns is unreadable at this width,
 * and the question being asked is nearly always about this week or next.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

interface MentorClass {
  id: string;
  title: string | null;
  startsAt: string;
  durationMins: number;
  status: string;
  booked: number;
  capacity: number;
  mine: boolean;
  /** The course and module it is a class of — the academy's own classes only (absent from an older LMS). */
  courseId?: string | null;
  course?: string | null;
  moduleId?: string | null;
  module?: string | null;
}

interface MentorMeeting {
  id: string;
  title: string;
  kind: string;
  startsAt: string;
  durationMins: number;
  attendeeNames: string[];
  bookedByEmail: string;
}

/** When the mentor can't be booked (2026-10-23) — marked in the LMS or the commission portal; the LMS refuses any
    booking inside it. No reason comes to the CRMs. */
interface MentorTimeOff {
  id: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}

interface Mentor {
  id: string;
  name: string;
  email: string;
  shared: boolean;
  /** Which academy they teach for — both academies' mentors are listed (2026-10-17); absent from an older LMS. */
  academy?: { id: string; name: string } | null;
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
  classes: MentorClass[];
  meetings: MentorMeeting[];
  /** Absent from an older server. */
  timeOff?: MentorTimeOff[];
}

const KIND_LABEL: Record<string, string> = {
  staff: "Staff",
  student: "Student",
  client: "Client",
};

interface Schedule {
  timezone: string;
  from: string;
  to: string;
  mentors: Mentor[];
}

/** Midnight on the Sunday of whatever week this date falls in. */
const weekStart = (d: Date) => {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
};

export default function MentorsPage() {
  const { user } = useAuthStore();
  const can = useAuthStore((s) => s.hasPermission);
  /* The Mentors row on the Roles screen: create books, edit changes a booking,
     delete cancels one. The server checks the same boxes. */
  const canBook = can("mentors", "create");
  const canChange = can("mentors", "edit");
  const canCancel = can("mentors", "delete");
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  /* Which day the phone is showing. Seven columns do not fit on a phone and
     shrinking them to where they do makes every one of them unreadable, so the
     narrow view is one day at a time and this is which. Index into `days`, so
     stepping the week keeps it pointing at the same weekday. */
  const [dayIndex, setDayIndex] = useState(() => (new Date().getDay() + 6) % 7);

  const { from, to, days } = useMemo(() => {
    const start = weekStart(new Date());
    start.setDate(start.getDate() + offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    /*
     * Asked for a day either side of the week on show.
     *
     * The window is built from browser-local midnights, so for a viewer east
     * of the academy it begins and ends a few hours early in the academy's own
     * day — and a meeting late on the final Saturday would simply not be
     * fetched, leaving its cell looking empty rather than full. A day of slack
     * costs nothing and removes the edge entirely; which cell each hour lands
     * in is decided afterwards, by the column it actually belongs to.
     */
    const pad = 864e5;
    return {
      from: new Date(start.getTime() - pad).toISOString(),
      to: new Date(end.getTime() + pad).toISOString(),
      days: Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return d;
      }),
    };
  }, [offset]);

  const schedule = useQuery({
    queryKey: ["mentors", "schedule", from, to],
    retry: false,
    queryFn: async () =>
      (
        await api.get<{ data: Schedule }>(
          `/mentors/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        )
      ).data.data,
  });

  const tz = schedule.data?.timezone || "Asia/Dubai";

  /*
   * Which column an hour belongs in.
   *
   * The two sides are asked different questions on purpose, and getting that
   * wrong put bookings one column to the right for anybody east of Dubai.
   *
   * A column is a calendar date — the "23" in its heading — and nothing more.
   * It has no time and no zone, so it is read straight off the date's own
   * year, month and day. Converting it into the academy's zone was the bug: a
   * browser in India builds midnight on the 23rd, which is half past ten on
   * the 22nd in Dubai, so the column labelled 23 started calling itself the
   * 22nd while a meeting genuinely on the 23rd called itself the 23rd — and
   * landed in the cell headed 24.
   *
   * A meeting, by contrast, is a real instant, so the only meaningful question
   * is which day it falls on *there*. That one does need the zone.
   */
  const columnKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const sameDay = (iso: string, day: Date) =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }) === columnKey(day);

  /*
   * The part of a mentor's time off on one column's day, as minutes of that day in the academy's zone (0–1440), or
   * null when it doesn't touch it. Time off can run for days, so it is clipped to each day it covers rather than
   * placed by its start the way a class is.
   */
  const offOnDay = (t: MentorTimeOff, day: Date) => {
    const guess = new Date(`${columnKey(day)}T00:00:00Z`);
    // That instant on the academy's clock, read as if it were UTC — the difference is the zone's offset, whatever the
    // browser's own zone (parsing a toLocaleString back would add the browser's offset on top).
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    const dayFrom = guess.getTime() - (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - guess.getTime());
    const a = Math.max(new Date(t.startsAt).getTime(), dayFrom);
    const b = Math.min(new Date(t.endsAt).getTime(), dayFrom + 864e5);
    if (b <= a) return null;
    return { from: Math.round((a - dayFrom) / 60000), to: Math.round((b - dayFrom) / 60000) };
  };
  const hm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

  /*
   * Finding one person in a long list.
   *
   * Filtered here rather than asked of the LMS again: the whole week is
   * already in hand, and a round trip per keystroke would make the grid flicker
   * to answer a question the browser can answer instantly.
   *
   * Name and address both, because the list shows both and people search by
   * whichever they happen to know.
   */
  const [query, setQuery] = useState("");
  /* The Who's free popup (2026-10-25). */
  const [freeOpen, setFreeOpen] = useState(false);

  /*
   * Search the sessions — a class by its title, course or module, a booked
   * session by its title or who it is with — and narrow the classes to a course
   * and its module (2026-10-09). Booked sessions belong to no course, so the
   * course and module leave them be; the search does not.
   */
  const [find, setFind] = useState("");
  /* Dubai's mentors, Bangalore's, or both (2026-10-17) — "" for both. */
  const [academy, setAcademy] = useState("");
  const academies = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of schedule.data?.mentors ?? []) if (x.academy?.id) m.set(x.academy.id, x.academy.name || "Academy");
    return Array.from(m).sort((a, b) => a[1].localeCompare(b[1]));
  }, [schedule.data]);
  const [course, setCourse] = useState("");
  const [mod, setMod] = useState("");
  const { courses, modules } = useMemo(() => {
    const cs = new Map<string, string>(), ms = new Map<string, string>();
    for (const m of schedule.data?.mentors ?? []) for (const c of m.classes ?? []) {
      if (c.courseId) cs.set(c.courseId, c.course || "Course");
      if (c.courseId === course && c.moduleId) ms.set(c.moduleId, c.module || "Module");
    }
    const sorted = (m: Map<string, string>) => Array.from(m).sort((a, b) => a[1].localeCompare(b[1]));
    return { courses: sorted(cs), modules: sorted(ms) };
  }, [schedule.data, course]);
  const needle = find.trim().toLowerCase();
  const filtering = !!(needle || course);
  const has = (...vs: (string | null | undefined)[]) => vs.some((v) => String(v ?? "").toLowerCase().includes(needle));
  const classShown = (c: MentorClass) =>
    (!course || c.courseId === course) && (!mod || c.moduleId === mod) && (!needle || (c.mine && has(c.title, c.course, c.module)));
  const meetingShown = (v: MentorMeeting) => !needle || has(v.title, ...(v.attendeeNames ?? []));

  /* Who's free looks at the people on the page (academy and name), whatever sessions are being searched. */
  const freeCandidates = useMemo(() => {
    const all = schedule.data?.mentors ?? [];
    const q = query.trim().toLowerCase();
    const inAcademy = academy ? all.filter((m) => m.academy?.id === academy) : all;
    return q ? inAcademy.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) : inAcademy;
  }, [schedule.data, query, academy]);

  const shown = useMemo(() => {
    const all = schedule.data?.mentors ?? [];
    const q = query.trim().toLowerCase();
    const inAcademy = academy ? all.filter((m) => m.academy?.id === academy) : all;
    const people = q ? inAcademy.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)) : inAcademy;
    // Searching or narrowing: only the mentors with something that matches this week.
    return filtering
      ? people.filter((m) => m.classes.some((c) => c.status !== "cancelled" && classShown(c)) || m.meetings.some(meetingShown))
      : people;
  }, [schedule.data, query, needle, course, mod, academy]);

  /*
   * Booking an hour.
   *
   * Opened from the day it is for, with that mentor already chosen: the
   * commonest mistake a form like this invites is booking the right hour with
   * the wrong person, and picking neither of them twice removes it.
   *
   * The time is typed in the academy's zone, like everything else here, and
   * converted on the way out — a form that quietly means the browser's zone
   * would book an hour nobody agreed to.
   */
  const [booking, setBooking] = useState<{ mentor: Mentor; day: Date } | null>(null);
  const [form, setForm] = useState({
    title: "", kind: "staff", time: "10:00", durationMins: "30",
    meetingUrl: "", notes: "",
  });
  /* Who is coming, as rows. A staff meeting is rarely two people, and everybody
     with an address gets the invitation and the joining link. Starts as one
     empty row so the commonest case needs no clicking. */
  const [guests, setGuests] = useState<{ name: string; email: string }[]>([
    { name: "", email: "" },
  ]);

  /*
   * Looking at one meeting, and changing it.
   *
   * The chip opens this rather than the booking form — clicking an hour that
   * already exists plainly means "what is this", not "put something else here".
   * The cell around it still books, so the empty space keeps its old meaning.
   */
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewingClass, setViewingClass] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const detail = useQuery({
    queryKey: ["mentors", "meeting", viewing],
    enabled: Boolean(viewing),
    retry: false,
    queryFn: async () =>
      (
        await api.get<{ data: {
          id: string; title: string; kind: string; startsAt: string; durationMins: number;
          meetingUrl: string; notes: string; bookedByEmail: string;
          mentorEmail: string; mentorName: string;
          attendees: { name: string; email: string }[];
        } }>(`/mentors/meetings/${viewing}`)
      ).data.data,
  });

  /* A class, read-only. The portal shows what is happening; a course's own
     session is edited where the course is. */
  const classDetail = useQuery({
    queryKey: ["mentors", "class", viewingClass],
    enabled: Boolean(viewingClass),
    retry: false,
    queryFn: async () =>
      (await api.get<{ data: Record<string, unknown> }>(`/mentors/classes/${viewingClass}`)).data.data,
  });

  const cancelMeeting = useMutation({
    mutationFn: async (id: string) => api.post(`/mentors/meetings/${id}/cancel`),
    onSuccess: () => {
      toast.success("Cancelled — everybody has been told");
      setConfirmCancel(false);
      setViewing(null);
      void qc.invalidateQueries({ queryKey: ["mentors", "schedule"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Could not cancel that")),
  });

  /* From a cell: ten o'clock, half an hour. From Who's free (2026-10-25): the time and length picked there. */
  const openBooking = (mentor: Mentor, day: Date, time = "10:00", durationMins = 30) => {
    setBooking({ mentor, day });
    setForm({
      title: "", kind: "staff", time, durationMins: String(durationMins),
      meetingUrl: "", notes: "",
    });
    setGuests([{ name: "", email: "" }]);
    setEditingId(null);
  };

  /* Edit reuses the booking form, filled in. Two forms for one set of fields
     would drift apart, and the second one to drift is always the one nobody
     opens. */
  const openEdit = (mentor: Mentor, d: NonNullable<typeof detail.data>) => {
    const when = new Date(d.startsAt);
    setBooking({ mentor, day: when });
    setForm({
      title: d.title,
      kind: d.kind,
      time: when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }),
      durationMins: String(d.durationMins),
      meetingUrl: d.meetingUrl,
      notes: d.notes,
    });
    setGuests(d.attendees.length ? d.attendees.map((a) => ({ name: a.name, email: a.email })) : [{ name: "", email: "" }]);
    setEditingId(d.id);
    setViewing(null);
  };


  /*
   * The half-hours of the chosen day, and what is already in each.
   *
   * Built from the week the calendar is already holding — nothing is fetched to
   * answer this. Every class and meeting that mentor has on that day is turned
   * into a span of minutes, and a slot is taken when the meeting being booked
   * would run into one of them. Which is why the duration matters: a
   * half-hour fits where ninety minutes does not, so changing it re-reads the
   * whole list.
   *
   * Taken slots say what is in the way rather than going quietly grey. "14:00
   * · SEO 2" tells somebody whether it is worth asking for that hour anyway;
   * a disabled row tells them nothing.
   *
   * Outside the mentor's stated hours is marked, never disabled. Those hours
   * are a pattern somebody set, not a contract — the same reasoning the LMS
   * applies when it refuses to enforce them.
   */
  const SLOT_MINUTES = 30;
  const NOT_AVAILABLE = "Not available";

  const minutesInZone = (iso: string) => {
    const hhmm = new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
    });
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const slotList = useMemo(() => {
    if (!booking) return [];
    const { mentor, day } = booking;
    const duration = Number(form.durationMins) || SLOT_MINUTES;

    const busy: { from: number; to: number; what: string }[] = [
      ...mentor.classes
        .filter((c) => sameDay(c.startsAt, day) && c.status !== "cancelled")
        .map((c) => {
          const from = minutesInZone(c.startsAt);
          return { from, to: from + (c.durationMins || 0), what: c.mine ? (c.title || "a class") : "another academy" };
        }),
      ...mentor.meetings
        .filter((v) => sameDay(v.startsAt, day))
        .map((v) => {
          const from = minutesInZone(v.startsAt);
          return { from, to: from + (v.durationMins || 0), what: v.attendeeNames.join(", ") || v.title };
        }),
      /* Their time off: taken like anything booked — the LMS refuses it anyway (2026-10-23). */
      ...(mentor.timeOff ?? [])
        .map((t) => offOnDay(t, day))
        .filter((x): x is { from: number; to: number } => x !== null)
        .map((x) => ({ ...x, what: NOT_AVAILABLE })),
    ];

    const free = mentor.slots.filter((sl) => sl.dayOfWeek === day.getDay());
    const inHours = (start: number) =>
      free.length === 0 ||
      free.some((sl) => {
        const [fh, fm] = sl.startTime.split(":").map(Number);
        const [th, tm] = sl.endTime.split(":").map(Number);
        return start >= (fh ?? 0) * 60 + (fm ?? 0) && start + duration <= (th ?? 0) * 60 + (tm ?? 0);
      });

    const out: { value: string; label: string; taken: string; outside: boolean }[] = [];
    for (let m = 0; m < 24 * 60; m += SLOT_MINUTES) {
      const value = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const clash = busy.find((b) => m < b.to && b.from < m + duration);
      out.push({
        value,
        label: value,
        taken: clash ? clash.what : "",
        outside: !inHours(m),
      });
    }
    return out;
  }, [booking, form.durationMins, tz, schedule.data]);

  /*
   * Stretching a meeting can take away the hour it was going to start in.
   *
   * The select would then sit on a row it will not let you choose again, and
   * the only sign would be the LMS refusing it at the end. So when the chosen
   * slot stops being free, the next free one is picked — moving the booking is
   * a smaller surprise than a refusal after filling the rest of the form in.
   */
  useEffect(() => {
    if (!booking || slotList.length === 0) return;
    const current = slotList.find((sl) => sl.value === form.time);
    if (current && !current.taken) return;
    const next = slotList.find((sl) => !sl.taken);
    if (next) setForm((f) => ({ ...f, time: next.value }));
  }, [slotList, booking, form.time]);

  const book = useMutation({
    mutationFn: async () => {
      if (!booking) throw new Error("Nothing to book");
      /* The chosen day at the chosen wall-clock time, in the academy's zone.
         Built by asking what that wall time is worth in UTC rather than by
         trusting the browser's own offset, which is somebody else's hour. */
      const [h, min] = form.time.split(":").map(Number);
      const local = new Date(booking.day);
      local.setHours(h ?? 0, min ?? 0, 0, 0);
      const asIfHere = new Date(
        local.toLocaleString("en-US", { timeZone: tz }),
      );
      const drift = local.getTime() - asIfHere.getTime();
      const startsAt = new Date(local.getTime() + drift);

      const payload = {
          mentorEmail: booking.mentor.email,
          title: form.title.trim(),
          kind: form.kind,
          scheduledStart: startsAt.toISOString(),
          durationMins: Number(form.durationMins),
          attendees: guests
            .map((g) => ({ name: g.name.trim(), email: g.email.trim() }))
            .filter((g) => g.name.length > 0),
          meetingUrl: form.meetingUrl.trim() || undefined,
          notes: form.notes.trim() || undefined,
      };

      /* The same fields either way. An edit that could only change some of
         them would send somebody back to the LMS for the rest. */
      if (editingId) {
        return (await api.patch<{ data: { linkNote: string | null } }>(
          `/mentors/meetings/${editingId}`, payload,
        )).data.data;
      }
      return (await api.post<{ data: { linkNote: string | null } }>(
        "/mentors/meetings", payload,
      )).data.data;
    },
    onSuccess: (d) => {
      /* Counted rather than written down: it said "both of them" while any
         number of people could be on it. Only the ones with an address are
         emailed, so that is the number worth reporting. */
      const emailed = guests.filter((g) => g.name.trim() && g.email.trim()).length;
      const who = `the mentor${emailed ? ` and ${emailed} guest${emailed > 1 ? "s" : ""}` : ""}`;
      toast.success(
        d?.linkNote ?? (editingId ? `Updated — ${who} told` : `Booked — ${who} emailed`),
      );
      setBooking(null);
      void qc.invalidateQueries({ queryKey: ["mentors", "schedule"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Could not book that")),
  });

  /*
   * Every time on this page is drawn in the academy's zone, never the
   * browser's.
   *
   * The recurring slots are stored as bare "HH:MM" with no zone at all, so
   * they only mean anything in the academy's own. Rendering the classes beside
   * them in whatever zone the viewer happens to sit in would put the two
   * halves of one row hours apart, both looking perfectly reasonable.
   */
  /*
   * One mentor's day: the pattern they set, the classes in it, the meetings
   * booked into it.
   *
   * Written once and rendered twice — a column of a week on a wide screen, a
   * card on a phone. The two views differ in how a day is *reached*, never in
   * what a day contains, and keeping that honest is worth a function.
   */
  const dayCell = (m: Mentor, day: Date) => {
    const slots = m.slots.filter((s) => s.dayOfWeek === day.getDay());
    const booked = m.classes.filter((c) => sameDay(c.startsAt, day) && classShown(c));
    const meetings = m.meetings.filter((v) => sameDay(v.startsAt, day) && meetingShown(v));
    const offs = (m.timeOff ?? []).map((t) => ({ t, on: offOnDay(t, day) })).filter((x) => x.on !== null);
    const empty = slots.length === 0 && booked.length === 0 && meetings.length === 0 && offs.length === 0;

    if (empty) return null;
    return (
      <div className="space-y-1">
        {/* Their time off (2026-10-23): nothing can be booked in it. */}
        {offs.map(({ t, on }) => (
          <div
            key={t.id}
            title="Not available — the mentor can't be booked then"
            className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-400"
          >
            <span className="tabular-nums">{on!.from === 0 && on!.to === 1440 ? "All day" : `${hm(on!.from)}–${hm(on!.to)}`}</span> · Not available
          </div>
        ))}

        {/* The pattern, behind everything else. */}
        {slots.map((s, i) => (
          <div
            key={`${s.startTime}-${i}`}
            className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-500"
          >
            {s.startTime}–{s.endTime}
          </div>
        ))}

        {/* What is actually in the diary. */}
        {booked.map((c) => (
          <button
            type="button"
            key={c.id}
            disabled={!c.mine}
            onClick={(e) => { e.stopPropagation(); if (c.mine) setViewingClass(c.id); }}
            title={
              c.mine
                ? `${c.title ?? "Class"} · ${c.booked}/${c.capacity} booked · ${c.status}`
                : "A class for the other academy — the time is taken, the subject is not shown"
            }
            className={cn(
              "w-full rounded border px-1.5 py-0.5 text-left text-[11px]",
              c.mine && "transition-colors hover:brightness-125",
              c.status === "cancelled"
                ? "border-border/60 bg-muted/40 text-muted-foreground line-through"
                : c.mine
                  ? "border-blue-500/30 bg-blue-500/15 text-blue-400"
                  : "border-border/60 bg-muted/60 text-muted-foreground",
            )}
          >
            <span className="tabular-nums">{at(c.startsAt)}</span>{" "}
            {c.mine ? (c.title || "Class") : "Booked elsewhere"}
            {/* Cancelled in the LMS: still shown, so an empty-looking day says why (2026-10-17). */}
            {c.status === "cancelled" && <span className="ml-1 inline-block rounded bg-rose-500/15 px-1 text-[10px] font-medium text-rose-400 no-underline">Cancelled</span>}
            {c.mine && c.course && (
              <span className="block truncate text-[10px] opacity-70">{c.course}{c.module ? ` · ${c.module}` : ""}</span>
            )}
          </button>
        ))}

        {/* Meetings, which are nobody's class. Named by
            kind and attendee rather than by title alone:
            "Intro call" tells you nothing, "Client ·
            Rahul Menon" tells you whether it can move. */}
        {meetings.map((v) => (
          <button
            type="button"
            key={v.id}
            onClick={(e) => { e.stopPropagation(); setViewing(v.id); }}
            title={`${v.title} · with ${v.attendeeNames.join(", ")} · ${v.durationMins} minutes`}
            className="w-full rounded border border-violet-500/30 bg-violet-500/15 px-1.5 py-0.5 text-left text-[11px] text-violet-300 transition-colors hover:bg-violet-500/25"
          >
            <span className="tabular-nums">{at(v.startsAt)}</span>{" "}
            {KIND_LABEL[v.kind] ?? v.kind} · {v.attendeeNames.join(", ")}
          </button>
        ))}
      </div>
    );
  };

  const at = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: tz,
    });


  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-foreground">Mentors</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When they are free, what is already booked, and when they are not available.{" "}
            <span className="whitespace-nowrap">All times {tz.replace("_", " ")}.</span>
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="mr-1 gap-1.5" disabled={!schedule.data} onClick={() => setFreeOpen(true)}>
            <Users2 className="h-3.5 w-3.5" /> Who&apos;s free?
          </Button>
          <Button variant="outline" size="icon" onClick={() => setOffset((o) => o - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-w-28 gap-1.5"
            onClick={() => setOffset(0)}
          >
            <CalendarDays className="h-3.5 w-3.5" />
            {offset === 0 ? "This week" : days[0]!.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </Button>
          <Button variant="outline" size="icon" onClick={() => setOffset((o) => o + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Search and narrow the sessions — booked sessions have no course, so the course and module keep them. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search sessions — title, course, module, who it's with…" className="pl-9" />
        </div>
        {academies.length > 1 && (
          <select value={academy} onChange={(e) => setAcademy(e.target.value)} aria-label="Academy"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">Both academies</option>
            {academies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <select value={course} onChange={(e) => { setCourse(e.target.value); setMod(""); }} aria-label="Course"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm">
          <option value="">All courses</option>
          {courses.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select>
        <select value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Module" disabled={!course || !modules.length}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50">
          <option value="">{course && !modules.length ? "No modules" : "All modules"}</option>
          {modules.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select>
        {filtering && (
          <Button variant="ghost" size="sm" onClick={() => { setFind(""); setCourse(""); setMod(""); }}>Clear</Button>
        )}
      </div>

      {schedule.isPending && (
        <Card><CardContent className="space-y-3 py-6">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </CardContent></Card>
      )}

      {/*
        The LMS being unreachable costs this screen and says why, rather than
        rendering an empty week that reads as "nobody works here".
      */}
      {schedule.isError && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-6 text-sm text-destructive">
            {apiErrorMessage(schedule.error, "The LMS could not be reached, so there is no schedule to show.")}
          </CardContent>
        </Card>
      )}

      {schedule.data && shown.length === 0 && (
        <Card><CardContent className="py-16 text-center">
          <Users2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
          {/*
            Two different nothings. An academy with no instructors is a fact
            about the LMS; a search matching none of them is a fact about the
            box above. Saying the first when the second is true sends somebody
            off to investigate their own typo.
          */}
          {query.trim() || filtering ? (
            <>
              <p className="mt-3 text-sm font-medium">{filtering ? "Nothing this week matches" : "Nobody matches that"}</p>
              <button
                onClick={() => { setQuery(""); setFind(""); setCourse(""); setMod(""); }}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Clear the search
              </button>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm font-medium">{academy ? "No mentors in this academy" : "No mentors"}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Anybody given the instructor role in the LMS appears here.
              </p>
            </>
          )}
        </CardContent></Card>
      )}

      {/*
        * A phone gets one day at a time.
        *
        * The week table below is the same information and simply will not fit:
        * at 375px each of its seven columns is forty pixels, which is narrower
        * than the times written in them. Sideways scrolling was the cheap
        * answer and the wrong one — finding Thursday meant dragging a table
        * whose only landmark, the mentor's name, scrolls away with it.
        */}
      {schedule.data && shown.length > 0 && (
        <div className="space-y-3 md:hidden">
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-2 py-1.5">
            <Button
              variant="ghost" size="sm" className="h-8 px-2"
              aria-label="Previous day"
              onClick={() => {
                if (dayIndex > 0) setDayIndex(dayIndex - 1);
                else { setOffset(offset - 1); setDayIndex(6); }
              }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <p className="text-sm font-medium">
              {days[dayIndex]?.toLocaleDateString(undefined, {
                weekday: "long", day: "numeric", month: "short",
              })}
            </p>
            <Button
              variant="ghost" size="sm" className="h-8 px-2"
              aria-label="Next day"
              onClick={() => {
                if (dayIndex < 6) setDayIndex(dayIndex + 1);
                else { setOffset(offset + 1); setDayIndex(0); }
              }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {shown.map((m) => {
            const day = days[dayIndex];
            if (!day) return null;
            const cell = dayCell(m, day);
            return (
              <Card key={m.id} className="overflow-hidden">
                <div className="flex items-start justify-between gap-2 border-b border-border/40 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{m.name || m.email}</p>
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {m.academy?.name && <Badge variant="outline" className="text-[10px]">{m.academy.name}</Badge>}
                    {m.shared && <Badge variant="outline" className="text-[10px]">Shared</Badge>}
                  </div>
                </div>
                <div className="space-y-2 px-3 py-2.5">
                  {cell ?? (
                    <p className="text-xs text-muted-foreground/60">Nothing on this day.</p>
                  )}
                  {/* An explicit button, not a tappable cell. There is no hover
                      on a phone to reveal that the day is a target, and a card
                      that books a meeting when you meant to read it is worse
                      than a button that takes up a line. */}
                  {canBook && (
                    <Button
                      variant="outline" size="sm" className="w-full gap-1.5"
                      onClick={() => openBooking(m, day)}
                    >
                      <Plus className="h-3.5 w-3.5" /> Book time
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {schedule.data && shown.length > 0 && (
        <Card className="hidden overflow-hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border/60 text-xs text-muted-foreground">
                  <th className="w-48 px-3 py-2.5 font-medium">Mentor</th>
                  {days.map((d) => (
                    <th key={d.toISOString()} className="px-2 py-2.5 font-medium">
                      {d.toLocaleDateString(undefined, { weekday: "short" })}{" "}
                      <span className="text-muted-foreground/60">
                        {d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id} className="border-b border-border/40 align-top last:border-0">
                    <td className="px-3 py-2.5">
                      <p className="truncate font-medium text-foreground">{m.name || m.email}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.academy?.name && <Badge variant="outline" className="text-[10px]">{m.academy.name}</Badge>}
                        {m.shared && <Badge variant="outline" className="text-[10px]">Shared</Badge>}
                      </div>
                    </td>

                    {days.map((day) => (
                      <td
                        key={day.toISOString()}
                        className={canBook ? "group/cell cursor-pointer px-2 py-2.5 transition-colors hover:bg-accent/40" : "px-2 py-2.5"}
                        title={canBook ? `Book time with ${m.name || m.email}` : undefined}
                        onClick={canBook ? () => openBooking(m, day) : undefined}
                      >
                        {dayCell(m, day) ?? (
                          <span className="text-xs text-muted-foreground/40 group-hover/cell:hidden">—</span>
                        )}
                        {canBook && (
                          <span className="mt-1 hidden text-[11px] text-primary group-hover/cell:block">
                            + Book
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {schedule.isFetching && !schedule.isPending && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Refreshing…
        </p>
      )}

      <WhoIsFree
        open={freeOpen}
        onOpenChange={setFreeOpen}
        mentors={freeCandidates}
        days={days}
        tz={tz}
        sameDay={sameDay}
        offOnDay={offOnDay}
        canBook={canBook}
        onBook={openBooking}
      />

      <Dialog open={Boolean(booking)} onOpenChange={(o) => !o && setBooking(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Change this meeting" : `Book time with ${booking?.mentor.name || booking?.mentor.email}`}
            </DialogTitle>
            <DialogDescription>
              {booking?.day.toLocaleDateString(undefined, {
                weekday: "long", day: "numeric", month: "long",
              })}
              {" · "}times are {tz.replace("_", " ")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mtitle">What is it</Label>
              <Input
                id="mtitle"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Intro call, weekly catch-up…"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mkind">Kind</Label>
              <select
                id="mkind"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="staff">Staff meeting</option>
                <option value="student">With a student</option>
                <option value="client">Outside client</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="mtime">Start</Label>
                <select
                  id="mtime"
                  value={form.time}
                  onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  {slotList.map((sl) => (
                    <option key={sl.value} value={sl.value} disabled={Boolean(sl.taken)}>
                      {sl.label}
                      {sl.taken ? ` · ${sl.taken}` : sl.outside ? " · outside their hours" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mdur">Minutes</Label>
                <Input
                  id="mdur" type="number" min={5} max={600} step={5}
                  value={form.durationMins}
                  onChange={(e) => setForm((f) => ({ ...f, durationMins: e.target.value }))}
                />
              </div>
            </div>

            {/*
              Who is coming, as many as there are. Everybody with an address
              gets the invitation and the joining link, sent to each of them
              separately — one message with all of them in `to` would publish
              their addresses to each other, and some of these people are
              outside the company.

              A row with no name is ignored rather than refused: leaving a
              half-typed line behind is not a mistake worth stopping somebody
              for.
            */}
            <div className="space-y-2 sm:col-span-2">
              <Label>Who they are meeting</Label>
              {guests.map((g, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={g.name}
                    onChange={(e) =>
                      setGuests((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                    }
                    placeholder="Name"
                  />
                  <Input
                    type="email"
                    value={g.email}
                    onChange={(e) =>
                      setGuests((rows) => rows.map((r, j) => (j === i ? { ...r, email: e.target.value } : r)))
                    }
                    placeholder="Email, so they get the invite"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    title="Remove"
                    disabled={guests.length === 1}
                    onClick={() => setGuests((rows) => rows.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setGuests((rows) => [...rows, { name: "", email: "" }])}
              >
                <Plus className="h-3.5 w-3.5" /> Add another person
              </Button>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="murl">Joining link</Label>
              <Input
                id="murl" value={form.meetingUrl}
                onChange={(e) => setForm((f) => ({ ...f, meetingUrl: e.target.value }))}
                placeholder="Paste one, or leave blank for a Google Meet"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mnotes">Anything else</Label>
              <Input
                id="mnotes" value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional — goes in both emails"
              />
            </div>
          </div>

          {slotList.find((sl) => sl.value === form.time)?.taken === NOT_AVAILABLE && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
              {booking?.mentor.name} is not available then — pick another time or day.
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setBooking(null)}>Cancel</Button>
            <Button
              disabled={
                slotList.find((sl) => sl.value === form.time)?.taken === NOT_AVAILABLE ||
                book.isPending ||
                form.title.trim().length < 3 ||
                !guests.some((g) => g.name.trim())
              }
              onClick={() => book.mutate()}
            >
              {book.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? "Save changes" : "Book it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/*
        One meeting, in full.
        
        Edit and Cancel appear only for the person who arranged it and for a
        root admin — the same rule the server enforces. Drawing them for
        everybody and letting the refusal explain itself afterwards would be
        offering something that is not on offer.
      */}
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => { if (!o) { setViewing(null); setConfirmCancel(false); } }}>
        <DialogContent className="sm:max-w-md">
          {detail.isPending && <Skeleton className="h-40 w-full" />}

          {detail.isError && (
            <p className="py-6 text-sm text-muted-foreground">
              {apiErrorMessage(detail.error, "That meeting could not be opened.")}
            </p>
          )}

          {detail.data && (() => {
            const d = detail.data;
            /* Always true once this has loaded: the LMS already refused to
               hand back a meeting the signed-in user may not manage — see
               getMentorMeetingForPortal on its side, which throws before this
               page ever sees the data otherwise. */
            const canManage = true;
            const mentor = (schedule.data?.mentors ?? []).find((m) => m.email === d.mentorEmail);
            const when = new Date(d.startsAt);

            return (
              <>
                <DialogHeader>
                  <DialogTitle>{d.title}</DialogTitle>
                  <DialogDescription>
                    {KIND_LABEL[d.kind] ?? d.kind} · {d.durationMins} minutes
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">When</p>
                    <p className="font-medium text-foreground">
                      {when.toLocaleString(undefined, {
                        weekday: "long", day: "numeric", month: "long",
                        hour: "2-digit", minute: "2-digit", timeZone: tz, hour12: false,
                      })} ({tz.replace("_", " ")})
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">Mentor</p>
                    <p className="text-foreground">{d.mentorName || d.mentorEmail}</p>
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">
                      {d.attendees.length === 1 ? "Attendee" : `Attendees (${d.attendees.length})`}
                    </p>
                    {d.attendees.map((a, i) => (
                      <p key={i} className="text-foreground">
                        {a.name}
                        {a.email && <span className="text-muted-foreground"> · {a.email}</span>}
                      </p>
                    ))}
                  </div>

                  {d.meetingUrl && (
                    <div>
                      <p className="text-xs text-muted-foreground">Joining link</p>
                      <a href={d.meetingUrl} target="_blank" rel="noreferrer"
                        className="break-all text-primary hover:underline">
                        {d.meetingUrl}
                      </a>
                    </div>
                  )}

                  {d.notes && (
                    <div>
                      <p className="text-xs text-muted-foreground">Notes</p>
                      <p className="text-foreground">{d.notes}</p>
                    </div>
                  )}

                  <p className="pt-1 text-xs text-muted-foreground">Booked by {d.bookedByEmail}</p>
                </div>

                <DialogFooter className="gap-2">
                  {canManage ? (
                    confirmCancel ? (
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          Cancel it? Everybody will be emailed.
                        </span>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                            No
                          </Button>
                          <Button
                            variant="destructive" size="sm"
                            disabled={cancelMeeting.isPending}
                            onClick={() => cancelMeeting.mutate(d.id)}
                          >
                            {cancelMeeting.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Yes, cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {canCancel && (
                          <Button variant="ghost" onClick={() => setConfirmCancel(true)}>Cancel meeting</Button>
                        )}
                        {canChange && (
                          <Button
                            disabled={!mentor}
                            title={mentor ? undefined : "Reopen the week this meeting is in to edit it"}
                            onClick={() => mentor && openEdit(mentor, d)}
                          >
                            Edit
                          </Button>
                        )}
                      </>
                    )
                  ) : null}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>


      {/* One class, as the LMS has it. Read-only: the portal says what is
          happening, and a course's session is changed where the course lives. */}
      <Dialog open={Boolean(viewingClass)} onOpenChange={(o) => { if (!o) setViewingClass(null); }}>
        <DialogContent className="sm:max-w-md">
          {classDetail.isPending && <Skeleton className="h-40 w-full" />}
          {classDetail.isError && (
            <p className="py-6 text-sm text-muted-foreground">
              {(classDetail.error as { response?: { status?: number } })?.response?.status === 404
                ? "This class is the other academy's, so its students and timeline stay in that academy's LMS. The calendar still shows its time, course and module."
                : apiErrorMessage(classDetail.error, "That class could not be opened.")}
            </p>
          )}
          {classDetail.data && (() => {
            const c = classDetail.data as Record<string, string | number | boolean>;
            const line = (label: string, value: unknown) =>
              value ? (
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-foreground">{String(value)}</p>
                </div>
              ) : null;
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{String(c.title || "Class")}</DialogTitle>
                  <DialogDescription>
                    {String(c.courseTitle || "")}
                    {c.instructorName ? ` · ${c.instructorName}` : ""}
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{String(c.status || "")}</Badge>
                    {c.language ? <Badge variant="outline">{String(c.language)}</Badge> : null}
                    <Badge variant="outline">{c.inPerson ? "In person" : "Online"}</Badge>
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">When</p>
                    <p className="font-medium text-foreground">
                      {new Date(String(c.startsAt)).toLocaleString(undefined, {
                        weekday: "long", day: "numeric", month: "long",
                        hour: "2-digit", minute: "2-digit", timeZone: tz, hour12: false,
                      })} ({tz.replace("_", " ")}) · {String(c.durationMins)} minutes
                    </p>
                  </div>

                  {line("Description", c.description)}
                  <div>
                    <p className="text-xs text-muted-foreground">Seats</p>
                    <p className="text-foreground">{String(c.booked)} of {String(c.capacity)} booked</p>
                  </div>
                  {c.inPerson ? line("Where", [c.location, c.room].filter(Boolean).join(" · ")) : null}
                  {!c.inPerson && c.meetingUrl ? (
                    <div>
                      <p className="text-xs text-muted-foreground">Joining link</p>
                      <a href={String(c.meetingUrl)} target="_blank" rel="noreferrer"
                        className="break-all text-primary hover:underline">{String(c.meetingUrl)}</a>
                    </div>
                  ) : null}
                  {line("Mentor's notes", c.mentorNotes)}
                  {c.recordingUrl ? (
                    <div>
                      <p className="text-xs text-muted-foreground">Recording</p>
                      <a href={String(c.recordingUrl)} target="_blank" rel="noreferrer"
                        className="break-all text-primary hover:underline">Watch it back</a>
                    </div>
                  ) : null}
                </div>
                {/* Info: who booked, joined, cancelled and reviewed, and when it started and ended. */}
                <ClassInfo c={c as Record<string, unknown>} tz={tz} />
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

    </div>
  );
}
