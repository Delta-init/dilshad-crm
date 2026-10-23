/**
 * READ ONLY (the user, 2026-10-23): every closed lead with a payment added on the lead after its enrolment went to
 * finance that finance never got — like Jasheer Parassery's AED 1,125 by POS, which left the invoice owing, the LMS
 * with half the course shut and Tetra Commission holding the bonus. Same rule as the lead page's "Not sent to
 * finance" tag (paymentStatesOf). Writes nothing to either database; asks finance what each close stands at.
 *
 *   bun --env-file=<sales CRM .env> scripts/lead-payments-not-in-finance.ts [--csv <file>]
 *
 * Each one is put right from the lead page: "Send to finance" on the payment, with its receipt.
 */
import { writeFileSync } from "node:fs";
import mongoose from "mongoose";

const argv = process.argv.slice(2);
const csvAt = argv.includes("--csv") ? argv[argv.indexOf("--csv") + 1] : undefined;
const uri = process.env.MONGODB_URI ?? "";
if (!uri) { console.error("No MONGODB_URI — pass the CRM's .env with --env-file"); process.exit(1); }

await mongoose.connect(uri, { readPreference: "secondaryPreferred" });
const { FinanceHandover } = await import("../src/models/FinanceHandover.js");
const { Student } = await import("../src/models/Student.js");
const { Lead } = await import("../src/models/Lead.js");
const { paymentStatesOf, statusesFor } = await import("../src/services/leadFinancePaymentService.js");

const handovers = await FinanceHandover.find({ status: "sent" }).select("studentId status academy financeOrgId sentAt resentAt").lean();
const students = await Student.find({ _id: { $in: handovers.map((h) => h.studentId) } }).select("leadId academy name enrollmentNumber assignedTo").populate("assignedTo", "name").lean();
const studentOf = new Map(students.map((s) => [String(s._id), s]));
const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId) } }).select("name phone payments").lean();
const leadOf = new Map(leads.map((l) => [String(l._id), l]));

const statuses = await statusesFor(handovers.flatMap((h) => {
  const s = studentOf.get(String(h.studentId));
  return s ? [{ id: String(s._id), handover: h as never, academy: s.academy as never }] : [];
}));
const statusOf = new Map(statuses.map((st) => [st.externalId, st]));
if (handovers.length && !statuses.length) console.warn("Finance gave no answer — is it reachable with this .env? Without it nothing counts as covered.");

const aed = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rows: Record<string, string | number>[] = [];
for (const h of handovers) {
  const s = studentOf.get(String(h.studentId));
  const lead = s ? leadOf.get(String(s.leadId)) : undefined;
  if (!s || !lead) continue;
  const st = statusOf.get(String(s._id));
  const states = paymentStatesOf((lead.payments ?? []) as never, h, st);
  for (const ps of states.filter((x) => x.state === "not_sent")) {
    const p = (lead.payments ?? []).find((x: any) => String(x._id) === ps.id) as any;
    rows.push({
      Client: lead.name ?? s.name ?? "",
      Enrolment: s.enrollmentNumber ?? "",
      "Closed by": (s.assignedTo as { name?: string } | null)?.name ?? "",
      Invoice: st?.invoiceNumber ?? "—",
      "Finance paid": st ? aed(st.amountPaidMinor / 100) : "—",
      "Finance still owed": st ? aed(st.balanceMinor / 100) : "—",
      "Payment on the lead": aed(Number(p?.amount) || 0),
      "Paid on": p?.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : "",
      Note: String(p?.note ?? "").slice(0, 60),
      "Lead id": String(lead._id),
    });
  }
}
await mongoose.disconnect();

console.log(`\n${handovers.length} closes in finance · ${rows.length} payment(s) on the lead that finance never got\n`);
if (rows.length) console.table(rows);
if (csvAt) {
  const head = Object.keys(rows[0] ?? { Client: "" });
  writeFileSync(csvAt, [head, ...rows.map((r) => head.map((k) => r[k] ?? ""))].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"));
  console.log(`Saved: ${csvAt}`);
}
process.exit(0);
