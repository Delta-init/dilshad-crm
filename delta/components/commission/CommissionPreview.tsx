"use client";

import { motion } from "framer-motion";
import { Coins, Hourglass, UserX } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCommissionPreview } from "@/hooks/useCommission";
import { useAuthStore } from "@/lib/store/authStore";
import { aed, inr, ROLE_LABEL } from "@/lib/commission";

interface CommissionPreviewProps {
  courseId?: string | null;
  /** The lead's team — the sale's team once it is closed. */
  teamId?: string | null;
  /** The lead's counsellor — who closes it, and earns the Sales Staff amount. */
  closerId?: string | null;
  /**
   * The mentor picked as "Meeting done by" on the close (2026-11-18), by email: the course's meeting fee comes off the
   * lines, and is shown here. Absent or None: no fee.
   */
  mentorEmail?: string | null;
  mentorName?: string | null;
}

/**
 * What closing this lead earns its counsellor, by the commission plan — shown
 * in the closing dialog before anything is saved.
 *
 * Information only: it never stops a close. Anything it cannot answer (no
 * course yet, the server unreachable) simply shows nothing.
 */
export function CommissionPreview({ courseId, teamId, closerId, mentorEmail, mentorName }: CommissionPreviewProps) {
  const me = useAuthStore((s) => s.user?._id);
  const { data, isLoading, isError } = useCommissionPreview({ course: courseId, team: teamId, closer: closerId, mentor: mentorEmail });

  if (!courseId || isError) return null;
  if (isLoading || !data) return <Skeleton className="h-14 rounded-xl" />;

  const you = Boolean(closerId && closerId === me);
  const who = you ? "You" : data.closerName || "The counsellor";
  const earns = you ? "earn" : "earns";
  const mine = data.lines.filter((l) => l.user === closerId && l.amount > 0);
  const planIsEmpty = data.plan.sales + data.plan.tl + data.plan.sm === 0;
  // The mentor's meeting (2026-11-18): the fee, and what it took off each line this viewer may see.
  const mentorFee = data.mentorFee ?? 0;
  const cutLines = data.lines.filter((l) => (l.mentorCut ?? 0) > 0);
  const mentorWho = mentorName || "The mentor";
  // Paid in rupees, earned in rupees (2026-11-13): the same lines' rupee amounts, for the part of the fee the client
  // pays in INR — shown apart from the AED, never added to it (2026-11-20).
  const rupees = data.closerTotalInr ?? 0;
  const rupeeNote = rupees > 0 && (
    <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
      {aed(data.closerTotal)} · or <span className="font-semibold">{inr(rupees)}</span> on the part paid in rupees
    </p>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Commission</p>
      {data.state === "excluded" ? (
        <div className="flex items-start gap-2 rounded-xl border border-border/50 bg-muted/20 p-3">
          <UserX className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{data.reason}. Nobody earns commission on this sale.</p>
        </div>
      ) : planIsEmpty ? (
        <div className="flex items-start gap-2 rounded-xl border border-border/50 bg-muted/20 p-3">
          <Coins className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">No commission is set for {data.courseName}.</p>
        </div>
      ) : data.state === "waiting" ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
          <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {who} {earns} {aed(data.closerTotal)} on this sale once it&apos;s settled
            </p>
            <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
              Will wait after the steps: {data.reason}.
            </p>
            {rupeeNote}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <Coins className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {who} {earns} <span className="font-bold text-primary">{aed(data.closerTotal)}</span> on this sale
            </p>
            {mine.length > 1 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {mine.map((l) => `${ROLE_LABEL[l.role]} ${aed(l.amount)}${(l.amountInr ?? 0) > 0 ? ` (or ${inr(l.amountInr ?? 0)})` : ""}`).join(" + ")}
              </p>
            )}
            {rupeeNote}
            {/* The mentor who held the meeting is paid out of the sale's commission (2026-11-18). */}
            {mentorEmail && mentorFee > 0 && (
              <p className="mt-0.5 text-[11px] text-violet-600 dark:text-violet-400">
                {mentorWho} earns <span className="font-semibold">{aed(mentorFee)}</span> for the meeting
                {cutLines.length > 0
                  ? ` — taken off ${cutLines.map((l) => `${l.user === closerId && you ? "yours" : `${ROLE_LABEL[l.role]} ${l.userName}`} −${aed(l.mentorCut ?? 0)}`).join(", ")}`
                  : ""}.
              </p>
            )}
            {mentorEmail && mentorFee === 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                No meeting fee is set for {data.courseName} — the mentor earns nothing on this sale, and nothing is taken off.
              </p>
            )}
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Counted once finance approves the sale.
            </p>
          </div>
        </div>
      )}
    </motion.div>
  );
}
