"use client";

import type { Dispatch, SetStateAction } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Paperclip, Plus, Upload, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { listItemVariants } from "@/lib/animations";
import { fmtFull } from "@/lib/currency";
import { CURRENCIES } from "@/lib/store/currencyStore";
import { uploadReceipt } from "@/hooks/useStudents";
import { BASE_CURRENCY, ENROLMENT_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type StoredReceipt } from "@/types/student";

/*
 * The payments taken at a close, one row each (the user, 2026-10-05): a client
 * may pay part in cash and part by card, and each payment has its own method,
 * amount and receipt. The money already on the lead before the close is a row
 * of its own — its amount fixed, its method and receipt still asked, since
 * finance records every payment against the invoice with its proof.
 *
 * Each payment is in AED unless the client paid in another currency (the owner,
 * 2026-10-05): then the amount is typed in that currency with the rate — 1 of
 * it = so many AED — and the AED figure is worked out, or typed and the rate
 * worked out from it. The AED figure is what the payment counts as.
 *
 * A close for the Bangalore academy (2026-10-10) is in INR instead (`base`):
 * each payment in rupees, or cash taken in AED with its rate — 1 AED = so many
 * INR. The money already on the lead is in AED, so there it is always that:
 * its AED fixed, its rate asked, the rupees it comes to worked out.
 *
 * Rupees on a Dubai close (the user, 2026-10-13) take their rate the way it is
 * quoted — 1 AED = so many INR — and "INR Transfer" as the method picks INR;
 * the rate kept and sent stays 1 INR = so many AED, like every other currency's.
 */

export interface PaymentRow {
  id: string;
  method: string;
  /** In `currency`. */
  amountInput: string;
  receipt: StoredReceipt | null;
  /** What it was paid in — the academy's currency unless the client paid in another. */
  currency: string;
  /** Another currency: 1 of it = this many of the academy's (AED, or INR for Bangalore). */
  rateInput: string;
  /** Another currency: what it comes to in the academy's. */
  convertedInput: string;
  /** The money already on the lead before the close, as one payment. */
  collectedBefore?: boolean;
  /** Already added to the lead's payments, by an attempt that then failed — not added twice. */
  addedToLead?: boolean;
  uploading?: boolean;
  uploadError?: string;
}

export const MAX_PAYMENTS = 10;

/** What a close's money is in: AED (Dubai — the CRM's own) or INR (Bangalore). */
export type PaymentBase = "AED" | "INR";

/** AED first, then the app's other currencies; for a Bangalore close, INR — or cash in AED. */
const paymentCurrencies = (base: PaymentBase) =>
  base === BASE_CURRENCY ? [BASE_CURRENCY, ...CURRENCIES.map((c) => c.code).filter((c) => c !== BASE_CURRENCY)] : [base, BASE_CURRENCY];
const currencyLabel = (code: string) => CURRENCIES.find((c) => c.code === code)?.label ?? code;

let rowSeq = 0;
export const newPaymentRow = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  id: `payment-${++rowSeq}`,
  method: "",
  amountInput: "",
  receipt: null,
  currency: BASE_CURRENCY,
  rateInput: "",
  convertedInput: "",
  ...over,
});

/**
 * Paid in another currency than the academy's. On a Dubai close the money
 * already on the lead never is (it is AED); on a Bangalore one it always is.
 */
export const isForeign = (r: PaymentRow, base: PaymentBase = BASE_CURRENCY) =>
  r.currency !== base && (!r.collectedBefore || base !== BASE_CURRENCY);

const num = (s: string) => Math.max(0, Number(s) || 0);

