/**
 * Checks that time on calls doesn't count towards a lead going inactive, and that nothing moves while its owner is on a
 * call (the user, 2026-10-19), on a scratch database with a stand-in 3CX (a token, and each extension's live
 * participants):
 *
 *   - Case 1: a 20-minute call by the owner's account comes off the clock (list and mover);
 *   - Case 2: a call matched only by the extension, unanswered, counts too; two overlapping calls are taken off once;
 *   - Case 3: the owner on a call right now — listed as on a call, the mover leaves it, a super admin can still move it
 *     by hand; off the call it moves;
 *   - Case 4: 3CX not answering, or not connected — nobody counts as on a call, the mover carries on.
 *
 * Run by inactive-leads-oncall-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

// A stand-in 3CX.
let liveOn = new Set<string>();
let threecxDown = false;
const fake3cx = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/connect/token") return Response.json({ access_token: "stand-in", expires_in: 3600 });
    const m = url.pathname.match(/^\/callcontrol\/(\d+)$/);
    if (m) {
      if (threecxDown) return new Response("down", { status: 503 });
      return Response.json({ dn: m[1], devices: [], participants: liveOn.has(m[1]) ? [{ id: 7, status: "Connected", callid: 99 }] : [] });
    }
    return new Response("not here", { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "oncall-check-jwt-secret-0123456789", JWT_REFRESH_SECRET: "oncall-check-refresh-secret-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: `http://127.0.0.1:${fake3cx.port}`, THREECX_CLIENT_ID: "stand-in", THREECX_API_KEY: "stand-in-key",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const { AppSetting } = await import("../src/models/AppSetting.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");
const svc = await import("../src/services/inactiveLeadService.js");
const { forgetLiveCalls } = await import("../src/services/callClock.js");

const ids: Record<string, Types.ObjectId> = {};
const role = new Types.ObjectId(), admin = new Types.ObjectId();
await db.collection("roles").insertMany([{ _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} }, { _id: role, roleName: "Sales Staff", isSystemRole: false, permissions: {} }]);
for (const [name, ext, r] of [["Admin", "", admin], ["Ann", "101", role], ["Ben", "102", role], ["Cat", "103", role], ["Dan", "104", role]] as const) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@test.local`, password: "x", role: r, status: "active", extension: ext || null });
}
const alpha = new Types.ObjectId();
await db.collection("teams").insertOne({
  _id: alpha, name: "Alpha", leaders: [], members: [ids.Ann, ids.Ben, ids.Cat, ids.Dan], inactiveMembers: [], absentToday: [], status: "active",
  settings: { autoAssign: true, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0, includedMembers: [], roundRobinStartDate: null,
    sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false },
  createdAt: new Date(), updatedAt: new Date(),
});
await AppSetting.init();
await updateAppSettings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } }, String(ids.Admin));
await AppSetting.collection.updateOne({ key: "app" }, { $set: { "inactiveLeads.enabledAt": new Date("2026-10-19T08:00:00+04:00") } });
await updateAppSettings({}, String(ids.Admin));

// Monday 19 October 2026, Gulf time — inside the working hours here (10:00–19:00 Draw, 09:00–18:00 Remote).
const gst = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00+04:00`);
let seq = 0;
async function lead(name: string, owner: Types.ObjectId, assigned: string) {
  const _id = new Types.ObjectId(), at = gst(assigned);
  await Lead.collection.insertOne({
    _id, name, phone: `+9715${String(10_000_000 + ++seq)}`, email: `l${seq}@test.local`, source: "META", status: "assigned", assignedTo: owner, assignedAt: at,
    team: alpha, reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0, firstContactTime: null, createdAt: at, updatedAt: at,
  });
  return _id;
}
let k = 0;
const call = (startHHMM: string, seconds: number, o: Record<string, unknown>) => LeadCall.collection.insertOne({
  key: `c-${++k}`, callId: String(k), segmentId: "", startedAt: gst(startHHMM), direction: "out", status: "answered", answered: true, talkSeconds: seconds, ringSeconds: 0,
  number: "971500000000", numberKey: "500000000", extension: "", agentName: "", recordingIds: [], recordingUrl: "", reason: "", rows: 1, lead: new Types.ObjectId(),
  leadName: "", user: null, userName: "", syncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...o,
});
const ownerOf = async (id: Types.ObjectId) => String((await Lead.findById(id).lean())?.assignedTo ?? "");
const listed = async (at: string) => (await svc.listInactiveLeads({ page: 1, limit: 100 } as never, gst(at))).items;

section("Case 1 — a call by the owner's account");
const annLead = await lead("Ann Busy", ids.Ann, "11:00");
await call("11:10", 1200, { user: ids.Ann, extension: "101" });
check("11:45: 45 min less a 20-min call = 25 — not inactive", !(await listed("11:45")).some((i) => i.id === String(annLead)));
check("…and the mover leaves it", (await svc.sweepInactiveLeads(gst("11:45"))).moved === 0 && (await ownerOf(annLead)) === String(ids.Ann));
check("12:05: 65 − 20 = 45 — inactive", (await listed("12:05")).find((i) => i.id === String(annLead))?.waitingMinutes === 45, (await listed("12:05")).map((i) => [i.name, i.waitingMinutes]));

section("Case 2 — by the extension only, unanswered; overlapping calls");
const benLead = await lead("Ben Busy", ids.Ben, "11:00");
await call("11:10", 1200, { extension: "102", user: null, status: "no_answer", answered: false });
check("a call on Ben's extension with no person on it, unanswered, counts: 45 at 12:05", (await listed("12:05")).find((i) => i.id === String(benLead))?.waitingMinutes === 45);
const catLead = await lead("Cat Busy", ids.Cat, "11:00");
await call("11:10", 1200, { user: ids.Cat, extension: "103" });
await call("11:20", 1200, { user: ids.Cat, extension: "103" });
check("calls 11:10–11:30 and 11:20–11:40 take off 30, not 40: 75 − 30 = 45 at 12:15", (await listed("12:15")).find((i) => i.id === String(catLead))?.waitingMinutes === 45,
  (await listed("12:15")).map((i) => [i.name, i.waitingMinutes]));

section("Case 3 — on a call right now");
const danLead = await lead("Dan On Call", ids.Dan, "11:00");
liveOn = new Set(["104"]);
forgetLiveCalls();
check("shown as on a call", (await listed("13:00")).find((i) => i.id === String(danLead))?.autoMove === "on_call", (await listed("13:00")).map((i) => [i.name, i.autoMove]));
await svc.sweepInactiveLeads(gst("13:00"));
check("…the mover leaves Dan's lead", (await ownerOf(danLead)) === String(ids.Dan));
check("…others' due leads still move", (await ownerOf(annLead)) !== String(ids.Ann));
const danHand = await lead("Dan By Hand", ids.Dan, "11:00");
const byHand = await svc.reassignInactiveLeads({ leadIds: [String(danHand)], to: String(ids.Cat) }, String(ids.Admin), gst("13:00"));
check("…a super admin can still move one of his by hand", byHand.moved.length === 1 && (await ownerOf(danHand)) === String(ids.Cat), byHand);
liveOn = new Set();
forgetLiveCalls();
await svc.sweepInactiveLeads(gst("13:01"));
check("off the call: it moves", (await ownerOf(danLead)) !== String(ids.Dan));

section("Case 4 — 3CX down, or not connected");
const downLead = await lead("Dan 3CX Down", ids.Dan, "11:00");
liveOn = new Set(["104"]);
threecxDown = true;
forgetLiveCalls();
await svc.sweepInactiveLeads(gst("13:02"));
check("3CX not answering: not held — moved as before", (await ownerOf(downLead)) !== String(ids.Dan));
threecxDown = false;
delete process.env.THREECX_API_KEY;
const offLead = await lead("Dan No 3CX", ids.Dan, "11:00");
forgetLiveCalls();
check("3CX not connected: due as usual", (await listed("13:03")).find((i) => i.id === String(offLead))?.autoMove === "due", (await listed("13:03")).map((i) => [i.name, i.autoMove]));

fake3cx.stop(true);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
