/**
 * Checks two things the user asked for on 2026-10-19, on a scratch database:
 *
 *   - Team / All reminders: a Super Admin and the Sales Manager see everyone's reminders, a team leader only those
 *     set by the people of the active teams they lead, anyone else only their own (403) — person and team filters
 *     kept inside that, open / done, who set each, and nothing changed by looking;
 *   - a team leader's leads are never inactive: not in "inactive now" (the page and the Workflow), not moved by the
 *     automatic mover, not moved by hand — while a member's lead still is; and a leader stepping down counts again.
 *
 * Run by team-reminders-check.sh. Scratch database only.
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
  JWT_SECRET: "team-reminders-check-jwt-0123456789", JWT_REFRESH_SECRET: "team-reminders-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
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
const svc = await import("../src/services/inactiveLeadService.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");

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
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: perms({ reminders: { view: true, create: true, edit: true, delete: true }, leads: { view: true, edit: true } }) },
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
for (const n of ["Sam", "Tina", "Ann", "Ben", "Vic", "Wes", "Zoe"]) await person(n);
// Sam: the Sales Manager. Tina leads Alpha (Ann, Ben). Vic leads Beta (Wes). Zoe is in no team. Old leads Gone (inactive).
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Sam, excludedUsers: [], fullViewers: [] });

const teamSettings = {
  autoAssign: true, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0,
  includedMembers: [], roundRobinStartDate: null, sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false,
};
const team: Record<string, Types.ObjectId> = {};
async function makeTeam(name: string, leaders: string[], members: string[], status = "active") {
  const _id = new Types.ObjectId();
  team[name] = _id;
  await db.collection("teams").insertOne({
    _id, name, leaders: leaders.map((m) => ids[m]), members: members.map((m) => ids[m]), inactiveMembers: [], absentToday: [], status,
    settings: teamSettings, createdAt: new Date(), updatedAt: new Date(),
  });
}
await makeTeam("Alpha", ["Tina"], ["Ann", "Ben"]);
await makeTeam("Beta", ["Vic"], ["Wes"]);
await makeTeam("Gone", ["Zoe"], ["Wes"], "inactive");

interface ApiBody<T> { success: boolean; message: string; data: T }
async function api<T>(path: string, who: string): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}

/* ── Leads with reminders ────────────────────────────────────────────────── */

let n = 0;
const ASSIGNED = new Date("2026-10-13T08:00:00.000Z"); // Tuesday 12:00 GST
const NOW = new Date("2026-10-19T11:00:00.000Z");      // Monday 15:00 GST — inside every CRM's mover hours
async function lead(owner: string, teamName: string | null, o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "META", status: "assigned",
    assignedTo: ids[owner], assignedAt: ASSIGNED, team: teamName ? team[teamName] : null, reporter: ids.Admin,
    notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    createdAt: ASSIGNED, updatedAt: ASSIGNED, ...o,
  });
  return _id;
}
const soon = new Date(Date.now() + 86_400_000), later = new Date(Date.now() + 2 * 86_400_000);
const rem = (by: string, title: string, isDone = false, at = soon) => ({
  _id: new Types.ObjectId(), createdBy: ids[by], title, remindAt: at, isDone, createdAt: new Date(), updatedAt: new Date(),
});
// Reminders: worked leads (status callback) so they never count as inactive below.
await lead("Ann", "Alpha", { status: "callback", reminders: [rem("Ann", "ann-1"), rem("Ann", "ann-done", true)] });
await lead("Ben", "Alpha", { status: "callback", reminders: [rem("Ben", "ben-1", false, later), rem("Tina", "tina-1")] });
await lead("Wes", "Beta", { status: "callback", reminders: [rem("Wes", "wes-1"), rem("Vic", "vic-1")] });
await lead("Zoe", null, { status: "callback", reminders: [rem("Zoe", "zoe-1")] });

