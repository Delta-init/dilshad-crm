"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Ban, CheckCircle2, Coins, Hourglass, Undo2, UserX, Users, AlertTriangle, Wallet,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCommissionEarnings } from "@/hooks/useCommission";
import {
  aed, monthLabel, recentMonths, ROLE_LABEL, ROLE_SHORT, STATE_LABEL, TL_PAID, uaeDate, uaeMonth,
} from "@/lib/commission";
import type { CommissionSale, CommissionSaleState } from "@/types/commission";

const ROLES = TL_PAID ? (["sales", "tl", "sm"] as const) : (["sales", "sm"] as const);

const SCOPE_NOTE = {
  all: "Everyone's commission",
  team: "Your team's sales and your own commission",
  own: "Your own commission",
} as const;

/** A month of commission: who earned what, and the sales behind it. */
export function EarningsTab() {
  const months = recentMonths();
  const [month, setMonth] = useState(uaeMonth());
  const { data, isLoading, isError, error } = useCommissionEarnings(month);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <p className="text-xs text-muted-foreground">
            {SCOPE_NOTE[data.scope]} · counted once finance approves · earned in the month the money is received, the rest as balance
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {(error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Couldn't load commission."}
        </div>
      ) : !data || data.sales.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-16 text-center"
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Coins className="h-7 w-7 text-primary" />
          </div>
          <h3 className="mb-1 font-semibold text-foreground">No approved sales in {monthLabel(month)}</h3>
          <p className="max-w-sm px-4 text-sm text-muted-foreground">
            A sale shows here from its close, and counts once every step is done — finance, LMS, CS, onboarding and the MT5 bonus. Pick another month, or check the plan for what each course pays.
          </p>
        </motion.div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat icon={Coins} label="Commission earned" value={aed(data.totals.amount)} tone="primary" />
            <Stat icon={Wallet} label="Balance — on payments due" value={aed(data.totals.balance ?? 0)} tone="amber" />
            <Stat icon={CheckCircle2} label="Sales counted" value={String(data.totals.counted)} tone="green" />
            <Stat icon={Hourglass} label="Not counted yet" value={String(data.totals.waiting + (data.totals.progress ?? 0))} tone="amber" />
            <Stat
              icon={Undo2}
              label="Reversed or excluded"
              value={String(data.totals.reversed + data.totals.excluded)}
              tone="muted"
            />
          </div>

          {data.people.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border/50 bg-card">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Person</th>
                    <th className="px-4 py-2.5 font-medium text-right">Sales Staff</th>
                    {TL_PAID && <th className="px-4 py-2.5 font-medium text-right">Team Leader</th>}
                    <th className="px-4 py-2.5 font-medium text-right">Sales Manager</th>
                    <th className="px-4 py-2.5 font-medium text-right">Earned</th>
                    <th className="px-4 py-2.5 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p, i) => (
                    <motion.tr
                      key={p._id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className="border-b border-border/30 last:border-0"
                    >
                      <td className="px-4 py-2.5 font-medium text-foreground">{p.name}</td>
                      {ROLES.map((role) => (
                        <td key={role} className="px-4 py-2.5 text-right tabular-nums">
                          {p[role].count ? (
                            <>
                              <span className="text-foreground">{aed(p[role].amount)}</span>
                              <span className="ml-1 text-[11px] text-muted-foreground">· {p[role].count}</span>
                              {(p[role].balance ?? 0) > 0 && (
                                <span className="block text-[10px] text-amber-600 dark:text-amber-400">+{aed(p[role].balance ?? 0)} balance</span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </td>
                      ))}
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-primary">{aed(p.total)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {(p.balance ?? 0) > 0 ? aed(p.balance ?? 0) : <span className="text-muted-foreground/60">—</span>}
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> Sales · {data.sales.length}
            </p>
            {data.sales.map((s, i) => <SaleRow key={s._id} sale={s} index={i} />)}
          </div>
        </>
      )}
    </div>
  );
}

const STATE_STYLE: Record<CommissionSaleState, { cls: string; icon: React.ElementType }> = {
  progress: { cls: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: Hourglass },
  counted: { cls: "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-400", icon: CheckCircle2 },
  waiting: { cls: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: Hourglass },
  excluded: { cls: "border-border/60 bg-muted/40 text-muted-foreground", icon: UserX },
  reversed: { cls: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400", icon: Ban },
};

function SaleRow({ sale: s, index }: { sale: CommissionSale; index: number }) {
  const style = STATE_STYLE[s.state];
  const Icon = style.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 12) * 0.03 }}
      className="rounded-xl border border-border/50 bg-card p-3.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{s.studentName}</span>
            {s.enrollmentNumber && <span className="text-[10px] text-muted-foreground">{s.enrollmentNumber}</span>}
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", style.cls)}
            >
              <Icon className="h-2.5 w-2.5" /> {STATE_LABEL[s.state]}
            </motion.span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {s.courseName || "No course"} · closed by {s.closerName || "nobody"}
            {s.teamName ? ` · ${s.teamName}` : ""} · {uaeDate(s.saleDate)}
            {s.invoiceNumber ? ` · ${s.invoiceNumber}` : ""}
            {typeof s.monthShare === "number" && s.monthShare < 1
              ? ` · ${Math.round(s.monthShare * 100)}% of the fee received this month`
              : ""}
          </p>
          {s.state === "counted" && s.lines.length > 0 && s.lines.every((l) => l.amount === 0) && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              No commission is set for {s.courseName ? `“${s.courseName}”` : "this course"} on the plan — it earns nothing.
            </p>
          )}
          {s.state !== "counted" && s.reason && (
            <p className={cn(
              "mt-1.5 text-[11px]",
              s.state === "waiting" || s.state === "progress" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
            )}>
              {s.reason}
            </p>
          )}
        </div>
        {s.lines.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {s.lines.map((l) => (
              <span
                key={l.role}
                title={l.note || `${ROLE_LABEL[l.role]}: ${l.userName}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px]",
                  s.state === "counted"
                    ? "border-primary/20 bg-primary/5 text-foreground"
                    : "border-border/50 bg-muted/30 text-muted-foreground line-through decoration-muted-foreground/40",
                )}
              >
                <span className="font-semibold text-primary">{ROLE_SHORT[l.role]}</span>
                {l.userName} · <span className="tabular-nums">{aed(l.earned ?? l.amount)}</span>
                {l.earned !== undefined && l.amount > 0 && l.earned !== l.amount && (
                  <span className="tabular-nums text-muted-foreground">of {aed(l.amount)}</span>
                )}
                {(l.balance ?? 0) > 0 && (
                  <span className="tabular-nums text-amber-600 dark:text-amber-400">+{aed(l.balance ?? 0)} balance</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function Stat({ icon: Icon, label, value, tone }: {
  icon: React.ElementType; label: string; value: string;
  tone: "primary" | "green" | "amber" | "muted";
}) {
  const tones = {
    primary: "text-primary bg-primary/10 border-primary/20",
    green: "text-green-700 dark:text-green-400 bg-green-500/10 border-green-500/20",
    amber: "text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
    muted: "text-muted-foreground bg-muted/30 border-border/50",
  }[tone];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("rounded-xl border p-3", tones)}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-1 truncate text-xl font-bold tabular-nums">{value}</p>
    </motion.div>
  );
}
