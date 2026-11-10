"use client";
import { History, Loader2, Undo2 } from "lucide-react";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle, ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { transferError, useRecentTransfers, useUndoTransfer } from "@/hooks/useLeadTransfer";

/* Users → Recent transfers (2026-11-10): who moved whose leads to whom, and Undo for 24 hours. */
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function RecentTransfersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const q = useRecentTransfers(open);
  const undo = useUndoTransfer();
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 px-4 sm:px-0"><History className="h-5 w-5" />Recent lead transfers</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="px-4 sm:px-0">Undo works for 24 hours, on leads nobody has worked since.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-4 pb-4 text-sm sm:px-0 sm:pb-0">
          {q.isLoading ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
            : !q.data?.length ? <p className="text-muted-foreground">No transfers yet.</p>
            : q.data.map((t) => (
              <div key={t.id} className="flex items-start gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p><strong>{t.moved}</strong> of <strong>{t.from}</strong>&apos;s leads{t.reason === "remove" ? " (on removing them)" : ""}</p>
                  <p className="text-xs text-muted-foreground">→ {t.targets.filter((x) => x.count > 0).map((x) => `${x.name} ${x.count}${x.team ? ` (${x.team})` : ""}`).join(", ")}</p>
                  <p className="text-xs text-muted-foreground">by {t.by || "—"} · {when(t.createdAt)}{t.undoneAt ? ` · undone (${t.undone} back)` : ""}</p>
                </div>
                {t.mayUndo && (
                  <Button size="sm" variant="outline" disabled={undo.isPending}
                    onClick={() => undo.mutate(t.id, {
                      onSuccess: (u) => toast.success(`Undone: ${u.undone} back to ${t.from}${u.skipped ? ` (${u.skipped} already worked, kept)` : ""}`),
                      onError: (e) => toast.error(transferError(e, "Not undone")),
                    })}>
                    <Undo2 className="mr-1.5 h-4 w-4" />Undo
                  </Button>
                )}
              </div>
            ))}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
