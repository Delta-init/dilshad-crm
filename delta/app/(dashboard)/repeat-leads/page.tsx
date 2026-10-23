"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Repeat2, RefreshCw, Loader2, Search, CheckCircle2, UserRoundCheck, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useRepeatLeads, useGiveRepeatLead, type RepeatLead, type RepeatLeadList } from "@/hooks/useRepeatLeads";

/**
 * Repeat leads (the user, 2026-10-23).
 *
 * A number the CRM already has, in again from the ads, no longer slips by: it comes to the team leader first. They
 * look at it — who had it, how often it came, from which campaign — and give it to the same person or another in
 * the team, where it lands as a new lead. Already a client: it stays with its owner and is only verified.
 */
export default function RepeatLeadsPage() {
  const [tab, setTab] = useState<"waiting" | "done">("waiting");
  const [search, setSearch] = useState("");
  const { data, isLoading, isFetching, refetch, error } = useRepeatLeads(tab);
  const notAllowed = (error as { response?: { status?: number } } | null)?.response?.status === 403;

  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (data?.leads ?? []).filter((l) => !q || [l.name, l.phone, l.email, l.repeat.previousOwner?.name, l.repeat.campaign].some((v) => String(v ?? "").toLowerCase().includes(q))),
    [data, q],
  );

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Repeat2 className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Repeat leads</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">
            Numbers we already had, in again from the ads — verify each one and give it to the same person or someone else in the team
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </motion.div>

      {notAllowed ? (
        <div className="rounded-xl border border-border/50 bg-card px-6 py-16 text-center text-sm text-muted-foreground">
          Repeat leads go to team leaders. A repeat of one of your leads comes back to you once your team leader has verified it.
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1 border-b border-border/60">
              {([["waiting", "To verify"], ["done", "Verified"]] as const).map(([key, label]) => (
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
                  {key === tab && data ? <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{data.leads.length}</span> : null}
                </button>
              ))}
            </div>
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone, who had it, campaign…" className="pl-9" />
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-border/50 bg-card px-6 py-16 text-center">
              <Repeat2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium">{tab === "waiting" ? "Nothing to verify" : "Nothing verified yet"}</p>
              <p className="mt-1 text-xs text-muted-foreground">When a number we already have comes in again, it shows here first.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((l) => <RepeatCard key={l.id} lead={l} teams={data!.teams} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const STATUS_WORD: Record<string, string> = {
  new: "New", assigned: "Assigned", pending_response: "Pending response", followup: "Follow up", closed: "Closed", lost: "Lost",
  not_connected: "Not connected", mia: "MIA", repeated: "Repeated", callback: "Callback", cnc: "CNC",
  meeting_scheduled: "Meeting scheduled", meeting_done: "Meeting done", wrong_number: "Wrong number",
};

function RepeatCard({ lead: l, teams }: { lead: RepeatLead; teams: RepeatLeadList["teams"] }) {
  const give = useGiveRepeatLead();
  const people = teams.find((t) => t.id === l.repeat.teamId)?.people ?? [];
  const before = l.repeat.previousOwner?.id ?? "";
  // The same person by default, when they're still in the team.
  const [to, setTo] = useState(l.repeat.alreadyClient ? (l.owner?.id ?? "") : people.some((p) => p.id === before) ? before : "");
  const r = l.repeat;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border/50 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/leads/${l.id}`} className="font-semibold text-sm hover:underline">{l.name || "No name"}</Link>
            <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-400">
              Came in {l.repeatCount + 1} times
            </span>
            {r.alreadyClient && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-400">
                <GraduationCap className="h-3 w-3" /> Already a client
              </span>
            )}
            {r.previousStatus && !r.alreadyClient && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Was {STATUS_WORD[r.previousStatus] ?? r.previousStatus}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {[l.phone, l.email].filter(Boolean).join(" · ")}
          </p>
          <p className="text-xs text-muted-foreground">
            In again {when(r.at)}
            {[r.source, r.campaign].filter(Boolean).length ? ` · ${[r.source, r.campaign].filter(Boolean).join(" · ")}` : ""}
          </p>
          <p className="text-xs">
            <span className="text-muted-foreground">Was with </span>
            <span className="font-medium">{r.previousOwner?.name || "nobody"}</span>
            {l.team ? <span className="text-muted-foreground"> · {l.team.name}</span> : null}
            {r.waiting && l.owner && l.owner.id !== r.previousOwner?.id ? <span className="text-muted-foreground"> · now with {l.owner.name}</span> : null}
          </p>
        </div>

        {r.waiting ? (
          <div className="flex flex-wrap items-center gap-2">
            {r.alreadyClient ? (
              <span className="text-xs text-muted-foreground">Stays with {l.owner?.name ?? "its owner"}</span>
            ) : (
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                aria-label="Give it to"
              >
                <option value="">Give it to…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.id === before ? " (had it before)" : ""}{p.leader ? " · leader" : ""}
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" className="gap-1.5" disabled={!to || give.isPending} onClick={() => give.mutate({ leadId: l.id, userId: to })}>
              {give.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRoundCheck className="h-4 w-4" />}
              {r.alreadyClient ? "Verified" : "Verify & give"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            {r.givenTo ? <>Given to <span className="font-medium text-foreground">{r.givenTo.name}</span></> : "Verified"}
            {r.decidedBy ? <> by {r.decidedBy.name}</> : null}
            {r.decidedAt ? <> · {when(r.decidedAt)}</> : null}
          </div>
        )}
      </div>
    </motion.div>
  );
}
