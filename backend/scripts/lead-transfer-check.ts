/**
 * Transferring a person's leads (the user, 2026-11-10), on a scratch database:
 *
 *   Who        Super Admins, the Sales Manager, roles that may edit users — nobody else (403)
 *   What       only open leads move; closed and lost stay; open reminders go with them, done ones don't
 *   How many   to one person, evenly, or the counts given (they must add up); never to themselves or someone
 *              deactivated; one lead at a time
 *   Team       the new owner's team (the one they lead, else theirs) — a lead already in one of theirs stays; someone
 *              in no team keeps the lead's team (and the preview warns)
 *   As new     the hand-over rule: status Assigned, dated now, first date kept
 *   Undo       24 hours, untouched leads back exactly (owner, team, status, dates, follow-up date, reminders); a
 *              touched one stays; not twice; not once the person is deactivated
 *   Removing   delete / deactivate refused while they hold open leads; with history → deactivated, not erased;
 *              with none → deleted and taken off their teams
 *
 * Run by lead-transfer-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "lead-transfer-check-jwt-0123456789", JWT_REFRESH_SECRET: "lead-transfer-check-refresh-0123456789",
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
const superRole = new Types.ObjectId(), staffRole = new Types.ObjectId(), hrRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: perms({ leads: { view: true, edit: true }, users: { view: true } }) },
  { _id: hrRole, roleName: "People", isSystemRole: false, permissions: perms({ users: { view: true, edit: true, delete: true } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role = staffRole, status = "active") {
  const _id = new Types.ObjectId();
  ids[name] = _id;
  const email = `${name.toLowerCase()}@test.local`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role, status, createdAt: new Date(), updatedAt: new Date() });
  tokens[name] = signAccessToken({ userId: String(_id), email, roleId: String(role) });
}
await person("Admin", superRole);
await person("Hana", hrRole);
for (const n of ["Sam", "Tina", "Ann", "Ben", "Vic", "Wes", "Zoe", "Nia"]) await person(n);
await person("Old", staffRole, "inactive");
// Sam: the Sales Manager. Tina leads Alpha (Ann, Ben). Vic leads Beta (Wes, Nia). Zoe is in no team.
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
await makeTeam("Beta", ["Vic"], ["Wes", "Nia"]);

interface ApiBody<T> { success: boolean; message: string; data: T }
async function api<T>(method: string, path: string, who: string, body?: unknown): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}

/* ── Ann's leads: 6 open (one in follow-up with a date), 2 closed, 1 lost ─── */
let n = 0;
const ASSIGNED = new Date("2026-10-13T08:00:00.000Z");
const FIRST = new Date("2026-09-01T08:00:00.000Z");
const FOLLOW = new Date(Date.now() + 3 * 86_400_000);
const rem = (by: string, title: string, isDone = false) => ({
  _id: new Types.ObjectId(), createdBy: ids[by], title, remindAt: new Date(Date.now() + 86_400_000), isDone, createdAt: new Date(), updatedAt: new Date(),
});
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
const annOpen = [
  await lead("Ann", "Alpha", { status: "followup", nextFollowUpAt: FOLLOW, originalCreatedAt: FIRST, reminders: [rem("Ann", "call back"), rem("Ann", "done one", true), rem("Tina", "tina's")] }),
  await lead("Ann", "Alpha"),
  await lead("Ann", "Alpha", { status: "cnc" }),
  await lead("Ann", "Beta", { status: "callback" }),
  await lead("Ann", null, { status: "new" }),
  await lead("Ann", "Alpha", { status: "not_connected" }),
];
const annClosed = [await lead("Ann", "Alpha", { status: "closed" }), await lead("Ann", "Alpha", { status: "closed" })];
const annLost = await lead("Ann", "Alpha", { status: "lost" });
const get = async (id: Types.ObjectId) => (await Lead.collection.findOne({ _id: id }))!;
const before = await Promise.all(annOpen.map(get));

/* ── Who may ──────────────────────────────────────────────────────────────── */
section("Who may transfer");
check("someone who can't edit users → 403", (await api("GET", `/lead-transfers/users/${ids.Ann}`, "Ben")).status === 403);
check("a Super Admin, the Sales Manager and a role that edits users may",
  (await api("GET", `/lead-transfers/users/${ids.Ann}`, "Admin")).status === 200
  && (await api("GET", `/lead-transfers/users/${ids.Ann}`, "Sam")).status === 200
  && (await api("GET", `/lead-transfers/users/${ids.Ann}`, "Hana")).status === 200);
let r = await api<{ open: number; closed: number; lost: number }>("GET", `/lead-transfers/users/${ids.Ann}`, "Admin");
check("Ann: 6 open, 2 closed, 1 lost", r.body.data.open === 6 && r.body.data.closed === 2 && r.body.data.lost === 1, r.body.data);

