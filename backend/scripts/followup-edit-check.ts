/**
 * Changing a follow-up date and editing a reminder's time (the user, 2026-10-22: "follow-up reminder edit, follow-up
 * date editing we need"):
 *   Case 1  happy path   PATCH /leads/:id/followup-date moves the date, its "Follow-up due" reminder with it (alerts
 *                        re-armed), clears the missed stamp, notes it in the activity; with no such reminder, one is
 *                        made for the lead's owner — whoever changes it
 *   Case 2  edge         editing the "Follow-up due" reminder's time moves the date; another reminder's doesn't; the
 *                        same time again re-arms nothing; a done follow-up reminder is left alone
 *   Case 3  errors       a past time, more than a year ahead, not a date, an unknown lead
 *   Case 4  permission   no session 401; a role without leads.edit 403
 *
 * Run by followup-edit-check.sh. Scratch database only.
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
  JWT_SECRET: "followup-edit-check-jwt-0123456789", JWT_REFRESH_SECRET: "followup-edit-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("not a local database");
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");

const admin = new Types.ObjectId(), viewer = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: viewer, roleName: "Viewer", isSystemRole: false, permissions: { leads: { view: true, edit: false }, reminders: { view: true, edit: false } } },
]);
const ann = new Types.ObjectId(), ben = new Types.ObjectId(), vic = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: ann, name: "Ann", email: "ann@test.local", password: "x", role: admin, status: "active" },
  { _id: ben, name: "Ben", email: "ben@test.local", password: "x", role: admin, status: "active" },
  { _id: vic, name: "Vic", email: "vic@test.local", password: "x", role: viewer, status: "active" },
]);

const H = 3_600_000;
const past = new Date(Date.now() - 30 * 86_400_000);
const at = (hours: number) => new Date(Math.floor((Date.now() + hours * H) / 60_000) * 60_000);
let n = 0;
async function lead(o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "META", status: "followup", assignedTo: ann, assignedAt: past,
    reporter: ann, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    createdAt: past, updatedAt: past, ...o,
  });
  return _id;
}
const reminderRow = (o: Record<string, unknown>) => ({ _id: new Types.ObjectId(), title: "Follow-up due", note: "", createdBy: ann, isDone: false, notifiedAt: null, warnedAt: null, createdAt: past, updatedAt: past, ...o });
const read = async (id: Types.ObjectId) => (await Lead.collection.findOne({ _id: id }))!;

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const tokenOf = (userId: Types.ObjectId, role: Types.ObjectId, email: string) => signAccessToken({ userId: String(userId), email, roleId: String(role) });
const BEN = tokenOf(ben, admin, "ben@test.local"), VIC = tokenOf(vic, viewer, "vic@test.local");
async function call(method: string, path: string, body?: unknown, token: string | null = BEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> & { data?: Record<string, unknown>; message?: string } };
}
const same = (a: unknown, b: Date) => !!a && new Date(a as Date).getTime() === b.getTime();

section("Case 1 — changing the date moves its reminder");
{
  const old = at(2), fired = new Date();
  const r1 = reminderRow({ remindAt: old, notifiedAt: fired, warnedAt: fired });
  const other = reminderRow({ title: "Call about the fee", remindAt: old });
  const id = await lead({ nextFollowUpAt: old, missedFollowUpWarnedAt: old, reminders: [r1, other] });
  const to = at(26);
  const r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: to.toISOString(), note: "Asked to call tomorrow" });
  const l = await read(id);
  check("200 with the new date and the old one", r.status === 200 && r.body.data?.nextFollowUpAt === to.toISOString() && r.body.data?.previous === old.toISOString(), r.body);
  check("the lead's date moved; the missed stamp is gone", same(l.nextFollowUpAt, to) && l.missedFollowUpWarnedAt === null, [l.nextFollowUpAt, l.missedFollowUpWarnedAt]);
  const moved = l.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(r1._id));
  check("its Follow-up due reminder moved too, its alerts re-armed", same(moved.remindAt, to) && moved.notifiedAt === null && moved.warnedAt === null, moved);
  const kept = l.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(other._id));
  check("another reminder at the same time is left alone", same(kept.remindAt, old));
  check("no second reminder made", l.reminders.length === 2, l.reminders.length);
  const log = l.activityLogs.at(-1);
  check("the activity says from and to, in GST, with the note", /Next follow-up moved from .* to .* \(GST\) — Asked to call tomorrow/.test(log?.description ?? "") && String(log.performedBy) === String(ben), log);
}
{
  const id = await lead({ nextFollowUpAt: null });
  const to = at(5);
  const r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: to.toISOString() });
  const l = await read(id);
  const made = l.reminders[0];
  check("no date before (no time set): the date is set", r.status === 200 && same(l.nextFollowUpAt, to) && r.body.data?.previous === null, r.body);
  check("…and a Follow-up due reminder made for the lead's owner (Ann), not whoever set it (Ben)",
    l.reminders.length === 1 && made.title === "Follow-up due" && same(made.remindAt, to) && String(made.createdBy) === String(ann) && made.isDone === false, made);
  check("…the activity says set for", /^Next follow-up set for .* \(GST\)$/.test(l.activityLogs.at(-1)?.description ?? ""), l.activityLogs.at(-1));
  const r2 = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: at(8).toISOString() });
  const l2 = await read(id);
  check("changed again: the same reminder moves, none added", r2.status === 200 && l2.reminders.length === 1 && same(l2.reminders[0].remindAt, at(8)), l2.reminders);
}

section("Case 2 — editing the reminder's time");
{
  const old = at(3), fired = new Date();
  const fu = reminderRow({ remindAt: old, notifiedAt: fired, warnedAt: fired });
  const call2 = reminderRow({ title: "Send the brochure", remindAt: at(4), notifiedAt: fired, warnedAt: fired });
  const id = await lead({ nextFollowUpAt: old, missedFollowUpWarnedAt: old, reminders: [fu, call2] });
  const to = at(30);
  let r = await call("PUT", `/leads/${id}/reminders/${fu._id}`, { remindAt: to.toISOString() });
  let l = await read(id);
  const a = l.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(fu._id));
  check("the Follow-up due reminder moved, its alerts re-armed", r.status === 200 && same(a.remindAt, to) && a.notifiedAt === null && a.warnedAt === null, a);
  check("…and the lead's follow-up date moved with it, missed stamp gone", same(l.nextFollowUpAt, to) && l.missedFollowUpWarnedAt === null, l.nextFollowUpAt);
  r = await call("PUT", `/leads/${id}/reminders/${call2._id}`, { remindAt: at(40).toISOString() });
  l = await read(id);
  const b = l.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(call2._id));
  check("another reminder's new time: re-armed, the follow-up date stays", r.status === 200 && b.notifiedAt === null && b.warnedAt === null && same(l.nextFollowUpAt, to), [b, l.nextFollowUpAt]);
  await Lead.collection.updateOne({ _id: id }, { $set: { "reminders.$[r].notifiedAt": fired } }, { arrayFilters: [{ "r._id": call2._id }] });
  r = await call("PUT", `/leads/${id}/reminders/${call2._id}`, { remindAt: at(40).toISOString(), title: "Send the brochure (PDF)" });
  l = await read(id);
  const c = l.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(call2._id));
  check("the same time again (a title edit): not re-armed", r.status === 200 && same(c.notifiedAt, fired) && c.title === "Send the brochure (PDF)", c);
}
{
  const old = at(3);
  const done = reminderRow({ remindAt: old, isDone: true });
  const id = await lead({ nextFollowUpAt: old, reminders: [done] });
  await call("PUT", `/leads/${id}/reminders/${done._id}`, { remindAt: at(9).toISOString() });
  const l = await read(id);
  check("a done Follow-up due reminder's time: the date stays", same(l.nextFollowUpAt, old), l.nextFollowUpAt);
}

section("Case 3 — errors");
{
  const id = await lead({ nextFollowUpAt: at(2) });
  let r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: new Date(Date.now() - 2 * H).toISOString() });
  check("a past time: 400, says future", r.status === 400 && /future/i.test(r.body.message ?? ""), r);
  r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: at(24 * 400).toISOString() });
  check("more than a year ahead: 400", r.status === 400 && /year/i.test(r.body.message ?? ""), r);
  r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: "tomorrow" });
  check("not a date: 400", r.status === 400, r);
  r = await call("PATCH", `/leads/${new Types.ObjectId()}/followup-date`, { nextFollowUpAt: at(2).toISOString() });
  check("an unknown lead: 404", r.status === 404, r);
  check("nothing changed on the lead", same((await read(id)).nextFollowUpAt, at(2)));
}

section("Case 4 — permission");
{
  const id = await lead({ nextFollowUpAt: at(2) });
  let r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: at(5).toISOString() }, null);
  check("no session: 401", r.status === 401, r.status);
  r = await call("PATCH", `/leads/${id}/followup-date`, { nextFollowUpAt: at(5).toISOString() }, VIC);
  check("a role without leads.edit: 403", r.status === 403, r.status);
  check("…the date unchanged", same((await read(id)).nextFollowUpAt, at(2)));
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