type Item = { _id: string; title: string; isDone: boolean; owner: { _id: string; name: string }; lead: { _id: string; name: string; assignedTo: { name: string } | null; team: { name: string } | null } };
type List = { items: Item[]; capped: boolean };
type Options = { scope: "all" | "team" | null; people: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }> };
const titles = (l: List | undefined) => (l?.items ?? []).map((i) => i.title).sort().join(",");

section("Which button each person gets");
{
  const a = await api<Options>("/leads/reminders/team/options", "Admin");
  check("Super Admin: All reminders, everyone active, the active teams", a.body.data?.scope === "all" && a.body.data.people.length === 8 && a.body.data.teams.map((t) => t.name).join() === "Alpha,Beta", a.body.data);
  const s = await api<Options>("/leads/reminders/team/options", "Sam");
  check("the Sales Manager: All reminders", s.body.data?.scope === "all", s.body.data);
  const t = await api<Options>("/leads/reminders/team/options", "Tina");
  check("a team leader: Team reminders, only their team's people and team", t.body.data?.scope === "team" && t.body.data.people.map((p) => p.name).join() === "Ann,Ben,Tina" && t.body.data.teams.map((x) => x.name).join() === "Alpha", t.body.data);
  const z = await api<Options>("/leads/reminders/team/options", "Zoe");
  check("someone who leads only an inactive team: no button", z.body.data?.scope === null, z.body.data);
  const w = await api<Options>("/leads/reminders/team/options", "Wes");
  check("a team member: no button", w.body.data?.scope === null, w.body.data);
}

section("What each sees");
{
  const a = await api<List>("/leads/reminders/team", "Admin");
  check("Super Admin: everyone's open reminders", titles(a.body.data) === "ann-1,ben-1,tina-1,vic-1,wes-1,zoe-1", titles(a.body.data));
  const s = await api<List>("/leads/reminders/team", "Sam");
  check("the Sales Manager: the same", titles(s.body.data) === titles(a.body.data), titles(s.body.data));
  const t = await api<List>("/leads/reminders/team", "Tina");
  check("Tina (leads Alpha): Ann's, Ben's and her own — not Beta's or Zoe's", titles(t.body.data) === "ann-1,ben-1,tina-1", titles(t.body.data));
  const v = await api<List>("/leads/reminders/team", "Vic");
  check("Vic (leads Beta): Wes's and his own", titles(v.body.data) === "vic-1,wes-1", titles(v.body.data));
  const one = t.body.data.items.find((i) => i.title === "ben-1");
  check("each says who set it, the lead's owner and team", one?.owner.name === "Ben" && one.lead.assignedTo?.name === "Ben" && one.lead.team?.name === "Alpha", one);
  const tina = t.body.data.items.find((i) => i.title === "tina-1");
  check("a reminder set on someone else's lead: set by its setter, the lead with its owner", tina?.owner.name === "Tina" && tina.lead.assignedTo?.name === "Ben", tina);
  const done = await api<List>("/leads/reminders/team?state=done", "Tina");
  check("Done: only the done ones", titles(done.body.data) === "ann-done", titles(done.body.data));
  const every = await api<List>("/leads/reminders/team?state=all", "Tina");
  check("All: open and done", titles(every.body.data) === "ann-1,ann-done,ben-1,tina-1", titles(every.body.data));
  const order = every.body.data.items.map((i) => i.title);
  check("open ones first, soonest first", order.indexOf("ann-done") === 3 && order.indexOf("ben-1") === 2, order);
}

