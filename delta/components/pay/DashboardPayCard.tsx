"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePay } from "@/hooks/useCommission";
import { aed, monthLabel, uaeMonth } from "@/lib/commission";
import { PayMonthCard } from "@/components/pay/PayMonthCard";

/**
 * The top of the dashboard: this month on the viewer's salary slab — or, for
 * a Super Admin who isn't on one, everyone's in a line. Nothing for anyone
 * else, and nothing when it can't be had: the dashboard is not where to say so.
 */
export function DashboardPayCard() {
  const { data, isLoading, isError } = usePay(uaeMonth());

  if (isLoading) return <Skeleton className="h-52 rounded-xl" />;
  if (isError || !data) return null;
  if (data.me) {
    return <PayMonthCard compact row={data.me} slab={data.slabs[data.me.role] ?? []} month={data.month} payoutsKnown={!!data.payoutsKnown} />;
  }
  if (!data.totals || !data.people?.length) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Pay on the slabs · {monthLabel(data.month)}</p>
          <p className="text-xs text-muted-foreground">
            {data.totals.people} {data.totals.people === 1 ? "person" : "people"} · salaries {aed(data.totals.salary)} · commission{" "}
            {aed(data.totals.payable)} · <span className="font-semibold text-primary">total {aed(data.totals.total)}</span>
          </p>
        </div>
      </div>
      <Link href="/my-pay" className="inline-flex shrink-0 items-center gap-1 self-end text-xs font-medium text-primary hover:underline sm:self-auto">
        Everyone&apos;s pay <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </motion.div>
  );
}
