/**
 * Checks repeat leads, on a scratch database (services/repeatLeadService.ts). Since 2026-11-26 a number the CRM already
 * has, coming in again, stays with whoever has it (the user: "remove" the team leader taking it to verify):
 *
 *   - no new lead; the old one counted and noted, its owner, status and dates as they were (a lost one open again);
 *     its owner is told;
 *   - an old sheet row sent late (made before the CRM first had the lead): nothing at all;
 *   - already a client: stays a client, its owner told; its owner has left, or nobody has it: through the split;
 *   - one still waiting for its team leader from before: as it was (the Repeat leads page, given out once).
 *
 * Run by repeat-leads-check.sh. Scratch database only.
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
  JWT_SECRET: "repeat-leads-check-jwt-0123456789", JWT_REFRESH_SECRET: "repeat-leads-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "", WHATSAPP_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "",
  SHEETS_API_KEY: "repeat-leads-check-sheets-key", SUPER_ADMIN_EMAIL: "admin@test.local",
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

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/* ── People, roles, teams ────────────────────────────────────────────────── */

type Action = "view" | "create" | "edit" | "delete" | "approve" | "export";
const perms = (m: Record<string, Partial<Record<Action, boolean>>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));
const superRole = new Types.ObjectId(), staffRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: perms({ leads: { view: true, edit: true } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role = staffRole) {
  const _id = new Types.ObjectId();
  ids[name] = _id;
  const email = `${name.toLowerCase()}@test.local`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role, status: "active", createdAt: new Date(), updatedAt: new Date() });
  tokens[name] = signAccessToken({ userId: String(_id), email, roleId: String(role) });
}
await person("Admin", superRole);
for (const n of ["Sam", "Tina", "Ann", "Ben", "Wes", "Vic"]) await person(n);
// Sam: the Sales Manager. Tina leads Alpha (Ann, Ben). Beta (Wes) has no leader. Vic leads Gamma (nobody else).
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Sam, excludedUsers: [], fullViewers: [] });
const teamSettings = {
  autoAssign: true, splitMode: "round_robin", splitStrategy: "instant", splitTime: null, roundRobinIndex: 0,
  includedMembers: [], roundRobinStartDate: null, sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false,
};
const team: Record<string, Types.ObjectId> = {};
async function makeTeam(name: string, leaders: string[], members: string[]) {
  const _id = new Types.ObjectId();
  team[name] = _id;
  await db.collection("teams").insertOne({
    _id, name, leaders: leaders.map((m) => ids[m]), members: members.map((m) => ids[m]), inactiveMembers: [], absentToday: [], status: "active",
    settings: teamSettings, createdAt: new Date(), updatedAt: new Date(),
  });
}
await makeTeam("Alpha", ["Tina"], ["Ann", "Ben"]);
await makeTeam("Beta", [], ["Wes"]);
await makeTeam("Gamma", ["Vic"], []);

interface ApiBody<T> { success: boolean; message: string; data: T }
async function api<T>(method: string, path: string, who: string | null, body?: unknown): Promise<{ status: number; body: ApiBody<T> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.authorization = `Bearer ${tokens[who]}`;
  else headers["x-api-key"] = "repeat-leads-check-sheets-key";
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}

let n = 0;
const OLD = new Date("2026-09-01T08:00:00.000Z");
async function lead(owner: string | null, teamName: string | null, o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "meta", status: "followup",
    assignedTo: owner ? ids[owner] : null, assignedAt: OLD, team: teamName ? team[teamName] : null, reporter: ids.Admin,
    notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    createdAt: OLD, updatedAt: OLD, ...o,
  });
  return _id;
}
const row = (phone: string, extra: Record<string, unknown> = {}) => ({ full_name: "Came Again", phone_number: phone, platform: "fb", campaign_name: "Oct Forex", ...extra });
const get = async (id: Types.ObjectId) => (await Lead.findById(id).lean()) as Record<string, any>;
const notices = async (who: string, type: string) => db.collection("notifications").countDocuments({ user: ids[who], type });
const settle = () => new Promise((r) => setTimeout(r, 300));

