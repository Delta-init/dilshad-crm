"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle,
  ResponsiveDialogDescription, ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { cn } from "@/lib/utils";
import { useChangeFollowUpDate } from "@/hooks/useLeads";

/*
 * Change a lead's next follow-up date (the user, 2026-10-22: "follow-up date editing we need") — from the Follow-ups
 * list on the Reminders page, the Today's Follow-ups pop-up and the lead's Follow-Ups panel. Dubai time, as every
 * other date here; the "Follow-up due" reminder moves with it (the API does that).
 */

/** An instant → the value of a datetime-local input, in Dubai time. */
export const toGstInput = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Dubai" }).slice(0, 16).replace(" ", "T");
/** A datetime-local value typed in Dubai time → the instant. */
export const fromGstInput = (v: string) => new Date(`${v}:00+04:00`);

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) + " GST";

interface Props {
  leadId: string;
  leadName?: string;
  current: string | null;
  /** The trigger's look: a small outline button (default) or a bare icon link for tight rows. */
  compact?: boolean;
  className?: string;
}

export function ChangeFollowUpDate({ leadId, leadName, current, compact, className }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const { mutate, isPending } = useChangeFollowUpDate(leadId);

  function start(e: React.MouseEvent) {
    // Beside a link to the lead in its rows: a click here never follows it.
    e.preventDefault();
    e.stopPropagation();
    const base = current && new Date(current).getTime() > Date.now() ? current : new Date(Date.now() + 3_600_000).toISOString();
    setValue(toGstInput(base));
    setNote("");
    setError("");
    setOpen(true);
  }

  function save() {
    const at = fromGstInput(value);
    if (!value || Number.isNaN(at.getTime())) { setError("Pick a date and time"); return; }
    if (at.getTime() <= Date.now() - 60_000) { setError("Pick a time in the future (GST)"); return; }
    mutate({ nextFollowUpAt: at.toISOString(), note: note.trim() || undefined }, { onSuccess: () => setOpen(false) });
  }

  return (
    <>
      {compact ? (
        <button type="button" onClick={start} title="Change the follow-up date"
          className={cn("inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground", className)}>
          <CalendarClock className="h-3 w-3" /> Change
        </button>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={start} className={cn("h-7 gap-1.5 text-xs", className)}>
          <CalendarClock className="h-3 w-3" /> Change date
        </Button>
      )}

      <ResponsiveDialog open={open} onOpenChange={(o) => { if (!isPending) setOpen(o); }}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Change follow-up date</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {leadName ? `${leadName} — ` : ""}{current ? `now ${fmt(current)}` : "no time set yet"}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <div className="space-y-3 px-4 sm:px-0">
            <div className="space-y-1">
              <Label className="flex items-center text-xs">
                Next follow-up <span className="ml-auto text-[10px] text-muted-foreground">GST (UTC+4)</span>
              </Label>
              <Input type="datetime-local" value={value} min={toGstInput(new Date().toISOString())}
                onChange={(e) => { setValue(e.target.value); setError(""); }} className="h-9 text-sm" />
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Why <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
                placeholder="e.g. Asked to call after 5 pm" className="resize-none text-sm" />
            </div>
          </div>
          <ResponsiveDialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
            <Button type="button" size="sm" onClick={save} disabled={isPending || !value}>{isPending ? "Saving…" : "Save"}</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

export default ChangeFollowUpDate;
