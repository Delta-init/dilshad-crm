/**
 * Checks the lead workflow (Inactive Leads → Workflow, and /service/lead-workflow for Root) on a scratch database —
 * as the Sales CRM's, but this Remote CRM keeps no breaks, so a lead whose owner is on a break just waits:
 *
 *   - Case 1: one Monday's leads — came in (first created that day, a hand-over keeps the first day), assigned or
 *     not, worked (status, note, a call by anyone), fresh, moved automatically or only by hand, inactive now with
 *     the owner on a break, nobody left, or waiting; the statuses, the hours, each team, each person (held, theirs
 *     now, lost, got, break minutes) and who lost leads to whom;
 *   - Case 2: a team, one person, two days, a day with nothing;
 *   - Case 3: bad days, the start after the end, more than 92 days, a bad id — 400;
 *   - Case 4: signed out, a role without the Inactive Leads box, the box's viewers; Root's secret.
 *
 * Run by lead-workflow-check.sh. Scratch database only.
 */
import { Types } from "mongoose";
import type { LeadWorkflow } from "../src/services/leadWorkflowService.js";

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
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
const SECRET = "lead-workflow-check-root-secret-0123456789";
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "lead-workflow-check-jwt", JWT_REFRESH_SECRET: "lead-workflow-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", ROOT_ERP_SECRET: SECRET,
  HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { Lead } = await import("../src/models/Lead.js");
const { LeadMove } = await import("../src/models/LeadMove.js");
const { CallLog } = await import("../src/models/CallLog.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");
const { AppSetting } = await import("../src/models/AppSetting.js");
const { leadWorkflow } = await import("../src/services/leadWorkflowService.js");

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
async function api<T>(path: string, who: string | null, headers: Record<string, string> = {}): Promise<{ status: number; body: { data: T; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data: T; message: string } };
}

