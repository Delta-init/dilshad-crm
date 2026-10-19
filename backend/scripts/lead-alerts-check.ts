/**
 * Checks the lead notifications the user asked for on 2026-10-19, on a scratch database:
 *
 *   - a new lead in (the form, an upload's batch, a 3CX inbound call, leads moved into a team): its team's leaders,
 *     the Super Admins and the Sales Manager are told — once each, about their share, never whoever brought it in;
 *     a lead with no team only the admins and the Sales Manager;
 *   - a lead given to someone: that person, kept in the bell — the split, the form (for a colleague), the Assign
 *     button, the scheduled split (its "system" no longer stops the notice), and a bulk action as one notice each.
 *
 * Run by lead-alerts-check.sh. Scratch database only; nobody's phone (no push subscriptions here).
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
  JWT_SECRET: "lead-alerts-check-jwt-0123456789", JWT_REFRESH_SECRET: "lead-alerts-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "", WHATSAPP_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { Notification } = await import("../src/models/Notification.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { LeadService, autoSplitLeadPublic } = await import("../src/services/leadService.js");
const { TeamService } = await import("../src/services/teamService.js");
const alerts = await import("../src/services/leadAlertService.js");
const leadService = new LeadService();
const teamService = new TeamService();
await Promise.all([Lead.init(), Notification.init()]);

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
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: perms({ leads: { view: true, create: true, edit: true, approve: true } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role = staffRole, status = "active") {
  const _id = new Types.ObjectId();
  ids[name] = _id;
  const email = `${name.toLowerCase()}@test.local`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role, status, createdAt: new Date(Date.now() - 86_400_000 * (100 - Object.keys(ids).length)), updatedAt: new Date() });
  tokens[name] = signAccessToken({ userId: String(_id), email, roleId: String(role) });
}
await person("Admin", superRole);
await person("OldAdmin", superRole, "inactive");
for (const n of ["Sam", "Tina", "Ann", "Ben", "Vic", "Wes"]) await person(n);
// Sam: the Sales Manager. Tina leads Alpha (Ann, Ben); Vic leads Beta (Wes).
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Sam, excludedUsers: [], fullViewers: [] });
const teamSettings = (s: Record<string, unknown> = {}) => ({
  autoAssign: true, splitMode: "round_robin", splitStrategy: "live", splitTime: null, roundRobinIndex: 0,
  includedMembers: [], roundRobinStartDate: null, sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false, ...s,
});
const team: Record<string, Types.ObjectId> = {};
async function makeTeam(name: string, leaders: string[], members: string[], settings: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  team[name] = _id;
  await db.collection("teams").insertOne({
    _id, name, leaders: leaders.map((m) => ids[m]), members: members.map((m) => ids[m]), inactiveMembers: [], absentToday: [], status: "active",
    settings: teamSettings(settings), createdAt: new Date(), updatedAt: new Date(),
  });
}
await makeTeam("Alpha", ["Tina"], ["Ann", "Ben"]);
await makeTeam("Beta", ["Vic"], ["Wes"]);
await makeTeam("Gamma", ["Vic"], ["Wes"], { autoAssign: true, splitStrategy: "scheduled", splitTime: "11:30" });

async function api<T>(method: string, path: string, who: string | null, body?: unknown): Promise<{ status: number; body: { success: boolean; data: T; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
}

let n = 0;
async function lead(o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${2000000 + n}`, source: "META", status: "new", assignedTo: null, team: null,
    reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    createdAt: new Date(), updatedAt: new Date(), ...o,
  });
  return _id;
}

/** Notices kept so far, by person — after the fire-and-forget ones have landed. */
async function inbox(): Promise<Record<string, Array<{ type: string; title: string; body: string; url: string }>>> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const c = await Notification.countDocuments();
    if (c === last) break;
    last = c;
    await Bun.sleep(150);
  }
  const docs = await Notification.find().sort({ createdAt: 1 }).lean<Array<{ user: Types.ObjectId; type: string; title: string; body: string; url: string }>>();
  const nameOf = new Map(Object.entries(ids).map(([k, v]) => [String(v), k]));
  const out: Record<string, Array<{ type: string; title: string; body: string; url: string }>> = {};
  for (const d of docs) (out[nameOf.get(String(d.user)) ?? "?"] ??= []).push({ type: d.type, title: d.title, body: d.body, url: d.url });
  return out;
}
const clear = () => Notification.deleteMany({});
const who = (box: Awaited<ReturnType<typeof inbox>>, type: string) => Object.entries(box).filter(([, l]) => l.some((x) => x.type === type)).map(([k]) => k).sort().join(",");

