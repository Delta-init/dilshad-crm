"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CalendarCheck, Plus, Clock, ChevronDown, ChevronUp, User, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useFollowUps, useAddFollowUp } from "@/hooks/useLeads";
import type { FollowUpEntry } from "@/hooks/useLeads";
import { ChangeFollowUpDate, toGstInput, fromGstInput } from "@/components/leads/ChangeFollowUpDate";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Dubai time, as every other date in the CRM (2026-10-22: this panel read and wrote India time, so a next follow-up
// typed as 3:00 pm was saved for 2:30 pm GST).
const toDatetimeLocal = toGstInput;

function formatGST(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " GST";
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function isOverdue(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

// ── Log form ──────────────────────────────────────────────────────────────────

interface LogFormProps {
  leadId: string;
  onCancel: () => void;
}

function LogForm({ leadId, onCancel }: LogFormProps) {
  const now = toDatetimeLocal(new Date().toISOString());
  const [note,            setNote]            = useState("");
  const [followedUpAt,    setFollowedUpAt]    = useState(now);
  const [nextFollowUpAt,  setNextFollowUpAt]  = useState("");
  const { mutate, isPending } = useAddFollowUp(leadId);

  function handleSave() {
    mutate(
      {
        note:           note.trim() || undefined,
        followedUpAt:   fromGstInput(followedUpAt).toISOString(),
        nextFollowUpAt: nextFollowUpAt
          ? fromGstInput(nextFollowUpAt).toISOString()
          : null,
      },
      { onSuccess: onCancel },
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Followed up at</Label>
          <Input
            type="datetime-local"
            value={followedUpAt}
            onChange={(e) => setFollowedUpAt(e.target.value)}
            className="text-xs h-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Next follow-up <span className="text-muted-foreground">(optional)</span></Label>
          <Input
            type="datetime-local"
            value={nextFollowUpAt}
            onChange={(e) => setNextFollowUpAt(e.target.value)}
            min={now}
            className="text-xs h-8"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Note <span className="text-muted-foreground">(optional)</span></Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What happened on this follow-up?"
          rows={2}
          className="text-xs resize-none"
          maxLength={1000}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={isPending}
          className="gap-1.5"
        >
          <CalendarCheck className="h-3.5 w-3.5" />
          {isPending ? "Logging…" : "Log Follow-Up"}
        </Button>
      </div>
    </motion.div>
  );
}

// ── Single follow-up entry ────────────────────────────────────────────────────

function FollowUpItem({ entry }: { entry: FollowUpEntry }) {
  const agentName = (entry.followedUpBy as { name: string } | string | undefined);
  const name = typeof agentName === "object" ? agentName?.name : agentName ?? "Agent";

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex gap-3"
    >
      {/* Timeline dot */}
      <div className="flex flex-col items-center gap-0 pt-1">
        <div className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>
      <div className="pb-4 min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-foreground">{formatGST(entry.followedUpAt)}</span>
          <span className="text-xs text-muted-foreground">{relativeTime(entry.followedUpAt)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <User className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{name}</span>
        </div>
        {entry.note && (
          <p className="mt-1 text-xs text-foreground/80 bg-muted/40 rounded px-2 py-1.5">
            {entry.note}
          </p>
        )}
        {entry.nextFollowUpAt && (
          <div className={cn(
            "mt-1.5 flex items-center gap-1.5 text-xs rounded px-2 py-1",
            isOverdue(entry.nextFollowUpAt)
              ? "bg-red-500/10 text-red-400 border border-red-500/20"
              : "bg-blue-500/10 text-blue-400 border border-blue-500/20",
          )}>
            {isOverdue(entry.nextFollowUpAt)
              ? <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              : <Clock className="h-3 w-3 flex-shrink-0" />}
            <span>Next: {formatGST(entry.nextFollowUpAt)}</span>
            {isOverdue(entry.nextFollowUpAt) && (
              <Badge variant="destructive" className="text-[10px] px-1 py-0 ml-auto">Overdue</Badge>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface FollowUpPanelProps {
  leadId: string;
  canEdit: boolean;
  /** In Follow Up with no date yet: the date can still be set from here. */
  leadInFollowUp?: boolean;
}

export function FollowUpPanel({ leadId, canEdit, leadInFollowUp = false }: FollowUpPanelProps) {
  const [showForm,    setShowForm]    = useState(false);
  const [showAll,     setShowAll]     = useState(false);

  const { data, isLoading } = useFollowUps(leadId);

  const followUps   = data?.followUps ?? [];
  const nextDue     = data?.nextFollowUpAt ?? null;
  const overdue     = isOverdue(nextDue);
  const PREVIEW     = 3;
  const visible     = showAll ? followUps : followUps.slice(-PREVIEW).reverse();
  const sorted      = [...followUps].sort(
    (a, b) => new Date(b.followedUpAt).getTime() - new Date(a.followedUpAt).getTime(),
  );
  const visibleSorted = showAll ? sorted : sorted.slice(0, PREVIEW);

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 flex-shrink-0">
            <CalendarCheck className="h-4 w-4 text-green-400" />
          </div>
          Follow-Ups
          <Badge variant="secondary" className="ml-1 text-xs font-normal">
            {followUps.length}
          </Badge>

          {nextDue && (
            <span className={cn(
              "ml-auto flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border",
              overdue
                ? "bg-red-500/10 text-red-400 border-red-500/20"
                : "bg-blue-500/10 text-blue-400 border-blue-500/20",
            )}>
              <Clock className="h-3 w-3" />
              {overdue ? "Overdue" : "Due"}: {formatGST(nextDue)}
            </span>
          )}

          {canEdit && (nextDue || leadInFollowUp) && (
            <ChangeFollowUpDate leadId={leadId} current={nextDue} className={nextDue ? "" : "ml-auto"} />
          )}

          {canEdit && !showForm && (
            <Button
              size="sm"
              variant="outline"
              className={cn("gap-1.5 text-xs h-7", !nextDue && !leadInFollowUp && "ml-auto")}
              onClick={() => setShowForm(true)}
            >
              <Plus className="h-3 w-3" />
              Log
            </Button>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <AnimatePresence>
          {showForm && canEdit && (
            <LogForm key="form" leadId={leadId} onCancel={() => setShowForm(false)} />
          )}
        </AnimatePresence>

        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/40" />
            ))}
          </div>
        )}

        {!isLoading && followUps.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No follow-ups logged yet.
          </p>
        )}

        {!isLoading && visibleSorted.length > 0 && (
          <div className="pl-1">
            {visibleSorted.map((entry) => (
              <FollowUpItem key={entry._id} entry={entry} />
            ))}
          </div>
        )}

        {followUps.length > PREVIEW && (
          <button
            type="button"
            onClick={() => setShowAll((p) => !p)}
            className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            {showAll ? (
              <><ChevronUp className="h-3.5 w-3.5" /> Show less</>
            ) : (
              <><ChevronDown className="h-3.5 w-3.5" /> Show all {followUps.length} follow-ups</>
            )}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

export default FollowUpPanel;
