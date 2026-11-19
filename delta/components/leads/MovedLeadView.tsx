"use client";
import type { ReactNode } from "react";
import { ArrowLeft, Loader2, Send, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { moveError, useMovedLead, useUndoMoveToCrm } from "@/hooks/useCrmLeadMoves";

/*
 * A lead that was moved to another CRM (2026-11-19), shown where its page was: read only — where it went, who has it
 * there, its notes and history as they were — with Undo for 24 hours. Null when it was never moved (or this person
 * may not see moved leads): the `fallback` — the page's "Lead not found", as before.
 */
export function MovedLeadView({ leadId, mayMove, onBack, fallback }: { leadId: string; mayMove: boolean; onBack: () => void; fallback: ReactNode }) {
  const { data, isLoading } = useMovedLead(leadId, mayMove);
  const undo = useUndoMoveToCrm();
  if (!mayMove) return <>{fallback}</>;
  if (isLoading) return <div className="flex justify-center py-32"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  if (!data) return <>{fallback}</>;
  const l = data.lead;
  return (
    <div className="space-y-6 pb-10">
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 -ml-2"><ArrowLeft className="h-4 w-4" />Back to Leads</Button>
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Send className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div className="text-sm">
              <p className="font-semibold">Moved to {data.toName}{data.undoneAt ? " — undone" : ""}</p>
              <p className="text-muted-foreground">
                By {data.byName || "someone"}, {formatDateTime(data.at)}.{" "}
                {data.outcome === "repeat" ? `${data.toName} already had this number — with its team leader${data.holder ? ` (${data.holder})` : ""}.` : data.holder ? `${data.holder} has it there.` : "Given out by their split."}
                {" "}It was {data.ownerName || "nobody"}&apos;s, {l.status.replace(/_/g, " ")}.
              </p>
            </div>
          </div>
          {data.canUndo && (
            <Button size="sm" variant="outline" disabled={undo.isPending}
              onClick={() => undo.mutate(leadId, {
                onSuccess: () => toast.success("The lead is back here"),
                onError: (e) => toast.error(moveError(e, "Not undone")),
              })}>
              {undo.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Undo2 className="mr-1.5 h-4 w-4" />}Undo
            </Button>
          )}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2"><CardTitle className="text-lg">{l.name}</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <p><span className="text-muted-foreground">Phone</span> {l.phone}</p>
            {l.email && <p><span className="text-muted-foreground">Email</span> {l.email}</p>}
            {l.source && <p><span className="text-muted-foreground">Source</span> {l.source}</p>}
            {l.campaign && <p><span className="text-muted-foreground">Campaign</span> {l.campaign}</p>}
          </CardContent>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Notes</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {(l.notes ?? []).length ? [...(l.notes ?? [])].reverse().map((n, i) => (
                <div key={i} className="rounded-md border p-3">
                  <p className="whitespace-pre-wrap">{n.content}</p>
                  {n.createdAt && <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</p>}
                </div>
              )) : <p className="text-muted-foreground">No notes.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">History</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {[...(l.activityLogs ?? [])].reverse().map((a, i) => (
                <p key={i}><span className="text-xs text-muted-foreground">{a.createdAt ? formatDateTime(a.createdAt) : ""}</span> {a.description}</p>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
