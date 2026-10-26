"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Hourglass, Landmark, Trophy, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { aed, monthLabel, ROLE_LABEL } from "@/lib/commission";
import { LadderBar } from "@/components/pay/SlabLadder";
import { PayoutBadge } from "@/components/pay/PayoutBadge";
import type { PayRow, SlabRow } from "@/types/commission";

/*
 * A person's month on their salary slab: what it pays (salary + the share of
 * commission their level pays), the sales behind it, and how far the next
 * level is. Full on My Pay; compact at the top of the dashboard.
 */

interface PayMonthCardProps {
  row: PayRow;
  /** Their role's slab, for the bar. */
  slab: SlabRow[];
  month: string;
  /** The dashboard's version: fewer words, a link to the page. */
  compact?: boolean;
  /** Finance answered: show where it stands on the commission (2026-10-21). */
  payoutsKnown?: boolean;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What the target counts, in the viewer's words. */
export function basisOf(row: PayRow, own = true): string {
  if (row.role === "sm") return "Every sale in the Sales CRM";
  if (row.role === "tl") return `${row.teams.length ? row.teams.join(", ") : own ? "Your team" : "Their team"}'s sales`;
  return own ? "Your own sales" : "Their own sales";
}

export function PayMonthCard({ row, slab, month, compact = false, payoutsKnown = false }: PayMonthCardProps) {
  const { level, next } = row;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={compact ? { y: -2 } : undefined}
      className="relative overflow-hidden rounded-xl border border-primary/20 bg-card p-4 sm:p-5"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/30 via-primary to-primary/30" />

      {/* Who, when, which level */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Wallet className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">
              {compact ? "My pay" : "Your month"} · {monthLabel(month)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {ROLE_LABEL[row.role]} slab · {basisOf(row)}
            </p>
          </div>
        </div>
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary"
        >
          <Trophy className="h-3.5 w-3.5" /> {level.name}
        </motion.span>
      </div>

      {/* What the month pays */}
      <div className={cn("mt-4 grid gap-3", compact ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 lg:grid-cols-4")}>
        <Figure label="Total this month" value={aed(row.total)} strong />
        <Figure label="Salary" value={aed(row.salary)} />
        <Figure label="Commission earned" value={aed(row.commission.earned)} />
        <Figure label={`Paid at ${row.percent}%`} value={aed(row.commission.payable)} />
      </div>
      {payoutsKnown && (
        <div className="mt-2 flex justify-end">
          <PayoutBadge payout={row.payout} payable={row.commission.payable} compact={compact} />
        </div>
      )}

      {/* The sales behind it, and the next level */}
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground">
            Approved sales:{" "}
            <span className="font-semibold tabular-nums text-foreground">{aed(row.sales.value)}</span>
            {" · "}
            {row.sales.count} {plural(row.sales.count, "sale", "sales")}
          </p>
          <p className={cn("text-xs font-medium", next ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400")}>
            {next
              ? `${aed(next.more)} more to ${next.name} — ${aed(next.salary)} salary, ${next.percent}% of commission`
              : "Top level reached"}
          </p>
        </div>
        <LadderBar rows={slab} value={row.sales.value} levelIndex={level.index} />
      </div>

      {/* What hasn't counted yet */}
      {(row.awaitingFinance.count > 0 || row.commission.notCountedYet > 0) && (
        <div className="mt-1 space-y-1">
          {row.awaitingFinance.count > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Landmark className="mt-0.5 h-3 w-3 shrink-0" />
              {row.awaitingFinance.count} {plural(row.awaitingFinance.count, "sale", "sales")} ({aed(row.awaitingFinance.value)}) waiting for
              finance to approve — {plural(row.awaitingFinance.count, "it counts", "they count")} toward the target once approved.
            </p>
          )}
          {row.commission.notCountedYet > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Hourglass className="mt-0.5 h-3 w-3 shrink-0" />
              {row.commission.notCountedYet} {plural(row.commission.notCountedYet, "sale is", "sales are")} waiting for finance&apos;s
              approval — the commission is added once {plural(row.commission.notCountedYet, "it's", "they're")} approved.
            </p>
          )}
        </div>
      )}

      {compact && (
        <div className="mt-3 flex justify-end">
          <Link href="/my-pay" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            Details <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </motion.div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", strong ? "border-primary/30 bg-primary/10" : "border-border/50 bg-muted/20")}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("truncate font-bold tabular-nums", strong ? "text-lg text-primary" : "text-base text-foreground")}>{value}</p>
    </div>
  );
}
