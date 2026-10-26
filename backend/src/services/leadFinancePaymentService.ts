import { Types } from "mongoose";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { PAYMENT_METHOD_LABELS, type EnrolmentPaymentMethod } from "../types/index.js";
import { BalancePaymentService } from "./balancePaymentService.js";
import { type BalanceFields, type EnrolmentStatus as FinanceStatus, type FinanceBalancePayment } from "./financeClient.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";

/** What finance says of a close, with what it adds for the Balance payments page. */
type EnrolmentStatus = FinanceStatus & BalanceFields & { balancePayments?: FinanceBalancePayment[] };

/** Each close asked of the organization it was billed in (as the Balance payments page asks). */
export async function statusesFor(items: { id: string; handover?: Parameters<typeof orgOfHandover>[0] | null; academy?: string | null }[]): Promise<EnrolmentStatus[]> {
  return (await fetchStatusesByOrg(items.map((i) => i.id), new Map(items.map((i) => [i.id, orgOfHandover(i.handover ?? null, i.academy)])))) as EnrolmentStatus[];
}

/*
 * A lead's payments, once its close is in finance (the user, 2026-10-23: "why the second payment is not updated, and
 * course access is not given on the LMS, and the CS not got it"). A payment added on the lead page after the close
 * stayed in this CRM — finance never had it, so the invoice still owed, the LMS kept half the modules shut and Tetra
 * Commission held the bonus. From now on a payment on a closed lead is sent to finance with its receipt, as a balance
 * payment, and waits for accounts like one recorded on the Balance payments page. Payments added before this are
 * marked "Not sent to finance", with a Send to finance button.
 */

type Viewer = { userId: string; role?: Parameters<BalancePaymentService["inScope"]>[0]["role"] };
const balance = new BalancePaymentService();

/** A payment on the lead the close itself recorded ("Collected at enrolment — …"). */
const fromTheClose = (note?: string | null) => /^Collected at enrolment\b/.test(note ?? "");
const minor = (n: unknown) => Math.round((Number(n) || 0) * 100);

export type LeadPaymentState =
  /** Part of the close finance has: taken at the close, or on the lead before the enrolment was (last) sent. */
  | "with_close"
  /** Sent to finance as a balance payment — `financeStatus` says how far it has got. */
  | "sent"
  /** Added on the lead after the close and never sent: finance doesn't have it. */
  | "not_sent";

export interface LeadFinanceLink {
  /** Whether the lead's close is in finance — then a new payment must go there. */
  inFinance: boolean;
  studentId: string | null;
  reachable: boolean;
  invoice: { number: string; approval: string; status: string; currency: string; totalMinor: number; paidMinor: number; balanceMinor: number } | null;
  waitingMinor: number;
  canRecord: boolean;
  whyNot: string;
  payments: { id: string; state: LeadPaymentState; financeStatus?: FinanceBalancePayment["status"]; reason?: string; receiptNumber?: string }[];
}

/**
 * Which of a lead's payments finance has. A payment on the lead before the enrolment was last sent went with it (the
 * close counts them as collected before); one after, only if it was sent as a balance payment. If finance has as much
 * paid (or waiting) as the lead says, nothing is flagged — accounts may have recorded it themselves. Without finance's
 * answer (`status` undefined) nothing is "covered".
 */
export function paymentStatesOf(
  payments: { _id: unknown; amount: number; note?: string | null; paidAt: Date; createdAt?: Date; finance?: { externalId?: string } | null }[],
  handover: { status?: string | null; sentAt?: Date | null; resentAt?: Date | null } | null | undefined,
  status: EnrolmentStatus | undefined,
): LeadFinanceLink["payments"] {
  const inFinance = handover?.status === "sent";
  const bps = status?.balancePayments ?? [];
  const waitingMinor = bps.filter((b) => b.status === "pending").reduce((s, b) => s + (b.amountMinor || 0), 0);
  const cutoff = Math.max(
    handover?.sentAt ? new Date(handover.sentAt).getTime() : 0,
    handover?.resentAt ? new Date(handover.resentAt).getTime() : 0,
  );
  const byId = new Map(bps.map((b) => [b.externalId, b]));
  const leadTotal = payments.reduce((s, p) => s + minor(p.amount), 0);
  const covered = !!status && (status.amountPaidMinor ?? 0) + waitingMinor >= leadTotal;
  return payments.map((p) => {
    const id = String(p._id);
    if (p.finance?.externalId) {
      const b = byId.get(p.finance.externalId);
      return { id, state: "sent" as const, ...(b ? { financeStatus: b.status, ...(b.reason ? { reason: b.reason } : {}), ...(b.receiptNumber ? { receiptNumber: b.receiptNumber } : {}) } : {}) };
    }
    const at = new Date(p.createdAt ?? p.paidAt).getTime();
    const withClose = !inFinance || fromTheClose(p.note) || at <= cutoff || covered;
    return { id, state: withClose ? ("with_close" as const) : ("not_sent" as const) };
  });
}

