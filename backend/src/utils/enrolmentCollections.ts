import { Lead } from "../models/Lead.js";
import { PAYMENT_METHOD_LABELS, RUPEE_METHODS, isRupeeMethod } from "../types/index.js";

/*
 * The money actually received on each enrolment, payment by payment, with the day it came in (the user, 2026-10-31:
 * "that month collected payment only count" — for the closing book's Collected and for commission, a payment counts
 * in the month it was received, and never in another).
 *
 * In the enrolment's own currency, so it can be set against its fee:
 *   - a Dubai close: the lead's payments in AED, as every revenue figure counts them (utils/countedPayments.ts) —
 *     taken before the close, at it, and balance payments once finance approves them;
 *   - a Bangalore close: the rupees taken at the close (the enrolment's own list, those already on the lead before
 *     it left out), and its balance payments in rupees on the lead once approved.
 */

/**
 * `amount` in the enrolment's own currency (set against its fee).
 *
 * `inr` (the user, 2026-11-13: "INR payment only gets commission in INR"): the client handed it over in rupees — so
 * that share of the sale's commission is earned at the course's rupee amount (commissionService splitByCurrency).
 * Only where that was said: INR Transfer as the method, or a payment typed in INR with its rate at the close; never
 * guessed, and never for another currency the close takes (USD, EUR…) — that stays in AED. A Bangalore close's
 * payments are rupees unless taken in AED cash.
 *
 * Razorpay pays out in rupees (the owner, 2026-11-13): wherever INR Transfer is named here — as a payment's method
 * or in its note — Razorpay is taken the same, both asked of RUPEE_METHODS (types/index.ts).
 */
export type Collection = { paidAt: Date; amount: number; inr?: boolean };

/** The rupee methods as a note names them: "INR Transfer", "Razorpay". */
const RUPEE_LABELS = RUPEE_METHODS.map((m) => PAYMENT_METHOD_LABELS[m]);
/** A note that names one between its dots: "… · INR Transfer", "… · Razorpay · INR 12,800 at …". */
const namesRupeeMethod = (note: string) => note.split("·").slice(1).some((part) => RUPEE_LABELS.includes(part.trim()));

type StudentLike = {
  _id: unknown;
  leadId?: unknown;
  academy?: string;
  enrollmentDate?: Date;
  payments?: { amount?: number; paidAt?: Date; collectedBefore?: boolean; method?: string; currency?: string; amountInCurrency?: number }[];
};
type LeadPayment = {
  amount: number; paidAt: Date; currency?: string; method?: string; note?: string;
  finance?: { externalId?: string; state?: string; method?: string } | null;
};

const counts = (p: LeadPayment) => !p.finance?.externalId || p.finance.state === "approved";

/** A payment on the lead the close itself put there: "Collected at enrolment — <course> · <method>…". */
const fromTheClose = (p: LeadPayment) => /^Collected at enrolment\b/.test(p.note ?? "");
/**
 * …whose note says rupees: "· INR Transfer" as its method, or what was handed over in rupees after it — "· INR 12,800
 * at 1 AED = 25.6 INR" as the close dialog writes it, "· INR 12,800 at 1 INR = 0.039 AED" as a correction does. A
 * note in another currency ("· USD 500 at 1 USD = 3.67 AED") says nothing of rupees. "· Razorpay" says rupees as
 * "· INR Transfer" does (2026-11-13).
 */
const noteSaysRupees = (p: LeadPayment) => namesRupeeMethod(p.note ?? "") || /·\s*INR [\d,.]+ at 1 (INR|AED) = /.test(p.note ?? "");

/**
 * Which of a Dubai enrolment's payments on the lead were rupees. A balance payment, or one added on the lead, says so
 * by its method. One the close put there ("Collected at enrolment — <course> · <method>") says so too: by its method
 * where the close dialog kept it on the row (since 2026-10-23), or in its note — a corrected enrolment's rows are
 * written again with amount and note only. One that says neither (its note changed by hand) is matched to the
 * close's own rupee payments — INR Transfer, or typed in INR — by its amount, each once, and by its method where it
 * has one. Those that say so themselves are settled first, each using up its own payment at the close, so another
 * row of the same amount is never taken for rupees as well.
 */
function rupeeRows(s: StudentLike, pays: LeadPayment[]): Set<LeadPayment> {
  const left = (s.payments ?? [])
    .filter((p) => !p.collectedBefore && (isRupeeMethod(p.method) || p.currency === "INR"))
    .map((p) => ({ amount: p.amount ?? 0, method: p.method }));
  const take = (p: LeadPayment) => {
    const i = left.findIndex((c) => Math.abs(c.amount - p.amount) < 0.005 && (!p.method || p.method === c.method));
    if (i >= 0) left.splice(i, 1);
    return i >= 0;
  };
  const rupees = new Set<LeadPayment>();
  for (const p of pays) {
    const close = fromTheClose(p);
    if (isRupeeMethod(p.method) || isRupeeMethod(p.finance?.method) || (close && noteSaysRupees(p))) {
      rupees.add(p);
      if (close) take(p);
    }
  }
  for (const p of pays) if (!rupees.has(p) && fromTheClose(p) && take(p)) rupees.add(p);
  return rupees;
}

/** Each enrolment's payments received, oldest first, by student id. */
export async function collectionsOf(students: StudentLike[]): Promise<Map<string, Collection[]>> {
  const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId).filter(Boolean) } })
    .select("payments.amount payments.paidAt payments.currency payments.finance payments.method payments.note")
    .lean<{ _id: unknown; payments?: LeadPayment[] }[]>();
  const paysOf = new Map(leads.map((l) => [String(l._id), l.payments ?? []]));
  const out = new Map<string, Collection[]>();
  for (const s of students) {
    const pays = paysOf.get(String(s.leadId)) ?? [];
    const rupees = rupeeRows(s, pays);
    const list: Collection[] =
      s.academy === "bangalore"
        ? [
            ...(s.payments ?? [])
              .filter((p) => !p.collectedBefore && (p.amount ?? 0) > 0)
              // Rupees, unless it was cash taken in AED — `currency: "AED"` with what was handed over (2026-11-13).
              .map((p) => ({
                paidAt: new Date(p.paidAt ?? s.enrollmentDate ?? 0),
                amount: p.amount ?? 0,
                ...(p.currency === "AED" && (p.amountInCurrency ?? 0) > 0 ? {} : { inr: true }),
              })),
            ...pays.filter((p) => p.currency === "INR" && counts(p) && p.amount > 0).map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount, inr: true })),
          ]
        : pays.filter((p) => p.currency !== "INR" && counts(p) && p.amount > 0)
          .map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount, ...(rupees.has(p) ? { inr: true } : {}) }));
    out.set(String(s._id), list.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }
  return out;
}

/** What came in between two instants (inclusive). */
export const collectedBetween = (list: Collection[] | undefined, from: Date, to: Date): number =>
  Math.round((list ?? []).filter((c) => c.paidAt >= from && c.paidAt <= to).reduce((s, c) => s + c.amount, 0) * 100) / 100;