section("A new lead from the form");
{
  await clear();
  const r = await api<{ _id: string }>("POST", "/leads", "Ann", { name: "Form One", phone: "+971501111111", source: "Walk-in", team: String(team.Alpha) });
  check("created", r.status === 201, r.body);
  const box = await inbox();
  check("Alpha's leader, the Super Admin and the Sales Manager hear of it — not Ann who made it, not Beta's leader, not an inactive admin",
    who(box, "new_lead") === "Admin,Sam,Tina", who(box, "new_lead"));
  const t = box.Tina?.find((x) => x.type === "new_lead");
  check("one lead: its name, team and source, a link to it", t?.title === "New Lead" && t.body.toLowerCase() === "form one · alpha · walk-in" && t.url === `/leads/${r.body.data._id}`, t);
  check("the split gave it to someone in Alpha (its leader is in the split too), who is told (kept in the bell)", ["Ann", "Ben", "Tina"].some((p) => box[p]?.some((x) => x.type === "lead_assigned" && x.url === `/leads/${r.body.data._id}`)), box);
}
{
  await clear();
  const r = await api<{ _id: string }>("POST", "/leads", "Tina", { name: "For Ben", phone: "+971501111112", source: "Walk-in", assignedTo: String(ids.Ben) });
  const box = await inbox();
  check("made by Tina for Ben: Ben is told it is his", box.Ben?.some((x) => x.type === "lead_assigned" && x.body.includes("For Ben") && x.url === `/leads/${r.body.data._id}`) === true, box.Ben);
  check("no team: only the Super Admin and the Sales Manager hear it came in (Tina made it)", who(box, "new_lead") === "Admin,Sam", who(box, "new_lead"));
  await clear();
  await api("POST", "/leads", "Ann", { name: "Mine", phone: "+971501111113", source: "Walk-in" });
  const own = await inbox();
  check("a lead made for yourself: no 'assigned' notice to yourself", !own.Ann?.length, own.Ann);
}

section("An upload's batch: one notice per person");
{
  await clear();
  const a = await Promise.all([1, 2, 3, 4].map(() => lead()));
  const res = await leadService.autoAssignLeads(a.map(String), [String(team.Alpha)]);
  await alerts.announceNewLeads(a, { by: String(ids.Admin) });
  const box = await inbox();
  check("4 leads split in Alpha", res.assigned === 4, res);
  const got = ["Tina", "Ann", "Ben"].map((p) => ({ p, notices: box[p]?.filter((x) => x.type === "lead_assigned") ?? [] }));
  const leadsIn = (x: { title: string }) => (x.title === "New Lead Assigned" ? 1 : Number(x.title.split(" ")[0]));
  check("each person given leads: one notice for all of theirs, not one per lead",
    got.every((g) => g.notices.length <= 1) && got.reduce((sum, g) => sum + g.notices.reduce((a, x) => a + leadsIn(x), 0), 0) === 4, got);
  const two = got.find((g) => g.notices[0] && leadsIn(g.notices[0]) === 2)?.notices[0];
  check("a notice for 2 says so and opens the leads list", two?.title === "2 Leads Assigned" && two.url === "/leads" && two.body.includes(", "), two);
  const tina = box.Tina?.filter((x) => x.type === "new_lead") ?? [];
  check("Tina: one '4 New Leads' notice with the team split", tina.length === 1 && tina[0].title === "4 New Leads" && tina[0].body === "Alpha 4", tina);
  check("the uploader (Admin) is not told of their own upload; the Sales Manager is", !box.Admin?.some((x) => x.type === "new_lead") && box.Sam?.some((x) => x.type === "new_lead") === true, box.Admin);
}
{
  await clear();
  const a1 = await lead({ team: team.Alpha }), a2 = await lead({ team: team.Alpha }), b1 = await lead({ team: team.Beta }), x = await lead();
  await alerts.announceNewLeads([a1, a2, b1, x]);
  const box = await inbox();
  const t = box.Tina?.[0], v = box.Vic?.[0], s = box.Sam?.[0];
  check("a mixed batch: Alpha's leader hears of Alpha's 2 only", box.Tina?.length === 1 && t?.title === "2 New Leads" && t.body === "Alpha 2", box.Tina);
  check("Beta's leader of Beta's 1, as the lead itself", box.Vic?.length === 1 && v?.title === "New Lead" && v.url === `/leads/${b1}`, box.Vic);
  check("the Sales Manager of all 4, split by team", s?.title === "4 New Leads" && s.body === "Alpha 2 · Beta 1 · No team 1", s);
  check("team members are not told of arrivals", !box.Ann && !box.Ben && !box.Wes, box);
}

