"use client";

import { BadgeCheck, CircleDollarSign, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { aed } from "@/lib/commission";
import type { CommissionPayout } from "@/types/commission";

/*
 * Where finance stands on a person's month of commission (the user, 2026-10-21: "show approved and paid in the CRM
 * My Pay also"): waiting for a manager in finance to approve it, approved (the amount frozen then), or paid — when,
 * how, and the reference. Shown only when finance could be asked; nothing is said when it couldn't.
 */

const METHOD: Record<string, string> = { bank_transfer: "bank transfer", cash: "cash", cheque: "cheque", card: "card", online: "online" };
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }) : "";

export function PayoutBadge({ payout, payable, compact = false }: { payout: CommissionPayout | null | undefined; payable: number; compact?: boolean }) {
  if (!payout) {
    if (!(payable > 0)) return null;
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground", compact ? "text-[10px]" : "text-[11px]")}>
        <Clock className="h-3 w-3" /> Waiting for finance approval
      </span>
    );
  }
  if (payout.state === "approved") {
    return (
      <span className={cn("inline-flex flex-wrap items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400", compact ? "text-[10px]" : "text-[11px]")}
        title={`Approved by ${payout.approvedByName}`}>
        <BadgeCheck className="h-3 w-3" /> Approved {aed(payout.amount)}{compact ? "" : ` · ${payout.approvedByName}, ${day(payout.approvedAt)} — to be paid`}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 font-medium text-green-700 dark:text-green-400", compact ? "text-[10px]" : "text-[11px]")}
      title={payout.reference ? `Reference ${payout.reference}` : undefined}>
      <CircleDollarSign className="h-3 w-3" /> Paid {aed(payout.amount)}
      {compact ? "" : ` · ${day(payout.paidOn)}${payout.paymentMethod ? ` by ${METHOD[payout.paymentMethod] ?? payout.paymentMethod}` : ""}${payout.reference ? ` · ${payout.reference}` : ""}`}
    </span>
  );
}
