"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Headphones, Pencil, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CallResult, RecordingPlayer, fmtClockDuration, fmtWhen } from "@/components/calls/callUi";
import { TrainingBadge, TrainingMarkDialog } from "@/components/calls/TrainingMarkDialog";
import {
  getTrainingRecordingLink, useTrainingCalls, type TrainingCall, type TrainingCategory, type TrainingFilters,
} from "@/hooks/useCalls";

/**
 * Training calls (the user, 2026-11-03: "mark a call for training … a new page for the training calls"; as in the Sales CRM) — every
 * call the Super Admin, the Sales Manager or a team leader marked, whoever made it: what it is an example of, why it
 * is worth hearing, and the recording, kept so it plays after 3CX deletes it. Open to every role until unticked; the
 * customer's number is never shown here.
 */
const PAGE = 30;

export default function TrainingCallsPage() {
  const [filters, setFilters] = useState<TrainingFilters>({ category: "all", person: "all", search: "" });
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<TrainingCall | null>(null);
  // The search waits for typing to stop.
  useEffect(() => {
    const t = setTimeout(() => { setFilters((f) => ({ ...f, search: typed })); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [typed]);
  const q = useTrainingCalls(filters, page, PAGE);
  const d = q.data;
  const total = d?.categories.reduce((t, c) => t + c.calls, 0) ?? 0;
  const set = (patch: Partial<TrainingFilters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const filtered = filters.category !== "all" || filters.person !== "all" || !!filters.search;
  const err = q.error as { response?: { data?: { message?: string } } } | null;

  return (
    <div className="space-y-5 pb-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Headphones className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground">Training calls</h1>
          <p className="text-sm text-muted-foreground">
            Calls picked to learn from — good examples, closings, handling objections, follow-ups, and what not to do. Listen, and hear why each was picked.
          </p>
        </div>
      </motion.div>

      {/* What they are examples of — and how many of each. */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Category">
        <Chip active={filters.category === "all"} onClick={() => set({ category: "all" })} label={`All · ${total}`} />
        {(d?.categories ?? []).map((c) => (
          <Chip key={c.key} active={filters.category === c.key} onClick={() => set({ category: c.key as TrainingCategory })}
            label={`${c.label} · ${c.calls}`} danger={c.key === "avoid"} />
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search the note, the lead, the salesperson…" className="pl-8" />
        </div>
        <Select value={filters.person} onValueChange={(v) => set({ person: v })}>
          <SelectTrigger className="w-full sm:w-[220px]"><SelectValue placeholder="Everyone" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {(d?.people ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name} · {p.calls}</SelectItem>)}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => { setTyped(""); setFilters({ category: "all", person: "all", search: "" }); setPage(1); }}>
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : q.isError ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {err?.response?.data?.message ?? "Couldn't load the training calls."}
        </div>
      ) : !d?.calls.length ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"><Headphones className="h-7 w-7 text-primary" /></div>
          <h3 className="mb-1 font-semibold text-foreground">{filtered ? "No training calls match" : "No training calls yet"}</h3>
          <p className="max-w-sm px-4 text-sm text-muted-foreground">
            {filtered ? "Try another category or clear the search." : "Team leaders, the Sales Manager and the Super Admin mark calls from the Calls page — “Mark for training” under a recording."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {d.calls.map((c, i) => (
            <motion.li key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.03 }}
              className="rounded-xl border border-border/50 bg-card p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <TrainingBadge category={c.training.category} />
                    <span className="text-sm font-semibold text-foreground">{c.userName || "Unknown"}</span>
                    {c.leadName && <span className="text-sm text-muted-foreground">with {c.leadName}</span>}
                  </div>
                  {c.training.note && <p className="border-l-2 border-primary/40 pl-3 text-sm text-foreground">{c.training.note}</p>}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <CallResult call={c} />
                    <span>{fmtWhen(c.startedAt)} GST</span>
                    {c.talkSeconds > 0 && <span>talk {fmtClockDuration(c.talkSeconds)}</span>}
                    <span>marked by {c.training.byName || "—"} · {fmtWhen(c.training.at)}</span>
                  </div>
                  {!c.training.saved && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                      Recording not kept yet — it plays from 3CX while 3CX has it.{d.canMark && c.training.copyError ? ` ${c.training.copyError}` : ""}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  <RecordingPlayer call={c} link={getTrainingRecordingLink} />
                  {d.canMark && (
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(c)} aria-label="Change or remove the mark">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </motion.li>
          ))}
        </ul>
      )}

      {d?.pagination && d.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Page {d.pagination.page} of {d.pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!d.pagination.hasPrevPage} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!d.pagination.hasNextPage} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {editing && <TrainingMarkDialog call={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Chip({ active, onClick, label, danger }: { active: boolean; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? danger ? "border-red-500 bg-red-500 text-white" : "border-primary bg-primary text-primary-foreground"
          : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}>
      {label}
    </button>
  );
}
