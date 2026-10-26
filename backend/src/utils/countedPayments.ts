/*
 * Which of a lead's payments count — revenue, the leaderboard, reports, team pages, exports, daily targets (the user,
 * 2026-10-26: a balance payment from the CRM "shows as a request; only once approved does it work, otherwise pending,
 * not calculated"). A payment sent to finance as a balance payment (`finance.externalId`) counts once finance approves
 * it (`finance.state`, kept by leadPaymentDecisions.ts); pending or rejected, it is shown on the lead and counted
 * nowhere. Every other payment — taken at the close, or on the lead before its close was in finance — counts as before.
 */

/** After `{ $unwind: "$payments" }`: only the payments that count. */
export const COUNTED_PAYMENT = {
  $or: [{ "payments.finance.externalId": { $exists: false } }, { "payments.finance.state": "approved" }],
};

/** A lead's payments that count, as an expression over its `payments` array. */
export const COUNTED_PAYMENTS = {
  $filter: {
    input: { $ifNull: ["$payments", []] },
    as: "p",
    cond: { $or: [{ $eq: [{ $ifNull: ["$$p.finance.externalId", null] }, null] }, { $eq: ["$$p.finance.state", "approved"] }] },
  },
};

/** What a lead's payments that count add up to — where `{ $sum: "$payments.amount" }` summed the whole array. */
export const COUNTED_TOTAL = { $sum: { $map: { input: COUNTED_PAYMENTS, as: "p", in: "$$p.amount" } } };

/** The same rule, for a payment in hand. */
export function isCountedPayment(p: { finance?: { externalId?: string | null; state?: string | null } | null }): boolean {
  return !p.finance?.externalId || p.finance.state === "approved";
}
