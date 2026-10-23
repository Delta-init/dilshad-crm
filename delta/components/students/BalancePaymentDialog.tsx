"use client";

import { useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle,
  ResponsiveDialogDescription, ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { toast } from "@/lib/toast";
import { ENROLMENT_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/types/student";
import { uploadBalanceReceipt, fmtMinor, type RecordInput } from "@/hooks/useBalancePayments";

export const dubaiToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * A payment after the close, sent to finance with its receipt (the Balance payments page, 2026-10-13; the lead's
 * Payments panel, 2026-10-23). It waits for accounts there; approved, it is on the invoice, the LMS opens the rest of
 * the course and Tetra Commission's balance follows. `preset`: an existing lead payment being sent — its amount fixed.
 */
export function BalancePaymentDialog({ studentId, name, course, invoice, waitingMinor, preset, sending, send, onClose }: {
  studentId: string;
  name: string;
  course?: string;
  invoice: { number: string; currency: string; balanceMinor: number };
  waitingMinor: number;
  preset?: { amount: number; paidOn: string; note?: string };
  sending: boolean;
  /** Sends it; `done` closes the dialog once finance has it. Refused, the dialog stays open to fix it. */
  send: (input: RecordInput, done: () => void) => void;
  onClose: () => void;
}) {
  const room = Math.max(0, invoice.balanceMinor - waitingMinor) / 100;
  // One id for this payment while the dialog is open: Save pressed twice is one payment.
  const [key] = useState(newKey);
  const [amount, setAmount] = useState(preset ? String(preset.amount) : "");
  const [method, setMethod] = useState<string>("bank_transfer");
  const [paidOn, setPaidOn] = useState(preset?.paidOn && preset.paidOn <= dubaiToday() ? preset.paidOn : dubaiToday());
  const [note, setNote] = useState(preset?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const value = Number(amount);
  const problem = !amount ? "" : !(value > 0) ? "Enter the amount paid"
    : Math.abs(value * 100 - Math.round(value * 100)) > 1e-6 ? "At most 2 decimals"
    : value > room + 1e-9 ? `More than the ${fmtMinor(Math.round(room * 100), invoice.currency)} left` : "";
  const ready = value > 0 && !problem && method && paidOn && paidOn <= dubaiToday() && file;

  async function submit() {
    if (!ready || !file) return;
    setUploading(true);
    let receipt;
    try {
      receipt = await uploadBalanceReceipt(studentId, file);
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? "The receipt could not be uploaded");
      return;
    } finally {
      setUploading(false);
    }
    send({ key: key.replace(/[^A-Za-z0-9_-]/g, ""), amount: value, method, paidOn, receipt, ...(note.trim() ? { note: note.trim() } : {}) }, onClose);
  }

  const busy = uploading || sending;
  return (
    <ResponsiveDialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{preset ? "Send to finance" : "Record a payment"} — {name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {course ? `${course}` : "The course"}{invoice.number ? ` · ${invoice.number}` : ""} · {fmtMinor(invoice.balanceMinor, invoice.currency)} left
            {waitingMinor > 0 ? ` (${fmtMinor(waitingMinor, invoice.currency)} already waiting for finance)` : ""}.
            It goes to finance with the receipt and shows as pending until accounts approve it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 sm:px-0">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bp-amount">Amount ({invoice.currency})</Label>
              <Input id="bp-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amount} readOnly={!!preset}
                onChange={(e) => setAmount(e.target.value)} placeholder={String(room)} />
              {problem && <p className="text-[11px] text-red-400">{problem}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-date">Paid on</Label>
              <Input id="bp-date" type="date" max={dubaiToday()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>How it was paid</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENROLMENT_PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bp-receipt">Receipt (required)</Label>
            <label htmlFor="bp-receipt" className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary">
              <Paperclip className="h-4 w-4" />
              {file ? file.name : "Attach a photo or PDF of the receipt"}
            </label>
            <input id="bp-receipt" type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > 10 * 1024 * 1024) { toast.error("A receipt can be at most 10 MB"); return; }
                setFile(f);
              }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bp-note">Note (optional)</Label>
            <Textarea id="bp-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything accounts should know" />
          </div>
        </div>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!ready || busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? "Uploading receipt…" : sending ? "Sending…" : "Send to finance"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
