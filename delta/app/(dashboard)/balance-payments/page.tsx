"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  HandCoins, Search, RefreshCw, Loader2, AlertTriangle, Clock, CheckCircle2, XCircle,
  Hourglass, CalendarClock, Plus, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AcademyBadge } from "@/components/students/AcademyBadge";
import { BalancePaymentDialog } from "@/components/students/BalancePaymentDialog";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store/authStore";
import { PAYMENT_METHOD_LABELS, type EnrolmentPaymentMethod } from "@/types/student";
import {
  useBalancePayments, useRecordBalancePayment, fmtMinor,
  type BalanceRow, type DueState, type RecordedPayment,
} from "@/hooks/useBalancePayments";

/**
 * Balance payments (the user, 2026-10-13).
 *
 * Every part-paid course this CRM closed, followed up by the people who sold
 * it: a salesperson sees their own, a team leader their teams', the Sales
 * Manager everyone's. Finance says what is paid, what is left and when the next
 * instalment is due; the next payment is recorded here with its receipt and
 * shows pending until accounts approve it — then it is on the invoice.
 */
export default function BalancePaymentsPage() {
  const [tab, setTab] = useState<"owing" | "paid" | "all">("owing");
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const { data, isLoading, isFetching, refetch } = useBalancePayments({ state: tab, search, mine });
  const mayRecord = useAuthStore().hasPermission("balancePayments", "create");
  const [recording, setRecording] = useState<BalanceRow | null>(null);

  const rows = data?.rows ?? [];
  const counts = data?.counts;

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <div className="flex items-center gap-2">
            <HandCoins className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Balance payments</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">
            Part-paid courses you closed: what is left, when it is due, and the payments sent to finance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setMine(!mine)}>
            {mine ? "Show all I can see" : "Show only mine"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </motion.div>

      {counts && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat icon={HandCoins}     label="Still owing"          value={String(counts.owing)}   tone="muted" />
          <Stat icon={AlertTriangle} label="Overdue"              value={String(counts.overdue)} tone="red" />
          <Stat icon={CalendarClock} label="Due in 3 days"        value={String(counts.dueSoon)} tone="amber" />
          <Stat icon={Hourglass}     label="Waiting for finance"  value={String(counts.waiting)} tone="violet" />
          <Stat
            icon={CheckCircle2}
            label="Left to collect"
            value={counts.left.length ? counts.left.map((l) => fmtMinor(l.balanceMinor, l.currency)).join(" · ") : "—"}
            tone="green"
            small
          />
        </div>
      )}

      {data && !data.reachable && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <WifiOff className="h-4 w-4" />
          Finance could not be reached just now — the amounts and due dates will show when it answers. Try Refresh in a minute.
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 border-b border-border/60">
          {([
            ["owing", "Still owing", counts?.owing],
            ["paid", "Paid off", counts?.paidOff],
            ["all", "All", undefined],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                tab === key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {count ? <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{count}</span> : null}
            </button>
          ))}
        </div>
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone or enrolment number…" className="pl-9" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-6 py-16 text-center">
          <HandCoins className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">{tab === "paid" ? "Nothing paid off yet" : "Nothing owing"}</p>
          <p className="mt-1 text-xs text-muted-foreground">A course closed part paid shows here until the balance is paid.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <BalanceCard key={r.studentId} row={r} mayRecord={mayRecord} onRecord={() => setRecording(r)} />
          ))}
        </div>
      )}

      {recording && <RecordPaymentDialog row={recording} onClose={() => setRecording(null)} />}
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone, small }: {
  icon: React.ElementType; label: string; value: string; tone: "green" | "amber" | "red" | "muted" | "violet"; small?: boolean;
}) {
  const tones = {
    green:  "text-green-400 bg-green-500/10 border-green-500/20",
    amber:  "text-amber-400 bg-amber-500/10 border-amber-500/20",
    red:    "text-red-400 bg-red-500/10 border-red-500/20",
    muted:  "text-muted-foreground bg-muted/30 border-border/50",
    violet: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  }[tone];
  return (
    <div className={cn("rounded-xl border p-3", tones)}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className={cn("mt-1 font-bold tabular-nums", small ? "text-sm" : "text-2xl")}>{value}</p>
    </div>
  );
}

const DUE: Record<DueState, { label: (d: string) => string; cls: string } | null> = {
  overdue:  { label: (d) => `Overdue since ${d}`, cls: "bg-red-500/15 text-red-400" },
  due_soon: { label: (d) => `Due ${d}`, cls: "bg-amber-500/15 text-amber-400" },
  later:    { label: (d) => `Next due ${d}`, cls: "bg-muted text-muted-foreground" },
  none:     null,
};

