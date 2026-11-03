/**
 * A team leader's own leads and the team a lead joins when it is given to someone (the owner, 2026-11-02: a team
 * leader's leads filed under another team were nowhere on their Leads page):
 *
 *   - Case 1: the Leads page for a team leader — every team they lead, and every lead given to them wherever it sits;
 *     not another team's leads held by others; filters only narrow it; a member still sees only their own.
 *   - Case 2: a lead given to someone joins their team (one they lead first), through save, updateOne, updateMany and
 *     findOneAndUpdate; one already in one of their teams stays; an update naming the team keeps it; someone in no team
 *     leaves it; a new lead with no team gets its owner's; a new lead with a team keeps it.
 *   - Case 3: lead sources → teams (2026-11-03) — a source with teams set is split only to them (whatever its case);
 *     one with none to the teams with auto-assign on; teams picked by hand ignore the rules; the Teams-page API is the
 *     Super Admin's, lists the sources, sets and clears a rule.
 *
 * Run by team-on-assign-check.sh (a throwaway mongod). Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a local scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  JWT_SECRET: "team-assign-check-throwaway-access-secret-1",
  JWT_REFRESH_SECRET: "team-assign-check-throwaway-refresh-secret",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", WHATSAPP: "off",
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const jwtUtils = await import("../src/utils/jwt.js");
const { Lead } = await import("../src/models/Lead.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/* ── People and teams: Mia leads Digital (and is in no other); Ann and Bo in Alpha (led by Lee); Zed in none ── */
const staffRole = new Types.ObjectId(), superRole = new Types.ObjectId();
const perms = { leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false } };
await db.collection("roles").insertMany([
  { _id: staffRole, roleName: "BDE", isSystemRole: false, permissions: perms },
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
]);
const ids: Record<string, Types.ObjectId> = {};
for (const n of ["Mia", "Lee", "Ann", "Bo", "Zed", "Duo"]) {
  ids[n] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[n], name: n, email: `${n.toLowerCase()}@ta.test`, password: "x", role: staffRole, status: "active" });
}
const team = { digital: new Types.ObjectId(), alpha: new Types.ObjectId(), beta: new Types.ObjectId(), old: new Types.ObjectId() };
await db.collection("teams").insertMany([
  { _id: team.alpha, name: "Alpha", status: "active", leaders: [ids.Lee], members: [ids.Ann, ids.Bo, ids.Duo], createdAt: new Date(1) },
  { _id: team.digital, name: "Digital", status: "active", leaders: [ids.Mia], members: [], createdAt: new Date(2) },
  // Duo: a member of Alpha, leader of Beta — a lead given to him goes to Beta.
  { _id: team.beta, name: "Beta", status: "active", leaders: [ids.Duo], members: [], createdAt: new Date(3) },
  { _id: team.old, name: "Old", status: "inactive", leaders: [], members: [ids.Zed], createdAt: new Date(4) },
]);
const token = (n: string) => jwtUtils.signAccessToken({ userId: String(ids[n]), email: `${n.toLowerCase()}@ta.test`, roleId: String(staffRole) });
async function names(who: string, q = ""): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/leads?limit=100${q}`, { headers: { authorization: `Bearer ${token(who)}` } });
  const body = (await res.json()) as { data?: { name: string }[] };
  return (body.data ?? []).map((l) => l.name).sort();
}
let n = 0;
const raw = (name: string, owner: string | null, t: Types.ObjectId | null) => ({
  _id: new Types.ObjectId(), name, phone: `+97150${1_000_000 + ++n}`, status: owner ? "assigned" : "new", assignedTo: owner ? ids[owner] : null,
  team: t, reporter: ids.Lee, activityLogs: [], notes: [], payments: [], followUps: [], reminders: [], createdAt: new Date(), updatedAt: new Date(),
});

try {
  section("Case 1 — a team leader's Leads page");
  // Straight into the collection: as the live data stands (Mia's leads filed under Alpha).
  await db.collection("leads").insertMany([
    raw("Mia's in Alpha", "Mia", team.alpha), raw("Mia's in Digital", "Mia", team.digital), raw("Digital, no holder", null, team.digital),
    raw("Ann's in Alpha", "Ann", team.alpha), raw("Bo's, no team", "Bo", null), raw("Zed's", "Zed", null),
  ]);
  check("Mia (leads Digital): her team's, and her own filed under Alpha — not Ann's", JSON.stringify(await names("Mia")) === JSON.stringify(["Digital, no holder", "Mia's in Alpha", "Mia's in Digital"]), await names("Mia"));
  check("…filtered to her own: only hers", JSON.stringify(await names("Mia", `&assignedTo=${ids.Mia}`)) === JSON.stringify(["Mia's in Alpha", "Mia's in Digital"]), await names("Mia", `&assignedTo=${ids.Mia}`));
  check("…filtered to Alpha: only her own there (not Ann's)", JSON.stringify(await names("Mia", `&team=${team.alpha}`)) === JSON.stringify(["Mia's in Alpha"]), await names("Mia", `&team=${team.alpha}`));
  check("…filtered to Ann: nothing", (await names("Mia", `&assignedTo=${ids.Ann}`)).length === 0, await names("Mia", `&assignedTo=${ids.Ann}`));
  check("Lee (leads Alpha): Alpha's leads (Mia's and Ann's)", JSON.stringify(await names("Lee")) === JSON.stringify(["Ann's in Alpha", "Mia's in Alpha"]), await names("Lee"));
  check("Ann (a member): only her own", JSON.stringify(await names("Ann")) === JSON.stringify(["Ann's in Alpha"]), await names("Ann"));
  await db.collection("leads").deleteMany({});

  section("Case 2 — a lead given to someone joins their team");
  const teamOf = async (id: Types.ObjectId) => String((await db.collection("leads").findOne({ _id: id }))?.team ?? null);
  const put = async (doc: ReturnType<typeof raw>) => { await db.collection("leads").insertOne(doc); return doc._id; };

  // save()
  let id = await put(raw("S1", "Ann", team.alpha));
  let doc = await Lead.findById(id);
  doc!.assignedTo = ids.Mia as never;
  await doc!.save();
  check("save: given to Mia → Digital", await teamOf(id) === String(team.digital), await teamOf(id));
  id = await put(raw("S2", "Bo", team.alpha));
  doc = await Lead.findById(id);
  doc!.assignedTo = ids.Ann as never;
  await doc!.save();
  check("save: Bo → Ann, already in Alpha: stays", await teamOf(id) === String(team.alpha), await teamOf(id));
  id = await put(raw("S3", "Ann", team.alpha));
  doc = await Lead.findById(id);
  doc!.assignedTo = ids.Zed as never;
  await doc!.save();
  check("save: given to Zed (in no active team): left in Alpha", await teamOf(id) === String(team.alpha), await teamOf(id));
  id = await put(raw("S4", "Ann", team.alpha));
  doc = await Lead.findById(id);
  doc!.assignedTo = ids.Mia as never;
  doc!.team = team.beta as never;
  await doc!.save();
  check("save: owner and team set together: the team given stands", await teamOf(id) === String(team.beta), await teamOf(id));

  // updateOne / findOneAndUpdate / updateMany
  id = await put(raw("U1", null, team.alpha));
  await Lead.updateOne({ _id: id }, { $set: { assignedTo: ids.Mia } });
  check("updateOne: given to Mia → Digital", await teamOf(id) === String(team.digital), await teamOf(id));
  id = await put(raw("U2", "Ann", null));
  await Lead.findByIdAndUpdate(id, { $set: { assignedTo: ids.Bo } });
  check("findByIdAndUpdate: no team, given to Bo → Alpha", await teamOf(id) === String(team.alpha), await teamOf(id));
  id = await put(raw("U3", "Ann", team.alpha));
  await Lead.updateOne({ _id: id }, { $set: { assignedTo: ids.Mia, team: team.alpha } });
  check("updateOne naming the team: it stands", await teamOf(id) === String(team.alpha), await teamOf(id));
  id = await put(raw("U4", "Ann", team.alpha));
  await Lead.updateOne({ _id: id }, { $set: { assignedTo: ids.Duo } });
  check("given to Duo (member of Alpha, leader of Beta): already in Alpha — stays", await teamOf(id) === String(team.alpha), await teamOf(id));
  id = await put(raw("U5", "Mia", team.digital));
  await Lead.updateOne({ _id: id }, { $set: { assignedTo: ids.Duo } });
  check("…from Digital: to Beta, the team he leads", await teamOf(id) === String(team.beta), await teamOf(id));
  const many = [await put(raw("M1", "Ann", team.alpha)), await put(raw("M2", null, null)), await put(raw("M3", "Bo", team.digital))];
  await Lead.updateMany({ _id: { $in: many } }, { $set: { assignedTo: ids.Ann } });
  check("updateMany: each to Ann's team — the one in Alpha stays, the rest join it", (await Promise.all(many.map(teamOf))).every((t) => t === String(team.alpha)), await Promise.all(many.map(teamOf)));
  id = await put(raw("U6", "Ann", team.alpha));
  await Lead.updateOne({ _id: id }, { $set: { assignedTo: null } });
  check("unassigned: the team stays", await teamOf(id) === String(team.alpha), await teamOf(id));

  // New leads
  const created = await Lead.create({ name: "N1", phone: "+971509999001", status: "assigned", assignedTo: ids.Mia, reporter: ids.Lee });
  check("a new lead with no team, given to Mia: Digital", await teamOf(created._id as Types.ObjectId) === String(team.digital));
  const kept = await Lead.create({ name: "N2", phone: "+971509999002", status: "assigned", assignedTo: ids.Mia, team: team.alpha, reporter: ids.Lee });
  check("a new lead with a team: it stands", await teamOf(kept._id as Types.ObjectId) === String(team.alpha));
  const nobody = await Lead.create({ name: "N3", phone: "+971509999003", status: "new", reporter: ids.Lee });
  check("a new lead with no owner: no team", await teamOf(nobody._id as Types.ObjectId) === "null");

  section("Case 3 — lead sources → teams");
  await db.collection("leads").deleteMany({});
  // Alpha and Beta split automatically; Digital doesn't.
  await db.collection("teams").updateMany({ _id: { $in: [team.alpha, team.beta] } }, { $set: { "settings.autoAssign": true, "settings.splitMode": "round_robin", "settings.splitStrategy": "live" } });
  await db.collection("teams").updateOne({ _id: team.digital }, { $set: { "settings.autoAssign": false } });
  const { LeadService } = await import("../src/services/leadService.js");
  const svc = new LeadService();
  const fresh = async (source: string, count: number) => {
    const docs = Array.from({ length: count }, (_, i) => ({ ...raw(`${source} ${i}`, null, null), status: "new", source }));
    await db.collection("leads").insertMany(docs);
    return docs.map((d) => String(d._id));
  };
  const teamsOfLeads = async (leadIds: string[]) => (await db.collection("leads").find({ _id: { $in: leadIds.map((x) => new Types.ObjectId(x)) } }).toArray()).map((l) => String(l.team ?? null));
  let got = await teamsOfLeads(await fresh("Sheet A", 6).then(async (x) => { await svc.autoAssignLeads(x); return x; }));
  check("no rule: only the teams with auto-assign on (Alpha, Beta) — never Digital", got.every((t) => t === String(team.alpha) || t === String(team.beta)) && got.includes(String(team.alpha)) && got.includes(String(team.beta)), got);
  await db.collection("lead_source_teams").insertOne({ key: "forex", source: "FOREX", teams: [team.digital], updatedByName: "x", createdAt: new Date(), updatedAt: new Date() });
  got = await teamsOfLeads(await fresh(" Forex ", 4).then(async (x) => { await svc.autoAssignLeads(x); return x; }));
  check("a rule (FOREX → Digital): every \" Forex \" lead to Digital, auto-assign off or not", got.every((t) => t === String(team.digital)), got);
  got = await teamsOfLeads(await fresh("FOREX", 3).then(async (x) => { await svc.autoAssignLeads(x, [String(team.alpha)]); return x; }));
  check("teams picked by hand: the rule doesn't apply", got.every((t) => t === String(team.alpha)), got);
  await db.collection("lead_source_teams").updateOne({ key: "forex" }, { $set: { teams: [new Types.ObjectId()] } });
  got = await teamsOfLeads(await fresh("FOREX", 2).then(async (x) => { await svc.autoAssignLeads(x).catch(() => null); return x; }));
  check("a rule whose team is gone: the leads wait unsplit (no team)", got.every((t) => t === "null"), got);
  await db.collection("lead_source_teams").deleteMany({});

  // The Teams-page API
  const superId = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: superId, name: "Root", email: "root@ta.test", password: "x", role: superRole, status: "active" });
  const rootToken = jwtUtils.signAccessToken({ userId: String(superId), email: "root@ta.test", roleId: String(superRole) });
  const call = async (method: string, path: string, tok: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: any; message?: string } };
  };
  let r = await call("GET", "/teams/source-rules", token("Lee"));
  check("the rules are the Super Admin's: a team leader is refused", r.status === 403, r.status);
  r = await call("GET", "/teams/source-rules", rootToken);
  const sheetA = (r.body.data?.sources ?? []).find((x: any) => x.source === "Sheet A");
  check("Super Admin: every source with its leads (Sheet A: 6), the teams with auto-assign", r.status === 200 && sheetA?.leads === 6 && sheetA.teams.length === 0
    && r.body.data.teams.find((t: any) => t.name === "Digital")?.autoAssign === false, { s: r.status, sheetA, teams: r.body.data?.teams });
  r = await call("PUT", "/teams/source-rules", rootToken, { source: "Sheet A", teams: [String(team.beta)] });
  check("set: Sheet A → Beta", r.status === 200 && (await db.collection("lead_source_teams").findOne({ key: "sheet a" }))?.teams?.map(String).join() === String(team.beta), r);
  got = await teamsOfLeads(await fresh("sheet a", 3).then(async (x) => { await svc.autoAssignLeads(x); return x; }));
  check("…and its next leads go to Beta only", got.every((t) => t === String(team.beta)), got);
  r = await call("PUT", "/teams/source-rules", rootToken, { source: "Sheet A", teams: [String(new Types.ObjectId())] });
  check("a team that doesn't exist: refused", r.status === 404, r.status);
  r = await call("PUT", "/teams/source-rules", rootToken, { source: "Sheet A", teams: [] });
  check("cleared: back to the default", r.status === 200 && !(await db.collection("lead_source_teams").findOne({ key: "sheet a" })), r);
  r = await call("PUT", "/teams/source-rules", rootToken, { source: "", teams: [] });
  check("bad input: refused", r.status === 400, r.status);
} finally {
  server.close();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
