/**
 * Checks that a lead's next follow-up date goes when its status moves on from Follow Up (the user, 2026-10-20: leads
 * moved to MIA kept their September follow-up date and showed as overdue every day) — every way a status changes:
 * saving the lead, updateOne / updateMany / findByIdAndUpdate, the status service, a hand-over to a new owner — and is
 * kept when the status stays Follow Up, the same change sets a date, or nothing about the status changes; and that
 * Today's Follow-ups no longer lists such a lead.
 *
 * Run by followup-date-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "followup-date-check-jwt-0123456789", JWT_REFRESH_SECRET: "followup-date-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { LeadService } = await import("../src/services/leadService.js");
const leadService = new LeadService();

const role = new Types.ObjectId();
await db.collection("roles").insertOne({ _id: role, roleName: "Super Admin", isSystemRole: true, permissions: {} });
const ann = new Types.ObjectId(), ben = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: ann, name: "Ann", email: "ann@test.local", password: "x", role, status: "active" },
  { _id: ben, name: "Ben", email: "ben@test.local", password: "x", role, status: "active" },
]);
const team = new Types.ObjectId();
const past = new Date(Date.now() - 30 * 86_400_000), future = new Date(Date.now() + 2 * 86_400_000);
let n = 0;
async function lead(o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "META", status: "followup", assignedTo: ann, assignedAt: past,
    team, reporter: ann, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    nextFollowUpAt: past, missedFollowUpWarnedAt: past, createdAt: past, updatedAt: past, ...o,
  });
  return _id;
}
const dateOf = async (id: Types.ObjectId) => {
  const l = await Lead.collection.findOne({ _id: id });
  return { next: l?.nextFollowUpAt ?? null, warned: l?.missedFollowUpWarnedAt ?? null, status: l?.status };
};

section("Cleared when the status moves on from Follow Up");
{
  const a = await lead();
  const doc = await Lead.findById(a);
  doc!.status = "mia" as never;
  await doc!.save();
  const d = await dateOf(a);
  check("saving the lead as MIA: the date and the missed stamp go", d.next === null && d.warned === null, d);
  const b = await lead();
  await Lead.updateOne({ _id: b }, { $set: { status: "not_connected" } });
  check("updateOne to Not connected", (await dateOf(b)).next === null);
  const c = await lead();
  await Lead.findByIdAndUpdate(c, { status: "closed" });
  check("findByIdAndUpdate to Closed (no $set)", (await dateOf(c)).next === null);
  const d1 = await lead(), d2 = await lead();
  await Lead.updateMany({ _id: { $in: [d1, d2] } }, { $set: { status: "lost" } });
  check("updateMany to Lost", (await dateOf(d1)).next === null && (await dateOf(d2)).next === null);
  const e = await lead();
  await leadService.updateLeadStatus(String(e), "mia" as never, String(ann));
  check("the status service (the status button, the after-call dialog)", (await dateOf(e)).next === null, await dateOf(e));
  const f = await lead();
  await Lead.updateOne({ _id: f }, { $set: { assignedTo: ben } });
  const df = await dateOf(f);
  check("handed over to a new owner: back to Assigned, the old owner's date gone", df.status === "assigned" && df.next === null && df.warned === null, df);
}

section("Kept");
{
  const a = await lead();
  await Lead.updateOne({ _id: a }, { $set: { name: "Renamed" } });
  check("a change that isn't the status", String((await dateOf(a)).next) === String(past));
  const b = await lead();
  await Lead.updateOne({ _id: b }, { $set: { status: "followup", nextFollowUpAt: future } });
  check("Follow Up again with a new date: the new date", String((await dateOf(b)).next) === String(future));
  const c = await lead();
  await Lead.updateOne({ _id: c }, { $set: { status: "callback", nextFollowUpAt: future } });
  check("a change that sets a date with the status: that date", String((await dateOf(c)).next) === String(future));
  const d = await lead({ status: "pending_response", nextFollowUpAt: future });
  const doc = await Lead.findById(d);
  doc!.name = "Other";
  await doc!.save();
  check("a follow-up logged on a lead in another status, saved without a status change", String((await dateOf(d)).next) === String(future));
  const e = await lead({ isNewTest: true });
  const created = await Lead.create({ name: "New", phone: "+971500000999", email: "new@test.local", source: "META", status: "followup", assignedTo: ann, team, reporter: ann, nextFollowUpAt: future });
  check("a lead created in Follow Up with a date", String((await dateOf(created._id as Types.ObjectId)).next) === String(future) && !!e);
}

section("Today's Follow-ups no longer lists a lead moved on");
{
  const app = express();
  app.use(express.json());
  app.use("/api/v1", routes);
  app.use(errorHandler);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  await Lead.collection.deleteMany({});
  const stays = await lead({ name: "Still Follow Up" });
  const moved = await lead({ name: "Moved To MIA" });
  await Lead.updateOne({ _id: moved }, { $set: { status: "mia" } });
  const token = signAccessToken({ userId: String(ann), email: "ann@test.local", roleId: String(role) });
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/leads/followups/mine/today`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await r.json()) as { data: Array<{ _id: string; name: string }> };
  const names = (body.data ?? []).map((x) => x.name);
  check("the Follow Up lead is listed, the MIA one isn't", r.status === 200 && names.includes("Still Follow Up") && !names.includes("Moved To MIA"), names);
  server.close();
  void stays;
}

await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
