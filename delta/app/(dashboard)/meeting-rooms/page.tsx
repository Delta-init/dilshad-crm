"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, DoorOpen, Eye, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  meetingRoomError, useBookMeetingRoom, useCancelMeetingRoomBooking, useMeetingRoomsDay,
  type MeetingRoom, type MeetingRoomBooking,
} from "@/hooks/useMeetingRooms";

/**
 * Meeting rooms (2026-10-19).
 *
 * The office's rooms, kept in the HRMS, one Dubai day at a time: a column per
 * room, the day's open hours (10:00–19:00) in half hours, every booking drawn
 * to scale with who holds it. Click a free half hour to book; your own
 * bookings have Cancel, and a super admin may cancel any made from this CRM.
 * Open to everyone signed in; read only while viewing as someone.
 */

const TZ = "Asia/Dubai";
/** Dubai keeps no daylight saving: a Dubai wall time is always UTC+4. */
const OFFSET = "+04:00";
const SLOT_MIN = 30;
const SLOT_PX = 28;

function dubaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
const hhmmToMin = (v: string) => {
  const [h, m] = v.split(":").map(Number) as [number, number];
  return (h || 0) * 60 + (m || 0);
};
const minToHhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const midnight = (day: string) => Date.parse(`${day}T00:00:00${OFFSET}`);
/** Minutes after Dubai midnight of `day` for an instant (below 0 or past 1440 when another day). */
const minutesOn = (day: string, at: string | number) => ((typeof at === "number" ? at : Date.parse(at)) - midnight(day)) / 60_000;
const instantOn = (day: string, min: number) => new Date(midnight(day) + min * 60_000).toISOString();
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(iso));

interface Placed { b: MeetingRoomBooking; top: number; height: number; lane: number; lanes: number }

