"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Clock, Users2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/*
 * Who's free (the user, 2026-10-25: "a popup of who has free time to take a meeting"). Pick a day of the week on
 * screen, a time and how long; every mentor with nothing in the way — no class, no meeting, no time off — is listed,
 * those inside the weekly hours they set first. Worked out from the week the page already holds, nothing fetched;
 * Book opens the page's own booking form with that day and time filled in.
 *
 * Outside their hours is listed, not hidden: those hours are a pattern somebody set, which the LMS doesn't enforce
 * (as the booking form treats them). A mentor who set no hours counts as within them.
 */

interface Span { from: number; to: number }
interface FreeMentor {
  id: string;
  name: string;
  email: string;
  shared: boolean;
  academy?: { id: string; name: string } | null;
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
  classes: { startsAt: string; durationMins: number; status: string }[];
  meetings: { startsAt: string; durationMins: number }[];
  timeOff?: { startsAt: string; endsAt: string; allDay: boolean }[];
}

const DURATIONS = [30, 45, 60, 90];
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const toMins = (t: string) => { const [h, m] = t.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => hhmm(i * 30));

export function WhoIsFree<M extends FreeMentor>({
  open, onOpenChange, mentors, days, tz, sameDay, offOnDay, canBook, onBook,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The mentors the page is showing (its academy filter and name search applied). */
  mentors: M[];
  /** The week on screen. */
  days: Date[];
  tz: string;
  /** The page's own rules for which day an instant falls on, and the part of a time off on a day. */
  sameDay: (iso: string, day: Date) => boolean;
  offOnDay: (t: NonNullable<M["timeOff"]>[number], day: Date) => Span | null;
  canBook: boolean;
  onBook: (mentor: M, day: Date, time: string, durationMins: number) => void;
}) {
  /* Today when it is on screen, else the week's first day; the next half-hour today, else ten o'clock. */
  const nowInZone = () => {
    const t = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
    return toMins(t);
  };
  const todayIndex = () => days.findIndex((d) => sameDay(new Date().toISOString(), d));
  const [dayIdx, setDayIdx] = useState(0);
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);

  useEffect(() => {
    if (!open) return;
    const i = todayIndex();
    setDayIdx(i >= 0 ? i : 0);
    setTime(i >= 0 ? hhmm(Math.min(23 * 60 + 30, Math.ceil((nowInZone() + 1) / 30) * 30)) : "10:00");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, days[0]?.getTime()]);

  const day = days[Math.min(dayIdx, days.length - 1)] ?? days[0];

  const { inHours, outside, busyCount } = useMemo(() => {
    const start = toMins(time), end = start + duration;
    const inH: { mentor: M; load: number }[] = [], out: { mentor: M; load: number }[] = [];
    let busy = 0;
    if (!day) return { inHours: inH, outside: out, busyCount: 0 };
    for (const m of mentors) {
      const onDay = <T extends { startsAt: string; durationMins: number }>(xs: T[]) => xs.filter((x) => sameDay(x.startsAt, day));
      const classes = onDay(m.classes.filter((c) => c.status !== "cancelled"));
      const meetings = onDay(m.meetings);
      const minsOf = (iso: string) => toMins(new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }));
      const spans: Span[] = [
        ...[...classes, ...meetings].map((x) => { const from = minsOf(x.startsAt); return { from, to: from + (x.durationMins || 0) }; }),
        ...(m.timeOff ?? []).map((t) => offOnDay(t, day)).filter((x): x is Span => x !== null),
      ];
      if (spans.some((s) => start < s.to && s.from < end)) { busy++; continue; }
      const hours = m.slots.filter((s) => s.dayOfWeek === day.getDay());
      const within = hours.length === 0 || hours.some((s) => start >= toMins(s.startTime) && end <= toMins(s.endTime));
      (within ? inH : out).push({ mentor: m, load: classes.length + meetings.length });
    }
    const byLoad = (a: { mentor: M; load: number }, b: { mentor: M; load: number }) => a.load - b.load || (a.mentor.name || a.mentor.email).localeCompare(b.mentor.name || b.mentor.email);
    return { inHours: inH.sort(byLoad), outside: out.sort(byLoad), busyCount: busy };
  }, [mentors, day, time, duration, tz]);

  const until = hhmm(Math.min(24 * 60, toMins(time) + duration));
  const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  const Row = ({ mentor, load, out }: { mentor: M; load: number; out?: boolean }) => (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{mentor.name || mentor.email}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {mentor.academy?.name && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">{mentor.academy.name}</Badge>}
          {mentor.shared && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">Shared</Badge>}
          <span>{load === 0 ? "Nothing else that day" : `${load} session${load === 1 ? "" : "s"} that day`}</span>
          {out && <span className="text-amber-500">· outside their hours</span>}
        </div>
      </div>
      {canBook && (
        <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5"
          onClick={() => { onOpenChange(false); onBook(mentor, day!, time, duration); }}>
          <CalendarPlus className="h-3.5 w-3.5" /> Book
        </Button>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users2 className="h-4 w-4 text-primary" /> Who&apos;s free?</DialogTitle>
          <DialogDescription>Mentors with nothing booked and no time off at that time. All times {tz.replace("_", " ")}.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Day</Label>
            <select value={dayIdx} onChange={(e) => setDayIdx(Number(e.target.value))} aria-label="Day"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {days.map((d, i) => <option key={i} value={i}>{dayLabel(d)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <select value={time} onChange={(e) => setTime(e.target.value)} aria-label="Start time"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {HALF_HOURS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">For</Label>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="How long"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {DURATIONS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" /> {day ? dayLabel(day) : ""}, {time}–{until}
          {busyCount > 0 && <span>· {busyCount} busy then</span>}
        </p>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-foreground">Free, within their hours · {inHours.length}</p>
            {inHours.length ? inHours.map(({ mentor, load }) => <Row key={mentor.id} mentor={mentor} load={load} />)
              : <p className="text-xs text-muted-foreground">Nobody — try another time.</p>}
          </div>
          {outside.length > 0 && (
            <div className={cn("space-y-1.5")}>
              <p className="text-xs font-semibold text-foreground">Free, outside their hours · {outside.length}</p>
              <p className="text-[11px] text-muted-foreground">Nothing booked, but outside the hours they set — worth asking first.</p>
              {outside.map(({ mentor, load }) => <Row key={mentor.id} mentor={mentor} load={load} out />)}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default WhoIsFree;
