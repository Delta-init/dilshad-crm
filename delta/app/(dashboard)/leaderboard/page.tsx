"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Link2, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtFull } from "@/lib/currency";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store/authStore";
import { useLeaderboard, type LeaderboardRankBy } from "@/hooks/useLeaderboard";
import { fmtTalkTotal } from "@/components/calls/callUi";
import { dubaiDate } from "@/lib/dubaiDates";

/**
 * Leaderboard (the owner, 2026-10-07).
 *
 * Every salesperson's month, ranked by revenue, then closings, then follow-ups,
 * then calls — or by calls, or by talk time (2026-10-14) — counted on the
 * server, in Dubai months. Calls are 3CX's: every call with a lead on their
 * extension, the connected ones, and the time talking. Open to everyone; your
 * own row is marked. On the current month, today's calls too (2026-10-15);
 * "Public link" copies the open board's address (/public/leaderboard — no
 * sign-in, live — a TV board), as the Bangalore CRM's.
 */

const RANKS: { id: LeaderboardRankBy; label: string; says: string }[] = [
  { id: "revenue", label: "Revenue", says: "ranked by revenue, then closings, follow-ups and calls" },
  { id: "calls", label: "Calls", says: "ranked by calls (3CX), then talk time" },
  { id: "talk", label: "Talk time", says: "ranked by time talking on 3CX calls, then calls" },
];

const MEDALS = ["🥇", "🥈", "🥉"];

/** "2026-10" for the current month on the Dubai calendar. */
function thisDubaiMonth(): string {
  return dubaiDate().slice(0, 7);
}

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function LeaderboardPage() {
  const [month, setMonth] = useState(thisDubaiMonth);
  const me = useAuthStore((s) => s.user);
  const [rankBy, setRankBy] = useState<LeaderboardRankBy>("revenue");
  const { data, isLoading, error } = useLeaderboard(month, rankBy);
  const rows = data?.rows ?? [];
  // Today's calls belong to the current month only.
  const showToday = month === thisDubaiMonth() && (data?.currentMonth ?? true);

  const copyPublicLink = async () => {
    const url = `${window.location.origin}/public/leaderboard`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Public link copied — anyone with it sees the board", { description: url });
    } catch {
      window.open(url, "_blank", "noopener");
    }
  };

  return (
    <div className="flex flex-col gap-6 pb-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Trophy className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">Leaderboard</h1>
            <p className="text-sm text-muted-foreground">
              {monthLabel(month)} — {RANKS.find((r) => r.id === rankBy)?.says}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-card p-0.5" role="group" aria-label="Rank by">
          {RANKS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRankBy(r.id)}
              className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors", rankBy === r.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {r.label}
            </button>
          ))}
        </div>
        <input
          type="month"
          value={month}
          max={thisDubaiMonth()}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="h-9 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
          aria-label="Month"
        />
        <button
          type="button"
          onClick={copyPublicLink}
          title="The open board — anyone with the link sees it, no sign-in"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Link2 className="h-3.5 w-3.5" /> Public link
        </button>
        </div>
      </motion.div>

      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="py-16 text-center text-sm text-red-400">Couldn&apos;t load the leaderboard. Try again in a moment.</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Trophy className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">Nobody on the board yet for {monthLabel(month)}.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 w-16">#</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3 text-right">Revenue</th>
                  <th className="px-4 py-3 text-right">Closings</th>
                  <th className="px-4 py-3 text-right">Follow-ups</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3 text-right">Connected</th>
                  <th className="px-4 py-3 text-right">Talk time</th>
                  {showToday && <th className="px-4 py-3 text-right">Today</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const mine = r.userId === me?._id;
                  return (
                    <motion.tr
                      key={r.userId}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 20) * 0.02 }}
                      className={cn("border-b border-border/40 last:border-0", mine && "bg-primary/10")}
                    >
                      <td className="px-4 py-3 font-semibold text-foreground">{MEDALS[r.rank - 1] ?? r.rank}</td>
                      <td className="px-4 py-3 font-medium text-foreground">
                        {r.name}
                        {mine && <span className="ml-2 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">You</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-foreground tabular-nums">{fmtFull(r.revenue)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.closings}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.followUps}</td>
                      <td className={cn("px-4 py-3 text-right tabular-nums", rankBy === "calls" && "font-semibold text-foreground")}>{r.calls}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.connected}</td>
                      <td className={cn("px-4 py-3 text-right tabular-nums", rankBy === "talk" && "font-semibold text-foreground")}>{r.talkSeconds ? fmtTalkTotal(r.talkSeconds) : "—"}</td>
                      {showToday && (
                        <td className="px-4 py-3 text-right tabular-nums" title="Calls today · talk time today">
                          {r.callsToday ?? "—"}
                          <span className="ml-1.5 text-xs text-muted-foreground">{r.talkSecondsToday ? fmtTalkTotal(r.talkSecondsToday) : ""}</span>
                        </td>
                      )}
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