/** Bookings of one room laid out on the grid; ones that overlap (they shouldn't) sit side by side. */
function place(bookings: MeetingRoomBooking[], day: string, openMin: number, closeMin: number): Placed[] {
  const items = bookings
    .map((b) => ({ b, s: Math.max(minutesOn(day, b.start), openMin), e: Math.min(minutesOn(day, b.end), closeMin) }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let group: Placed[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const g of group) g.lanes = laneEnds.length;
    out.push(...group);
    group = [];
    laneEnds = [];
    groupEnd = -Infinity;
  };
  for (const x of items) {
    if (group.length && x.s >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= x.s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(x.e); } else laneEnds[lane] = x.e;
    group.push({
      b: x.b,
      top: ((x.s - openMin) / SLOT_MIN) * SLOT_PX,
      height: Math.max(((x.e - x.s) / SLOT_MIN) * SLOT_PX, 18),
      lane,
      lanes: 1,
    });
    groupEnd = Math.max(groupEnd, x.e);
  }
  if (group.length) flush();
  return out;
}

interface Draft { roomId: string; startMin: number }

export default function MeetingRoomsPage() {
  const [day, setDay] = useState(dubaiToday);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, error, isFetching } = useMeetingRoomsDay(day);
  const cancel = useCancelMeetingRoomBooking();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toCancel, setToCancel] = useState<MeetingRoomBooking | null>(null);
  // Kept apart from the booking so the dialog keeps its text while it closes.
  const [cancelOpen, setCancelOpen] = useState(false);

  // The answer for this day (not the previous day's, kept while the new one loads).
  const current = data && data.day === day ? data : undefined;
  const openMin = hhmmToMin(current?.open ?? "10:00");
  const closeMin = hhmmToMin(current?.close ?? "19:00");
  const slots = useMemo(() => {
    const s: number[] = [];
    for (let m = openMin; m < closeMin; m += SLOT_MIN) s.push(m);
    return s;
  }, [openMin, closeMin]);
  const hours = useMemo(() => {
    const h: number[] = [];
    for (let m = Math.ceil(openMin / 60) * 60; m <= closeMin; m += 60) h.push(m);
    return h;
  }, [openMin, closeMin]);
  const nowMin = minutesOn(day, now);
  const viewOnly = !!current?.you?.viewOnly;
  const superAdmin = !!current?.you?.superAdmin;
  const rooms: MeetingRoom[] = current?.rooms ?? [];
  const height = slots.length * SLOT_PX;
  const isToday = day === dubaiToday();
  const dayOver = nowMin >= closeMin;

  /** A half hour can be booked until it is over. */
  const bookable = (startMin: number) => !viewOnly && startMin + SLOT_MIN > nowMin;
  const canCancel = (b: MeetingRoomBooking) => !viewOnly && (b.mine || (superAdmin && b.fromThisCrm));

  return (
    <div className="flex flex-col gap-6 pb-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <DoorOpen className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">Meeting rooms</h1>
            <p className="text-sm text-muted-foreground">
              {dayLabel(day)} — {current ? `${current.open}–${current.close}` : "10:00–19:00"}, Dubai time. Click a free half hour to book.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setDay((d) => shiftDay(d, -1))} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <input
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-9 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
            aria-label="Day"
          />
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setDay((d) => shiftDay(d, 1))} aria-label="Next day">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setDay(dubaiToday())} disabled={isToday}>
            Today
          </Button>
          {isFetching && !isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </motion.div>

      {viewOnly && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          <Eye className="h-4 w-4 shrink-0" /> View only — you are viewing the CRM as someone else, so rooms can&apos;t be booked or cancelled.
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
        {isLoading && !current ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error && !current ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <DoorOpen className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-red-400">{meetingRoomError(error, "Couldn't load the meeting rooms. Try again in a moment.")}</p>
          </div>
        ) : !current || rooms.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <DoorOpen className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No meeting rooms to show.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[300px] p-3 sm:p-4">
              {/* Room names */}
              <div className="flex">
                <div className="w-14 shrink-0" />
                <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${rooms.length}, minmax(0, 1fr))` }}>
                  {rooms.map((r) => (
                    <div key={r.id} className="pb-2 text-center">
                      <p className="text-sm font-semibold text-foreground">{r.name}</p>
                      {(r.capacity || r.location) && (
                        <p className="text-xs text-muted-foreground">
                          {[r.capacity ? `${r.capacity} seats` : "", r.location ?? ""].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex">
                {/* Hours */}
                <div className="relative w-14 shrink-0" style={{ height }}>
                  {hours.map((m) => (
                    <span
                      key={m}
                      className={cn(
                        "absolute right-2 text-[11px] tabular-nums text-muted-foreground",
                        m === openMin ? "" : m === closeMin ? "-translate-y-full" : "-translate-y-1/2",
                      )}
                      style={{ top: ((m - openMin) / SLOT_MIN) * SLOT_PX }}
                    >
                      {minToHhmm(m)}
                    </span>
                  ))}
                </div>

                <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${rooms.length}, minmax(0, 1fr))` }}>
                  {rooms.map((room) => {
                    const placed = place(current.bookings.filter((b) => b.roomId === room.id), day, openMin, closeMin);
                    return (
                      <div key={room.id} className="relative overflow-hidden rounded-lg border border-border/60" style={{ height }}>
                        {/* Half hours: a solid line on the hour, a dashed one on the half */}
                        {slots.map((m) => {
                          const free = bookable(m);
                          return (
                            <button
                              key={m}
                              type="button"
                              disabled={!free}
                              onClick={() => setDraft({ roomId: room.id, startMin: m })}
                              title={free ? `Book ${room.name} at ${minToHhmm(m)}` : undefined}
                              aria-label={free ? `Book ${room.name} at ${minToHhmm(m)}` : `${room.name} ${minToHhmm(m)}`}
                              className={cn(
                                "absolute inset-x-0 block w-full",
                                m === openMin ? "" : m % 60 === 0 ? "border-t border-border/70" : "border-t border-dashed border-border/40",
                                free ? "cursor-pointer hover:bg-primary/5" : "cursor-default bg-muted/40",
                              )}
                              style={{ top: ((m - openMin) / SLOT_MIN) * SLOT_PX, height: SLOT_PX }}
                            />
                          );
                        })}

                        {/* The bookings, to scale */}
                        {placed.map(({ b, top, height: h, lane, lanes }) => {
                          const short = h < SLOT_PX * 2;
                          return (
                            <div
                              key={b.id}
                              className={cn(
                                "absolute z-10 overflow-hidden rounded-md border px-2 py-1 text-xs shadow-sm",
                                b.mine
                                  ? "border-primary/50 bg-primary/15 text-foreground"
                                  : "border-border bg-secondary text-secondary-foreground",
                              )}
                              style={{
                                top: top + 1,
                                height: h - 2,
                                left: `calc(${(lane / lanes) * 100}% + 2px)`,
                                width: `calc(${100 / lanes}% - 4px)`,
                              }}
                              title={`${b.title} · ${fmtTime(b.start)}–${fmtTime(b.end)} · ${b.holder}`}
                            >
                              {canCancel(b) && (
                                <button
                                  type="button"
                                  onClick={() => { setToCancel(b); setCancelOpen(true); }}
                                  className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-red-500"
                                  aria-label={`Cancel ${b.title}`}
                                  title="Cancel this booking"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <p className={cn("truncate font-semibold", canCancel(b) && "pr-5")}>
                                {b.title}
                                {short && <span className="font-normal text-muted-foreground"> · {fmtTime(b.start)}–{fmtTime(b.end)}</span>}
                              </p>
                              {!short && (
                                <>
                                  <p className="truncate tabular-nums text-muted-foreground">{fmtTime(b.start)}–{fmtTime(b.end)}</p>
                                  <p className="truncate text-muted-foreground">{b.mine ? `You · ${b.holder}` : b.holder}</p>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>

              {dayOver && !viewOnly && (
                <p className="mt-3 text-center text-xs text-muted-foreground">This day is over — pick a later day to book.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {draft && current && (
        <BookRoomDialog
          key={`${draft.roomId}-${draft.startMin}-${day}`}
          day={day}
          rooms={rooms}
          openMin={openMin}
          closeMin={closeMin}
          nowMin={nowMin}
          initial={draft}
          onClose={() => setDraft(null)}
        />
      )}

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this booking?</AlertDialogTitle>
            <AlertDialogDescription>
              {toCancel
                ? `${toCancel.title} — ${toCancel.roomName}, ${fmtTime(toCancel.start)}–${fmtTime(toCancel.end)}${toCancel.mine ? "" : `, held by ${toCancel.holder}`}. The room becomes free for anyone to book.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (toCancel) cancel.mutate(toCancel.id);
                setCancelOpen(false);
              }}
            >
              Cancel booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground";

function BookRoomDialog({
  day, rooms, openMin, closeMin, nowMin, initial, onClose,
}: {
  day: string;
  rooms: MeetingRoom[];
  openMin: number;
  closeMin: number;
  nowMin: number;
  initial: Draft;
  onClose: () => void;
}) {
  const book = useBookMeetingRoom();
  const [title, setTitle] = useState("");
  const [roomId, setRoomId] = useState(initial.roomId);
  const [startMin, setStartMin] = useState(initial.startMin);
  const [endMin, setEndMin] = useState(Math.min(initial.startMin + 60, closeMin));
  const [problem, setProblem] = useState("");

  // Starts: every half hour of the day not yet over; ends: after the start, up to closing.
  const starts: number[] = [];
  for (let m = openMin; m < closeMin; m += SLOT_MIN) if (m + SLOT_MIN > nowMin) starts.push(m);
  const ends: number[] = [];
  for (let m = startMin + SLOT_MIN; m <= closeMin; m += SLOT_MIN) ends.push(m);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem("");
    if (!title.trim()) { setProblem("Give the meeting a title"); return; }
    book.mutate(
      { roomId, start: instantOn(day, startMin), end: instantOn(day, endMin), title: title.trim() },
      {
        onSuccess: () => onClose(),
        onError: (err) => setProblem(meetingRoomError(err, "Could not book the room")),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !book.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Book a meeting room</DialogTitle>
            <DialogDescription>{dayLabel(day)} · Dubai time</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mr-title">Title</Label>
            <Input
              id="mr-title"
              autoFocus
              value={title}
              maxLength={200}
              placeholder="e.g. Client call with Ahmed"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mr-room">Room</Label>
            <select id="mr-room" className={selectClass} value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{r.capacity ? ` · ${r.capacity} seats` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mr-start">Start</Label>
              <select
                id="mr-start"
                className={selectClass}
                value={startMin}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  setStartMin(s);
                  if (endMin <= s) setEndMin(Math.min(s + 60, closeMin));
                }}
              >
                {starts.map((m) => <option key={m} value={m}>{minToHhmm(m)}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mr-end">End</Label>
              <select id="mr-end" className={selectClass} value={endMin} onChange={(e) => setEndMin(Number(e.target.value))}>
                {ends.map((m) => <option key={m} value={m}>{minToHhmm(m)}</option>)}
              </select>
            </div>
          </div>

          {problem && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-500">{problem}</p>}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={book.isPending}>Close</Button>
            <Button type="submit" disabled={book.isPending || !title.trim()}>
              {book.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Book
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