/* ── People, roles, teams ── */
const perms = (m: Record<string, Record<string, boolean>>) => Object.fromEntries(Object.entries(m).map(([k, v]) =>
  [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));
const role = { superAdmin: new Types.ObjectId(), staff: new Types.ObjectId(), viewer: new Types.ObjectId() };
await db.collection("roles").insertMany([
  { _id: role.superAdmin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: role.staff, roleName: "Sales Staff", isSystemRole: false, permissions: perms({ leads: { view: true } }) },
  { _id: role.viewer, roleName: "Inactive Viewer", isSystemRole: false, permissions: perms({ "inactive-leads": { view: true } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, r: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  const email = `${name.toLowerCase()}@test.local`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role: r, status: "active", ...extra });
  ids[name] = _id;
  tokens[name] = signAccessToken({ userId: String(_id), email, roleId: String(r) });
}
const gst = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+04:00`);
const SUN = "2026-10-18", MON = "2026-10-19";
const NOW = gst(MON, "17:00");

await person("Admin", role.superAdmin);
await person("Ann", role.staff);
await person("Ben", role.staff);
await person("Cat", role.staff, { breakSince: gst(MON, "16:30") });
await person("Dan", role.staff);
await person("Sam", role.staff);
await person("Vic", role.viewer);
const team = { Alpha: new Types.ObjectId(), Beta: new Types.ObjectId() };
const teamSettings = { autoAssign: true, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0, includedMembers: [],
  roundRobinStartDate: null, sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false };
await db.collection("teams").insertMany([
  { _id: team.Alpha, name: "Alpha", leaders: [], members: [ids.Ann, ids.Ben, ids.Cat], inactiveMembers: [], absentToday: [], status: "active", settings: teamSettings },
  { _id: team.Beta, name: "Beta", leaders: [], members: [ids.Dan], inactiveMembers: [], absentToday: [], status: "active", settings: teamSettings },
]);
await AppSetting.init();
await updateAppSettings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } }, String(ids.Admin));
await AppSetting.collection.updateOne({ key: "app" }, { $set: { "inactiveLeads.enabledAt": gst(MON, "08:00") } });
await updateAppSettings({}, String(ids.Admin));

/* ── Monday's leads ── */
let seq = 0;
const L: Record<string, Types.ObjectId> = {};
function lead(key: string, o: { owner?: Types.ObjectId | null; team?: Types.ObjectId; status?: string; created?: Date; original?: Date; assigned?: Date; extra?: Record<string, unknown> }) {
  const _id = new Types.ObjectId();
  L[key] = _id;
  const owner = o.owner === undefined ? null : o.owner;
  const created = o.created ?? gst(MON, "13:00");
  return {
    _id, name: key, phone: `+9715${String(10_000_000 + ++seq)}`, email: `l${seq}@test.local`, source: "META",
    status: o.status ?? (owner ? "assigned" : "new"), assignedTo: owner, assignedAt: owner ? o.assigned ?? created : null,
    team: o.team ?? team.Alpha, reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [],
    callCount: 0, firstContactTime: null, createdAt: created, updatedAt: created,
    ...(o.original ? { originalCreatedAt: o.original } : {}), ...o.extra,
  };
}
await Lead.collection.insertMany([
  lead("Worked status", { owner: ids.Ann, status: "followup" }),
  lead("Worked note", { owner: ids.Ann, extra: { notes: [{ _id: new Types.ObjectId(), author: ids.Ann, content: "Rang back", createdAt: gst(MON, "13:20") }] } }),
  lead("Called", { owner: ids.Ben, created: gst(MON, "09:15") }),
  lead("Moved auto", { owner: ids.Ben, assigned: gst(MON, "14:00") }),
  lead("Moved hand", { owner: ids.Cat, status: "followup", assigned: gst(MON, "15:00") }),
  lead("On break", { owner: ids.Cat }),
  lead("Nobody left", { owner: ids.Dan, team: team.Beta, extra: { inactivity: { lostBy: [], moves: 0, stuckAt: gst(MON, "15:00") } } }),
  lead("Waiting", { owner: ids.Ann }),
  lead("Fresh", { owner: ids.Ann, created: gst(MON, "16:40") }),
  lead("Unassigned", { owner: null, created: gst(MON, "18:10") }),
  lead("Closed", { owner: ids.Ann, status: "closed", created: gst(MON, "10:05") }),
  // Not Monday's: came in on Sunday — one of them handed over on Monday, which keeps its first day.
  lead("Sunday", { owner: ids.Ann, created: gst(SUN, "12:00") }),
  lead("Handed over", { owner: ids.Ben, created: gst(MON, "13:00"), original: gst(SUN, "11:00") }),
]);
await CallLog.collection.insertOne({ leadId: L["Called"], callType: "Outbound", callDirection: "outbound", userId: ids.Cat, createdAt: gst(MON, "10:00") });
await LeadMove.collection.insertMany([
  { lead: L["Moved auto"], leadName: "Moved auto", team: team.Alpha, from: ids.Ann, to: ids.Ben, kind: "automatic", by: null, inactiveMinutes: 45, createdAt: gst(MON, "14:00") },
  { lead: L["Moved hand"], leadName: "Moved hand", team: team.Alpha, from: ids.Ben, to: ids.Cat, kind: "manual", by: ids.Admin, inactiveMinutes: 60, createdAt: gst(MON, "15:00") },
]);

/* ═══ Case 1 ═══ */
section("Case 1 — Monday, at 17:00");
const w: LeadWorkflow = await leadWorkflow({ from: MON, to: MON }, NOW);
const t = w.totals;
same("came in: 11 (Sunday's, and the one first created Sunday, left out)", t.came, 11);
same("assigned 10, not assigned 1", [t.assigned, t.unassigned], [10, 1]);
same("worked 4 — status, note, a colleague's call, closed", t.worked, 4);
same("fresh 1 — 20 minutes in, under the limit", t.fresh, 1);
same("went inactive 5: moved auto 1, by hand 1, nobody left 1, waiting 2 (no break pause in this CRM)",
  [t.inactive, t.movedAuto, t.movedHand, t.onBreak, t.nobodyLeft, t.waiting], [5, 1, 1, 0, 1, 2]);
check("every assigned lead is in exactly one place", t.worked + t.fresh + t.inactive === t.assigned, t);
same("two moves", t.moves, 2);
same("statuses now, most first", w.statuses.map((s) => `${s.status}:${s.count}`).sort(), ["assigned:7", "closed:1", "followup:2", "new:1"]);
const wh = (await AppSetting.findOne({ key: "app" }).lean())!.workingHours;
same("the rule: 45 min, in the working hours, no breaks here", [w.rule.limitMinutes, w.rule.hours.start, w.rule.hours.end, w.rule.breaks], [45, wh.start, wh.end, false]);
same("hours: one day → 24 hours", [w.timeline.unit, w.timeline.rows.length], ["hour", 24]);
same("…by the hour they came in: 09 1, 10 1, 13 7, 16 1, 18 1", Object.fromEntries(w.timeline.rows.filter((r) => r.came).map((r) => [r.key, r.came])), { "09": 1, "10": 1, "13": 7, "16": 1, "18": 1 });
const alpha = w.teams.find((x) => x.name === "Alpha"), beta = w.teams.find((x) => x.name === "Beta");
same("Alpha: 10 came, 1 unassigned, 4 worked", [alpha?.came, alpha?.unassigned, alpha?.worked], [10, 1, 4]);
same("Beta: 1 came, nobody left to take it", [beta?.came, beta?.nobodyLeft], [1, 1]);
const P = (n: string) => w.people.find((p) => p.name === n);
same("Ann: held 6 (5 hers now + 1 moved away), lost 1, worked 3, fresh 1, inactive now 1",
  [P("Ann")?.held, P("Ann")?.now, P("Ann")?.lost, P("Ann")?.worked, P("Ann")?.fresh, P("Ann")?.inactiveNow], [6, 5, 1, 3, 1, 1]);
same("Ben: held 3, his now 2, lost 1, got 1, worked 1 (the call), the moved one inactive with him now",
  [P("Ben")?.held, P("Ben")?.now, P("Ben")?.lost, P("Ben")?.got, P("Ben")?.worked, P("Ben")?.inactiveNow], [3, 2, 1, 1, 1, 1]);
same("Cat: 2 now, got 1, no break minutes kept here, one lead inactive with her",
  [P("Cat")?.now, P("Cat")?.got, P("Cat")?.breakMinutes, P("Cat")?.inactiveNow], [2, 1, 0, 1]);
same("Cat's statuses", P("Cat")?.statuses, { followup: 1, assigned: 1 });
same("people: with a team each", [P("Ann")?.team, P("Dan")?.team], ["Alpha", "Beta"]);
same("moves map: Ann → Ben (automatic), Ben → Cat (by hand)",
  w.movesMap.map((m) => `${m.from.name}>${m.to.name}:${m.count}/${m.automatic}`).sort(), ["Ann>Ben:1/1", "Ben>Cat:1/0"]);

/* ═══ Case 2 ═══ */
section("Case 2 — a team, one person, two days, an empty day");
const wb = await leadWorkflow({ from: MON, to: MON, teamId: String(team.Beta) }, NOW);
same("team Beta: one lead, nobody left", [wb.totals.came, wb.totals.nobodyLeft, wb.teams.length], [1, 1, 1]);
const wa = await leadWorkflow({ from: MON, to: MON, personId: String(ids.Ann) }, NOW);
same("Ann alone: the 6 she held, only her row", [wa.totals.came, wa.people.map((p) => p.name)], [6, ["Ann"]]);
same("…the one moved from her counts as moved", wa.totals.movedAuto, 1);
const w2 = await leadWorkflow({ from: SUN, to: MON }, NOW);
same("Sunday and Monday: 13 came, by day", [w2.totals.came, w2.timeline.unit, w2.timeline.rows.map((r) => r.came)], [13, "day", [2, 11]]);
const empty = await leadWorkflow({ from: "2026-10-10", to: "2026-10-10" }, NOW);
same("a day with nothing: zeros, no teams, no people", [empty.totals.came, empty.teams.length, empty.people.length, empty.movesMap.length], [0, 0, 0, 0]);
const def = await leadWorkflow({}, NOW);
same("no days given: today (Monday at 17:00)", [def.period.from, def.period.to, def.totals.came], [MON, MON, 11]);
const onlyFrom = await leadWorkflow({ from: SUN }, NOW);
same("only a start: from it to today", [onlyFrom.period.from, onlyFrom.period.to], [SUN, MON]);

/* ═══ Case 3 ═══ */
section("Case 3 — bad asks");
const bad = async (label: string, qs: string) => {
  const r = await api(`/inactive-leads/workflow?${qs}`, "Admin");
  check(`${label} → 400`, r.status === 400, r.status);
};
await bad("a day not written YYYY-MM-DD", "from=19-10-2026");
await bad("a day that doesn't exist", "from=2026-13-45&to=2026-13-45");
await bad("the start after the end", `from=${MON}&to=${SUN}`);
await bad("more than 92 days", "from=2026-01-01&to=2026-10-19");
await bad("a bad team id", "teamId=nope");
await bad("a bad person id", "personId=123");

/* ═══ Case 4 ═══ */
section("Case 4 — who may see it");
check("signed out → 401", (await api(`/inactive-leads/workflow?from=${MON}`, null)).status === 401);
check("Sales Staff without the Inactive Leads box → 403", (await api(`/inactive-leads/workflow?from=${MON}`, "Sam")).status === 403);
const vic = await api<LeadWorkflow>(`/inactive-leads/workflow?from=${MON}&to=${MON}`, "Vic");
check("the box's viewer → 200, Monday's 11", vic.status === 200 && vic.body.data.totals.came === 11, vic.status);
const admin = await api<LeadWorkflow>(`/inactive-leads/workflow?from=${MON}&to=${MON}`, "Admin");
check("the Super Admin → 200", admin.status === 200 && admin.body.data.totals.came === 11, admin.status);
check("Root without the secret → 401", (await api(`/service/lead-workflow?from=${MON}`, null)).status === 401);
check("Root with a wrong secret → 401", (await api(`/service/lead-workflow?from=${MON}`, null, { "x-portal-secret": "x".repeat(SECRET.length) })).status === 401);
const root = await api<LeadWorkflow>(`/service/lead-workflow?from=${MON}&to=${MON}&teamId=${team.Beta}`, null, { "x-portal-secret": SECRET });
check("Root with the secret → 200, the same counts (team Beta: 1)", root.status === 200 && root.body.data.totals.came === 1, root.body);
check("Root, a bad day → 400", (await api(`/service/lead-workflow?from=yesterday`, null, { "x-portal-secret": SECRET })).status === 400);
check("Root, start after end → 400", (await api(`/service/lead-workflow?from=${MON}&to=${SUN}`, null, { "x-portal-secret": SECRET })).status === 400);
check("nothing changed: no lead moved, no move written", (await LeadMove.countDocuments()) === 2 && String((await Lead.findById(L["Waiting"]).lean())?.assignedTo) === String(ids.Ann));

/* ═══ The leads behind each box (2026-10-19) ═══ */
section("The leads behind each box — always exactly the map's numbers");
{
  const { leadWorkflowLeads } = await import("../src/services/leadWorkflowService.js");
  const B = (box: string, status?: string) => leadWorkflowLeads({ from: MON, to: MON, box: box as never, status }, NOW);
  const want: Record<string, number> = { came: t.came, assigned: t.assigned, unassigned: t.unassigned, worked: t.worked, fresh: t.fresh, inactive: t.inactive,
    moved_auto: t.movedAuto, moved_hand: t.movedHand, on_break: t.onBreak, nobody_left: t.nobodyLeft, waiting: t.waiting };
  for (const [box, n] of Object.entries(want)) {
    const r = await B(box);
    check(`${box}: ${n} on the map, ${n} in the list`, r.total === n && r.rows.length === n, [r.total, r.rows.length]);
  }
  const st = await B("status", "followup");
  check("a status: Follow-up's 2", st.total === 2 && st.rows.every((x) => x.status === "followup"), st.rows.map((x) => x.name));
  const auto = await B("moved_auto");
  check("a moved lead says from whom to whom, when, how", auto.rows[0]?.move?.from.name === "Ann" && auto.rows[0]?.move?.to.name === "Ben" && auto.rows[0]?.move?.kind === "automatic", auto.rows[0]?.move);
  const brk = await B("on_break");
  check("on a break: none here (no breaks kept)", brk.total === 0, brk.total);
  const wait = await B("waiting");
  check("still waiting: its minutes", wait.rows[0]?.waitedMinutes === 240, wait.rows[0]);
  const came = await B("came");
  check("newest first", came.rows[0]?.name === "Unassigned" && came.rows.at(-1)?.name === "Called", came.rows.map((x) => x.name));
  check("by owner and by team, of all of them", came.byOwner.find((o) => o.name === "Ann")?.count === 5 && came.byOwner.find((o) => o.name === "Not assigned")?.count === 1
    && came.byTeam.find((x) => x.name === "Beta")?.count === 1, [came.byOwner, came.byTeam]);
  const annOnly = await leadWorkflowLeads({ from: MON, to: MON, personId: String(ids.Ann), box: "came" }, NOW);
  check("one person: the leads they held", annOnly.total === 6, annOnly.total);
  const r1 = await api(`/inactive-leads/workflow/leads?from=${MON}&to=${MON}&box=nope`, "Admin");
  check("an unknown box → 400", r1.status === 400, r1.status);
  const r2 = await api(`/inactive-leads/workflow/leads?from=${MON}&to=${MON}&box=status`, "Admin");
  check("a status box with no status → 400", r2.status === 400, r2.status);
  check("signed out → 401, without the box → 403", (await api(`/inactive-leads/workflow/leads?box=came`, null)).status === 401 && (await api(`/inactive-leads/workflow/leads?box=came`, "Sam")).status === 403);
  const r3 = await api<{ total: number }>(`/inactive-leads/workflow/leads?from=${MON}&to=${MON}&box=worked`, "Vic");
  check("the box's viewer → 200", r3.status === 200 && r3.body.data.total === t.worked, r3.status);
  // (By the real clock, as the route goes: a box that doesn't depend on the time of day.)
  const r4 = await api<{ total: number }>(`/service/lead-workflow/leads?from=${MON}&to=${MON}&box=came`, null, { "x-portal-secret": SECRET });
  check("Root with the secret → the same list", r4.status === 200 && r4.body.data.total === t.came, r4.body);
  check("Root without it → 401; a bad box → 400", (await api(`/service/lead-workflow/leads?box=came`, null)).status === 401
    && (await api(`/service/lead-workflow/leads?box=x`, null, { "x-portal-secret": SECRET })).status === 400);
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
