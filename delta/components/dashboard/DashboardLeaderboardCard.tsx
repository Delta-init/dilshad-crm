"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtFull } from "@/lib/currency";
import { useAuthStore } from "@/lib/store/authStore";
import { useLeaderboard, type LeaderboardRow } from "@/hooks/useLeaderboard";
import { fmtTalkTotal } from "@/components/calls/callUi";

/**
 * This month's leaderboard on the dashboard (the owner, 2026-10-07): the top
 * five, and your own place underneath when you are further down, with their 3CX
 * calls and talk time (2026-10-14). The full board — ranked by calls or talk
 * time too — is one click away.
 */

const TOP = 5;
const MEDALS = ["🥇", "🥈", "🥉"];

/** Shown only to a role with the Leaderboard box (every role until it is unticked). */
export function DashboardLeaderboardCard() {
  useAuthStore((s) => s.user); // re-check when the signed-in user changes
  const canSee = useAuthStore((s) => s.hasPermission)("leaderboard", "view");
  return canSee ? <LeaderboardCard /> : null;
}

function LeaderboardCard() {
  const me = useAuthStore((s) => s.user);
  const { data, isLoading, error } = useLeaderboard();
  const rows = data?.rows ?? [];
  const top = rows.slice(0, TOP);
  const mine = rows.find((r) => r.userId === me?._id);
  const showMine = mine && mine.rank > TOP;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="overflow-hidden rounded-2xl border border-border/60 bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Trophy className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Leaderboard — this month</p>
            <p className="text-xs text-muted-foreground">Ranked by revenue, then closings</p>
          </div>
        </div>
        <Link href="/leaderboard" className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="py-10 text-center text-sm text-red-400">Couldn&apos;t load the leaderboard.</p>
      ) : top.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nobody on the board yet this month.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 w-12">#</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2 text-right">Revenue</th>
                <th className="px-4 py-2 text-right">Closings</th>
                <th className="hidden px-4 py-2 text-right sm:table-cell">Calls</th>
                <th className="hidden px-4 py-2 text-right sm:table-cell">Talk</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => <Row key={r.userId} r={r} mine={r.userId === me?._id} />)}
              {showMine && (
                <>
                  <tr><td colSpan={6} className="px-4 py-1 text-center text-xs text-muted-foreground">…</td></tr>
                  <Row r={mine} mine />
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

function Row({ r, mine }: { r: LeaderboardRow; mine: boolean }) {
  return (
    <tr className={cn("border-b border-border/40 last:border-0", mine && "bg-primary/10")}>
      <td className="px-4 py-2 font-semibold text-foreground">{MEDALS[r.rank - 1] ?? r.rank}</td>
      <td className="px-4 py-2 font-medium text-foreground">
        {r.name}
        {mine && <span className="ml-2 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">You</span>}
      </td>
      <td className="px-4 py-2 text-right font-semibold text-foreground tabular-nums">{fmtFull(r.revenue)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{r.closings}</td>
      <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell" title={`${r.connected} connected`}>{r.calls}</td>
      <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell">{r.talkSeconds ? fmtTalkTotal(r.talkSeconds) : "—"}</td>
    </tr>
  );
}
