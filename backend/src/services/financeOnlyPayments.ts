import { Types } from "mongoose";
import { env } from "../config/env.js";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { ENROLMENT_PAYMENT_METHODS } from "../types/index.js";
import { type BalanceFields, type EnrolmentStatus } from "./financeClient.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";

/*
 * Payments accounts record straight in finance, brought into the CRM (the user, 2026-11-25: "the finance accountant
 * will directly enter the balance payments, so if the full payment is done it will get the commission, and it will
 * reflect in the CRM also" — as in the Sales CRM). A client's last payment entered in finance left the invoice paid in
 * full there, but this CRM only ever heard of balance payments it sent itself — the enrolment kept it pending and the
 * commission waited for full payment for good.
 *
 * Every two minutes, every part-paid enrolment in finance is asked of finance:
 *   - money finance has that the enrolment doesn't — finance paid more than the enrolment says — is put on the lead
 *     as payments approved by finance, on finance's dates, with its tax invoice number ("Recorded in finance —
 *     TI-00072"), the latest first, as much as is missing; added to the enrolment as an approved balance payment is
 *     (applyApprovedBalances);
 *   - once finance says the invoice is paid in full and the enrolment has all of its money, the enrolment is paid in
 *     full at finance's fee — a fee lowered in finance, or a pending figure never brought down, no longer keeps it
 *     owing.
 * So what is pending, the fee status, the revenue figures and the commission (paid in full on the last payment) follow.
 *
 * Only payments finance dates on or after FINANCE_ONLY_PAYMENTS_FROM (the user: "only from November … October not
 * needed for now") — earlier money is left as the CRM has it, and an enrolment missing some of it stays owing.
 *
 * Never adds what is already there: a payment is kept under finance's own id for it, and once the enrolment has as
 * much as finance nothing is missing. Left alone while one of the lead's own balance payments is still waiting for
 * finance's decision — that one may be the money. Never throws for finance being away.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const METHODS = ENROLMENT_PAYMENT_METHODS as readonly string[];

/** What finance says of a close, with the payments and balance payments it adds for the Balance payments page. */
type Status = EnrolmentStatus & BalanceFields;
type FinancePayment = NonNullable<BalanceFields["payments"]>[number];
type LeadPay = { _id?: unknown; amount: number; currency?: string; finance?: { externalId?: string; state?: string } | null };
export type MissingPayment = { id: string; amountMinor: number; paidOn: string; method: string; receipt?: string };

/** The id a payment recorded in finance carries on the lead: finance's own id for it, else its receipt, else its day and amount. */
export const financeOnlyId = (studentId: string, p: FinancePayment) =>
  p.id ? `fin-${p.id}` : `fin-${studentId}-${p.taxInvoiceNumber || p.receiptNumber || `${p.paidOn}-${p.amountMinor}`}`;

/**
 * Which of finance's payments make up what the enrolment is missing: from `from` on only, the latest first, until it
 * is covered — the last one only for the part still missing. `fromCrm`: receipts of balance payments this CRM sent —
 * the enrolment has those already, so they are never the missing money.
 */
export function missingPayments(studentId: string, finPayments: FinancePayment[], missingMinor: number, from: string, fromCrm: Set<string> = new Set()): MissingPayment[] {
  const out: MissingPayment[] = [];
  let left = missingMinor;
  const newestFirst = [...finPayments]
    .filter((p) => p.amountMinor > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.paidOn ?? "") && p.paidOn.slice(0, 10) >= from && !(p.receiptNumber && fromCrm.has(p.receiptNumber)))
    .sort((a, b) => b.paidOn.localeCompare(a.paidOn));
  for (const p of newestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, p.amountMinor);
    const receipt = p.taxInvoiceNumber || p.receiptNumber;
    out.push({ id: financeOnlyId(studentId, p), amountMinor: take, paidOn: p.paidOn.slice(0, 10), method: p.method ?? "", ...(receipt ? { receipt } : {}) });
    left -= take;
  }
  return out;
}

export interface FinanceOnlyResult {
  /** Payments put on leads. */
  added: number;
  /** Enrolments made paid in full as finance has them. */
  paidInFull: number;
  /** What was found, for a script to show: per enrolment, what is missing and the payments for it. */
  found: {
    studentId: string; invoice?: string; crmPaid: number; financePaid: number; crmFee: number; financeFee: number; currency: string;
    payments: MissingPayment[]; paidInFull?: boolean; skipped?: string;
  }[];
}