/** Rupees on a Dubai close: their rate is typed as 1 AED = so many INR, the inverse of the one kept. */
const quotedPerAed = (r: Pick<PaymentRow, "currency">, base: PaymentBase) => base === BASE_CURRENCY && r.currency === "INR";
/** How much of the academy's currency one unit of the row's bought, from the rate as typed. */
const perUnit = (r: PaymentRow, base: PaymentBase, rateInput = r.rateInput) => {
  const rate = num(rateInput);
  return quotedPerAed(r, base) ? (rate > 0 ? 1 / rate : 0) : rate;
};
/** A Dubai INR row's rate as it is typed (1 AED = INR) from the one kept (1 INR = AED). */
export const rateInputFor = (currency: string, exchangeRate: number, base: PaymentBase = BASE_CURRENCY) =>
  quotedPerAed({ currency }, base) ? String(Number((1 / exchangeRate).toPrecision(8))) : String(exchangeRate);
/** Whole fils, as a plain number string. */
const toAedInput = (n: number) => String(Math.round(n * 100) / 100);
/** A rate worked out from two amounts, to ten significant figures. */
const toRateInput = (n: number) => String(Number(n.toPrecision(10)));

/** What the payment counts as, in the academy's currency — the converted figure when it was paid in another. */
export const rowAmount = (r: PaymentRow, base: PaymentBase = BASE_CURRENCY) => (isForeign(r, base) ? num(r.convertedInput) : num(r.amountInput));

/** For the close: what was handed over in another currency, and its rate — nothing when paid in the academy's. */
export function rowForeignFields(r: PaymentRow, base: PaymentBase = BASE_CURRENCY): { currency?: string; amountInCurrency?: number; exchangeRate?: number } {
  if (!isForeign(r, base)) return {};
  return { currency: r.currency, amountInCurrency: num(r.amountInput), exchangeRate: Number(perUnit(r, base).toPrecision(12)) };
}

/** "INR 50,000 at 1 INR = 0.044 AED" (or, on a Bangalore close, "AED 1,000 at 1 AED = 22.5 INR") — for the lead's payment note. */
export function describeForeign(r: PaymentRow, base: PaymentBase = BASE_CURRENCY): string {
  if (!isForeign(r, base)) return "";
  const paid = num(r.amountInput).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const rate = Number(num(r.rateInput).toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 10 });
  return quotedPerAed(r, base) ? `${r.currency} ${paid} at 1 ${base} = ${rate} ${r.currency}` : `${r.currency} ${paid} at 1 ${r.currency} = ${rate} ${base}`;
}

/**
 * What of a payment goes on the lead's own payment list — which is in AED and
 * is what the CRM's revenue figures add up. Dubai: the payment, in AED. A
 * Bangalore close: only cash handed over in AED, at its AED; rupees stay on
 * the enrolment. Null for nothing. The server writes the same on a correction.
 */
export function leadAmountOf(r: PaymentRow, base: PaymentBase = BASE_CURRENCY): number | null {
  if (base === BASE_CURRENCY) return rowAmount(r, base);
  return r.currency === BASE_CURRENCY && num(r.amountInput) > 0 ? num(r.amountInput) : null;
}

/** Each row as a new close starts it again once the academy changes: the method and receipt kept, the money asked afresh in its currency. */
export function rowsForBase(rows: PaymentRow[], base: PaymentBase): PaymentRow[] {
  return rows.map((r) =>
    r.collectedBefore
      ? { ...r, currency: BASE_CURRENCY, rateInput: "", convertedInput: "" }
      : { ...r, currency: base, amountInput: "", rateInput: "", convertedInput: "" },
  );
}

/** What each payment still needs, the way the close's "Still needed" line says it. */
export function missingInRows(rows: PaymentRow[], base: PaymentBase = BASE_CURRENCY): string[] {
  const one = rows.length === 1;
  return rows.flatMap((r, i) => {
    const whose = `payment ${i + 1}'s`;
    return [
      !r.method && (one ? "payment method" : `${whose} method`),
      !r.collectedBefore && !(num(r.amountInput) > 0) && (one ? "the amount paid" : `${whose} amount`),
      isForeign(r, base) && num(r.amountInput) > 0 && !(num(r.rateInput) > 0 && num(r.convertedInput) > 0) &&
        (one ? `the ${r.currency} rate` : `${whose} ${r.currency} rate`),
      !r.receipt && (one ? "payment receipt" : `${whose} receipt`),
    ].filter(Boolean) as string[];
  });
}

