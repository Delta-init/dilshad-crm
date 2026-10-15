"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Maximize, Minimize, Moon, RotateCw, Sun, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtFull } from "@/lib/currency";
import {
  DEFAULT_TALK_TARGETS,
  RANK_OPTIONS,
  fmtTalk,
  useLeaderboardLive,
  usePublicLeaderboard,
  type LeaderboardRank,
  type LeaderboardRow,
  type LiveState,
} from "@/hooks/useLeaderboard";
import { STATUS_META } from "@/lib/statusConfig";

/**
 * The open leaderboard — the TV board (the owner, 2026-10-15: "same as the Bangalore CRM's public link"; then
 * "display it on a TV, only the leaderboard, live over the socket and re-ordering; no gradients, solid colours,
 * blue the main one; first, second and third each their own colour, everyone else the same; a 3D icon for the
 * leader only"). No sign-in. Every salesperson's month — revenue, closings, follow-ups, 3CX calls and call time
 * against the targets, today's calls — and the leads they hold now, by status.
 *
 * Live: the API's socket says "changed" and the board is fetched at once; the cards slide to their new places.
 * On a TV: the controls fade after a few seconds untouched, and a board taller than the screen glides down and
 * back on its own. Dark unless a screen is switched to light.
 */

const BOARD_NAME = "Remote CRM";
const THEME_KEY = "public-leaderboard-dark"; // "0" = light; anything else, or nothing, = dark

/** Lead statuses in pipeline order (closed and lost last), named as this CRM names them (lib/statusConfig); a status
 * not listed here still shows, in its own words. */
const STATUS_ORDER: string[] = ["new", "assigned", "pending_response", "followup", "meeting_scheduled", "meeting_done", "callback", "cnc", "not_connected", "wrong_number", "mia", "repeated", "closed", "lost"];
const STATUS_TONE: Record<string, "good" | "bad"> = { closed: "good", lost: "bad" };

/** First, second and third — each its own solid colour (theme-aware, in CSS below). Everyone else looks the same. */
const PLACES: Record<number, { name: "gold" | "silver" | "bronze"; label: string }> = {
  1: { name: "gold", label: "1st" },
  2: { name: "silver", label: "2nd" },
  3: { name: "bronze", label: "3rd" },
};

const RANK_LABEL: Record<LeaderboardRank, string> = { revenue: "Revenue", calls: "Calls", talk: "Call time" };

// The board's columns from lg up — with today's for the current month, without it for a past one.
const GRID_TODAY = "lg:grid-cols-[5.5rem_minmax(0,2.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.45fr)_minmax(0,1.45fr)]";
const GRID_PAST = "lg:grid-cols-[5.5rem_minmax(0,2.7fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.7fr)]";

/** Solid colours only, as CSS variables — so the first paint already has the right theme. Dark unless asked. */
const CSS = `
.lb{--bg:#0b1120;--card:#111a2e;--line:#1f2b45;--ink:#f1f5f9;--ink2:#cbd5e1;--mute:#8a97ad;--track:#1d2842;--chip:#17213a;
--blue:#3b82f6;--good:#22c55e;--bad:#f87171;--live:#ef4444;--warn:#f59e0b;
--gold:#f5b301;--gold-text:#f5b301;--gold-card:#1a1a14;--gold-on:#1a1300;
--silver:#c4cdd9;--silver-text:#d5dce6;--silver-card:#151d2d;--silver-on:#0f172a;
--bronze:#d9822b;--bronze-text:#e8944a;--bronze-card:#1b1712;--bronze-on:#1a0d00;
background:var(--bg);color:var(--ink)}
.lb[data-theme=light]{--bg:#eef2f7;--card:#ffffff;--line:#dbe3ee;--ink:#0f172a;--ink2:#334155;--mute:#64748b;--track:#e2e8f0;--chip:#f1f5f9;
--blue:#2563eb;--good:#16a34a;--bad:#dc2626;--live:#dc2626;--warn:#d97706;
--gold:#e0a100;--gold-text:#a16207;--gold-card:#fff8e1;--gold-on:#1a1300;
--silver:#94a3b8;--silver-text:#475569;--silver-card:#f5f7fa;--silver-on:#0f172a;
--bronze:#c2671c;--bronze-text:#9a4a0f;--bronze-card:#fdf1e6;--bronze-on:#ffffff}
body:has(.lb){background:#0b1120}
body:has(.lb[data-theme=light]){background:#eef2f7}
@keyframes lb-sway{0%,100%{transform:perspective(320px) rotateY(-24deg) translateY(0)}50%{transform:perspective(320px) rotateY(24deg) translateY(-3px)}}
.lb-trophy{animation:lb-sway 3.6s ease-in-out infinite;transform-origin:50% 62%}
@keyframes lb-ping{0%{box-shadow:0 0 0 0 rgba(239,68,68,.6)}70%,100%{box-shadow:0 0 0 7px rgba(239,68,68,0)}}
.lb-live{animation:lb-ping 1.8s ease-out infinite}
@media (prefers-reduced-motion:reduce){.lb-trophy,.lb-live{animation:none}}
`;