/* ── Preview ─────────────────────────────────────────────────────────────── */
section("Preview: who gets how many, in which team");
type Plan = { open: number; targets: Array<{ name: string; count: number; team: { name: string } | null }>; warnings: string[] };
r = await api<Plan>("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Vic }, { userId: ids.Tina }, { userId: ids.Wes }, { userId: ids.Zoe }] }) as never;
let pl = r.body.data as unknown as Plan;
check("evenly between four: 2, 2, 1, 1", pl.targets.map((t) => t.count).join() === "2,2,1,1", pl);
check("…each with their team: Vic leads Beta, Tina leads Alpha, Wes is in Beta, Zoe none (warned)",
  pl.targets.map((t) => t.team?.name ?? "-").join() === "Beta,Alpha,Beta,-" && pl.warnings.length === 1 && /Zoe/.test(pl.warnings[0]!), pl);
r = await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Vic, count: 5 }, { userId: ids.Tina, count: 1 }] });
check("counts given: 5 and 1", (r.body.data as unknown as Plan).targets.map((t) => t.count).join() === "5,1", r.body);
check("counts that don't add up to the 6 → 400", (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Vic, count: 4 }, { userId: ids.Tina, count: 1 }] })).status === 400);
check("some counts and not others → 400", (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Vic, count: 6 }, { userId: ids.Tina }] })).status === 400);
check("to Ann herself, someone deactivated, the same person twice, nobody → 400",
  (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Ann }] })).status === 400
  && (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Old }] })).status === 400
  && (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [{ userId: ids.Vic }, { userId: ids.Vic }] })).status === 400
  && (await api("POST", `/lead-transfers/users/${ids.Ann}/preview`, "Admin", { targets: [] })).status === 400);
check("a preview moves nothing", (await Lead.countDocuments({ assignedTo: ids.Ann })) === 9);

/* ── Transfer: split between Vic (Beta) and Tina (Alpha), 3 each ─────────── */
section("Split between Vic and Tina");
r = await api<{ id: string; moved: number; targets: Array<{ name: string; count: number }> }>("POST", `/lead-transfers/users/${ids.Ann}`, "Sam", { targets: [{ userId: ids.Vic }, { userId: ids.Tina }] }) as never;
const done = r.body.data as unknown as { id: string; moved: number; targets: Array<{ name: string; count: number }> };
check("6 moved: 3 to Vic, 3 to Tina", r.status === 200 && done.moved === 6 && done.targets.map((t) => `${t.name}:${t.count}`).join() === "Vic:3,Tina:3", r.body);
const after = await Promise.all(annOpen.map(get));
const toVic = after.filter((l) => String(l.assignedTo) === String(ids.Vic));
const toTina = after.filter((l) => String(l.assignedTo) === String(ids.Tina));
check("…taken in turn, oldest first: Vic, Tina, Vic…", String(after[0]!.assignedTo) === String(ids.Vic) && String(after[1]!.assignedTo) === String(ids.Tina) && String(after[2]!.assignedTo) === String(ids.Vic));
check("Vic's are in Beta, the team he leads (whatever team they were in)", toVic.length === 3 && toVic.every((l) => String(l.team) === String(team.Beta)), toVic.map((l) => l.team));
check("Tina's are in Alpha — the one in Beta too, the lead with no team too", toTina.length === 3 && toTina.every((l) => String(l.team) === String(team.Alpha)), toTina.map((l) => l.team));
check("as new for them: status Assigned, dated now, first date kept", after.every((l) => l.status === "assigned" && Date.now() - new Date(l.createdAt).getTime() < 60_000)
  && after[0]!.originalCreatedAt?.toISOString() === FIRST.toISOString(), after.map((l) => [l.status, l.createdAt]));
const r0 = after[0]!.reminders as Array<{ title: string; createdBy: Types.ObjectId }>;
check("Ann's open reminder went with it; her done one and Tina's stayed whose they were",
  String(r0.find((x) => x.title === "call back")!.createdBy) === String(ids.Vic)
  && String(r0.find((x) => x.title === "done one")!.createdBy) === String(ids.Ann)
  && String(r0.find((x) => x.title === "tina's")!.createdBy) === String(ids.Tina));
check("each says so in its history", after.every((l) => (l.activityLogs as Array<{ action: string; description: string }>).some((a) => a.action === "lead_transferred" && /from Ann to (Vic|Tina) by Sam/.test(a.description))));
check("closed and lost leads stayed with Ann", (await Lead.countDocuments({ _id: { $in: [...annClosed, annLost] }, assignedTo: ids.Ann })) === 3);
const batch = await db.collection("leadtransfers").findOne({});
check("the transfer is recorded: from, by, who got how many, every lead", batch?.fromName === "Ann" && batch.byName === "Sam" && batch.items.length === 6 && batch.moved === 6, batch && { ...batch, items: batch.items.length });
r = await api<Array<{ id: string; mayUndo: boolean }>>("GET", "/lead-transfers", "Admin") as never;
check("…and listed, with Undo open", (r.body.data as unknown as Array<{ id: string; mayUndo: boolean }>)[0]?.mayUndo === true);

