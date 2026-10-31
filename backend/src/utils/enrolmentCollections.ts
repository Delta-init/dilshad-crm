import { Lead } from "../models/Lead.js";

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

export type Collection = { paidAt: Date; amount: number };

type StudentLike = {
  _id: unknown;
  leadId?: unknown;
  academy?: string;
  enrollmentDate?: Date;
  payments?: { amount?: number; paidAt?: Date; collectedBefore?: boolean }[];
};
type LeadPayment = { amount: number; paidAt: Date; currency?: string; finance?: { externalId?: string; state?: string } | null };

const counts = (p: LeadPayment) => !p.finance?.externalId || p.finance.state === "approved";

/** Each enrolment's payments received, oldest first, by student id. */
export async function collectionsOf(students: StudentLike[]): Promise<Map<string, Collection[]>> {
  const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId).filter(Boolean) } })
    .select("payments.amount payments.paidAt payments.currency payments.finance")
    .lean<{ _id: unknown; payments?: LeadPayment[] }[]>();
  const paysOf = new Map(leads.map((l) => [String(l._id), l.payments ?? []]));
  const out = new Map<string, Collection[]>();
  for (const s of students) {
    const pays = paysOf.get(String(s.leadId)) ?? [];
    const list: Collection[] =
      s.academy === "bangalore"
        ? [
            ...(s.payments ?? [])
              .filter((p) => !p.collectedBefore && (p.amount ?? 0) > 0)
              .map((p) => ({ paidAt: new Date(p.paidAt ?? s.enrollmentDate ?? 0), amount: p.amount ?? 0 })),
            ...pays.filter((p) => p.currency === "INR" && counts(p) && p.amount > 0).map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount })),
          ]
        : pays.filter((p) => p.currency !== "INR" && counts(p) && p.amount > 0).map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount }));
    out.set(String(s._id), list.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }
  return out;
}

/** What came in between two instants (inclusive). */
export const collectedBetween = (list: Collection[] | undefined, from: Date, to: Date): number =>
  Math.round((list ?? []).filter((c) => c.paidAt >= from && c.paidAt <= to).reduce((s, c) => s + c.amount, 0) * 100) / 100;
