"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { AlertCircle, CalendarClock, ChevronDown, PhoneCall } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMyTodayFollowups, type TodayFollowupLead } from "@/hooks/useLeads";
import type { ReminderWithLead } from "@/types/lead";
import { ChangeFollowUpDate } from "@/components/leads/ChangeFollowUpDate";

/*
 * Follow-ups on the Reminders page (the user, 2026-10-20: "why is it not showing in the reminders?"): the follow-up
 * dates on the leads — the same list as the daily Today's Follow-ups pop-up — beside the reminders, so everything
 * pending is in one place. A follow-up that already has the same reminder (one made with it) isn't shown twice.
 * Each one's date can be changed here (2026-10-22) — its reminder moves with it.
 */

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));
const gstDay = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);

export function FollowupsSection({ reminders }: { reminders: ReminderWithLead[] }) {
  const { data: followups = [], isLoading } = useMyTodayFollowups();
  const [showUntimed, setShowUntimed] = useState(false);

  const { overdue, today, untimed } = useMemo(() => {
    // A follow-up that already sits here as an open reminder at the same time is that reminder.
    const sameAsReminder = (l: TodayFollowupLead) => !!l.nextFollowUpAt && reminders.some((r) =>
      !r.isDone && r.lead?._id === l._id && Math.abs(new Date(r.remindAt).getTime() - new Date(l.nextFollowUpAt!).getTime()) < 60_000);
    const now = new Date();
    const rows = followups.filter((l) => !sameAsReminder(l));
    return {
      overdue: rows.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) < now),
      today: rows.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) >= now && gstDay(new Date(l.nextFollowUpAt)) === gstDay(now)),
      untimed: rows.filter((l) => !l.nextFollowUpAt),
    };
  }, [followups, reminders]);

  if (isLoading || overdue.length + today.length + untimed.length === 0) return null;

  // A plain function, not a component made in render: a refresh of the list must not remount a row (and close its
  // Change dialog mid-edit).
  const row = (lead: TodayFollowupLead, late?: boolean) => {
    const missed = !!lead.missedFollowUpWarnedAt && !!lead.nextFollowUpAt && new Date(lead.missedFollowUpWarnedAt) >= new Date(lead.nextFollowUpAt);
    return (
      <div key={lead._id} className={cn("flex items-center gap-2 rounded-xl border pr-3 transition-colors hover:bg-accent/30", late ? "border-red-500/30 bg-red-500/5" : "border-border bg-card")}>
      <Link href={`/leads/${lead._id}`} className="flex min-w-0 flex-1 items-center gap-3 p-3 pr-0">
        <PhoneCall className={cn("h-4 w-4 shrink-0", late ? "text-red-400" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{lead.name || "Unnamed lead"}</p>
          <p className="truncate text-xs text-muted-foreground">{[lead.phone, lead.source].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("text-xs font-semibold", late ? "text-red-400" : "text-foreground")}>{lead.nextFollowUpAt ? fmt(lead.nextFollowUpAt) : "No time set"}</p>
          {missed && <span className="mt-0.5 inline-block rounded-full border border-red-500/30 bg-red-500/10 px-1.5 text-[10px] text-red-400">missed</span>}
        </div>
      </Link>
      <ChangeFollowUpDate compact leadId={lead._id} leadName={lead.name} current={lead.nextFollowUpAt} className="shrink-0" />
      </div>
    );
  };

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Follow-ups due</h2>
        {overdue.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-400">
            <AlertCircle className="h-3 w-3" /> {overdue.length} overdue
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">From your leads&apos; follow-up dates — the same list as the Today&apos;s Follow-ups pop-up. Change a date here, or update the lead to clear one.</p>
      {overdue.length > 0 && <div className="space-y-2">{overdue.map((l) => row(l, true))}</div>}
      {today.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Later today</p>
          {today.map((l) => row(l))}
        </div>
      )}
      {untimed.length > 0 && (
        <div className="space-y-2">
          <button type="button" onClick={() => setShowUntimed((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showUntimed && "rotate-180")} />
            {untimed.length} in Follow Up with no time set
          </button>
          {showUntimed && untimed.map((l) => row(l))}
        </div>
      )}
    </motion.section>
  );
}
