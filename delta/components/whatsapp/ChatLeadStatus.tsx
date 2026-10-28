"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LEAD_STATUSES, STATUS_META, type LeadStatus } from "@/lib/statusConfig";
import { LOST_REASONS } from "@/components/leads/LostReasonModal";
import { useUpdateLeadStatus } from "@/hooks/useLeads";
import { toast } from "@/lib/toast";

/*
 * The lead's status, changed from its WhatsApp chat (2026-10-28: "a tag for the lead in here") — as on the lead page
 * (PATCH /leads/:id/status): Follow Up asks what was said and when next, Meeting Scheduled when, Lost why. Closed is
 * the close form on the lead page (it goes to finance), so it opens the lead.
 */
const NEEDS_DETAILS = new Set<LeadStatus>(["followup", "meeting_scheduled", "lost"]);
const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function ChatLeadStatus({ lead }: { lead: { id: string; status: string } }) {
  const qc = useQueryClient();
  const update = useUpdateLeadStatus();
  const [asking, setAsking] = useState<LeadStatus | null>(null);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState("");

  const done = () => { setAsking(null); setNote(""); setWhen(""); setReason(""); void qc.invalidateQueries({ queryKey: ["whatsapp"] }); };
  const send = async (status: LeadStatus, extra: Record<string, string | undefined> = {}) => {
    try { await update.mutateAsync({ id: lead.id, status, ...extra }); done(); } catch { /* the hook says why */ }
  };
  const pick = (v: string) => {
    const s = v as LeadStatus;
    if (s === lead.status) return;
    if (NEEDS_DETAILS.has(s)) { setAsking(s); setWhen(s === "meeting_scheduled" ? localInput(new Date(Date.now() + 3600_000)) : ""); return; }
    void send(s);
  };
  const confirm = () => {
    if (asking === "followup") {
      if (!note.trim()) { toast.error("Write what was said"); return; }
      void send("followup", { followUpNote: note, followUpAt: new Date().toISOString(), nextFollowUpAt: when ? new Date(when).toISOString() : undefined });
    } else if (asking === "meeting_scheduled") {
      if (!when) { toast.error("Pick when the meeting is"); return; }
      void send("meeting_scheduled", { meetingAt: new Date(when).toISOString(), meetingNote: note || undefined });
    } else if (asking === "lost") {
      if (!reason || !note.trim()) { toast.error("Pick why, and write a note"); return; }
      void send("lost", { lostReason: reason, lostNotes: note });
    }
  };

  const current = STATUS_META[lead.status as LeadStatus];
  return (
    <>
      <Select value={lead.status} onValueChange={pick} disabled={update.isPending}>
        <SelectTrigger className="h-8 w-40 text-xs" aria-label="Lead status">
          {update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SelectValue placeholder={current?.label ?? lead.status} />}
        </SelectTrigger>
        <SelectContent>
          {LEAD_STATUSES.filter((s) => s !== "closed").map((s) => <SelectItem key={s} value={s} className="text-xs">{STATUS_META[s].label}</SelectItem>)}
          {lead.status === "closed" && <SelectItem value="closed" className="text-xs">{STATUS_META.closed.label}</SelectItem>}
        </SelectContent>
      </Select>
      {lead.status !== "closed" && (
        <Link href={`/leads/${lead.id}`} className="hidden text-xs text-primary hover:underline lg:block" title="Closing is the close form on the lead page">Close it…</Link>
      )}

      <Dialog open={!!asking} onOpenChange={(o) => { if (!o) setAsking(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{asking ? STATUS_META[asking].label : ""}</DialogTitle>
            <DialogDescription>
              {asking === "followup" ? "What was said, and when to follow up next." : asking === "meeting_scheduled" ? "When the meeting is — it becomes a reminder." : "Why the lead is lost."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {asking === "lost" && (
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger><SelectValue placeholder="Why…" /></SelectTrigger>
                <SelectContent>{LOST_REASONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {(asking === "followup" || asking === "meeting_scheduled") && (
              <label className="block text-xs text-muted-foreground">
                {asking === "followup" ? "Next follow-up (optional)" : "Meeting"}
                <Input type="datetime-local" className="mt-1" value={when} onChange={(e) => setWhen(e.target.value)} />
              </label>
            )}
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={asking === "followup" ? "What the client said" : asking === "lost" ? "Notes" : "Note (optional)"} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>Cancel</Button>
            <Button onClick={confirm} disabled={update.isPending}>{update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
