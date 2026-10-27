"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRecentFollowups } from "@/hooks/useWhatsApp";

/**
 * The latest automatic follow-ups (2026-10-27, api services/whatsapp/followups.ts) from the WhatsApps you may read —
 * yours, and your team's for a team leader, everyone's for the Sales Manager and a Super Admin. Hidden while there are none.
 */
export function RecentFollowups() {
  const { data = [] } = useRecentFollowups();
  const [open, setOpen] = useState(false);
  if (!data.length) return null;
  const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        <span className="flex items-center gap-2"><Repeat className="h-4 w-4 text-muted-foreground" />Recent automatic follow-ups ({data.length})</span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="divide-y border-t">
          {data.map((f) => (
            <li key={f.id} className="flex flex-col gap-0.5 px-4 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
              <span className="shrink-0 text-xs text-muted-foreground sm:w-32">{when(f.at)}</span>
              <span className="shrink-0 sm:w-48">
                {f.lead ? <Link href={`/leads/${f.lead.id}`} className="font-medium text-primary hover:underline">{f.lead.name || `+${f.phone}`}</Link> : <span>+{f.phone}</span>}
                <span className="text-xs text-muted-foreground"> · step {f.step} of {f.of}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={f.body}>{f.body}</span>
              <span className="shrink-0 text-xs text-muted-foreground">from {f.ownerName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
