"use client";

import { motion } from "framer-motion";
import { Coins, Hourglass, UserX } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCommissionPreview } from "@/hooks/useCommission";
import { useAuthStore } from "@/lib/store/authStore";
import { aed, ROLE_LABEL } from "@/lib/commission";

interface CommissionPreviewProps {
  courseId?: string | null;
  /** The lead's team — the sale's team once it is closed. */
  teamId?: string | null;
  /** The lead's counsellor — who closes it, and earns the Sales Staff amount. */
  closerId?: string | null;
}

/**
 * What closing this lead earns its counsellor, by the commission plan — shown
 * in the closing dialog before anything is saved.
 *
 * Information only: it never stops a close. Anything it cannot answer (no
 * course yet, the server unreachable) simply shows nothing.
 */
export function CommissionPreview({ courseId, teamId, closerId }: CommissionPreviewProps) {
  const me = useAuthStore((s) => s.user?._id);
  const { data, isLoading, isError } = useCommissionPreview({ course: courseId, team: teamId, closer: closerId });

  if (!courseId || isError) return null;
  if (isLoading || !data) return <Skeleton className="h-14 rounded-xl" />;

  const you = Boolean(closerId && closerId === me);
  const who = you ? "You" : data.closerName || "The counsellor";
  const earns = you ? "earn" : "earns";
  const mine = data.lines.filter((l) => l.user === closerId && l.amount > 0);
  const planIsEmpty = data.plan.sales + data.plan.tl + data.plan.sm === 0;

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
                {mine.map((l) => `${ROLE_LABEL[l.role]} ${aed(l.amount)}`).join(" + ")}
              </p>
            )}
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Counted once finance approves the sale and it&apos;s paid in full.
            </p>
          </div>
        </div>
      )}
    </motion.div>
  );
}