interface PaymentRowsEditorProps {
  leadId: string;
  rows: PaymentRow[];
  onChange: Dispatch<SetStateAction<PaymentRow[]>>;
  /** The academy's currency: AED (Dubai, the default) or INR (Bangalore). */
  base?: PaymentBase;
}

export function PaymentRowsEditor({ leadId, rows, onChange, base = BASE_CURRENCY }: PaymentRowsEditorProps) {
  const update = (id: string, patch: Partial<PaymentRow>) =>
    onChange((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // Another currency: the rate and the AED figure follow each other — whichever
  // was typed last works out the other; a new amount keeps the rate.
  // Rupees on a Dubai close: the typed rate is INR for 1 AED, so the AED is rupees ÷ rate.
  const rateFrom = (r: PaymentRow, paid: number, converted: number) => (quotedPerAed(r, base) ? paid / converted : converted / paid);
  function setAmount(r: PaymentRow, amountInput: string) {
    const paid = num(amountInput);
    if (!isForeign(r, base)) return update(r.id, { amountInput });
    if (num(r.rateInput) > 0) return update(r.id, { amountInput, convertedInput: paid > 0 ? toAedInput(paid * perUnit(r, base)) : "" });
    if (num(r.convertedInput) > 0 && paid > 0) return update(r.id, { amountInput, rateInput: toRateInput(rateFrom(r, paid, num(r.convertedInput))) });
    update(r.id, { amountInput });
  }
  function setRate(r: PaymentRow, rateInput: string) {
    const paid = num(r.amountInput);
    const unit = perUnit(r, base, rateInput);
    update(r.id, { rateInput, convertedInput: paid > 0 && unit > 0 ? toAedInput(paid * unit) : "" });
  }
  function setConverted(r: PaymentRow, convertedInput: string) {
    const paid = num(r.amountInput);
    const aed = num(convertedInput);
    update(r.id, { convertedInput, rateInput: paid > 0 && aed > 0 ? toRateInput(rateFrom(r, paid, aed)) : "" });
  }
  // A new currency starts its rate afresh: no feed is trusted for it, the seller enters it.
  const setCurrency = (r: PaymentRow, currency: string) => update(r.id, { currency, rateInput: "", convertedInput: "" });
  // "INR Transfer" is rupees: it picks INR for the row (on a Bangalore close, its own currency).
  function setMethod(r: PaymentRow, method: string) {
    if (method !== "inr_bank_account" || r.collectedBefore || r.currency === "INR") return update(r.id, { method });
    update(r.id, { method, currency: "INR", rateInput: "", convertedInput: "" });
  }

  async function attach(id: string, file: File) {
    update(id, { uploading: true, uploadError: "" });
    try {
      const receipt = await uploadReceipt(leadId, file);
      update(id, { receipt, uploading: false });
    } catch (e) {
      update(id, { uploading: false, uploadError: e instanceof Error ? e.message : "Could not upload that file" });
    }
  }

  const removable = rows.filter((r) => !r.collectedBefore).length > 1 || rows.some((r) => r.collectedBefore);

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {rows.map((r, i) => (
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2"
          >
            <div className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-[10px] font-semibold text-muted-foreground">{i + 1}.</span>
              <Select value={r.method} onValueChange={(v) => setMethod(r, v)}>
                <SelectTrigger className="h-8 w-[130px] shrink-0 text-xs" aria-label={`Payment ${i + 1} method`}>
                  <SelectValue placeholder="Paid by…" />
                </SelectTrigger>
                <SelectContent>
                  {ENROLMENT_PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">{PAYMENT_METHOD_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {r.collectedBefore ? (
                <div className="flex-1 text-xs">
                  {/* In AED, the lead's currency; on a Bangalore close its rate to INR is asked below. */}
                  <span className="font-semibold text-foreground">{base === BASE_CURRENCY ? fmtFull(rowAmount(r)) : `${BASE_CURRENCY} ${num(r.amountInput).toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">already on the lead</span>
                </div>
              ) : (
                <>
                  <Select value={r.currency} onValueChange={(v) => setCurrency(r, v)}>
                    <SelectTrigger className="h-8 w-[76px] shrink-0 text-xs" aria-label={`Payment ${i + 1} currency`}>
                      <SelectValue>{r.currency}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {paymentCurrencies(base).map((c) => (
                        <SelectItem key={c} value={c} className="text-xs">{currencyLabel(c)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number" min="0" step="0.01" value={r.amountInput}
                    onChange={(e) => setAmount(r, e.target.value)}
                    placeholder={isForeign(r, base) ? `Amount in ${r.currency}` : base === BASE_CURRENCY ? "Amount" : `Amount in ${base}`} className="h-8 min-w-0 flex-1 text-xs"
                    aria-label={`Payment ${i + 1} amount${isForeign(r, base) ? ` in ${r.currency}` : ""}`}
                  />
                </>
              )}
              {!r.collectedBefore && removable && (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onChange((prev) => prev.filter((x) => x.id !== r.id))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-red-400"
                  aria-label={`Remove payment ${i + 1}`}
                >
                  <X className="h-3.5 w-3.5" />
                </motion.button>
              )}
            </div>
            {/* Paid in another currency: the rate, and what it comes to in the academy's — the figure that counts. */}
            <AnimatePresence initial={false}>
              {isForeign(r, base) && (
                <motion.div
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  exit="hidden"
                  className="flex flex-wrap items-center gap-1.5 pl-7 text-[11px] text-muted-foreground"
                >
                  {/* Rupees on a Dubai close are quoted the other way round: 1 AED = so many INR. */}
                  <span>1 {quotedPerAed(r, base) ? base : r.currency} =</span>
                  <Input
                    type="number" min="0" step="any" value={r.rateInput}
                    onChange={(e) => setRate(r, e.target.value)}
                    placeholder="rate" className="h-7 w-24 text-xs"
                    aria-label={quotedPerAed(r, base) ? `Payment ${i + 1}: 1 ${base} in ${r.currency}` : `Payment ${i + 1}: 1 ${r.currency} in ${base}`}
                  />
                  <span>{quotedPerAed(r, base) ? r.currency : base} →</span>
                  <Input
                    type="number" min="0" step="0.01" value={r.convertedInput}
                    onChange={(e) => setConverted(r, e.target.value)}
                    placeholder={`in ${base}`} className="h-7 w-28 text-xs"
                    aria-label={`Payment ${i + 1} in ${base}`}
                  />
                  <span>{base}</span>
                </motion.div>
              )}
            </AnimatePresence>
            {r.receipt ? (
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card px-2.5 py-1.5">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <a href={r.receipt.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-xs hover:underline">
                  {r.receipt.name}
                </a>
                <button
                  type="button"
                  onClick={() => update(r.id, { receipt: null })}
                  className="text-[10px] text-muted-foreground hover:text-red-400"
                >
                  Replace
                </button>
              </div>
            ) : (
              <label
                className={cn(
                  "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground",
                  r.uploading && "pointer-events-none opacity-60",
                )}
              >
                <Upload className="h-3.5 w-3.5" />
                {r.uploading ? "Uploading…" : "Attach this payment's receipt — photo or PDF"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attach(r.id, f);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
            {r.uploadError && <p className="text-[10px] text-red-400">{r.uploadError}</p>}
          </motion.div>
        ))}
      </AnimatePresence>
      {rows.length < MAX_PAYMENTS && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => onChange((prev) => [...prev, newPaymentRow({ currency: base })])}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Add another payment
        </motion.button>
      )}
    </div>
  );
}