/** Runs while the page is still arriving, so a screen set to light never flashes dark first. */
const THEME_BOOT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="0")document.currentScript.parentElement.setAttribute("data-theme","light")}catch(e){}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────
/** "2026-10" for the current Dubai month. */
function thisDubaiMonth(): string {
  const d = new Date(Date.now() + 4 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(m: string, by: number): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const dubaiTime = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const minutesOf = (seconds?: number) => Math.floor((seconds ?? 0) / 60);
const humanize = (key: string) => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const statusLabel = (key: string) => (STATUS_META as Record<string, { label?: string } | undefined>)[key]?.label ?? humanize(key);
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// ─── Pieces ────────────────────────────────────────────────────────────────────
/** The leader's trophy — solid-colour faces, so it reads as 3D without a gradient; it turns slowly. */
function Trophy3D({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <ellipse cx="32" cy="60.5" rx="16" ry="2.6" fill="#000000" opacity="0.3" />
      {/* plinth: top, front and side */}
      <path d="M17 50 20 47.5h28L45 50z" fill="#3a4d7a" />
      <path d="M17 50h28v7H17z" fill="#24345a" />
      <path d="M45 50l3-2.5v7L45 57z" fill="#18233f" />
      <rect x="24" y="52" width="14" height="3" rx="0.6" fill="#f5c542" />
      {/* stem */}
      <path d="M28.5 39.5h7l3 9h-13z" fill="#e3a008" />
      <path d="M32 39.5h3.5l3 9H32z" fill="#b97f04" />
      {/* handles, behind the cup */}
      <path d="M17 17h-6.5c0 9.5 4.2 15.6 11 16.6" fill="none" stroke="#d99a06" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M47 17h6.5c0 9.5-4.2 15.6-11 16.6" fill="none" stroke="#a87503" strokeWidth="3.6" strokeLinecap="round" />
      {/* the cup: its lit half and its shaded half */}
      <path d="M16 12h16v28C23 40 16 32.5 16 22z" fill="#ffcc1f" />
      <path d="M32 12h16v10c0 10.5-7 18-16 18z" fill="#e5a400" />
      <path d="M20.5 14.5h3.2V23c0 4.2 1 7.4 3 10.4-4.1-1.9-6.2-6.1-6.2-10.6z" fill="#ffe58c" />
      {/* the rim and the mouth */}
      <ellipse cx="32" cy="12" rx="16" ry="4.2" fill="#ffe27a" />
      <ellipse cx="32" cy="12.2" rx="12.8" ry="2.7" fill="#a87503" />
      <path d="m32 18.2 2.3 4.7 5.2.8-3.8 3.7.9 5.2-4.6-2.4-4.6 2.4.9-5.2-3.8-3.7 5.2-.8z" fill="#fff6cf" />
    </svg>
  );
}

/** Where they stand: the trophy for the leader; second and third in their colours; everyone else the same. */
function RankMark({ rank }: { rank: number }) {
  const place = PLACES[rank];
  if (rank === 1) {
    return (
      <div className="flex flex-col items-center">
        <div className="lb-trophy">
          <Trophy3D className="h-[clamp(3rem,2.9vw,4.25rem)] w-[clamp(3rem,2.9vw,4.25rem)]" />
        </div>
        <span className="mt-0.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: "var(--gold-text)" }}>1st</span>
      </div>
    );
  }
  if (place) {
    return (
      <div className="flex flex-col items-center gap-1">
        <span
          className="grid h-[clamp(2.6rem,2.3vw,3.25rem)] w-[clamp(2.6rem,2.3vw,3.25rem)] place-items-center rounded-full text-[clamp(1.1rem,1.15vw,1.5rem)] font-extrabold tabular-nums"
          style={{ background: `var(--${place.name})`, color: `var(--${place.name}-on)` }}
        >
          {rank}
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: `var(--${place.name}-text)` }}>{place.label}</span>
      </div>
    );
  }
  return (
    <span className="grid h-[clamp(2.5rem,2.3vw,3.1rem)] w-[clamp(2.5rem,2.3vw,3.1rem)] place-items-center rounded-full border border-[color:var(--line)] text-[clamp(0.95rem,1vw,1.25rem)] font-bold tabular-nums text-[color:var(--mute)]">
      {rank}
    </span>
  );
}