/** Part-paid enrolments in finance — or only `studentIds` — checked against finance. `write: false` only reports. */
export async function syncFinanceOnlyPayments(opts: { studentIds?: string[]; write?: boolean; from?: string } = {}): Promise<FinanceOnlyResult> {
  const write = opts.write !== false;
  const from = opts.from ?? env.FINANCE_ONLY_PAYMENTS_FROM;
  const result: FinanceOnlyResult = { added: 0, paidInFull: 0, found: [] };
  const students = await Student.find(
    opts.studentIds?.length
      ? { _id: { $in: opts.studentIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) } }
      : { pendingAmount: { $gt: 0 } },
  ).select("leadId academy paidAmount pendingAmount totalFee assignedTo")
    .lean<{ _id: unknown; leadId?: unknown; academy?: string; paidAmount?: number; pendingAmount?: number; totalFee?: number; assignedTo?: unknown }[]>();
  if (!students.length) return result;
  const handovers = await FinanceHandover.find({ studentId: { $in: students.map((s) => s._id) }, status: "sent" })
    .select("studentId academy financeOrgId").lean<{ studentId: unknown; academy?: string; financeOrgId?: string }[]>();
  const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
  const inFinance = students.filter((s) => handoverOf.has(String(s._id)));
  if (!inFinance.length) return result;
  const statuses: Status[] = await fetchStatusesByOrg(
    inFinance.map((s) => String(s._id)),
    new Map(inFinance.map((s) => [String(s._id), orgOfHandover(handoverOf.get(String(s._id)) ?? null, s.academy)])),
  );
  const statusOf = new Map(statuses.map((st) => [st.externalId, st]));

  for (const s of inFinance) {
    const studentId = String(s._id);
    const st = statusOf.get(studentId);
    if (!st || st.status === "void") continue;            // finance away, or nothing to take from it
    const currency = s.academy === "bangalore" ? "INR" : "AED";
    const crmPaid = round2(s.paidAmount ?? 0);
    const crmFee = round2(s.totalFee ?? 0);
    const financePaid = round2((st.amountPaidMinor ?? 0) / 100);
    const financeFee = round2((st.totalMinor ?? 0) / 100);
    const missingMinor = Math.round(financePaid * 100) - Math.round(crmPaid * 100);
    const lastPaidOn = (st.payments ?? []).reduce((d, p) => ((p.paidOn ?? "") > d ? p.paidOn.slice(0, 10) : d), "");
    // Paid in full in finance, on a day this takes in, and the CRM still says something is owed.
    const fullInFinance = (st.balanceMinor ?? 0) <= 0 && financePaid > 0 && lastPaidOn >= from && (s.pendingAmount ?? 0) > 0;
    if (missingMinor <= 0 && !fullInFinance) continue;
    const row: FinanceOnlyResult["found"][number] = { studentId, invoice: st.invoiceNumber, crmPaid, financePaid, crmFee, financeFee, currency, payments: [] };
    result.found.push(row);
    if ((st.currency || "AED") !== currency) { row.skipped = `the invoice is in ${st.currency}, the enrolment in ${currency}`; continue; }
    if (!s.leadId) { row.skipped = "the enrolment has no lead"; continue; }
    const lead = await Lead.findById(s.leadId).select("payments assignedTo").lean<{ _id: unknown; payments?: LeadPay[]; assignedTo?: unknown }>();
    if (!lead) { row.skipped = "its lead is gone"; continue; }
    if ((lead.payments ?? []).some((p) => p.finance?.externalId && p.finance.state !== "approved" && p.finance.state !== "rejected")) {
      row.skipped = "one of the lead's balance payments is still waiting for finance";
      continue;
    }
    const fromCrm = new Set((st.balancePayments ?? []).map((b) => b.receiptNumber).filter((r): r is string => !!r));
    row.payments = missingMinor > 0 ? missingPayments(studentId, st.payments ?? [], missingMinor, from, fromCrm) : [];
    const bringsIn = row.payments.reduce((t, m) => t + m.amountMinor, 0);
    // All of finance's money is here once these are in — only then does the enrolment follow finance to paid in full.
    row.paidInFull = fullInFinance && Math.round(crmPaid * 100) + bringsIn >= Math.round(financePaid * 100);
    if (!row.payments.length && !row.paidInFull) { row.skipped = `the money missing was paid before ${from}`; continue; }
    if (!write) continue;

    const addedBy = lead.assignedTo ?? s.assignedTo;
    if (row.payments.length && !addedBy) { row.skipped = "nobody to put the payment under"; continue; }
    for (const m of row.payments) {
      const paidAt = new Date(`${m.paidOn}T00:00:00.000Z`);
      const payment = {
        _id: new Types.ObjectId(),
        amount: m.amountMinor / 100,
        note: `Recorded in finance${m.receipt ? ` — ${m.receipt}` : ""}`,
        paidAt,
        addedBy,
        finance: { externalId: m.id, method: m.method || "recorded in finance", sentAt: new Date(), state: "approved" as const, decidedAt: paidAt },
        ...(METHODS.includes(m.method) ? { method: m.method } : {}),
        ...(currency === "INR" ? { currency: "INR" } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      // Once only: not when the lead already has it (a pass run twice, or two at once).
      const r = await Lead.updateOne({ _id: lead._id, "payments.finance.externalId": { $ne: m.id } }, { $push: { payments: payment } });
      if (r.modifiedCount) result.added++;
    }
    if (row.paidInFull) {
      // As finance has it: its fee, all of it paid. The payments brought in are counted in it, so the pass that adds
      // approved balance payments to the enrolment leaves them be.
      const r = await Student.updateOne(
        { _id: s._id, pendingAmount: { $gt: 0 } },
        {
          $set: { totalFee: financeFee, paidAmount: financePaid, pendingAmount: 0, feeStatus: "paid" },
          ...(row.payments.length ? { $addToSet: { balanceApplied: { $each: row.payments.map((m) => m.id) } } } : {}),
        },
      );
      if (r.modifiedCount) result.paidInFull++;
    }
  }
  return result;
}