const methodLabel = (m: string) => PAYMENT_METHOD_LABELS[m as EnrolmentPaymentMethod] ?? m.replace(/_/g, " ");

function BalanceCard({ row: r, mayRecord, onRecord }: { row: BalanceRow; mayRecord: boolean; onRecord: () => void }) {
  const inv = r.invoice;
  const due = DUE[r.dueState];
  const pct = inv && inv.totalMinor > 0 ? Math.min(100, Math.round((inv.paidMinor / inv.totalMinor) * 100)) : 0;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border/50 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm">{r.name}</span>
            <span className="text-[10px] text-muted-foreground">{r.enrollmentNumber}</span>
            <AcademyBadge academy={r.academy} />
            {due && inv && <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", due.cls)}>{due.label(inv.nextDueOn)}</span>}
            {inv && inv.balanceMinor <= 0 && <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-400">Paid in full</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {r.course || "No course"}
            {inv?.number ? ` · ${inv.number}` : ""}
            {r.closedBy.name ? ` · closed by ${r.closedBy.name}` : ""}
            {r.team ? ` · ${r.team}` : ""}
            {r.phone ? ` · ${r.phone}` : ""}
          </p>
        </div>
        {mayRecord && (
          <div className="flex flex-col items-end gap-1">
            <Button size="sm" className="gap-1.5" disabled={!r.canRecord} onClick={onRecord}>
              <Plus className="h-4 w-4" /> Record payment
            </Button>
            {!r.canRecord && r.whyNot && <span className="text-[10px] text-muted-foreground">{r.whyNot}</span>}
          </div>
        )}
      </div>

      {inv ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <span>Course fee <b className="tabular-nums">{fmtMinor(inv.totalMinor, inv.currency)}</b></span>
            <span className="text-green-400">Paid <b className="tabular-nums">{fmtMinor(inv.paidMinor, inv.currency)}</b></span>
            <span className={inv.balanceMinor > 0 ? "text-amber-400" : "text-muted-foreground"}>Left <b className="tabular-nums">{fmtMinor(inv.balanceMinor, inv.currency)}</b></span>
            {r.waitingMinor > 0 && <span className="text-violet-400">Waiting for finance <b className="tabular-nums">{fmtMinor(r.waitingMinor, inv.currency)}</b></span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-green-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{r.whyNot}</p>
      )}

      {(inv?.payments.length || r.balancePayments.length) ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {inv && inv.payments.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">On the invoice</p>
              <ul className="space-y-1">
                {inv.payments.map((p, i) => (
                  <li key={i} className="flex justify-between gap-2 text-xs">
                    <span>{p.paidOn} · {methodLabel(p.method)}{p.receiptNumber ? ` · ${p.receiptNumber}` : ""}</span>
                    <span className="tabular-nums">{fmtMinor(p.amountMinor, inv.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.balancePayments.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">Sent to finance from here</p>
              <ul className="space-y-1">
                {r.balancePayments.map((b) => <SentPayment key={b.externalId} p={b} />)}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}

function SentPayment({ p }: { p: RecordedPayment }) {
  const tone = {
    pending:  { icon: Clock, cls: "text-amber-400", label: "Pending" },
    approved: { icon: CheckCircle2, cls: "text-green-400", label: "Approved" },
    rejected: { icon: XCircle, cls: "text-red-400", label: "Rejected" },
  }[p.status];
  const Icon = tone.icon;
  return (
    <li className="text-xs">
      <div className="flex justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Icon className={cn("h-3.5 w-3.5", tone.cls)} />
          <span className={tone.cls}>{tone.label}</span>
          <span className="text-muted-foreground">· {p.paidOn} · {methodLabel(p.method)}{p.receiptNumber ? ` · ${p.receiptNumber}` : ""}</span>
        </span>
        <span className="tabular-nums">{fmtMinor(p.amountMinor, p.currency)}</span>
      </div>
      {p.status === "rejected" && p.reason && <p className="ml-5 text-[11px] text-red-400/80">{p.reason}</p>}
      {p.status !== "pending" && p.decidedBy && <p className="ml-5 text-[10px] text-muted-foreground">by {p.decidedBy}</p>}
    </li>
  );
}


/** The next payment, with its receipt: sent to finance, pending until accounts approve it. */
function RecordPaymentDialog({ row, onClose }: { row: BalanceRow; onClose: () => void }) {
  const record = useRecordBalancePayment(row.studentId);
  return (
    <BalancePaymentDialog
      studentId={row.studentId}
      name={row.name}
      course={row.course}
      invoice={row.invoice!}
      waitingMinor={row.waitingMinor}
      sending={record.isPending}
      // Refused or not reached: the mutation says why, and the dialog stays open to fix it.
      send={(input, done) => record.mutate(input, { onSuccess: done })}
      onClose={onClose}
    />
  );
}