/** A figure that just changed shows in blue for a moment — not when the month or the ranking was switched. */
function Flash({ value, scope, className, style, children }: { value: number; scope: string; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const seen = useRef({ value, scope });
  const [on, setOn] = useState(false);
  useEffect(() => {
    const was = seen.current;
    seen.current = { value, scope };
    if (was.scope !== scope) {
      setOn(false);
      return;
    }
    if (was.value === value) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 2_500);
    return () => clearTimeout(t);
  }, [value, scope]);
  return (
    <span className={cn("transition-colors duration-700", className)} style={on ? { ...style, color: "var(--blue)" } : style}>
      {children}
    </span>
  );
}

/** How far towards the target: "769 / 1,000 min", green with a tick once it's reached. */
function TargetFigure({ seconds, targetMinutes, className }: { seconds: number; targetMinutes: number; className?: string }) {
  const mins = minutesOf(seconds);
  const hit = mins >= targetMinutes;
  return (
    <span className={cn("text-[11px] tabular-nums", hit ? "font-semibold text-[color:var(--good)]" : "text-[color:var(--mute)]", className)}>
      {fmtInt(mins)} / {fmtInt(targetMinutes)} min{hit ? " ✓" : ""}
    </span>
  );
}

/** Call time against a target: a solid bar, blue on the way, green once it's reached — the figure under it unless it sits beside the value. */
function TargetBar({ seconds, targetMinutes, figure = true }: { seconds: number; targetMinutes: number; figure?: boolean }) {
  const mins = minutesOf(seconds);
  const hit = mins >= targetMinutes;
  return (
    <div className="mt-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--track)]">
        <motion.div
          className="h-full rounded-full"
          style={{ background: hit ? "var(--good)" : "var(--blue)" }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min((mins / targetMinutes) * 100, 100)}%` }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />
      </div>
      {figure && <TargetFigure seconds={seconds} targetMinutes={targetMinutes} className="mt-1 block" />}
    </div>
  );
}

/** The leads they hold now (not the month's), by status. */
function LeadsNow({ counts, total, className }: { counts?: Record<string, number>; total?: number; className?: string }) {
  const known = new Set(STATUS_ORDER);
  const items = [
    ...STATUS_ORDER.map((key) => ({ key, n: counts?.[key] ?? 0 })),
    ...Object.entries(counts ?? {})
      .filter(([k]) => !known.has(k))
      .map(([key, n]) => ({ key, n })),
  ]
    .filter((i) => i.n > 0)
    .map((i) => ({ ...i, label: statusLabel(i.key), tone: STATUS_TONE[i.key] }));
  if (!items.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="mr-0.5 text-[11px] font-semibold text-[color:var(--mute)]">
        Leads now <span className="tabular-nums text-[color:var(--ink2)]">{fmtInt(total ?? items.reduce((sum, i) => sum + i.n, 0))}</span>
      </span>
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1 rounded-md bg-[color:var(--chip)] px-1.5 py-0.5 text-[11px] text-[color:var(--mute)]">
          <span
            className={cn("font-bold tabular-nums", i.tone === "good" ? "text-[color:var(--good)]" : i.tone === "bad" ? "text-[color:var(--bad)]" : "text-[color:var(--ink2)]")}
          >
            {fmtInt(i.n)}
          </span>
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Label({ children, on }: { children: React.ReactNode; on?: boolean }) {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-wider", on ? "text-[color:var(--blue)]" : "text-[color:var(--mute)]")}>{children}</p>
  );
}

function PersonCard({
  row,
  index,
  rankBy,
  showToday,
  targets,
  scope,
  moved,
}: {
  row: LeaderboardRow;
  index: number;
  rankBy: LeaderboardRank;
  showToday: boolean;
  targets: { dayMinutes: number; monthMinutes: number };
  scope: string;
  moved?: number;
}) {
  const place = PLACES[row.rank];
  // The figure the board is ranked by stands out — in the place's colour for the top three.
  const ranked = (k: LeaderboardRank): { className: string; style?: React.CSSProperties } =>
    rankBy === k
      ? { className: "font-extrabold", style: place ? { color: `var(--${place.name}-text)` } : { color: "var(--ink)" } }
      : { className: "font-semibold", style: { color: "var(--ink2)" } };
  const value = "text-[clamp(1.05rem,1.35vw,1.75rem)] leading-tight tabular-nums";
  const sub = `${plural(row.closings, "closing")} · ${plural(row.followUps, "follow-up")}`;
  const movedBadge =
    moved !== undefined && moved !== 0 ? (
      <span
        className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", moved > 0 ? "bg-[color:var(--blue)] text-white" : "bg-[color:var(--chip)] text-[color:var(--mute)]")}
        aria-label={moved > 0 ? `Up ${moved}` : `Down ${-moved}`}
      >
        {moved > 0 ? `▲ ${moved}` : `▼ ${-moved}`}
      </span>
    ) : null;
  const revenue = ranked("revenue"), calls = ranked("calls"), talk = ranked("talk");

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ layout: { type: "spring", stiffness: 240, damping: 30 }, duration: 0.4, delay: Math.min(index, 12) * 0.03 }}
      className="relative overflow-hidden rounded-2xl border"
      style={{ background: place ? `var(--${place.name}-card)` : "var(--card)", borderColor: place ? `var(--${place.name})` : "var(--line)" }}
    >
      {place && <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: `var(--${place.name})` }} aria-hidden />}

      {/* Phones and tablets */}
      <div className="p-4 pl-5 lg:hidden">
        <div className="flex items-center gap-3">
          <RankMark rank={row.rank} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="line-clamp-2 break-words text-base font-bold leading-snug">{row.name}</p>
              {movedBadge}
            </div>
            <p className="text-xs text-[color:var(--mute)]">{sub}</p>
          </div>
          <div className="shrink-0 text-right">
            <Flash value={row.revenue} scope={scope} className={cn("text-lg tabular-nums", revenue.className)} style={revenue.style}>
              {fmtFull(row.revenue)}
            </Flash>
            <Label on={rankBy === "revenue"}>Revenue</Label>
          </div>
        </div>
        <div className={cn("mt-3 grid grid-cols-2 gap-x-4 gap-y-3", showToday && "sm:grid-cols-4")}>
          <div>
            <Label on={rankBy === "calls"}>Calls</Label>
            <Flash value={row.calls} scope={scope} className={cn("text-base tabular-nums", calls.className)} style={calls.style}>
              {fmtInt(row.calls)}
            </Flash>
            <p className="text-[11px] text-[color:var(--mute)]">{fmtInt(row.connected)} connected</p>
          </div>
          <div>
            <Label on={rankBy === "talk"}>Call time · month</Label>
            <Flash value={row.talkSeconds} scope={scope} className={cn("text-base tabular-nums", talk.className)} style={talk.style}>
              {fmtTalk(row.talkSeconds)}
            </Flash>
            <TargetBar seconds={row.talkSeconds} targetMinutes={targets.monthMinutes} />
          </div>
          {showToday && (
            <>
              <div>
                <Label>Calls today</Label>
                <p className="text-base font-semibold tabular-nums text-[color:var(--ink2)]">{fmtInt(row.callsToday ?? 0)}</p>
                <p className="text-[11px] text-[color:var(--mute)]">{fmtInt(row.connectedToday ?? 0)} connected</p>
              </div>
              <div>
                <Label>Call time today</Label>
                <p className="text-base font-semibold tabular-nums text-[color:var(--ink2)]">{fmtTalk(row.talkSecondsToday ?? 0)}</p>
                <TargetBar seconds={row.talkSecondsToday ?? 0} targetMinutes={targets.dayMinutes} />
              </div>
            </>
          )}
        </div>
        <LeadsNow counts={row.leadCounts} total={row.totalLeads} className="mt-3" />
      </div>

      {/* Desktops and TVs */}
      <div className={cn("hidden items-center gap-x-6 gap-y-2 py-[clamp(0.6rem,0.7vw,1rem)] pl-5 pr-6 lg:grid", showToday ? GRID_TODAY : GRID_PAST)}>
        <div className="row-span-2 flex justify-center">
          <RankMark rank={row.rank} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[clamp(1.05rem,1.3vw,1.7rem)] font-bold leading-tight">{row.name}</p>
            {movedBadge}
          </div>
          <p className="mt-0.5 text-[clamp(0.75rem,0.8vw,1rem)] text-[color:var(--mute)]">{sub}</p>
        </div>
        <div className="text-right">
          <Flash value={row.revenue} scope={scope} className={cn(value, revenue.className)} style={revenue.style}>
            {fmtFull(row.revenue)}
          </Flash>
        </div>
        <div className="text-right">
          <Flash value={row.calls} scope={scope} className={cn(value, calls.className)} style={calls.style}>
            {fmtInt(row.calls)}
          </Flash>
          <p className="text-[11px] tabular-nums text-[color:var(--mute)]">{fmtInt(row.connected)} connected</p>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Flash value={row.talkSeconds} scope={scope} className={cn(value, talk.className)} style={talk.style}>
              {fmtTalk(row.talkSeconds)}
            </Flash>
            <TargetFigure seconds={row.talkSeconds} targetMinutes={targets.monthMinutes} />
          </div>
          <TargetBar seconds={row.talkSeconds} targetMinutes={targets.monthMinutes} figure={false} />
        </div>
        {showToday && (
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className={cn(value, "font-semibold text-[color:var(--ink2)]")}>
                {fmtInt(row.callsToday ?? 0)} <span className="text-[0.7em] font-medium text-[color:var(--mute)]">calls</span> · {fmtTalk(row.talkSecondsToday ?? 0)}
              </p>
              <TargetFigure seconds={row.talkSecondsToday ?? 0} targetMinutes={targets.dayMinutes} />
            </div>
            <TargetBar seconds={row.talkSecondsToday ?? 0} targetMinutes={targets.dayMinutes} figure={false} />
          </div>
        )}
        {/* The leads they hold now — one line under the whole row */}
        <LeadsNow counts={row.leadCounts} total={row.totalLeads} className="col-[2/-1]" />
      </div>
    </motion.li>
  );
}

/** Dubai time, ticking — its own little clock, so the board doesn't redraw every second. */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-right leading-tight">
      <p className="text-[clamp(1.1rem,1.5vw,2rem)] font-bold tabular-nums">{now ? dubaiTime(now) : "--:--:--"}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--mute)]">Dubai</p>
    </div>
  );
}

function ControlButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[color:var(--line)] bg-[color:var(--card)] text-[color:var(--ink2)] transition-colors hover:border-[color:var(--blue)] hover:text-[color:var(--ink)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────
export default function PublicLeaderboardPage() {
  const [dark, setDark] = useState(true);
  const [month, setMonth] = useState(thisDubaiMonth);
  const [rankBy, setRankBy] = useState<LeaderboardRank>("revenue");
  const refetchNow = useRef<() => void>(() => undefined);
  const liveState: LiveState = useLeaderboardLive(month, () => refetchNow.current());
  const live = liveState === "live";
  const { data, isLoading, isError, isFetching, refetch } = usePublicLeaderboard(month, rankBy, live);
  useEffect(() => {
    refetchNow.current = () => void refetch();
  }, [refetch]);

  // The screen's own light / dark, kept in this browser (storage may be unavailable — then it's just dark).
  useEffect(() => {
    try {
      if (localStorage.getItem(THEME_KEY) === "0") setDark(false);
    } catch {
      /* no storage here */
    }
  }, []);
  const toggleTheme = () =>
    setDark((d) => {
      try {
        localStorage.setItem(THEME_KEY, d ? "0" : "1");
      } catch {
        /* no storage here */
      }
      return !d;
    });

  // A wall screen left on this month moves on to the next at midnight on the 1st (Dubai).
  useEffect(() => {
    let last = thisDubaiMonth();
    const id = setInterval(() => {
      const now = thisDubaiMonth();
      if (now === last) return;
      const ended = last; // read now: the update below runs later, after `last` has moved on
      last = now;
      setMonth((m) => (m === ended ? now : m));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Untouched for a few seconds (a TV): the controls and the pointer fade away; any touch brings them back.
  const [awake, setAwake] = useState(true);
  const lastTouched = useRef(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      lastTouched.current = Date.now();
      setAwake(true);
      clearTimeout(t);
      t = setTimeout(() => setAwake(false), 4_000);
    };
    wake();
    const kinds = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"] as const;
    for (const k of kinds) window.addEventListener(k, wake, { passive: true });
    return () => {
      clearTimeout(t);
      for (const k of kinds) window.removeEventListener(k, wake);
    };
  }, []);

  // A TV can't scroll: untouched for 20 s, a board taller than the screen glides down, rests, and goes back up.
  // Big screens only — a phone in someone's hand scrolls when they do.
  useEffect(() => {
    const big = window.matchMedia("(min-width: 1024px)");
    const still = () => big.matches && Date.now() - lastTouched.current >= 20_000;
    let raf = 0;
    let wait: ReturnType<typeof setTimeout> | undefined;
    let pos = 0;
    let phase: "top" | "down" | "bottom" = "top";
    let until = 0;
    let lastT = 0;
    const check = () => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (!still() || room <= 2) {
        phase = "top";
        wait = setTimeout(check, 500);
        return;
      }
      pos = window.scrollY;
      until = performance.now() + 6_000;
      lastT = 0;
      raf = requestAnimationFrame(step);
    };
    const step = (t: number) => {
      const room = document.documentElement.scrollHeight - window.innerHeight;
      if (!still() || room <= 2) {
        check();
        return;
      }
      const dt = lastT ? Math.min(100, t - lastT) : 0;
      lastT = t;
      if (phase === "top") {
        if (t >= until) phase = "down";
      } else if (phase === "down") {
        pos = Math.min(room, pos + dt * 0.045); // ~45 px a second
        window.scrollTo(0, pos);
        if (pos >= room) {
          phase = "bottom";
          until = t + 8_000;
        }
      } else if (t >= until) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        pos = 0;
        phase = "top";
        until = t + 10_000;
      }
      raf = requestAnimationFrame(step);
    };
    check();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(wait);
    };
  }, []);

  // Full screen, for the TV.
  const [full, setFull] = useState(false);
  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  // Who moved, live: same month and ranking as last time, a new place — shown for a few seconds.
  const lastBoard = useRef<{ key: string; ranks: Map<string, number> } | null>(null);
  const [moves, setMoves] = useState<Record<string, { by: number; until: number }>>({});
  useEffect(() => {
    if (!data) return;
    const key = `${data.month}|${data.rankBy}`;
    const ranks = new Map(data.rows.map((r) => [r.userId, r.rank]));
    const before = lastBoard.current;
    lastBoard.current = { key, ranks };
    if (!before || before.key !== key) {
      setMoves((m) => (Object.keys(m).length ? {} : m)); // another month or ranking: nobody "moved"
      return;
    }
    const until = Date.now() + 8_000;
    const moved: Record<string, { by: number; until: number }> = {};
    ranks.forEach((rank, id) => {
      const was = before.ranks.get(id);
      if (was !== undefined && was !== rank) moved[id] = { by: was - rank, until };
    });
    if (Object.keys(moved).length) setMoves((m) => ({ ...m, ...moved }));
  }, [data]);
  useEffect(() => {
    const ends = Object.values(moves).map((m) => m.until);
    if (!ends.length) return;
    const t = setTimeout(() => setMoves((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.until > Date.now()))), Math.max(0, Math.min(...ends) - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [moves]);

  const rows = data?.rows ?? [];
  const current = month === thisDubaiMonth();
  const showToday = current && (data?.currentMonth ?? true);
  const targets = data?.targets ?? DEFAULT_TALK_TARGETS;
  const quiet = rows.every((r) => !r.revenue && !r.closings && !r.followUps && !r.calls && !r.talkSeconds);
  const updated = data?.updatedAt ? dubaiTime(new Date(data.updatedAt)) : "";
  const scope = data ? `${data.month}|${data.rankBy}` : "";
  const head = (k: LeaderboardRank | null) => (k && k === rankBy ? "text-[color:var(--blue)]" : "");

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn("lb relative min-h-screen", !awake && "lg:cursor-none")} data-theme={dark ? "dark" : "light"} suppressHydrationWarning>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />

        <main className="mx-auto w-full max-w-[2200px] px-4 pb-6 sm:px-6 lg:px-[2.2vw]">
          {/* ── Top strip ── */}
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
            <div className="flex min-w-0 items-center gap-3 lg:gap-4">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[color:var(--blue)] text-white lg:h-[clamp(3rem,3vw,4rem)] lg:w-[clamp(3rem,3vw,4rem)]">
                <Trophy className="h-6 w-6 lg:h-[45%] lg:w-[45%]" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-[clamp(1.35rem,1.8vw,2.4rem)] font-extrabold leading-tight tracking-tight">Leaderboard</h1>
                <p className="truncate text-[clamp(0.8rem,0.9vw,1.15rem)] text-[color:var(--mute)]">
                  {BOARD_NAME} · {monthLabel(month)} · ranked by {RANK_LABEL[rankBy].toLowerCase()}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3 lg:gap-5">
              <div className={cn("flex flex-wrap items-center gap-2 transition-opacity duration-500", !awake && "lg:pointer-events-none lg:opacity-0")}>
                <div className="flex rounded-lg border border-[color:var(--line)] bg-[color:var(--card)] p-1" role="group" aria-label="Rank by">
                  {RANK_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setRankBy(o.value)}
                      aria-pressed={rankBy === o.value}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                        rankBy === o.value ? "bg-[color:var(--blue)] text-white" : "text-[color:var(--mute)] hover:text-[color:var(--ink)]"
                      )}
                    >
                      {RANK_LABEL[o.value]}
                    </button>
                  ))}
                </div>
                <div className="flex h-9 items-center rounded-lg border border-[color:var(--line)] bg-[color:var(--card)]">
                  <button
                    type="button"
                    onClick={() => setMonth((m) => shiftMonth(m, -1))}
                    aria-label="Previous month"
                    className="grid h-full w-8 place-items-center text-[color:var(--ink2)] hover:text-[color:var(--ink)]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="whitespace-nowrap px-1 text-xs font-semibold">{monthLabel(month)}</span>
                  <button
                    type="button"
                    onClick={() => setMonth((m) => shiftMonth(m, 1))}
                    disabled={current}
                    aria-label="Next month"
                    className="grid h-full w-8 place-items-center text-[color:var(--ink2)] hover:text-[color:var(--ink)] disabled:opacity-30"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <ControlButton label="Refresh" onClick={() => void refetch()}>
                  <RotateCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
                </ControlButton>
                <ControlButton label={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
                  {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </ControlButton>
                <ControlButton label={full ? "Leave full screen" : "Full screen"} onClick={toggleFull}>
                  {full ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
                </ControlButton>
              </div>

              {current ? (
                <span
                  className="flex items-center gap-2 rounded-full border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider"
                  title={
                    live
                      ? "Live — updates the moment the board changes"
                      : liveState === "connecting"
                        ? "Connecting — refreshing every 30 seconds meanwhile"
                        : "Reconnecting — still refreshing every 30 seconds"
                  }
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      live ? "lb-live bg-[color:var(--live)]" : liveState === "connecting" ? "bg-[color:var(--mute)]" : "bg-[color:var(--warn)]"
                    )}
                  />
                  {live ? "Live" : liveState === "connecting" ? "Connecting" : "Reconnecting"}
                </span>
              ) : (
                <span className="rounded-full border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--mute)]">
                  Past month
                </span>
              )}
              <Clock />
            </div>
          </header>

          {/* ── The board ── */}
          {isLoading ? (
            <ul className="space-y-2.5" aria-label="Loading">
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="h-24 animate-pulse rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)]" />
              ))}
            </ul>
          ) : isError && !data ? (
            <div className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-12 text-center text-sm text-[color:var(--mute)]">
              Couldn&apos;t load the leaderboard — it tries again on its own.
            </div>
          ) : quiet ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] p-14 text-center">
              <Trophy className="h-10 w-10 text-[color:var(--mute)]" />
              <p className="text-lg font-bold">Nothing on the board yet</p>
              <p className="text-sm text-[color:var(--mute)]">No sales or calls for {monthLabel(month)}.</p>
            </div>
          ) : (
            <>
              <div
                className={cn(
                  "mb-2 hidden gap-x-6 pl-5 pr-6 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--mute)] lg:grid",
                  showToday ? GRID_TODAY : GRID_PAST
                )}
              >
                <span className="text-center">#</span>
                <span>Salesperson</span>
                <span className={cn("text-right", head("revenue"))}>Revenue</span>
                <span className={cn("text-right", head("calls"))}>Calls</span>
                <span className={head("talk")}>Call time · month</span>
                {showToday && <span>Today</span>}
              </div>
              <ul className="space-y-2">
                {rows.map((r, i) => (
                  <PersonCard
                    key={r.userId}
                    row={r}
                    index={i}
                    rankBy={rankBy}
                    showToday={showToday}
                    targets={targets}
                    scope={scope}
                    moved={moves[r.userId]?.by}
                  />
                ))}
              </ul>
            </>
          )}

          <footer className="mt-5 flex flex-col gap-1 text-center text-xs text-[color:var(--mute)] sm:flex-row sm:justify-between sm:text-left">
            <span className="tabular-nums">
              {updated ? `Updated ${updated} (Dubai)` : ""}
              {updated && current ? " · " : ""}
              {current ? (live ? "live — updates as the board changes" : "refreshes every 30 seconds") : ""}
            </span>
            <span>
              Targets: {fmtInt(targets.monthMinutes)} min of calls a month, {fmtInt(targets.dayMinutes)} a day
            </span>
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}
