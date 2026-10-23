"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  DollarSign, Plus, Pencil, Trash2,
  TrendingUp, CircleDollarSign, Wallet, Calendar, AlertTriangle, Send, Landmark,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { Payment } from "@/types/lead";
import { useAddPayment, useUpdatePayment, useDeletePayment, useLeadPaymentFinance, useSendLeadPayment, type LeadFinanceLink } from "@/hooks/usePayments";
import { BalancePaymentDialog } from "@/components/students/BalancePaymentDialog";
import { fmtMinor } from "@/hooks/useBalancePayments";
import { toast } from "@/lib/toast";
import { useCurrencyStore } from "@/lib/store/currencyStore";
import { fmtCurrency, getCurrencySymbol } from "@/lib/currency";
import { toGstDateISO } from "@/lib/utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = fmtCurrency;

function toDateInput(iso: string) {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AE", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai",
  });
}

// ── Payment Form ─────────────────────────────────────────────────────────────

interface FormData { amount: string; note: string; paidAt: string }

interface PaymentFormProps {
  initial?: FormData;
  onSave: (d: FormData) => void;
  onCancel: () => void;
  saving: boolean;
}

function PaymentForm({ initial, onSave, onCancel, saving }: PaymentFormProps) {
  const today = toGstDateISO(new Date());
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [note,   setNote]   = useState(initial?.note   ?? "");
  const [paidAt, setPaidAt] = useState(initial?.paidAt ?? today);

  const valid = !!amount && Number(amount) > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3"
    >
      <div className="flex gap-2">
        {/* Amount */}
        <div className="flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">
            Amount ({getCurrencySymbol().trim()})
          </p>
          <Input
            type="number"
            min={0}
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
        {/* Date */}
        <div className="flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">Date paid</p>
          <Input
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <Textarea
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="text-sm resize-none min-h-[48px]"
        rows={2}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button
          size="sm"
          disabled={!valid || saving}
          onClick={() => onSave({ amount, note, paidAt })}
        >
          {saving ? "Saving…" : initial ? "Update" : "Add Payment"}
        </Button>
      </div>
    </motion.div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

/** Where a payment stands with finance, once the lead's close is there (2026-10-23). */
function FinanceTag({ state }: { state?: LeadFinanceLink["payments"][number] }) {
  if (!state || state.state === "with_close") return null;
  const tag = state.state === "not_sent"
    ? { text: "Not sent to finance", cls: "border-amber-500/40 bg-amber-500/10 text-amber-500" }
    : state.financeStatus === "approved"
      ? { text: `Approved by finance${state.receiptNumber ? ` · ${state.receiptNumber}` : ""}`, cls: "border-green-500/40 bg-green-500/10 text-green-500" }
      : state.financeStatus === "rejected"
        ? { text: `Rejected by finance${state.reason ? `: ${state.reason}` : ""}`, cls: "border-red-500/40 bg-red-500/10 text-red-400" }
        : { text: "With finance — waiting for approval", cls: "border-blue-500/40 bg-blue-500/10 text-blue-400" };
  return <span className={cn("mt-1 inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", tag.cls)}><Landmark className="h-3 w-3" />{tag.text}</span>;
}

interface PaymentPanelProps {
  leadId: string;
  /** For the send-to-finance dialog's title. */
  leadName?: string;
  /** Closed: its close may be in finance, and then payments go there (2026-10-23). */
  closed?: boolean;
  payments: Payment[];
  sellingAmount?: number;  // negotiated price for this lead (preferred)
  courseAmount?: number;   // fallback: total fee from the linked course
  canEdit: boolean;
}

export function PaymentPanel({ leadId, leadName, closed, payments, sellingAmount, courseAmount, canEdit }: PaymentPanelProps) {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const [adding,    setAdding]    = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId,  setDeleteId]  = useState<string | null>(null);

  const addMut    = useAddPayment(leadId);
  const updateMut = useUpdatePayment(leadId);
  const deleteMut = useDeletePayment(leadId);

  // Once the close is in finance, a payment here goes to finance with its receipt (2026-10-23) — a payment kept only
  // on the lead never reached the invoice, the LMS or Tetra Commission.
  const { data: link } = useLeadPaymentFinance(leadId, !!closed);
  const inFinance = !!link?.inFinance;
  const sendMut = useSendLeadPayment(leadId);
  const [sending, setSending] = useState<{ preset?: Payment } | null>(null);
  const stateOf = (id: string) => link?.payments.find((x) => x.id === id);
  const startAdd = () => {
    if (!inFinance) { setAdding(true); return; }
    if (!link?.canRecord) { toast.error(link?.whyNot || "A payment can't be sent to finance right now"); return; }
    setSending({});
  };
  const startSend = (p: Payment) => {
    if (!link?.canRecord) { toast.error(link?.whyNot || "It can't be sent to finance right now"); return; }
    setSending({ preset: p });
  };

  const sorted = [...payments].sort(
    (a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime(),
  );

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

  // sellingAmount takes priority over courseAmount for progress tracking
  const targetAmount = sellingAmount ?? courseAmount;
  const hasTotal     = targetAmount != null && targetAmount > 0;
  const pct          = hasTotal ? Math.min(100, (totalPaid / targetAmount!) * 100) : null;
  const remaining    = hasTotal ? targetAmount! - totalPaid : null;
  const isOverpaid   = hasTotal && totalPaid > targetAmount!;
  const overpaidBy   = isOverpaid ? totalPaid - targetAmount! : 0;

  // bar color based on %
  const barColor =
    pct == null     ? "bg-primary" :
    isOverpaid      ? "bg-red-500" :
    pct >= 100      ? "bg-green-500" :
    pct >= 50       ? "bg-blue-500"  :
                      "bg-amber-500";

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
            Payments
            {payments.length > 0 && (
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary">
                {payments.length}
              </span>
            )}
          </span>
          {canEdit && !adding && (
            <Button
              variant="ghost" size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={startAdd}
              title={inFinance ? "Send a payment to finance" : "Add a payment"}
            >
              <Plus className="h-4 w-4" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-3">

        {/* Summary strip */}
        {(payments.length > 0 || hasTotal) && (
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 space-y-2.5">
            {/* Overpaid alert */}
            {isOverpaid && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                <p className="text-xs font-medium text-red-400">
                  Overpaid by {fmt(overpaidBy)} — exceeds the selling price
                </p>
              </motion.div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-0.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Wallet className="h-3 w-3" /> Total Paid
                </p>
                <p className={cn("text-base font-bold", isOverpaid ? "text-red-400" : "text-green-400")}>
                  {fmt(totalPaid)}
                </p>
              </div>
              {hasTotal && (
                <>
                  <div className="space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" /> {isOverpaid ? "Overpaid" : "Remaining"}
                    </p>
                    <p className={cn(
                      "text-base font-bold",
                      isOverpaid ? "text-red-400" : remaining === 0 ? "text-green-400" : "text-amber-400",
                    )}>
                      {isOverpaid ? fmt(overpaidBy) : fmt(remaining!)}
                    </p>
                  </div>
                  <div className="col-span-2 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">
                        {sellingAmount != null ? "Selling price" : "Course fee"}: {fmt(targetAmount!)}
                      </span>
                      <span className={cn(
                        "font-semibold",
                        isOverpaid ? "text-red-400" : pct! >= 100 ? "text-green-400" : "text-foreground",
                      )}>
                        {pct!.toFixed(1)}% paid
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className={cn("h-full rounded-full", barColor)}
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, pct!)}%` }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* In finance: what it says, and where new payments go */}
        {inFinance && link?.invoice && (
          <p className="flex items-start gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-[11px] text-muted-foreground">
            <Landmark className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span>
              In finance as {link.invoice.number}: {fmtMinor(link.invoice.paidMinor, link.invoice.currency)} paid,{" "}
              {fmtMinor(link.invoice.balanceMinor, link.invoice.currency)} left
              {link.waitingMinor > 0 ? ` (${fmtMinor(link.waitingMinor, link.invoice.currency)} waiting for approval)` : ""}.
              New payments go to finance with their receipt.
            </span>
          </p>
        )}

        {/* Add form */}
        <AnimatePresence>
          {adding && (
            <PaymentForm
              onSave={(d) =>
                addMut.mutate(
                  { amount: Number(d.amount), note: d.note || undefined, paidAt: new Date(d.paidAt).toISOString() },
                  { onSuccess: () => setAdding(false) },
                )
              }
              onCancel={() => setAdding(false)}
              saving={addMut.isPending}
            />
          )}
        </AnimatePresence>

        {/* Empty state */}
        {sorted.length === 0 && !adding && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center gap-2 py-6 text-center"
          >
            <DollarSign className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">No payments recorded yet</p>
            {canEdit && (
              <Button variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={startAdd}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add payment
              </Button>
            )}
          </motion.div>
        )}

        {/* Payment list */}
        <AnimatePresence initial={false}>
          {sorted.map((p) => {
            const isEditing = editingId === p._id;
            return (
              <motion.div
                key={p._id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -10 }}
                layout
              >
                {isEditing ? (
                  <PaymentForm
                    initial={{
                      amount: String(p.amount),
                      note:   p.note ?? "",
                      paidAt: toDateInput(p.paidAt),
                    }}
                    onSave={(d) =>
                      updateMut.mutate(
                        {
                          paymentId: p._id,
                          data: { amount: Number(d.amount), note: d.note || undefined, paidAt: new Date(d.paidAt).toISOString() },
                        },
                        { onSuccess: () => setEditingId(null) },
                      )
                    }
                    onCancel={() => setEditingId(null)}
                    saving={updateMut.isPending}
                  />
                ) : (
                  <div className="rounded-xl border border-border/50 bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-bold text-green-400">{fmt(p.amount)}</span>
                          {pct != null && targetAmount != null && (
                            <span className="text-[10px] text-muted-foreground">
                              ({((p.amount / targetAmount) * 100).toFixed(1)}%)
                            </span>
                          )}
                        </div>
                        {p.note && (
                          <p className="text-xs text-muted-foreground leading-snug">{p.note}</p>
                        )}
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Calendar className="h-3 w-3" />
                          {formatDate(p.paidAt)}
                        </p>
                        <FinanceTag state={stateOf(p._id)} />
                        {canEdit && stateOf(p._id)?.state === "not_sent" && link?.invoice?.currency === "AED" && (
                          <Button variant="outline" size="sm" className="mt-1.5 h-7 gap-1 text-xs" onClick={() => startSend(p)}>
                            <Send className="h-3 w-3" /> Send to finance
                          </Button>
                        )}
                      </div>

                      {/* Sent to finance: it is finance's to change now. */}
                      {canEdit && !p.finance && (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Button
                            variant="ghost" size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            title="Edit"
                            onClick={() => setEditingId(p._id)}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-red-400"
                            title="Delete"
                            onClick={() => setDeleteId(p._id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </CardContent>

      {sending && link?.studentId && link.invoice && (
        <BalancePaymentDialog
          studentId={link.studentId}
          name={leadName || "this client"}
          invoice={link.invoice}
          waitingMinor={link.waitingMinor}
          preset={sending.preset ? { amount: sending.preset.amount, paidOn: toGstDateISO(new Date(sending.preset.paidAt)), note: sending.preset.note } : undefined}
          sending={sendMut.isPending}
          send={(input, done) => sendMut.mutate({ ...input, ...(sending.preset ? { paymentId: sending.preset._id } : {}) }, { onSuccess: done })}
          onClose={() => setSending(null)}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete payment?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) deleteMut.mutate(deleteId, { onSuccess: () => setDeleteId(null) });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