async function closeOf(leadId: string) {
  if (!Types.ObjectId.isValid(leadId)) return null;
  const lead = await Lead.findById(leadId);
  if (!lead) return null;
  const student = await Student.findOne({ leadId: lead._id }).select("_id academy").lean();
  const handover = student
    ? await FinanceHandover.findOne({ studentId: student._id }).select("status academy financeOrgId sentAt resentAt").lean()
    : null;
  return { lead, student, handover };
}

/** The lead's close in finance, and where each of its payments stands. Never throws for finance being away. */
export async function leadFinanceLink(viewer: Viewer, leadId: string): Promise<LeadFinanceLink | null> {
  const c = await closeOf(leadId);
  if (!c) return null;
  const { lead, student, handover } = c;
  const inFinance = handover?.status === "sent";
  const studentId = student ? String(student._id) : null;
  let status: EnrolmentStatus | undefined;
  let reachable = true;
  if (inFinance && studentId) {
    const got = await statusesFor([{ id: studentId, handover, academy: student?.academy }]);
    status = got.find((s) => s.externalId === studentId);
    reachable = got.length > 0;
  }
  const bps = status?.balancePayments ?? [];
  const waitingMinor = bps.filter((b) => b.status === "pending").reduce((s, b) => s + (b.amountMinor || 0), 0);
  const balanceMinor = status?.balanceMinor ?? 0;
  const mayAct = studentId ? await balance.inScope(viewer, studentId) : false;
  const whyNot = !inFinance
    ? "Not in finance yet"
    : !status
      ? reachable ? "Finance has no invoice for this close" : "Finance could not be reached — try again"
      : status.status === "void"
        ? "The invoice is void"
        : status.approval !== "approved"
          ? "Finance hasn't approved this enrolment yet"
          : balanceMinor <= 0
            ? "Paid in full"
            : waitingMinor >= balanceMinor
              ? "The rest is already waiting for finance"
              : !mayAct
                ? "Only its closer, their team leader, the Sales Manager or a Super Admin can send payments for it"
                : "";

  const payments = paymentStatesOf(lead.payments, handover, status);

  return {
    inFinance,
    studentId,
    reachable,
    invoice: status
      ? { number: status.invoiceNumber, approval: status.approval, status: status.status, currency: status.currency, totalMinor: status.totalMinor, paidMinor: status.amountPaidMinor, balanceMinor }
      : null,
    waitingMinor,
    canRecord: !whyNot,
    whyNot,
    payments,
  };
}

/** Whether a payment may be added to the lead without finance: no — once its close is in finance. */
export async function closeIsInFinance(leadId: string): Promise<boolean> {
  const c = await closeOf(leadId);
  return c?.handover?.status === "sent";
}

/**
 * A payment on a closed lead, sent to finance (the Balance payments page's checks and request), then kept on the
 * lead, marked as sent. With `paymentId`, an existing lead payment not sent before is sent — its amount as it is.
 * Sending the same form twice is one payment (finance keys it on `key`, the lead on the external id).
 */
export async function sendLeadPayment(viewer: Viewer, leadId: string, body: Record<string, unknown>) {
  const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
  const c = await closeOf(leadId);
  if (!c) throw fail(404, "Lead not found");
  const { lead, student, handover } = c;
  if (!student || handover?.status !== "sent") throw fail(409, "This lead's enrolment isn't in finance yet");

  const paymentId = typeof body.paymentId === "string" && body.paymentId ? body.paymentId : null;
  const existing = paymentId ? lead.payments.id(paymentId) : null;
  if (paymentId && !existing) throw fail(404, "Payment not found");
  if (existing?.finance?.externalId) throw fail(409, "This payment was sent to finance already");
  if (existing && minor(body.amount) !== minor(existing.amount)) throw fail(400, "Send the payment's own amount — change it on the lead first if it is wrong");

  const sent = await balance.record(viewer, String(student._id), body);
  // The finance write came first: a retry after a failure here finds the payment already with finance (same key)
  // and only records it on the lead.
  await keepOnLead(lead._id, viewer, body, sent?.externalId ?? `bp-${String(body.key ?? "")}`, paymentId);
  return sent;
}

/**
 * A balance payment sent to finance, kept on its lead as a request — pending, counted nowhere until finance approves it
 * (2026-10-26: leadPaymentDecisions.ts keeps the decision). From the lead's Payments panel, or since 2026-10-26 the
 * Balance payments page too, which used to leave the lead without it. Once only: the external id is finance's key.
 */
export async function keepOnLead(leadId: unknown, viewer: Viewer, body: Record<string, unknown>, externalId: string, paymentId?: string | null): Promise<void> {
  const fresh = await Lead.findById(leadId);
  if (!fresh || fresh.payments.some((p) => p.finance?.externalId === externalId)) return;
  const method = String(body.method ?? "");
  const finance = { externalId, method, sentAt: new Date(), state: "pending" as const };
  const target = paymentId ? fresh.payments.id(paymentId) : null;
  if (target) target.finance = finance;
  else {
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : `Balance payment · ${PAYMENT_METHOD_LABELS[method as EnrolmentPaymentMethod] ?? method}`;
    fresh.payments.push({ amount: Number(body.amount), note, paidAt: new Date(String(body.paidOn)), addedBy: new Types.ObjectId(viewer.userId), finance } as never);
  }
  await fresh.save();
}