/* ── Undo ────────────────────────────────────────────────────────────────── */
section("Undo");
// Vic works one of his straight away: it stays with him.
await Lead.updateOne({ _id: annOpen[0] }, { $push: { activityLogs: { action: "note_added", description: "Called", performedBy: ids.Vic, createdAt: new Date(Date.now() + 1000) } } });
r = await api<{ undone: number; skipped: number }>("POST", `/lead-transfers/${done.id}/undo`, "Admin") as never;
check("5 back to Ann, the one Vic worked stays with him", r.status === 200 && (r.body.data as unknown as { undone: number; skipped: number }).undone === 5
  && (r.body.data as unknown as { skipped: number }).skipped === 1 && String((await get(annOpen[0]!)).assignedTo) === String(ids.Vic), r.body);
const back = await Promise.all(annOpen.slice(1).map(get));
check("…exactly as they were: owner, team, status, dated as before", back.every((l, i) => String(l.assignedTo) === String(ids.Ann)
  && String(l.team) === String(before[i + 1]!.team) && l.status === before[i + 1]!.status && new Date(l.createdAt).getTime() === new Date(before[i + 1]!.createdAt).getTime()),
  back.map((l) => [l.status, l.team, l.createdAt]));
check("not twice", (await api("POST", `/lead-transfers/${done.id}/undo`, "Admin")).status === 409);

// A follow-up lead's date comes back with Undo.
await Lead.collection.updateOne({ _id: annOpen[1] }, { $set: { status: "followup", nextFollowUpAt: FOLLOW } });
r = await api("POST", `/lead-transfers/users/${ids.Ann}`, "Admin", { targets: [{ userId: ids.Zoe }] });
const zoeBatch = (r.body.data as unknown as { id: string }).id;
const z = await get(annOpen[1]!);
// A CRM whose leads carry a next follow-up date: the hand-over clears it, Undo puts it back. One without: left alone.
const dated = !!Lead.schema.path("nextFollowUpAt");
check(`to Zoe (in no team): the lead keeps its team${dated ? "; the hand-over clears the follow-up date" : ""}`,
  String(z.assignedTo) === String(ids.Zoe) && String(z.team) === String(team.Alpha) && (dated ? z.nextFollowUpAt == null : true), z);
await api("POST", `/lead-transfers/${zoeBatch}/undo`, "Admin");
const zb = await get(annOpen[1]!);
check(`…Undo puts it back${dated ? " with its follow-up date" : ""}`, String(zb.assignedTo) === String(ids.Ann) && zb.status === "followup"
  && new Date(zb.nextFollowUpAt).getTime() === FOLLOW.getTime(), zb);

/* ── Removing someone ────────────────────────────────────────────────────── */
section("Deleting or deactivating someone with leads");
r = await api("DELETE", `/users/${ids.Ann}`, "Admin");
check("Delete while Ann holds open leads → 409, says how many", r.status === 409 && /5 open leads — transfer them first/.test(r.body.message), r.body);
r = await api("PUT", `/users/${ids.Ann}`, "Admin", { status: "inactive" });
check("…and so does deactivating her (Edit)", r.status === 409 && /transfer them first/.test(r.body.message), r.body);
r = await api("POST", `/lead-transfers/users/${ids.Ann}`, "Hana", { targets: [{ userId: ids.Wes, count: 4 }, { userId: ids.Nia, count: 1 }], reason: "remove" });
check("her 5 go to Wes (4) and Nia (1)", r.status === 200 && (r.body.data as unknown as { moved: number }).moved === 5, r.body);
r = await api("DELETE", `/users/${ids.Ann}`, "Admin");
const ann = await db.collection("users").findOne({ _id: ids.Ann });
check("then Delete: deactivated, not erased — she has closed and lost leads", r.status === 200 && ann?.status === "inactive" && /deactivated, not deleted/.test(r.body.message), r.body);
check("…her closed and lost leads keep her name", (await Lead.countDocuments({ assignedTo: ids.Ann, status: { $in: ["closed", "lost"] } })) === 3);
const last = (await db.collection("leadtransfers").find({}).sort({ createdAt: -1 }).limit(1).toArray())[0]!;
check("Undo refused once she's deactivated", (await api("POST", `/lead-transfers/${last._id}/undo`, "Admin")).status === 409);
r = await api("DELETE", `/users/${ids.Zoe}`, "Admin");
check("Zoe holds no leads and has no history: deleted outright", r.status === 200 && !(await db.collection("users").findOne({ _id: ids.Zoe })), r.body);
await db.collection("leads").deleteMany({ assignedTo: ids.Nia });
r = await api("DELETE", `/users/${ids.Nia}`, "Admin");
const beta = await db.collection("teams").findOne({ _id: team.Beta });
check("someone with no leads at all is deleted and taken off their team", r.status === 200 && !(await db.collection("users").findOne({ _id: ids.Nia }))
  && !(beta?.members ?? []).some((m: Types.ObjectId) => String(m) === String(ids.Nia)), beta?.members);

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
