"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { AlertTriangle, Coins, Info, Users, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { usePay } from "@/hooks/useCommission";
import { monthLabel, payMonths, ROLE_LABEL } from "@/lib/commission";
import { PayMonthCard } from "@/components/pay/PayMonthCard";
import { SlabTable } from "@/components/pay/SlabLadder";
import { EveryonePayTable } from "@/components/pay/EveryonePayTable";

/**
 * My Pay: a month's salary and commission on the salary slabs (the user,
 * 2026-10-05). Everyone sees their own month; a Super Admin and the Sales
 * Manager also everyone's; a team leader their team's (2026-10-23).
 * The slabs themselves are set on Commission → Plan.
 */
export default function MyPayPage() {
  const months = payMonths();
  const [month, setMonth] = useState(months[0]!);
  const { data, isLoading, isError, error } = usePay(month);

  return (
    <div className="flex flex-col gap-6 pb-6">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Wallet className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">My Pay</h1>
            <p className="text-sm text-muted-foreground">Salary and commission on your slab, month by month</p>
          </div>
        </div>
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
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : isError || !data ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {(error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Couldn't load your pay."}
        </div>
      ) : (
        <>
          {data.me ? (
            <>
              <PayMonthCard row={data.me} slab={data.slabs[data.me.role] ?? []} month={data.month} payoutsKnown={!!data.payoutsKnown} />
              <section className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Your slab · {ROLE_LABEL[data.me.role]}
                </p>
                <SlabTable rows={data.slabs[data.me.role] ?? []} levelIndex={data.me.level.index} nextIndex={data.me.next?.index} />
              </section>
            </>
          ) : !data.people ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-16 text-center"
            >
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                <Wallet className="h-7 w-7 text-primary" />
              </div>
              <h3 className="mb-1 font-semibold text-foreground">You&apos;re not on a salary slab</h3>
              <p className="mb-4 max-w-sm px-4 text-sm text-muted-foreground">
                Slabs are for Sales Staff (team leaders included) and the Sales Manager. If you sell, ask a Super Admin to add you to your team.
              </p>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button asChild size="sm" className="gap-1.5">
                  <Link href="/commission"><Coins className="h-4 w-4" /> Commission</Link>
                </Button>
              </motion.div>
            </motion.div>
          ) : null}

          {data.people && data.totals && (
            <section className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Users className="h-3.5 w-3.5" /> {data.view === "team" ? "Your team" : "Everyone"} · {monthLabel(data.month)}
              </p>
              {data.people.length ? (
                <EveryonePayTable people={data.people} totals={data.totals} payoutsKnown={!!data.payoutsKnown} />
              ) : (
                <p className="rounded-xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                  Nobody is on the slabs yet — they cover the Sales Manager and everyone in an active team.
                </p>
              )}
            </section>
          )}

          <HowItsWorkedOut slabsFrom={data.slabsFrom} />
        </>
      )}
    </div>
  );
}

function HowItsWorkedOut({ slabsFrom }: { slabsFrom: string | null }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Info className="h-4 w-4 text-primary" /> How it&apos;s worked out
      </p>
      <ul className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        <li>Your target counts the money received in the month (UAE time) on every sale finance has approved — a balance paid next month counts next month; money received before October 2026 never counts.</li>
        <li>Sales Staff count their own sales — a team leader too, on their own closes — and the Sales Manager every sale in the CRM.</li>
        <li>The highest level your sales reach sets your salary and the share of your commission paid. Below the first level, the base row pays.</li>
        <li>A sale earns its commission as its fee is paid: the part received this month earns this month, the rest shows as balance until it&apos;s paid. Counted once finance approves the sale.</li>
        <li>Pay = salary + commission earned that month × that share.</li>
        <li>A sale voided in finance comes off. Until the month&apos;s sales are all approved and counted, its figures can still go up.</li>
        <li>
          {slabsFrom
            ? `The slabs were last changed for ${monthLabel(slabsFrom)}. `
            : "These are the slabs as first set. "}
          A Super Admin changes them on Commission → Plan; a change holds from that month on.
        </li>
      </ul>
    </motion.div>
  );
}
