"use client";

import { CalendarDays, CheckCircle2, Receipt, Users } from "lucide-react";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogHeader, ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { cn } from "@/lib/utils";
import { aed, monthLabel, ROLE_LABEL, ROLE_SHORT, uaeDate } from "@/lib/commission";
import type { CommissionEarnings, CommissionRole, CommissionSale } from "@/types/commission";

type Person = CommissionEarnings["people"][number];

/**
 * One person's month behind their figures (the user, 2026-11-03: "click on it and see which closings, the amount, the
 * course name, when closed — every detail as a popup"): each counted sale they earn on, with the student, course,
 * invoice, fee, who closed it and when, their role on it and what it pays them. A role picked shows only that role's.
 * Made from the sales the page already has, so it shows only what the viewer may see there.
 */
export function PersonSalesDialog({ person, role, month, sales, roles, onRole, onClose }: {
  person: Person;
  role: CommissionRole | null;
  month: string;
  sales: CommissionSale[];
  /** The positions this CRM pays. */
  roles: readonly CommissionRole[];
  onRole: (role: CommissionRole | null) => void;
  onClose: () => void;
}) {
  // As the table adds them up: a counted sale's lines that pay this month or wait for the full payment — a line of 0
  // (a team leader's own close, say) pays nothing and isn't in the figures.
  const pays = (l: CommissionSale["lines"][number]) => (l.earned ?? l.amount) > 0 || (l.balance ?? 0) > 0;
  const mine = sales
    .filter((s) => s.state === "counted")
    .map((s) => ({ sale: s, lines: s.lines.filter((l) => l.user === person._id && (!role || l.role === role) && pays(l)) }))
    .filter((x) => x.lines.length > 0)
    .sort((a, b) => a.sale.saleDate.localeCompare(b.sale.saleDate));
  const stillPaying = mine.filter((x) => x.lines.some((l) => (l.balance ?? 0) > 0)).length;
  const earned = role ? person[role].amount : person.total;
  const waiting = role ? person[role].balance ?? 0 : person.balance ?? 0;

  return (
    <ResponsiveDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <ResponsiveDialogContent desktopClassName="max-w-3xl max-h-[85vh] overflow-y-auto">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{person.name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {monthLabel(month)} · {role ? `as ${ROLE_LABEL[role]}` : "every role"} · {mine.length} {mine.length === 1 ? "closing" : "closings"}
            {stillPaying > 0 ? ` · ${stillPaying} waiting for the client to pay in full` : ""}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 pb-4 sm:px-0 sm:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border border-primary/20 bg-primary/10 px-2.5 py-1.5 text-sm font-semibold tabular-nums text-primary">
              Earned {aed(earned)}
            </span>
            {waiting > 0 && (
              <span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-sm tabular-nums text-amber-700 dark:text-amber-400">
                +{aed(waiting)} waiting for full payment
              </span>
            )}
          </div>

          {/* Each position they earn as — pick one to see only its closings. */}
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Role">
            <RoleChip active={!role} onClick={() => onRole(null)} label="All" />
            {roles.filter((r) => person[r].count > 0 || (person[r].balance ?? 0) > 0).map((r) => (
              <RoleChip key={r} active={role === r} onClick={() => onRole(r)} label={`${ROLE_LABEL[r]} · ${aed(person[r].amount)}`} />
            ))}
          </div>

          {mine.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
              No counted closings for {person.name} {role ? `as ${ROLE_LABEL[role]} ` : ""}in {monthLabel(month)}.
            </p>
          ) : (
            <ul className="space-y-2">
              {mine.map(({ sale: s, lines }) => (
                <li key={s._id} className="rounded-xl border border-border/50 bg-card p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{s.studentName}</span>
                        {s.enrollmentNumber && <span className="text-[10px] text-muted-foreground">{s.enrollmentNumber}</span>}
                        <span className="inline-flex items-center gap-1 rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                          <CheckCircle2 className="h-2.5 w-2.5" /> {s.paidInFullAt ? "Paid in full" : "Client still paying"}
                        </span>
                      </p>
                      <p className="text-xs font-medium text-foreground">{s.courseName || "No course"}</p>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" /> Closed {uaeDate(s.saleDate)}</span>
                        {s.approvedAt && <span>approved {uaeDate(s.approvedAt)}</span>}
                        {s.paidInFullAt && <span>paid in full {uaeDate(s.paidInFullAt)}</span>}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" /> Closed by {s.closerName || "nobody"}{s.teamName ? ` · ${s.teamName}` : ""}</span>
                        {s.invoiceNumber && <span className="inline-flex items-center gap-1"><Receipt className="h-3 w-3" /> {s.invoiceNumber}</span>}
                        {typeof s.fee === "number" && s.fee > 0 && <span>fee {aed(s.fee)}</span>}
                        {typeof s.monthShare === "number" && s.monthShare < 1 && <span>{Math.round(s.monthShare * 100)}% of the fee received this month</span>}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {lines.map((l) => (
                        <span key={l.role} title={l.note || undefined}
                          className="inline-flex items-center gap-1 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] text-foreground">
                          <span className="font-semibold text-primary">{ROLE_SHORT[l.role]}</span>
                          <span className="tabular-nums font-semibold">{aed(l.earned ?? l.amount)}</span>
                          {l.earned !== undefined && l.amount > 0 && l.earned !== l.amount && (
                            <span className="tabular-nums text-muted-foreground">of {aed(l.amount)}</span>
                          )}
                          {(l.balance ?? 0) > 0 && (
                            <span className="tabular-nums text-amber-600 dark:text-amber-400">+{aed(l.balance ?? 0)} waiting</span>
                          )}
                        </span>
                      ))}
                      {lines.some((l) => l.note) && (
                        <span className="max-w-[220px] text-right text-[10px] text-muted-foreground">{lines.find((l) => l.note)!.note}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function RoleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}>
      {label}
    </button>
  );
}