section("A number already with Ann (Alpha) comes in again — it stays hers");
const l1 = await lead("Ann", "Alpha");
const leadsBefore = await Lead.countDocuments();
const NOW = () => new Date().toISOString();
let r = await api<Record<string, unknown>>("POST", "/sheets/sync", null, row("+971501000001", { created_time: NOW() }));
await settle();
let d = await get(l1);
check("answered as a duplicate and a repeat; no new lead", r.status === 200 && r.body.data?.duplicate === true && r.body.data?.repeat === true && (await Lead.countDocuments()) === leadsBefore, r.body);
check("still Ann's, still follow-up, its dates as they were — no team leader in between", String(d.assignedTo) === String(ids.Ann) && d.status === "followup" && new Date(d.createdAt).getTime() === OLD.getTime() && d.repeat?.waiting === false && String(d.repeat?.holder) === String(ids.Ann), { assignedTo: d.assignedTo, status: d.status, createdAt: d.createdAt, repeat: d.repeat });
check("counted once, a note of the campaign, the activity says it stays with Ann", d.repeatCount === 1 && /Came in again \(meta · fb · Oct Forex\)/.test(d.notes.at(-1)?.content ?? "") && d.activityLogs.some((a: any) => a.action === "repeat_enquiry" && /stays with Ann/.test(a.description)), { count: d.repeatCount, note: d.notes.at(-1)?.content, log: d.activityLogs.at(-1) });
check("Ann told her lead came in again; Tina isn't", (await notices("Ann", "repeat_lead")) === 1 && (await notices("Tina", "repeat_lead")) === 0);
check("…pointing at the lead", (await db.collection("notifications").findOne({ user: ids.Ann, type: "repeat_lead" }))?.url === `/leads/${l1}`);
check("not on anyone's Repeat leads list", !(await api<List>("GET", "/leads/repeats", "Tina")).body.data.leads.some((x) => x.id === String(l1)));
r = await api("POST", "/sheets/sync", null, row("+971501000001", { campaign_name: "Nov Forex", created_time: NOW() }));
await settle();
d = await get(l1);
check("in again: counted twice, still Ann's", d.repeatCount === 2 && String(d.assignedTo) === String(ids.Ann) && d.repeat?.campaign === "Nov Forex", d.repeat);

section("An old row sent late (2026-11-26) — the same enquiry, not a repeat");
const l7 = await lead("Ann", "Alpha", { status: "not_connected" });
r = await api<Record<string, unknown>>("POST", "/sheets/sync", null, row("+971501000002", { created_time: new Date(OLD.getTime() - 86_400_000).toISOString() }));
await settle();
d = await get(l7);
check("answered as a duplicate, not a repeat", r.body.data?.duplicate === true && r.body.data?.repeat === false, r.body);
check("nothing changed: Ann's, not connected, not counted, no note, nobody told", String(d.assignedTo) === String(ids.Ann) && d.status === "not_connected" && !d.repeatCount && !d.notes.length && !d.repeat && (await notices("Ann", "repeat_lead")) === 2, d);
const l8 = await lead("Ann", "Alpha", { createdAt: new Date("2026-10-20T08:00:00Z"), originalCreatedAt: OLD });
r = await api<{ results: { status: string }[] }>("POST", "/sheets/sync/batch", null, { rows: [row("+971501000003", { created_time: "2026-09-15T08:00:00Z" })] });
await settle();
d = await get(l8);
check("handed over since (created date moved) — but made after it was first here: a repeat", d.repeatCount === 1 && String(d.assignedTo) === String(ids.Ann), d.repeat);
const l9 = await lead("Ann", "Alpha");
await api("POST", "/sheets/sync/batch", null, { rows: [row("+971501000004", { created_time: "2026-08-01T08:00:00Z" })] });
d = await get(l9);
check("…through the batch, an older one: nothing", !d.repeatCount && !d.repeat, d.repeat);
const l10 = await lead("Ann", "Alpha");
await api("POST", "/sheets/sync", null, row("+971501000005"));
d = await get(l10);
check("no time on the row: a repeat, as before", d.repeatCount === 1, d.repeat);

section("A lost one through the batch sync");
const l2 = await lead("Ben", "Alpha", { status: "lost", lostReason: "not_interested" });
r = await api<{ summary: { duplicate: number; created: number } }>("POST", "/sheets/sync/batch", null, { rows: [row("+971501000006", { created_time: NOW() }), row("+971509999999", { full_name: "Brand New" })] });
await settle();
d = await get(l2);
check("the batch: one new lead, one repeat", r.body.data?.summary?.duplicate === 1 && r.body.data?.summary?.created === 1, r.body.data?.summary);
check("still Ben's, open again (Assigned), Ben told", d.status === "assigned" && String(d.assignedTo) === String(ids.Ben) && d.repeat?.waiting === false && d.repeat?.previousStatus === "lost" && (await notices("Ben", "repeat_lead")) === 1, { status: d.status, repeat: d.repeat });

