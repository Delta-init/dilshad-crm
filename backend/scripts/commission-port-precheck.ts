/**
 * Before the collected-commission version goes live (2026-10-31): what it will change by itself, saved first.
 * READ ONLY — it never writes to the database; it writes one backup file.
 *
 *   1. enrolments the balance sync will move (leadPaymentDecisions.applyApprovedBalances, on its first tick): each
 *      with its paid / pending now and what it will become — check each by hand afterwards;
 *   2. commission records the sweep will put back in their own month (a "paid in full" month, where that was used);
 *   3. counted sales whose commission lines are all 0 (a course with no plan earns nothing — the page says so now);
 *   4. repeat leads given away although an enrolment exists (status reset after a close) — to restore by hand.
 *
 * The enrolments and commission records of 1 and 2 are saved, as they are now, to
 * ~/Downloads/<db>-commission-port-backup-<time>.json.
 *
 *   cd backend && bun scripts/commission-port-precheck.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) { console.error("MONGODB_URI is not set"); process.exit(1); }
await mongoose.connect(uri);
const db = mongoose.connection.db!;
console.log(`Database: ${mongoose.connection.host} / ${db.databaseName}   (read only)\n`);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── 1. The balance sync ─────────────────────────────────────────────────────
type LeadPay = { amount: number; currency?: string; finance?: { externalId?: string; state?: string } | null };
const leads = await db.collection("leads").find(
  { payments: { $elemMatch: { "finance.externalId": { $exists: true }, "finance.state": "approved" } } },
  { projection: { name: 1, payments: 1 } },
).toArray();
const students = await db.collection("students").find({ leadId: { $in: leads.map((l) => l._id) } }).toArray();
const studentOf = new Map(students.map((s) => [String(s.leadId), s]));
const willMove: { student: unknown; name: string; paid: number; pending: number; becomes: { paid: number; pending: number } }[] = [];
for (const lead of leads) {
  const st = studentOf.get(String(lead._id));
  if (!st) continue;
  const currency = st.academy === "bangalore" ? "INR" : "AED";
  const approved = ((lead.payments ?? []) as LeadPay[]).filter((p) => p.finance?.externalId && p.finance.state === "approved" && (p.currency ?? "AED") === currency && p.amount > 0);
  const fresh = approved.filter((p) => !((st.balanceApplied ?? []) as string[]).includes(String(p.finance!.externalId)));
  if (!fresh.length) continue;
  const atClose = Array.isArray(st.payments) && st.payments.length ? st.payments.reduce((s: number, p: { amount?: number }) => s + (p.amount || 0), 0) : null;
  const paidNow = Number(st.paidAmount) || 0;
  const paid = atClose === null
    ? round2(paidNow + fresh.reduce((s, p) => s + p.amount, 0))
    : Math.max(paidNow, round2(atClose + approved.reduce((s, p) => s + p.amount, 0)));
  const fee = Number(st.totalFee) || 0;
  willMove.push({ student: st._id, name: String(st.name ?? ""), paid: paidNow, pending: Number(st.pendingAmount) || 0, becomes: { paid, pending: Math.max(0, round2(fee - paid)) } });
}
console.log(`1. Enrolments the balance sync will update: ${willMove.length}`);
for (const w of willMove) console.log(`   ${w.name.slice(0, 30).padEnd(30)} paid ${w.paid} → ${w.becomes.paid}   pending ${w.pending} → ${w.becomes.pending}${w.becomes.paid === w.paid ? "   (no change: already typed in)" : ""}`);

// ── 2. Sales back to their own month ────────────────────────────────────────
const moved = await db.collection("commissionsales").find({ $or: [{ paidInFullAt: { $exists: true } }, { owed: { $exists: true } }] }).toArray();
console.log(`\n2. Commission records the sweep will put back in their sale's month: ${moved.length}`);
for (const s of moved) console.log(`   ${String(s.studentName ?? "").slice(0, 30).padEnd(30)} ${s.state}  month ${s.month}  sold ${new Date(s.saleDate).toISOString().slice(0, 10)}`);

// ── 3. Counted sales that earn nothing ──────────────────────────────────────
const zero = await db.collection("commissionsales").find({ state: "counted", saleDate: { $gte: new Date("2026-10-01T00:00:00+04:00") } }).toArray();
const nothing = zero.filter((s) => (s.lines ?? []).length && (s.lines as { amount?: number }[]).every((l) => !(Number(l.amount) > 0)));
console.log(`\n3. Counted sales whose lines are all 0 (no commission on the course's plan): ${nothing.length}`);
for (const s of nothing) console.log(`   ${String(s.studentName ?? "").slice(0, 30).padEnd(30)} ${String(s.courseName ?? "").slice(0, 40)}  ${s.month}`);

// ── 4. Repeat leads given away although enrolled ────────────────────────────
const decided = await db.collection("leads").find({ "repeat.decidedAt": { $ne: null }, status: { $ne: "closed" } }, { projection: { name: 1, status: 1, assignedTo: 1, "repeat.previousOwner": 1 } }).toArray();
const enrolled = new Set((await db.collection("students").find({ leadId: { $in: decided.map((l) => l._id) } }, { projection: { leadId: 1 } }).toArray()).map((s) => String(s.leadId)));
const lost = decided.filter((l) => enrolled.has(String(l._id)));
console.log(`\n4. Repeat leads given away although an enrolment exists: ${lost.length}`);
for (const l of lost) console.log(`   ${String(l.name ?? "").slice(0, 30).padEnd(30)} status ${l.status}  now ${l.assignedTo}  was ${l.repeat?.previousOwner}`);

// ── The backup ──────────────────────────────────────────────────────────────
const dir = path.join(os.homedir(), "Downloads");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${db.databaseName}-commission-port-backup-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify({
  at: new Date().toISOString(),
  students: students.filter((s) => willMove.some((w) => String(w.student) === String(s._id))),
  commissionSales: moved,
  repeatLeads: lost,
}, null, 2));
console.log(`\nBackup: ${file}`);
await mongoose.disconnect();
