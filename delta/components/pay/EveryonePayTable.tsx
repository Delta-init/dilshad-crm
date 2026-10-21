"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { PayoutBadge } from "@/components/pay/PayoutBadge";
import { aed, ROLE_SHORT } from "@/lib/commission";
import { basisOf } from "@/components/pay/PayMonthCard";
import type { PayRow, PayView } from "@/types/commission";

/** Everyone's month on the slabs, for a Super Admin: level, salary, commission, total. */
interface EveryonePayTableProps {
  people: PayRow[];
  totals: NonNullable<PayView["totals"]>;
  /** Finance answered: show where it stands on each person's commission (2026-10-21). */
  payoutsKnown?: boolean;
}

const ROLE_TONE = {
  sm: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  tl: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sales: "border-border/60 bg-muted/40 text-muted-foreground",
} as const;

export function EveryonePayTable({ people, totals, payoutsKnown = false }: EveryonePayTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/50 bg-card">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Person</th>
            <th className="px-4 py-2.5 text-right font-medium">Approved sales</th>
            <th className="px-4 py-2.5 font-medium">Level</th>
            <th className="px-4 py-2.5 text-right font-medium">Salary</th>
            <th className="px-4 py-2.5 text-right font-medium">Commission</th>
            <th className="px-4 py-2.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p, i) => (
            <motion.tr
              key={p.user}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 15) * 0.03 }}
              className="border-b border-border/30 last:border-0"
            >
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={cn("rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", ROLE_TONE[p.role])}>
                    {ROLE_SHORT[p.role]}
                  </span>
                  <span className="font-medium text-foreground">{p.name}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{basisOf(p, false)}</p>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                <span className="text-foreground">{aed(p.sales.value)}</span>
                <span className="ml-1 text-[11px] text-muted-foreground">· {p.sales.count}</span>
                {p.awaitingFinance.count > 0 && (
                  <p className="text-[10px] text-amber-700 dark:text-amber-400">
                    +{aed(p.awaitingFinance.value)} in finance
                  </p>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5">
                <span className="font-semibold text-primary">{p.level.name}</span>
                <p className="text-[10px] text-muted-foreground">
                  {p.next ? `${aed(p.next.more)} to ${p.next.name}` : "Top level"}
                </p>
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-foreground">{aed(p.salary)}</td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                <span className="text-foreground">{aed(p.commission.payable)}</span>
                <p className="text-[10px] text-muted-foreground">
                  {p.percent}% of {aed(p.commission.earned)}
                  {p.commission.notCountedYet > 0 ? ` · ${p.commission.notCountedYet} not counted yet` : ""}
                </p>
                {payoutsKnown && <div className="mt-1"><PayoutBadge payout={p.payout} payable={p.commission.payable} compact /></div>}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-primary">{aed(p.total)}</td>
            </motion.tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border/60 bg-muted/20 text-sm font-semibold">
            <td className="px-4 py-2.5 text-foreground" colSpan={3}>
              {totals.people} {totals.people === 1 ? "person" : "people"}
            </td>
            <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-foreground">{aed(totals.salary)}</td>
            <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-foreground">{aed(totals.payable)}</td>
            <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-primary">{aed(totals.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