section("A 3CX inbound call from someone new");
{
  await clear();
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/calls/contact-create`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ first_name: "Caller", last_name: "New", phone_mobile: "+971509999999" }),
  });
  const body = (await r.json()) as { contact_id?: string };
  const box = await inbox();
  check("the lead is made", r.status === 201 && !!body.contact_id, body);
  check("the Super Admin and the Sales Manager hear of it", who(box, "new_lead") === "Admin,Sam" && box.Sam?.[0].body.startsWith("Caller New · No team"), box);
  await clear();
  await fetch(`http://127.0.0.1:${port}/api/v1/calls/contact-create`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ first_name: "Caller", last_name: "New", phone_mobile: "+971509999999" }),
  });
  check("the same caller again: nothing new, nobody told", Object.keys(await inbox()).length === 0);
}

section("Assigning by hand, moving into a team, the scheduled split");
{
  await clear();
  const l = await lead({ team: team.Beta });
  const r = await api("PATCH", `/leads/${l}/assign`, "Vic", { userId: String(ids.Wes) });
  const box = await inbox();
  check("Assign button: Wes is told, kept in the bell with a link", r.status === 200 && box.Wes?.length === 1 && box.Wes[0].type === "lead_assigned" && box.Wes[0].url === `/leads/${l}`, { status: r.status, box });

  await clear();
  const m = await Promise.all([1, 2].map(() => lead({ team: team.Alpha, assignedTo: ids.Ann, status: "assigned" })));
  await teamService.bulkTransferLeads(m.map(String), String(team.Beta), String(ids.Tina));
  const moved = await inbox();
  check("bulk transfer into Beta: Beta's leader hears '2 leads moved in'", moved.Vic?.length === 1 && moved.Vic[0].title === "2 leads moved in", moved.Vic);
  check("…not Tina who moved them", !moved.Tina, moved.Tina);

  await clear();
  const q = await Promise.all([1, 2, 3].map(() => lead({ team: team.Gamma })));
  await autoSplitLeadPublic(String(team.Gamma), String(q[0]), String(ids.Admin));
  check("a scheduled team holds a new lead until its split time", (await Lead.collection.findOne({ _id: q[0] }))?.assignedTo == null);
  await alerts.collectAssignments(async () => {
    for (const id of q) await autoSplitLeadPublic(String(team.Gamma), String(id), "system", undefined, true);
  });
  const done = await Lead.collection.find({ _id: { $in: q } }).toArray();
  const box2 = await inbox();
  check("the scheduled split (\"system\"): all 3 assigned", done.every((d) => String(d.assignedTo) === String(ids.Vic) || String(d.assignedTo) === String(ids.Wes)), done.map((d) => d.assignedTo));
  check("…its log kept, shown as System (no person)", done.every((d) => (d.activityLogs ?? []).some((a: { action: string; performedBy?: unknown }) => a.action === "lead_assigned" && a.performedBy == null)));
  const notices = [...(box2.Vic ?? []), ...(box2.Wes ?? [])].filter((x) => x.type === "lead_assigned");
  check("…and the people told, one notice each for the run", notices.length >= 1 && notices.length <= 2 && notices.reduce((s, x) => s + (x.title.startsWith("New Lead") ? 1 : Number(x.title.split(" ")[0])), 0) === 3, notices);
}

section("Never in the way");
{
  await clear();
  let threw = false;
  try {
    await alerts.announceNewLeads(["nope", String(new Types.ObjectId())]);
    await alerts.announceAssignment("nope", "x", "y");
    await alerts.announceBulkAssignment(String(ids.Ann), 0);
  } catch { threw = true; }
  check("bad ids, missing leads, a count of 0: nothing thrown, nothing sent", !threw && (await Notification.countDocuments()) === 0);
  const before = await Notification.countDocuments();
  const out = await alerts.collectAssignments(async () => 42);
  check("collectAssignments hands back what it ran", out === 42 && (await Notification.countDocuments()) === before);
}

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
