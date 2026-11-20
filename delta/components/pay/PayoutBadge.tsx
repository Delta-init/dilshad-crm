"use client";

import { BadgeCheck, CircleDollarSign, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { aed, inr } from "@/lib/commission";
import type { CommissionPayout } from "@/types/commission";

/*
 * Where finance stands on a person's month of commission (the user, 2026-10-21: "show approved and paid in the CRM
 * My Pay also"): waiting for a manager in finance to approve it, approved (the amount frozen then), or paid — when,
 * how, and the reference. Shown only when finance could be asked; nothing is said when it couldn't.
 *
 * The rupee part (2026-11-20) is approved and paid apart from the AED one, so it is shown apart: "Approved AED 1,200 +
 * INR 5,750" while both stand the same, each said on its own when they don't ("Paid AED 1,200 · INR 5,750 approved —
 * to be paid"), and only the INR for a month that is only rupees. Never added to the AED.
 */

const METHOD: Record<string, string> = { bank_transfer: "bank transfer", cash: "cash", cheque: "cheque", card: "card", online: "online" };
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }) : "";

type State = "approved" | "paid";
type Part = { money: string; state: State; paidOn?: string | null };

/** The month's parts as finance sent them: the AED one (none for a rupees-only month), then the rupee one, if any. */
function partsOf(payout: CommissionPayout): Part[] {
  const rupees = payout.inr && payout.inr.amount > 0 ? payout.inr : null;
  // A rupees-only month: `inrOnly`, or — from a finance that doesn't say so — no AED amount beside a rupee part.
  const inrOnly = Boolean(rupees && (payout.inrOnly || !(payout.amount > 0)));
  return [
    ...(inrOnly ? [] : [{ money: aed(payout.amount), state: payout.state, paidOn: payout.paidOn }]),
    ...(rupees ? [{ money: inr(rupees.amount), state: rupees.state, paidOn: rupees.paidOn }] : []),
  ];
}

export function PayoutBadge({ payout, payable, payableInr = 0, compact = false }: {
  payout: CommissionPayout | null | undefined;
  payable: number;
  /** What the month pays in rupees (2026-11-20): waits for finance like the AED does. */
  payableInr?: number;
  compact?: boolean;
}) {
  if (!payout) {
    if (!(payable > 0) && !(payableInr > 0)) return null;
    return (
      <span className={cn("inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground", compact ? "text-[10px]" : "text-[11px]")}>
        <Clock className="h-3 w-3" /> Waiting for finance approval
      </span>
    );
  }

  const parts = partsOf(payout);
  const allPaid = parts.every((p) => p.state === "paid");
  const sameState = parts.every((p) => p.state === parts[0]!.state);
  const method = payout.paymentMethod ? ` by ${METHOD[payout.paymentMethod] ?? payout.paymentMethod}` : "";
  const reference = payout.reference ? ` · ${payout.reference}` : "";

  let text: string;
  if (sameState) {
    const money = parts.map((p) => p.money).join(" + ");
    if (parts[0]!.state === "approved") {
      text = `Approved ${money}${compact ? "" : ` · ${payout.approvedByName}, ${day(payout.approvedAt)} — to be paid`}`;
    } else {
      // Paid on the AED part's day; the rupee part's own day when it was paid on another.
      const [first, second] = parts;
      const otherDay = second && second.paidOn && second.paidOn !== first!.paidOn ? ` (INR ${day(second.paidOn)})` : "";
      text = `Paid ${money}${compact ? "" : ` · ${day(first!.paidOn)}${otherDay}${method}${reference}`}`;
    }
  } else {
    // The two parts stand differently: each said on its own, the first with its verb, the second after it.
    const [first, second] = parts as [Part, Part];
    const toBePaid = compact ? "" : " — to be paid";
    text = `${first.state === "paid" ? "Paid" : "Approved"} ${first.money}${first.state === "approved" ? toBePaid : ""}`
      + ` · ${second.money} ${second.state}${second.state === "approved" ? toBePaid : ""}`;
  }

  const title = [
    `Approved by ${payout.approvedByName}${payout.approvedAt ? `, ${day(payout.approvedAt)}` : ""}`,
    ...parts.filter((p) => p.state === "paid" && p.paidOn).map((p) => `${p.money} paid ${day(p.paidOn)}`),
    ...(payout.reference ? [`Reference ${payout.reference}`] : []),
  ].join(" · ");

  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
        allPaid
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        compact ? "text-[10px]" : "text-[11px]",
      )}
      title={title}
    >
      {allPaid ? <CircleDollarSign className="h-3 w-3" /> : <BadgeCheck className="h-3 w-3" />} {text}
    </span>
  );
}
