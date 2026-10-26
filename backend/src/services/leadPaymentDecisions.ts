import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { type FinanceBalancePayment } from "./financeClient.js";
import { statusesFor } from "./leadFinancePaymentService.js";

/*
 * Finance's decision on each balance payment sent from a lead (the user, 2026-10-26: "it needs to show as a request,
 * then approve — only then it works; otherwise it shows as pending, not calculated"). Kept on the lead's payment
 * (`finance.state`), so it counts — revenue, leaderboard, reports (utils/countedPayments.ts) — once approved, and shows
 * as a request until then, or as rejected with finance's reason. Every two minutes: every lead with a sent payment not
 * decided yet — those sent before this, with no state, among them — asked of finance by its enrolment, in the
 * organization it was billed in. A decision is final: an approved or rejected payment is not asked about again.
 */

const UNDECIDED = { "finance.externalId": { $exists: true }, "finance.state": { $nin: ["approved", "rejected"] } };
const INTERVAL_MS = 120_000;
const BATCH = 200;

type LeadPayments = { _id: unknown; payments?: { _id: unknown; finance?: { externalId?: string; state?: string } | null }[] };

export async function syncLeadPaymentDecisions(): Promise<number> {
  const leads = await Lead.find({ payments: { $elemMatch: UNDECIDED } }).select("payments._id payments.finance").lean<LeadPayments[]>();
  let changed = 0;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const students = await Student.find({ leadId: { $in: batch.map((l) => l._id) } }).select("leadId academy").lean<{ _id: unknown; leadId: unknown; academy?: string }[]>();
    const handovers = await FinanceHandover.find({ studentId: { $in: students.map((s) => s._id) } })
      .select("studentId academy financeOrgId").lean<{ studentId: unknown; academy?: string; financeOrgId?: string }[]>();
    const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
    const statuses = await statusesFor(students.map((s) => ({ id: String(s._id), handover: handoverOf.get(String(s._id)) ?? null, academy: s.academy })));
    if (!statuses.length) continue;                       // finance away, or none of them there: next time
    const decisionOf = new Map<string, FinanceBalancePayment>(statuses.flatMap((st) => (st.balancePayments ?? []).map((b) => [b.externalId, b] as const)));

    for (const lead of batch) {
      for (const p of lead.payments ?? []) {
        const f = p.finance;
        if (!f?.externalId || f.state === "approved" || f.state === "rejected") continue;
        const b = decisionOf.get(f.externalId);
        if (!b || b.status === f.state) continue;          // finance doesn't know it (yet), or nothing new
        await Lead.updateOne(
          { _id: lead._id },
          {
            $set: {
              "payments.$[p].finance.state": b.status,
              ...(b.status !== "pending" ? { "payments.$[p].finance.decidedAt": b.decidedAt ? new Date(b.decidedAt) : new Date() } : {}),
              ...(b.reason ? { "payments.$[p].finance.reason": b.reason } : {}),
            },
          },
          { arrayFilters: [{ "p._id": p._id }] },
        );
        changed++;
      }
    }
  }
  return changed;
}

let running = false;
async function tick() {
  if (running) return;                                   // a slow pass is never overlapped by the next one
  running = true;
  try {
    const n = await syncLeadPaymentDecisions();
    if (n) console.log(`[leadPayments] ${n} balance payment decision(s) from finance kept on their leads`);
  } catch (err) {
    console.error("[leadPayments] tick error:", err);
  } finally {
    running = false;
  }
}

export function startLeadPaymentDecisionScheduler() {
  console.log("⏰ Balance payment decisions from finance — every 2 min");
  void tick();
  setInterval(tick, INTERVAL_MS);
}
