"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  BadgeDollarSign, CalendarCheck, ChevronDown, Loader2, RefreshCw, Trophy, Users, Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtFull } from "@/lib/currency";
import { useDailyClosings, type ClosingDay } from "@/hooks/useClosings";
import { useTeams } from "@/hooks/useTeams";

/**
 * The closing book.
 *
 * A closing is the moment a lead becomes a student, and the question asked
 * about it is always the same shape: how did today go, and how does that
 * compare with the days around it. Answering it meant opening the enrolment
 * list and counting by eye, which nobody does twice — so the day everyone is
 * measured on was the one number nobody could see.
 *
 * Days rather than a chart, because the follow-up question is always "who?",
 * and a bar on a graph cannot be opened. Each day expands into the enrolments
 * behind it.
 *
 * Dates are Dubai dates. `enrollmentDate` is an instant, and which business day
 * it belongs to is a local question — a sale closed at 2am here is the previous
 * day in UTC, and grouping on that would take a closing off somebody's day.
 */

/** Dubai's today, since that is the day the business is counting. */
const TZ = "Asia/Dubai";
const dayKey = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: TZ });

function startOfMonth(): string {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  return dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
}

/** "Today", "Yesterday", or "Mon, 15 Sept" — a date somebody can place at a glance. */
function dayLabel(date: string, todayKey: string): string {
  if (date === todayKey) return "Today";
  const yesterday = new Date(`${todayKey}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

export default function ClosingsPage() {
  const [dateFrom, setDateFrom] = useState(startOfMonth);
  const [dateTo, setDateTo] = useState(() => dayKey(new Date()));
  const [team, setTeam] = useState("");
  const [person, setPerson] = useState("");
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useDailyClosings({
    dateFrom, dateTo, team: team || undefined, user: person || undefined, mine,
  });
  // Everyone's for a Super Admin / the Sales Manager, a leader's own teams, nothing to pick for anyone else.
  const view = data?.view ?? "own";
  const { data: teamsData } = useTeams({ limit: 100 }, { enabled: !!data && view !== "own" });
  const teams = useMemo(() => {
    const all = teamsData?.data ?? [];
    if (view === "all") return all;
    const mine = new Set((data?.teams ?? []).map((t) => t.id));
    return all.filter((t) => mine.has(t._id));
  }, [teamsData, view, data?.teams]);

  // The people to pick from: the chosen team's, or every team's — leaders and
  // members both (leaders aren't in `members`), once each, by name.
  const people = useMemo(() => {
    const from = team ? teams.filter((t) => t._id === team) : teams;
    return from
      .flatMap((t) => [...(t.leaders ?? []), ...(t.members ?? [])])
      .filter((u): u is NonNullable<typeof u> => typeof u === "object" && !!u)
      .filter((u, i, list) => list.findIndex((x) => x._id === u._id) === i)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [teams, team]);

  // A person who isn't in the newly chosen team would leave the page empty.
  const pickTeam = (id: string) => {
    setTeam(id);
    const inTeam = teams.find((t) => t._id === id);
    if (id && person && inTeam && ![...(inTeam.leaders ?? []), ...(inTeam.members ?? [])].some((u) => u?._id === person)) {
      setPerson("");
    }
  };

  const days = data?.days ?? [];
  const totals = data?.totals;
  const todayKey = data?.today.date ?? dayKey(new Date());

  // The busiest day in view, so the bars have something to be relative to.
  const busiest = useMemo(() => Math.max(1, ...days.map((d) => d.count)), [days]);

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <div className="flex items-center gap-2">
            <CalendarCheck className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Daily Closings</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">
            Every enrolment closed, the day it was closed
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view !== "own" && (
            <motion.div whileTap={{ scale: 0.97 }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMine(!mine)}
                className="gap-2"
              >
                {mine ? (view === "team" ? "Show my team's" : "Show everyone's") : "Show only mine"}
              </Button>
            </motion.div>
          )}
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </motion.div>

      {/* ── Today first, because that is what the page is opened for. ───────── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-2 gap-3 lg:grid-cols-5"
      >
        <Stat
          icon={CalendarCheck}
          label="Closed today"
          value={String(data?.today.count ?? 0)}
          sub={data?.today.count ? fmtFull(data.today.totalFee) : "Nothing yet"}
          tone="green"
        />
        <Stat
          icon={Users}
          label="In this period"
          value={String(totals?.count ?? 0)}
          sub={`${totals?.days ?? 0} day${totals?.days === 1 ? "" : "s"} with a closing`}
          tone="violet"
        />
        {/* Collected first, the balance beside it (the user, 2026-10-31). */}
        <Stat
          icon={Wallet}
          label="Collected in this period"
          value={fmtFull(totals?.paidAmount ?? 0)}
          sub={`of ${fmtFull(totals?.totalFee ?? 0)} · ${fmtFull(totals?.pendingAmount ?? 0)} balance`}
          tone="amber"
        />
        <Stat
          icon={BadgeDollarSign}
          label="Commission earned"
          value={fmtFull(totals?.commissionEarned ?? 0)}
          sub={`${fmtFull(totals?.commissionBalance ?? 0)} balance, on payments still due`}
          tone="green"
        />
        <Stat
          icon={Trophy}
          label="Top closer"
          value={data?.leaderboard[0]?.name ?? "—"}
          sub={
            data?.leaderboard[0]
              ? `${data.leaderboard[0].count} closing${data.leaderboard[0].count === 1 ? "" : "s"}`
              : "No closings yet"
          }
          tone="muted"
        />
      </motion.div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/50 bg-card p-3">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">From</label>
          <Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[150px]" />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">To</label>
          <Input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[150px]" />
        </div>
        {view !== "own" && (
          <>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Team</label>
          <select
            value={team}
            onChange={(e) => pickTeam(e.target.value)}
            className="h-9 w-[170px] rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{view === "team" ? "All my teams" : "All teams"}</option>
            {teams.map((t) => (
              <option key={t._id} value={t._id}>{t.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Person</label>
          {/* "Show only mine" already narrows it to the caller, and wins on the API. */}
          <select
            value={mine ? "" : person}
            onChange={(e) => setPerson(e.target.value)}
            disabled={mine}
            title={mine ? "Showing only your closings" : undefined}
            className="h-9 w-[170px] rounded-md border border-border bg-background px-2 text-sm disabled:opacity-50"
          >
            <option value="">{mine ? "Only mine" : "Everyone"}</option>
            {people.map((u) => (
              <option key={u._id} value={u._id}>{u.name}</option>
            ))}
          </select>
        </div>
          </>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setDateFrom(dayKey(new Date())); setDateTo(dayKey(new Date())); }}>
            Today
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setDateFrom(startOfMonth()); setDateTo(dayKey(new Date())); }}>
            This month
          </Button>
        </div>
      </div>

      {/* ── The book ────────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : days.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-6 py-16 text-center">
          <CalendarCheck className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">No closings in this period</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Close a lead and the day it happened appears here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {days.map((day) => (
            <DayRow
              key={day.date}
              day={day}
              label={dayLabel(day.date, todayKey)}
              isToday={day.date === todayKey}
              share={day.count / busiest}
              open={open === day.date}
              onToggle={() => setOpen(open === day.date ? null : day.date)}
            />
          ))}
        </div>
      )}

      {/* ── Who closed them, over the whole period ──────────────────────────── */}
      {(data?.leaderboard.length ?? 0) > 1 && (
        <div className="rounded-xl border border-border/50 bg-card p-4">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold">Who closed them</h3>
          </div>
          <div className="mt-3 space-y-1.5">
            {data?.leaderboard.map((c, i) => (
              <div key={c.name} className="flex items-center gap-3 text-sm">
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate">{c.name}</span>
                <span className="tabular-nums text-muted-foreground">{fmtFull(c.totalFee)}</span>
                <span className="w-16 text-right font-medium tabular-nums">
                  {c.count} closing{c.count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DayRow({
  day, label, isToday, share, open, onToggle,
}: {
  day: ClosingDay;
  label: string;
  isToday: boolean;
  share: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={cn(
      "overflow-hidden rounded-xl border bg-card transition-colors",
      isToday ? "border-primary/40" : "border-border/50",
    )}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/30"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        <div className="w-32 shrink-0">
          <p className={cn("text-sm font-semibold", isToday && "text-primary")}>{label}</p>
          <p className="text-[11px] text-muted-foreground">{day.date}</p>
        </div>

        {/* The day's size, relative to the busiest day on screen. A number on
            its own does not say whether it was a good day. */}
        <div className="hidden flex-1 sm:block">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted/40">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(share * 100, 4)}%` }}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-5 text-right">
          <div>
            <p className="text-lg font-bold tabular-nums leading-none">{day.count}</p>
            <p className="text-[11px] text-muted-foreground">closing{day.count === 1 ? "" : "s"}</p>
          </div>
          <div className="w-28">
            <p className="text-sm font-semibold tabular-nums leading-none">{fmtFull(day.paidAmount)}</p>
            <p className="text-[11px] text-muted-foreground">
              {day.pendingAmount > 0 ? `${fmtFull(day.pendingAmount)} balance` : `of ${fmtFull(day.totalFee)}`}
            </p>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-border/50">
          {day.enrolments.map((e) => (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/30 px-4 py-2.5 last:border-0"
            >
              <div className="min-w-[160px] flex-1">
                <p className="text-sm font-medium">{e.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {e.enrollmentNumber || "—"}{e.courseName ? ` · ${e.courseName}` : ""}
                </p>
              </div>
              <div className="min-w-[120px]">
                <p className="text-xs">{e.closedByName}</p>
                <p className="text-[11px] text-muted-foreground">{e.teamName}</p>
              </div>
              {e.commission?.state === "counted" && (e.commission.earned > 0 || e.commission.balance > 0) && (
                <div className="text-right">
                  <p className="text-xs font-medium tabular-nums text-green-600 dark:text-green-400">
                    {fmtFull(e.commission.earned)} commission
                  </p>
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    {e.commission.balance > 0 ? `${fmtFull(e.commission.balance)} on the balance` : "All earned"}
                  </p>
                </div>
              )}
              <div className="ml-auto text-right">
                <p className="text-sm font-semibold tabular-nums">
                  {fmtFull(e.paidAmount)}
                  <span className="font-normal text-muted-foreground"> / {fmtFull(e.totalFee)}</span>
                </p>
                <p className={cn("text-[11px]", e.pendingAmount > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                  {e.pendingAmount > 0 ? `${fmtFull(e.pendingAmount)} balance` : "Paid in full"}
                </p>
                {(e.paidOutside ?? 0) > 0 && (
                  <p className="text-[11px] text-muted-foreground" title="Received outside this period — not counted in it, nor in its commission">
                    {fmtFull(e.paidOutside ?? 0)} paid outside this period
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub, tone }: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  tone: "green" | "amber" | "muted" | "violet";
}) {
  const tones = {
    green:  "text-green-400 bg-green-500/10 border-green-500/20",
    amber:  "text-amber-400 bg-amber-500/10 border-amber-500/20",
    muted:  "text-muted-foreground bg-muted/30 border-border/50",
    violet: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  }[tone];
  return (
    <div className={cn("rounded-xl border p-3", tones)}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-1 truncate text-2xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-[11px] opacity-70">{sub}</p>
    </div>
  );
}
