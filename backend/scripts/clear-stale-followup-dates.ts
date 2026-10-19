/**
 * One-off clean-up (the user, 2026-10-20): leads that moved on from Follow Up (to MIA, Not connected, …) before the
 * lead model started clearing it (leadFollowUpDate.ts) still carry their old next follow-up date, so Today's
 * Follow-ups shows them as overdue every day. This clears that date — and its missed-warning stamp — on leads that are
 * NOT in Follow Up and whose date is already past. A future date on another status (set by Log follow-up) is left alone.
 *
 * Dry run by default: says how many and whose. With --write it first saves every lead's old values to an undo file,
 * then clears them.
 *
 *   bun scripts/clear-stale-followup-dates.ts            # dry run, on the database in .env (MONGODB_URI)
 *   bun scripts/clear-stale-followup-dates.ts --write    # clear them (undo file written first)
 *
 * Undo: bun scripts/clear-stale-followup-dates.ts --undo <undo-file.json>
 */
import mongoose from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) { console.error("Set MONGODB_URI (the CRM's database)"); process.exit(1); }
const args = process.argv.slice(2);
const write = args.includes("--write");
const undoAt = args.indexOf("--undo");

await mongoose.connect(uri);
const leads = mongoose.connection.db!.collection("leads");

if (undoAt >= 0) {
  const file = args[undoAt + 1];
  if (!file) { console.error("--undo needs the undo file"); process.exit(1); }
  const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ _id: string; nextFollowUpAt: string | null; missedFollowUpWarnedAt: string | null }>;
  let n = 0;
  for (const r of rows) {
    const res = await leads.updateOne({ _id: new mongoose.Types.ObjectId(r._id), nextFollowUpAt: null }, {
      $set: { nextFollowUpAt: r.nextFollowUpAt ? new Date(r.nextFollowUpAt) : null, missedFollowUpWarnedAt: r.missedFollowUpWarnedAt ? new Date(r.missedFollowUpWarnedAt) : null },
    });
    n += res.modifiedCount;
  }
  console.log(`Undo: put back ${n} of ${rows.length} (a lead given a new date since is left as it is).`);
  await mongoose.disconnect();
  process.exit(0);
}

const now = new Date();
const filter = { status: { $ne: "followup" }, nextFollowUpAt: { $ne: null, $lt: now } };
const stale = await leads.find(filter, { projection: { name: 1, status: 1, assignedTo: 1, nextFollowUpAt: 1, missedFollowUpWarnedAt: 1 } }).toArray();
const users = await mongoose.connection.db!.collection("users").find({ _id: { $in: [...new Set(stale.map((l) => l.assignedTo).filter(Boolean))] } }, { projection: { name: 1 } }).toArray();
const nameOf = new Map(users.map((u) => [String(u._id), String(u.name)]));
const byOwner = new Map<string, number>(), byStatus = new Map<string, number>();
for (const l of stale) {
  const o = l.assignedTo ? nameOf.get(String(l.assignedTo)) ?? "Unknown" : "Not assigned";
  byOwner.set(o, (byOwner.get(o) ?? 0) + 1);
  byStatus.set(String(l.status), (byStatus.get(String(l.status)) ?? 0) + 1);
}
console.log(`${stale.length} leads not in Follow Up with a past follow-up date.`);
console.log("By status:", Object.fromEntries([...byStatus].sort((a, b) => b[1] - a[1])));
console.log("By owner:", Object.fromEntries([...byOwner].sort((a, b) => b[1] - a[1])));
for (const l of stale.slice(0, 15)) console.log(`  - ${l.name} | ${l.status} | ${new Date(l.nextFollowUpAt).toISOString().slice(0, 16)} | ${l.assignedTo ? nameOf.get(String(l.assignedTo)) ?? "?" : "-"}`);

if (!write) {
  console.log("\nDry run — nothing changed. Run again with --write to clear them.");
} else if (stale.length) {
  const file = `stale-followup-dates-undo-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(stale.map((l) => ({ _id: String(l._id), nextFollowUpAt: l.nextFollowUpAt ?? null, missedFollowUpWarnedAt: l.missedFollowUpWarnedAt ?? null })), null, 2));
  const res = await leads.updateMany({ _id: { $in: stale.map((l) => l._id) }, ...filter }, { $set: { nextFollowUpAt: null, missedFollowUpWarnedAt: null } });
  console.log(`\nCleared ${res.modifiedCount}. Undo file: ${file}`);
}
await mongoose.disconnect();
