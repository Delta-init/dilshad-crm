"use client";

import { useState } from "react";
import { GraduationCap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogDescription, ResponsiveDialogFooter, ResponsiveDialogHeader, ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { TRAINING_CATEGORIES, TRAINING_LABEL, useTrainingMark, type TrainingCategory } from "@/hooks/useCalls";

/**
 * Mark a call for training (the user, 2026-11-03, as in the Sales CRM): what it is an example of, and why it is worth hearing — or no
 * longer a training call. The Super Admin, the Sales Manager and team leaders; the API checks it.
 */
export function TrainingMarkDialog({ call, onClose }: {
  call: { id: string; leadName?: string; userName?: string; training?: { category: TrainingCategory; note: string } | null };
  onClose: () => void;
}) {
  const [category, setCategory] = useState<TrainingCategory | null>(call.training?.category ?? null);
  const [note, setNote] = useState(call.training?.note ?? "");
  const mark = useTrainingMark();
  const marked = !!call.training;
  const fail = (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Couldn't save it");

  const save = () => {
    if (!category) return;
    mark.mutate({ callId: call.id, category, note: note.trim() }, {
      onSuccess: () => { toast.success(marked ? "Training call updated" : "Marked for training — on the Training calls page"); onClose(); },
      onError: fail,
    });
  };
  const remove = () =>
    mark.mutate({ callId: call.id, remove: true }, {
      onSuccess: () => { toast.success("No longer a training call"); onClose(); },
      onError: fail,
    });

  return (
    <ResponsiveDialog open onOpenChange={(o) => { if (!o && !mark.isPending) onClose(); }}>
      <ResponsiveDialogContent desktopClassName="max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-primary" /> {marked ? "Training call" : "Mark for training"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {[call.userName, call.leadName].filter(Boolean).join(" with ") || "This call"} — everyone can listen to it on the Training calls page.
            Its recording is kept, so it plays after 3CX deletes it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="space-y-4 px-4 sm:px-0">
          <div className="space-y-1.5">
            <Label className="text-xs">What it is an example of</Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Category">
              {TRAINING_CATEGORIES.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={category === k} onClick={() => setCategory(k)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    category === k
                      ? k === "avoid" ? "border-red-500 bg-red-500 text-white" : "border-primary bg-primary text-primary-foreground"
                      : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}>
                  {TRAINING_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="training-note" className="text-xs">Why it is worth hearing <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea id="training-note" value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Handles the price question, then asks for the close" className="text-sm" />
            <p className="text-right text-[10px] text-muted-foreground">{note.length}/1000</p>
          </div>
        </div>
        <ResponsiveDialogFooter className="gap-2 px-4 pb-4 sm:px-0 sm:pb-0">
          {marked && (
            <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" disabled={mark.isPending} onClick={remove}>
              Remove mark
            </Button>
          )}
          <Button variant="outline" disabled={mark.isPending} onClick={onClose}>Cancel</Button>
          <Button disabled={!category || mark.isPending} onClick={save}>
            {mark.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {marked ? "Save" : "Mark for training"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** A call's training mark, as a small badge — "Training · Closing". */
export function TrainingBadge({ category, onClick }: { category: TrainingCategory; onClick?: () => void }) {
  const cls = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
    category === "avoid" ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-primary/30 bg-primary/10 text-primary",
  );
  const body = <><GraduationCap className="h-3 w-3" /> Training · {TRAINING_LABEL[category]}</>;
  return onClick
    ? <button type="button" className={cn(cls, "hover:opacity-80")} onClick={onClick} title="Change or remove the mark">{body}</button>
    : <span className={cls}>{body}</span>;
}
