/**
 * One-off (the user, 2026-10-28): balance payments sent to finance for a Bangalore enrolment before keepOnLead marked
 * them were kept on the lead in rupees with nothing to say so, and every revenue figure counted them as dirhams —
 * about 22 times too much once finance approved them. This marks each such lead payment `currency: "INR"`, so the AED
 * sums leave it out and utils/bangaloreRevenue.ts counts it in AED at the Settings rate. The amount is not touched.
 *
 * Which: on a lead whose enrolment is for the Bangalore academy, a payment sent to finance (`finance.externalId`) and
 * not yet marked. Payments taken at the close, or on the lead before it, are AED and left alone.
 *
 * Dry run by default: lists them. With --write it saves the list to an undo file first, then marks them.
 *
 *   bun scripts/tag-bangalore-balance-payments.ts            # dry run, on the database in MONGODB_URI
 *   bun scripts/tag-bangalore-balance-payments.ts --write    # mark them (undo file written first)
 *
 * Undo: bun scripts/tag-bangalore-balance-payments.ts --undo <undo-file.json>
 */
import mongoose from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) { console.error("Set MONGODB_URI (the CRM's database)"); process.exit(1); }
const args = process.argv.slice(2);
const write = args.includes("--write");
const undoAt = args.indexOf("--undo");

await mongoose.connect(uri);
const db = mongoose.connection.db!;
const leads = db.collection("leads");

if (undoAt >= 0) {
  const file = args[undoAt + 1];
  if (!file) { console.error("--undo needs the undo file"); process.exit(1); }
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ leadId: string; paymentId: string }>;
  let n = 0;
  for (const r of rows) {
    const res = await leads.updateOne(
      { _id: new mongoose.Types.ObjectId(r.leadId) },
      { $unset: { "payments.$[p].currency": "" } },
      { arrayFilters: [{ "p._id": new mongoose.Types.ObjectId(r.paymentId) }] },
    );
    n += res.modifiedCount;
  }
  console.log(`Undo: unmarked ${n} of ${rows.length}.`);
  await mongoose.disconnect();
  process.exit(0);
}

const enrolled = await db.collection("students").find({ academy: "bangalore" }).project({ leadId: 1, name: 1 }).toArray();
const found: Array<{ leadId: string; paymentId: string; lead: string; amount: number; paidAt: string; state: string; note: string }> = [];
for (const s of enrolled) {
  const lead = await leads.findOne({ _id: s.leadId }, { projection: { name: 1, payments: 1 } });
  for (const p of lead?.payments ?? []) {
    if (!p?.finance?.externalId || p.currency) continue;
    found.push({
      leadId: String(lead!._id), paymentId: String(p._id), lead: String(lead!.name ?? s.name ?? ""),
      amount: Number(p.amount) || 0, paidAt: new Date(p.paidAt).toISOString().slice(0, 10), state: String(p.finance.state ?? "pending"), note: String(p.note ?? ""),
    });
  }
}

console.log(`${enrolled.length} Bangalore enrolments; ${found.length} balance payment(s) in rupees not yet marked:`);
for (const f of found) console.log(`  ${f.lead} · ₹${f.amount.toLocaleString("en-US")} · ${f.paidAt} · ${f.state} · ${f.note}`);

if (!write) {
  console.log("\nDry run — nothing changed. Add --write to mark them.");
  await mongoose.disconnect();
  process.exit(0);
}
if (!found.length) { console.log("Nothing to mark."); await mongoose.disconnect(); process.exit(0); }

const undoFile = `tag-bangalore-balance-payments-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(undoFile, JSON.stringify(found.map(({ leadId, paymentId }) => ({ leadId, paymentId })), null, 2));
console.log(`\nUndo file: ${undoFile}`);
let n = 0;
for (const f of found) {
  const res = await leads.updateOne(
    { _id: new mongoose.Types.ObjectId(f.leadId) },
    { $set: { "payments.$[p].currency": "INR" } },
    { arrayFilters: [{ "p._id": new mongoose.Types.ObjectId(f.paymentId), "p.currency": { $exists: false } }] },
  );
  n += res.modifiedCount;
}
console.log(`Marked ${n} of ${found.length}.`);
await mongoose.disconnect();