section("Already a client");
const l3 = await lead("Ann", "Alpha", { status: "closed" });
await api("POST", "/sheets/sync", null, row("+971501000007", { created_time: NOW() }));
await settle();
d = await get(l3);
check("stays Ann's and closed; Ann told her client came in again", String(d.assignedTo) === String(ids.Ann) && d.status === "closed" && d.repeat?.waiting === false && d.repeat?.alreadyClient === true && (await db.collection("notifications").findOne({ user: ids.Ann, type: "repeat_lead", title: "Your client came in again" })) !== null, { status: d.status, repeat: d.repeat });

section("A leader's own lead, a team with no leader, someone who has left");
const l5 = await lead("Tina", "Alpha");
await api("POST", "/sheets/sync", null, row("+971501000008", { created_time: NOW() }));
d = await get(l5);
check("Tina's own lead stays hers", String(d.assignedTo) === String(ids.Tina) && d.repeat?.waiting === false);
const l4 = await lead("Wes", "Beta");
await api("POST", "/sheets/sync", null, row("+971501000009", { created_time: NOW() }));
await settle();
d = await get(l4);
check("Beta has no leader: still Wes's, Wes told", String(d.assignedTo) === String(ids.Wes) && (await notices("Wes", "repeat_lead")) === 1, d.repeat);
const l11 = await lead("Wes", "Beta");
await db.collection("users").updateOne({ _id: ids.Wes }, { $set: { status: "inactive" } });
await api("POST", "/sheets/sync", null, row("+971501000010", { created_time: NOW() }));
await settle();
d = await get(l11);
check("its owner has left: through the split, not held", d.repeatCount === 1 && d.activityLogs.some((a: any) => /nobody active has it/.test(a.description ?? "")) && d.repeat == null, d.activityLogs.map((a: any) => a.description));
await db.collection("users").updateOne({ _id: ids.Wes }, { $set: { status: "active" } });

section("No owner and no team");
const l6 = await lead(null, null, { status: "new" });
r = await api("POST", "/sheets/sync", null, row("+971501000011", { created_time: NOW() }));
await settle();
d = await get(l6);
check("not held — counted, and it goes through the split like a new lead", r.body.data && (d.repeat == null || d.repeat.waiting !== true) && d.repeatCount === 1 && d.activityLogs.some((a: any) => /split/.test(a.description ?? "")), { repeat: d.repeat, team: d.team, assignedTo: d.assignedTo });

section("Added by hand: told who has it");
const l12 = await lead("Ben", "Alpha");
r = await api("POST", "/leads", "Admin", { name: "Typed Again", phone: "+971501000012", source: "walk_in" });
check("refused (409), saying it stays with Ben", r.status === 409 && /stays with Ben/.test(r.body.message ?? ""), r.body);

section("One still waiting for its team leader from before (the Repeat leads page)");
const lw = await lead("Tina", "Alpha", { status: "assigned", repeatCount: 1, repeat: { waiting: true, at: new Date(), team: team.Alpha, previousOwner: ids.Ann, previousStatus: "followup", alreadyClient: false, holder: ids.Tina, source: "meta", campaign: "Oct Forex", decidedBy: null, decidedAt: null, givenTo: null } });
const tinaBefore = await notices("Tina", "repeat_lead");
await api("POST", "/sheets/sync", null, row("+971501000013", { created_time: NOW() }));
await settle();
d = await get(lw);
check("in again while it waits: counted, still Tina's, still waiting, Tina told", d.repeatCount === 2 && String(d.assignedTo) === String(ids.Tina) && d.repeat?.waiting === true && (await notices("Tina", "repeat_lead")) === tinaBefore + 1, { count: d.repeatCount, to: d.assignedTo, tina: await notices("Tina", "repeat_lead") });
type List = { scope: string; teams: Array<{ name: string; people: Array<{ id: string; name: string }> }>; leads: Array<{ id: string; repeatCount: number; repeat: { previousOwner: { name: string } | null; alreadyClient: boolean } }> };
const list = await api<List>("GET", "/leads/repeats", "Tina");
check("Tina: hers to verify, Ann as who had it", list.status === 200 && list.body.data.leads.some((x) => x.id === String(lw) && x.repeat.previousOwner?.name === "Ann"), list.body.data);
check("Ann (not a leader): not hers to see", (await api("GET", "/leads/repeats", "Ann")).status === 403);
check("not to someone in another team", (await api("POST", `/leads/${lw}/repeat/give`, "Tina", { userId: String(ids.Wes) })).status === 400);
r = await api("POST", `/leads/${lw}/repeat/give`, "Tina", { userId: String(ids.Ann) });
d = await get(lw);
check("given back to Ann: hers, decided by Tina, once", r.status === 200 && String(d.assignedTo) === String(ids.Ann) && d.repeat?.waiting === false && (await api("POST", `/leads/${lw}/repeat/give`, "Tina", { userId: String(ids.Ben) })).status === 409, r.body);

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