section("Filters stay inside what they may see");
{
  const p = await api<List>(`/leads/reminders/team?person=${ids.Ann}`, "Tina");
  check("Tina, one of her people: only theirs", titles(p.body.data) === "ann-1", titles(p.body.data));
  const out = await api<List>(`/leads/reminders/team?person=${ids.Wes}`, "Tina");
  check("Tina, someone outside her teams: 403", out.status === 403, out.status);
  const tm = await api<List>(`/leads/reminders/team?team=${team.Beta}`, "Tina");
  check("Tina, a team she doesn't lead: 403", tm.status === 403, tm.status);
  const ta = await api<List>(`/leads/reminders/team?team=${team.Beta}`, "Admin");
  check("Super Admin, a team: its leader's and members' reminders", titles(ta.body.data) === "vic-1,wes-1", titles(ta.body.data));
  const both = await api<List>(`/leads/reminders/team?team=${team.Alpha}&person=${ids.Wes}`, "Admin");
  check("a person not in the team asked for: nothing", both.status === 200 && both.body.data.items.length === 0, both.body);
  const bad = await api<List>("/leads/reminders/team?person=nope", "Admin");
  check("a person id that isn't one: 403, not a crash", bad.status === 403, bad.status);
  const st = await api<List>("/leads/reminders/team?state=maybe", "Admin");
  check("a state that isn't one: 400", st.status === 400, st.status);
}

section("Anyone else: only their own");
{
  const w = await api<List>("/leads/reminders/team", "Wes");
  check("a team member asking for the team view: 403", w.status === 403, w.status);
  const z = await api<List>("/leads/reminders/team", "Zoe");
  check("the leader of an inactive team: 403", z.status === 403, z.status);
  const mine = await api<Array<{ title: string }>>("/leads/reminders/mine", "Tina");
  check("My reminders unchanged: Tina's own only", mine.body.data?.map((r) => r.title).join() === "tina-1", mine.body.data);
  const before = await Lead.collection.countDocuments({ "reminders.isDone": true });
  await api<List>("/leads/reminders/team?state=all", "Admin");
  check("looking changes nothing", (await Lead.collection.countDocuments({ "reminders.isDone": true })) === before);
}

section("A team leader's leads are never inactive and never move");
{
  await updateAppSettings({ inactiveLeads: { autoReassign: true, limitMinutes: 30 } } as never, String(ids.Admin));
  await db.collection("appsettings").updateOne({ key: "app" }, { $set: { "inactiveLeads.enabledAt": new Date("2026-10-01T00:00:00.000Z") } });
  await updateAppSettings({} as never, String(ids.Admin));

  const tinas = await lead("Tina", "Alpha");
  const anns = await lead("Ann", "Alpha");
  const vics = await lead("Vic", "Beta");
  const now1 = await svc.inactiveNow(NOW);
  check("a member's untouched lead is inactive", now1.has(String(anns)), [...now1.keys()]);
  check("the leaders' untouched leads are not (Inactive leads page and the Workflow)", !now1.has(String(tinas)) && !now1.has(String(vics)));
  check("teamLeaderIds: the active teams' leaders only", (await svc.teamLeaderIds()).map(String).sort().join() === [ids.Tina, ids.Vic].map(String).sort().join());

  const byHand = await svc.reassignInactiveLeads({ leadIds: [String(tinas)], to: String(ids.Ben) }, String(ids.Admin), NOW);
  const t1 = await Lead.collection.findOne({ _id: tinas });
  check("moving a leader's lead by hand: skipped, still theirs", byHand.moved.length === 0 && String(t1?.assignedTo) === String(ids.Tina), byHand);

  const sweep = await svc.sweepInactiveLeads(NOW);
  const [t2, a2, v2] = await Promise.all([tinas, anns, vics].map((id) => Lead.collection.findOne({ _id: id })));
  check("the automatic mover: the member's lead moved on", String(a2?.assignedTo) !== String(ids.Ann), { sweep, owner: String(a2?.assignedTo) });
  check("the automatic mover: the leaders' leads stay", String(t2?.assignedTo) === String(ids.Tina) && String(v2?.assignedTo) === String(ids.Vic));

  // Vic steps down as leader: his leads count again.
  await db.collection("teams").updateOne({ _id: team.Beta }, { $set: { leaders: [], members: [ids.Wes, ids.Vic] } });
  const now2 = await svc.inactiveNow(NOW);
  check("a leader who steps down: their lead counts again", now2.has(String(vics)), [...now2.keys()]);
}

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
