/**
 * Checks repeat leads (the user, 2026-10-23), on a scratch database: a number the CRM already has, coming in again
 * from the sheet / Root sync, goes to its team leader first, who verifies it and gives it to the same person or
 * another in the same team (services/repeatLeadService.ts):
 *
 *   - no new lead; the old one counted, noted, held by its team's leader (a lost one Assigned again), they are told;
 *   - again while it waits: counted again, still one decision;
 *   - only that team's leaders (and Super Admins / the Sales Manager) see and give it — to someone in the team;
 *   - given out: theirs as a new lead, they are told; decided once;
 *   - already a client: stays with its owner, only verified; a team with no leader: a Super Admin holds it;
 *   - no owner and no team: through the split, not held; the batch sync the same.
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

section("A number already with Ann (Alpha) comes in again");
const l1 = await lead("Ann", "Alpha");
const leadsBefore = await Lead.countDocuments();
let r = await api<Record<string, unknown>>("POST", "/sheets/sync", null, row("+971501000001"));
await settle();
let d = await get(l1);
check("answered as a duplicate and a repeat; no new lead", r.status === 200 && r.body.data?.duplicate === true && r.body.data?.repeat === true && (await Lead.countDocuments()) === leadsBefore, r.body);
check("now with Tina, its team leader, Assigned, waiting — Ann noted as who had it", String(d.assignedTo) === String(ids.Tina) && d.status === "assigned" && d.repeat?.waiting === true && String(d.repeat?.previousOwner) === String(ids.Ann) && d.repeat?.previousStatus === "followup", d.repeat);
check("counted once, a note of the campaign, the activity logged", d.repeatCount === 1 && /Came in again \(meta · fb · Oct Forex\)/.test(d.notes.at(-1)?.content ?? "") && d.activityLogs.some((a: any) => a.action === "repeat_enquiry"), { count: d.repeatCount, note: d.notes.at(-1)?.content });
check("Tina told to verify it; Ann isn't", (await notices("Tina", "repeat_lead")) === 1 && (await notices("Ann", "repeat_lead")) === 0);
check("a fresh lead for Tina: its created date is now, the first one kept", new Date(d.createdAt).getTime() > OLD.getTime() && new Date(d.originalCreatedAt).getTime() === OLD.getTime());

r = await api("POST", "/sheets/sync", null, row("+971501000001", { campaign_name: "Nov Forex" }));
await settle();
d = await get(l1);
check("in again while it waits: counted twice, still Tina's, still Ann as the one before", d.repeatCount === 2 && String(d.assignedTo) === String(ids.Tina) && d.repeat?.waiting === true && String(d.repeat?.previousOwner) === String(ids.Ann) && d.repeat?.campaign === "Nov Forex", d.repeat);

section("Who sees it");
type List = { scope: string; teams: Array<{ name: string; people: Array<{ id: string; name: string }> }>; leads: Array<{ id: string; repeatCount: number; repeat: { previousOwner: { name: string } | null; alreadyClient: boolean } }> };
let list = await api<List>("GET", "/leads/repeats", "Tina");
check("Tina: hers to verify, Ann as who had it, her team's people to give it to", list.status === 200 && list.body.data.leads.some((x) => x.id === String(l1) && x.repeat.previousOwner?.name === "Ann" && x.repeatCount === 2) && list.body.data.teams.find((t) => t.name === "Alpha")?.people.map((p) => p.name).join() === "Ann,Ben,Tina", list.body.data);
check("Ann (not a leader): not hers to see", (await api("GET", "/leads/repeats", "Ann")).status === 403);
check("Vic (leads another team): sees none of Alpha's", (await api<List>("GET", "/leads/repeats", "Vic")).body.data?.leads.length === 0);
check("the counts: Tina 1, Ann none (no menu item)", (await api<{ count: number | null }>("GET", "/leads/repeats/count", "Tina")).body.data?.count === 1 && (await api<{ count: number | null }>("GET", "/leads/repeats/count", "Ann")).body.data?.count === null);

section("Tina verifies and gives it out");
check("not to someone in another team", (await api("POST", `/leads/${l1}/repeat/give`, "Tina", { userId: String(ids.Wes) })).status === 400);
check("Ann can't give it out", (await api("POST", `/leads/${l1}/repeat/give`, "Ann", { userId: String(ids.Ann) })).status === 403);
check("Vic can't either", (await api("POST", `/leads/${l1}/repeat/give`, "Vic", { userId: String(ids.Ben) })).status === 403);
r = await api("POST", `/leads/${l1}/repeat/give`, "Tina", { userId: String(ids.Ben) });
await settle();
d = await get(l1);
check("given to Ben (same team): his, Assigned, decided by Tina", r.status === 200 && String(d.assignedTo) === String(ids.Ben) && d.status === "assigned" && d.repeat?.waiting === false && String(d.repeat?.decidedBy) === String(ids.Tina) && String(d.repeat?.givenTo) === String(ids.Ben), { status: r.status, body: r.body, repeat: d.repeat });
check("…logged, and Ben told it's his", d.activityLogs.some((a: any) => a.action === "repeat_verified" && /given to Ben/.test(a.description)) && (await notices("Ben", "lead_assigned")) === 1);
check("decided once only", (await api("POST", `/leads/${l1}/repeat/give`, "Tina", { userId: String(ids.Ann) })).status === 409);
check("no longer waiting in Tina's list", !(await api<List>("GET", "/leads/repeats", "Tina")).body.data.leads.some((x) => x.id === String(l1)) && (await api<List>("GET", "/leads/repeats?state=done", "Tina")).body.data.leads.some((x) => x.id === String(l1)));

section("A lost one, through the batch sync, given back to the same person");
const l2 = await lead("Ben", "Alpha", { status: "lost", lostReason: "not_interested" });
r = await api<{ summary: { duplicate: number; created: number } }>("POST", "/sheets/sync/batch", null, { rows: [row("+971501000002"), row("+971509999999", { full_name: "Brand New" })] });
await settle();
d = await get(l2);
check("the batch: one new lead, one repeat", r.body.data?.summary?.duplicate === 1 && r.body.data?.summary?.created === 1, r.body.data?.summary);
check("the lost lead is Assigned again, with Tina to verify", d.status === "assigned" && String(d.assignedTo) === String(ids.Tina) && d.repeat?.waiting === true && d.repeat?.previousStatus === "lost", { status: d.status, repeat: d.repeat });
r = await api("POST", `/leads/${l2}/repeat/give`, "Tina", { userId: String(ids.Ben) });
d = await get(l2);
check("given back to Ben — the same person", r.status === 200 && String(d.assignedTo) === String(ids.Ben) && d.activityLogs.some((a: any) => /given back to Ben/.test(a.description ?? "")), d.activityLogs.map((a: any) => a.description));

section("Already a client");
const l3 = await lead("Ann", "Alpha", { status: "closed" });
await api("POST", "/sheets/sync", null, row("+971501000003"));
d = await get(l3);
check("stays Ann's and closed, waiting for Tina to verify", String(d.assignedTo) === String(ids.Ann) && d.status === "closed" && d.repeat?.waiting === true && d.repeat?.alreadyClient === true, { status: d.status, repeat: d.repeat });
check("can't be given to someone else", (await api("POST", `/leads/${l3}/repeat/give`, "Tina", { userId: String(ids.Ben) })).status === 400);
r = await api("POST", `/leads/${l3}/repeat/give`, "Tina", { userId: String(ids.Ann) });
d = await get(l3);
check("verified with Ann: still hers, still closed", r.status === 200 && String(d.assignedTo) === String(ids.Ann) && d.status === "closed" && d.repeat?.waiting === false);

section("A team with no leader, and a leader's own lead");
const l4 = await lead("Wes", "Beta");
await api("POST", "/sheets/sync", null, row("+971501000004"));
await settle();
d = await get(l4);
check("Beta has no leader: a Super Admin holds it and is told", String(d.assignedTo) === String(ids.Admin) && d.repeat?.waiting === true && (await notices("Admin", "repeat_lead")) >= 1, d.repeat);
check("Tina doesn't see it", !(await api<List>("GET", "/leads/repeats", "Tina")).body.data.leads.some((x) => x.id === String(l4)));
r = await api("POST", `/leads/${l4}/repeat/give`, "Sam", { userId: String(ids.Wes) });
d = await get(l4);
check("the Sales Manager gives it back to Wes", r.status === 200 && String(d.assignedTo) === String(ids.Wes) && d.repeat?.waiting === false, r.body);
const l5 = await lead("Tina", "Alpha");
await api("POST", "/sheets/sync", null, row("+971501000005"));
d = await get(l5);
check("Tina's own lead stays with her, waiting for her to verify", String(d.assignedTo) === String(ids.Tina) && d.repeat?.waiting === true && String(d.repeat?.previousOwner) === String(ids.Tina));

section("No owner and no team");
const l6 = await lead(null, null, { status: "new" });
r = await api("POST", "/sheets/sync", null, row("+971501000006"));
await settle();
d = await get(l6);
check("not held — counted, and it goes through the split like a new lead", r.body.data && (d.repeat == null || d.repeat.waiting !== true) && d.repeatCount === 1 && d.activityLogs.some((a: any) => /goes through the split/.test(a.description ?? "")), { repeat: d.repeat, team: d.team, assignedTo: d.assignedTo });

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
