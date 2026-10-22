"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { BellRing, CalendarClock, ChevronRight, AlarmClockOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMyTodayFollowups, type TodayFollowupLead } from "@/hooks/useLeads";
import { useAuthStore } from "@/lib/store/authStore";
import { ChangeFollowUpDate } from "@/components/leads/ChangeFollowUpDate";

// Today's date in GST as YYYY-MM-DD
function todayGST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "short",
  });
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const gstDay = d.toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
  return gstDay < todayGST();
}

/**
 * Daily pop-up on the dashboard listing the user's follow-up leads due today
 * (plus overdue ones). Shows automatically once per day per user; the row
 * links straight to the lead, and its date can be changed from it (2026-10-22).
 */
export function DailyFollowupsPopup() {
  const { user } = useAuthStore();
  const { data: followups = [], isLoading } = useMyTodayFollowups();
  const [open, setOpen] = useState(false);

  const storageKey = `followupsPopupShown:${user?._id ?? "anon"}:${todayGST()}`;

  useEffect(() => {
    if (isLoading || followups.length === 0) return;
    try {
      if (localStorage.getItem(storageKey)) return;
      localStorage.setItem(storageKey, "1");
      setOpen(true);
    } catch {
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, followups.length, storageKey]);

  if (followups.length === 0) return null;

  const overdue     = followups.filter((f) => f.nextFollowUpAt && isOverdue(f.nextFollowUpAt));
  const today       = followups.filter((f) => f.nextFollowUpAt && !isOverdue(f.nextFollowUpAt));
  const unscheduled = followups.filter((f) => !f.nextFollowUpAt);

  // A plain function, not a component made in render: a refresh must not remount a row (and close its Change dialog).
  function row(lead: TodayFollowupLead) {
    const late = isOverdue(lead.nextFollowUpAt);
    return (
      <div key={lead._id} className="flex items-center gap-2 rounded-xl border border-border/40 bg-muted/10 pr-2.5 hover:border-primary/40 hover:bg-primary/5 transition-all group">
      <Link
        href={`/leads/${lead._id}`}
        onClick={() => setOpen(false)}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3"
      >
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${late ? "bg-red-500/10" : lead.nextFollowUpAt ? "bg-blue-500/10" : "bg-amber-500/10"}`}>
          <CalendarClock className={`h-4 w-4 ${late ? "text-red-500" : lead.nextFollowUpAt ? "text-blue-500" : "text-amber-500"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{lead.name}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {lead.phone ?? ""}{lead.source ? ` · ${lead.source}` : ""}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {lead.nextFollowUpAt ? (
            <>
              <p className={`text-xs font-semibold tabular-nums ${late ? "text-red-500" : "text-foreground"}`}>
                {fmtTime(lead.nextFollowUpAt)}
              </p>
              <p className={`text-[10px] ${late ? "text-red-400" : "text-muted-foreground"}`}>
                {late ? `overdue · ${fmtDate(lead.nextFollowUpAt)}` : fmtDate(lead.nextFollowUpAt)}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-semibold text-amber-500">No time set</p>
              {lead.lastFollowupDate && (
                <p className="text-[10px] text-muted-foreground">last: {fmtDate(lead.lastFollowupDate)}</p>
              )}
            </>
          )}
          {lead.missedFollowUpWarnedAt && lead.nextFollowUpAt &&
            new Date(lead.missedFollowUpWarnedAt) >= new Date(lead.nextFollowUpAt) && (
            <span className="mt-0.5 inline-flex items-center rounded-full bg-red-500/15 border border-red-500/30 px-1.5 py-px text-[9px] font-bold text-red-500">
              ⚠ missed
            </span>
          )}
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </Link>
      <ChangeFollowUpDate compact leadId={lead._id} leadName={lead.name} current={lead.nextFollowUpAt} className="shrink-0" />
      </div>
    );
  }

  return (
    <>
      {/* Reopen chip — always visible on the dashboard while followups exist */}
      <motion.button
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        whileTap={{ scale: 0.96 }}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-500 hover:bg-blue-500/15 transition-colors"
      >
        <BellRing className="h-3.5 w-3.5" />
        {followups.length} follow-up{followups.length > 1 ? "s" : ""} pending
        {overdue.length > 0 && (
          <span className="rounded-full bg-red-500/15 border border-red-500/30 px-1.5 py-px text-[10px] font-bold text-red-500">
            {overdue.length} overdue
          </span>
        )}
      </motion.button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl bg-card border border-border shadow-2xl overflow-hidden"
                initial={{ scale: 0.92, y: 20 }}
                animate={{ scale: 1,    y: 0  }}
                exit={{    scale: 0.92, y: 20 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-center gap-3 p-5 border-b border-border/50 bg-blue-500/5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10">
                    <BellRing className="h-5 w-5 text-blue-500" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold text-foreground">Today&apos;s Follow-ups</h2>
                    <p className="text-xs text-muted-foreground">
                      {today.length} due today{overdue.length > 0 ? ` · ${overdue.length} overdue` : ""}{unscheduled.length > 0 ? ` · ${unscheduled.length} without time` : ""}
                    </p>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {overdue.length > 0 && (
                    <>
                      <p className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-red-500">
                        <AlarmClockOff className="h-3 w-3" /> Overdue
                      </p>
                      {overdue.map((l) => row(l))}
                    </>
                  )}
                  {today.length > 0 && (
                    <>
                      <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Due today
                      </p>
                      {today.map((l) => row(l))}
                    </>
                  )}
                  {unscheduled.length > 0 && (
                    <>
                      <p className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-amber-500">
                        Follow-up leads — no time set
                      </p>
                      {unscheduled.map((l) => row(l))}
                    </>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border/50 bg-muted/20">
                  <Button size="sm" onClick={() => setOpen(false)}>
                    Got it
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export default DailyFollowupsPopup;
