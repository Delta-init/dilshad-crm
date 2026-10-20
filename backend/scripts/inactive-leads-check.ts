/**
 * Checks the Remote CRM's Inactive Leads end to end on a scratch database (2026-10-15, with the fixes the Sales CRM's
 * port found). Never a real mailbox (no SMTP here) and nobody's phone (no push subscriptions).
 *
 *   - Case 1: the settings (defaults, the switch stamping when it went on); which leads count as inactive — every
 *     way an owner acts (status, note, follow-up, reminder) and any call by anyone, ever (2026-10-17 — the Call
 *     button, a 3CX call out or picked up, straight from 3CX too), working time only, the newest hand-over; the automatic mover — the team's split rule, never back
 *     to anyone who lost it, flagged once when nobody is left, who is told what; moving by hand; the moves log; the
 *     bell's stored notices; the team split, and with people left out;
 *   - Case 2: the caps (counted after the calls), a 5,000-character lead name, switched on with no time recorded or
 *     a minute ago, two passes and a hand move at once (one move, one turn), a lead closed or noted while its move is
 *     on its way (left alone), a colleague's call (a called lead is active), deactivated people, every skip reason, a new
 *     limit at once, time zone names, two half-saves at once, the page's own team and people lists;
 *   - Case 3: bad filters, bad move bodies and bad settings — 400 and nothing changed;
 *   - Case 4: who may see the page, move leads, see and change the settings; everyone's notices their own.
 *   - Breaks (2026-10-20, as the Sales CRM): a break that ended comes off its owner's clock (not anyone else's); on a
 *     break now — listed as such, the mover leaves it, a super admin can still move it by hand; a break left on from
 *     an earlier day ends with that day; "Take break" / "End break" over HTTP — written down once, a kind, bad bodies.
 *
 * Run by inactive-leads-check.sh. Scratch database only.
 */
import { Types } from "mongoose";
import type { InactiveLeadList, LeadMoveDTO, ReassignResult } from "../src/services/inactiveLeadService.js";
import type { AppSettingsDTO } from "../src/services/settingsService.js";
import type { NotificationDTO } from "../src/types/index.js";

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

/* ── The app ─────────────────────────────────────────────────────────────── */

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "inactive-check-jwt",
  JWT_REFRESH_SECRET: "inactive-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  SMTP_HOST: "",
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
const { Notification } = await import("../src/models/Notification.js");
const { Team } = await import("../src/models/Team.js");
const { CallLog } = await import("../src/models/CallLog.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const { AppSetting } = await import("../src/models/AppSetting.js");
const svc = await import("../src/services/inactiveLeadService.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");
const { pickSplitAssignee, autoSplitLeadPublic } = await import("../src/services/leadService.js");
type SplitTeam = import("../src/services/leadService.js").SplitTeam;
/** Midnight in Dubai (no summer time) on the day of `at`. */
const gstMidnight = (at: Date): Date => {
  const g = new Date(at.getTime() + 4 * 3_600_000);
  return new Date(Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate()) - 4 * 3_600_000);
};
await Promise.all([Lead.init(), LeadMove.init(), Notification.init(), AppSetting.init(), LeadCall.init()]);

const app = express();
app.use((await import("helmet")).default());
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

interface ApiBody<T> {
  success: boolean;
  message: string;
  data: T;
  pagination?: { total: number; page: number; limit: number; totalPages: number };
}
async function api<T>(method: string, path: string, who: string | null, body?: unknown): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}

/* ── People, roles, teams ────────────────────────────────────────────────── */

type Action = "view" | "create" | "edit" | "delete" | "approve" | "export";
const perms = (m: Record<string, Partial<Record<Action, boolean>>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));

const role = {
  superAdmin: new Types.ObjectId(),
  staff: new Types.ObjectId(),
  viewer: new Types.ObjectId(),
  mover: new Types.ObjectId(),
  settingsViewer: new Types.ObjectId(),
  settingsEditor: new Types.ObjectId(),
};
const leadsWork = { view: true, create: true, edit: true };
await db.collection("roles").insertMany([
  { _id: role.superAdmin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: role.staff, roleName: "Sales Staff", isSystemRole: false, permissions: perms({ leads: leadsWork }) },
  { _id: role.viewer, roleName: "Inactive Viewer", isSystemRole: false, permissions: perms({ leads: { view: true }, "inactive-leads": { view: true } }) },
  { _id: role.mover, roleName: "Inactive Mover", isSystemRole: false, permissions: perms({ leads: { view: true }, "inactive-leads": { view: true, edit: true } }) },
  { _id: role.settingsViewer, roleName: "Settings Viewer", isSystemRole: false, permissions: perms({ settings: { view: true } }) },
  { _id: role.settingsEditor, roleName: "Settings Editor", isSystemRole: false, permissions: perms({ settings: { view: true, edit: true } }) },
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
await person("Admin", role.superAdmin);
await person("OldAdmin", role.superAdmin, { status: "inactive" });
for (const [name, ext] of [["Ann", "101"], ["Ben", "102"], ["Cat", "103"], ["Dan", "104"]] as const) await person(name, role.staff, { extension: ext });
await person("Eve", role.staff, { status: "inactive" });
for (const name of ["Fay", "Gus", "Hal", "Ian", "Joy", "Kim", "Lia"]) await person(name, role.staff);
await person("Vic", role.viewer);
await person("Max", role.mover);
await person("Sid", role.settingsViewer);
await person("Sue", role.settingsEditor);

const teamSettings = (s: Record<string, unknown> = {}) => ({
  autoAssign: true, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0,
  includedMembers: [], roundRobinStartDate: null, sourceRoundRobinIndices: {}, sourceExclusions: {}, ...s,
});
const team: Record<string, Types.ObjectId> = {};
async function makeTeam(name: string, members: string[], settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await db.collection("teams").insertOne({
    _id, name, leaders: [], members: members.map((m) => ids[m]), inactiveMembers: [], absentToday: [], status: "active",
    settings: teamSettings(settings), createdAt: new Date(), updatedAt: new Date(), ...extra,
  });
  team[name] = _id;
}
await makeTeam("Alpha", ["Ann", "Ben", "Cat", "Dan"]);
await makeTeam("Beta", ["Fay", "Gus"]);
await makeTeam("Echo", ["Eve", "Fay", "Gus"]);
await makeTeam("Solo", ["Ann"]);
await makeTeam("Dead", ["Fay", "Gus"], {}, { status: "inactive" });
await makeTeam("Rho", ["Ann", "Ben", "Cat", "Dan"]);
await makeTeam("Load", ["Fay", "Gus"], { splitMode: "equal_load" });
await makeTeam("Live", ["Ann", "Ben", "Cat", "Dan"], { splitStrategy: "live" });
await makeTeam("Since", ["Ann", "Ben", "Cat", "Dan"], { roundRobinStartDate: new Date("2026-10-01T00:00:00Z") });
await makeTeam("Held", ["Ann", "Ben"], { splitTime: "15:00" });
await makeTeam("Manual", ["Ann", "Ben"], { autoAssign: false });

/* ── Time ────────────────────────────────────────────────────────────────── */

// Dubai keeps no summer time: +04:00 all year. Monday 19 October 2026 at noon is the clock the service checks use.
const gst = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+04:00`);
const FRI = "2026-10-16", SAT = "2026-10-17", SUN = "2026-10-18", MON = "2026-10-19";
const NOW = gst(MON, "12:00");
const A10 = gst(MON, "10:00");
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
// Long past by any clock this runs at: for the HTTP checks, which go by the real time.
const PAST = gst("2026-10-01", "10:00");
// Today in Dubai by the real clock, for the parts that read it (live split, breaks).
const TODAY = new Date(Math.max(Date.now() - 60_000, gstMidnight(new Date()).getTime() + 1000));

/* ── Leads ───────────────────────────────────────────────────────────────── */

let seq = 0;
interface LeadSeed {
  name: string;
  owner?: Types.ObjectId | null;
  team?: Types.ObjectId | null;
  assignedAt?: Date | null;
  status?: string;
  reporter?: Types.ObjectId;
  createdAt?: Date;
  originalCreatedAt?: Date;
  source?: string;
  extra?: Record<string, unknown>;
}
function leadDoc(o: LeadSeed) {
  seq++;
  const assignedAt = o.owner ? o.assignedAt ?? A10 : null;
  const createdAt = o.createdAt ?? assignedAt ?? new Date();
  return {
    _id: new Types.ObjectId(),
    name: o.name,
    phone: `+9715${String(10_000_000 + seq)}`,
    email: `lead${seq}@test.local`,
    source: o.source ?? "",
    status: o.status ?? (o.owner ? "assigned" : "new"),
    assignedTo: o.owner ?? null,
    assignedAt,
    team: o.team === undefined ? team.Alpha : o.team,
    reporter: o.reporter ?? ids.Admin,
    notes: [], reminders: [], payments: [], activityLogs: [], followUps: [],
    callCount: 0, callConnected: 0, callNotConnected: 0, firstContactTime: null, lastContactedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...(o.originalCreatedAt ? { originalCreatedAt: o.originalCreatedAt } : {}),
    ...o.extra,
  };
}
type LeadRow = ReturnType<typeof leadDoc>;
async function seed(...docs: LeadRow[]) {
  if (docs.length) await Lead.collection.insertMany(docs);
  return docs;
}
const sub = (o: Record<string, unknown>) => ({ _id: new Types.ObjectId(), ...o });

async function reset() {
  await Promise.all([Lead, LeadMove, Notification, CallLog, LeadCall].map((m) => m.collection.deleteMany({})));
  await Team.collection.updateMany({}, { $set: { "settings.roundRobinIndex": 0, "settings.sourceRoundRobinIndices": {} } });
}
async function settings(patch: Parameters<typeof updateAppSettings>[0]) {
  return updateAppSettings(patch, String(ids.Admin));
}
/** Sets when automatic moves went on, past the API (which only ever stamps "now"); an empty save clears the cache. */
async function enabledAt(at: Date | null) {
  await AppSetting.collection.updateOne({ key: "app" }, { $set: { "inactiveLeads.enabledAt": at } });
  await settings({});
}
const leadNow = (id: Types.ObjectId) => Lead.findById(id).lean();
const ownerOf = async (id: Types.ObjectId) => String((await leadNow(id))?.assignedTo ?? "");
const notices = (who: string) => Notification.find({ user: ids[who] }).sort({ createdAt: 1, _id: 1 }).lean();
const cursor = async (t: string) => (await Team.findById(team[t]).lean())?.settings?.roundRobinIndex;
const nameOf = Object.fromEntries(Object.entries(ids).map(([k, v]) => [String(v), k]));
const who = (id: unknown) => nameOf[String(id)] ?? String(id);
async function splitTeam(t: string) {
  return (await Team.findById(team[t]).populate("members", "_id status").populate("leaders", "_id status").lean()) as unknown as SplitTeam;
}

/* ═══ Case 1 — happy path ════════════════════════════════════════════════ */

section("Case 1 — the settings");
{
  const r = await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin");
  check("GET /settings/app → 200 (created on first ask)", r.status === 200, r.status);
  const s = r.body.data.settings;
  check("defaults: automatic moves off, 45 min, never switched on", s.inactiveLeads.autoReassign === false && s.inactiveLeads.limitMinutes === 45 && s.inactiveLeads.enabledAt === null, s.inactiveLeads);
  check("defaults: idle alerts off, 30 min, team leaders not told", s.idleAlerts.enabled === false && s.idleAlerts.limitMinutes === 30 && s.idleAlerts.notifyTeamLeaders === false, s.idleAlerts);
  check("defaults: Mon–Sat, 09:00–18:00, Asia/Dubai", s.workingHours.timezone === "Asia/Dubai" && s.workingHours.start === "09:00" && s.workingHours.end === "18:00" && s.workingHours.days.join() === "1,2,3,4,5,6", s.workingHours);
  check("defaults: inactive-lead and idle emails on (sent only where a mailbox is set up)", s.email.inactiveLeads === true && s.email.idleAlerts === true, s.email);
  const shift = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Admin", { workingHours: { start: "10:00", end: "19:00" } });
  check("the rest of this check runs in a 10:00–19:00 shift", shift.status === 200 && shift.body.data.settings.workingHours.start === "10:00", shift.body.data?.settings?.workingHours);

  let p = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Admin", { inactiveLeads: { limitMinutes: 60 } });
  check("PUT a new limit → 200, saved, the switch still off", p.status === 200 && p.body.data.settings.inactiveLeads.limitMinutes === 60 && p.body.data.settings.inactiveLeads.enabledAt === null, p.body);
  check("…and who saved it", p.body.data.settings.updatedBy === String(ids.Admin), p.body.data.settings.updatedBy);
  const before = Date.now();
  p = await api("PUT", "/settings/app", "Admin", { inactiveLeads: { autoReassign: true } });
  const on = p.body.data.settings.inactiveLeads.enabledAt;
  check("switched on → the moment is stamped", p.status === 200 && on !== null && new Date(on).getTime() >= before - 1000 && new Date(on).getTime() <= Date.now() + 1000, on);
  await Bun.sleep(20);
  p = await api("PUT", "/settings/app", "Admin", { inactiveLeads: { autoReassign: true, limitMinutes: 50 } });
  check("saved again while on → the moment is kept", p.body.data.settings.inactiveLeads.enabledAt === on, p.body.data.settings.inactiveLeads);
  p = await api("PUT", "/settings/app", "Admin", { workingHours: { days: [6, 1, 1, 3] } });
  check("working days de-duplicated and in order", p.body.data.settings.workingHours.days.join() === "1,3,6", p.body.data.settings.workingHours.days);
  p = await api("PUT", "/settings/app", "Admin", { inactiveLeads: { autoReassign: false } });
  check("switched off → the moment is cleared", p.body.data.settings.inactiveLeads.enabledAt === null, p.body.data.settings.inactiveLeads);
  p = await api("PUT", "/settings/app", "Admin", { inactiveLeads: { limitMinutes: 45 }, workingHours: { days: [1, 2, 3, 4, 5, 6] } });
  check("back to 45 min, Mon–Sat", p.status === 200 && p.body.data.settings.inactiveLeads.limitMinutes === 45, p.body.data.settings);
}

section("Case 1 — which leads count as inactive (Monday noon, 45 min of working time)");
const L: Record<string, LeadRow> = {};
{
  const add = (key: string, o: Omit<LeadSeed, "name">) => (L[key] = leadDoc({ name: key, ...o }));
  const at = (hhmm: string) => gst(MON, hhmm);
  add("idle", { owner: ids.Ann });
  add("fresh", { owner: ids.Ann, assignedAt: at("11:30") });
  add("edge45", { owner: ids.Ann, assignedAt: at("11:15") });
  add("edge44", { owner: ids.Ann, assignedAt: at("11:16") });
  add("weekend", { owner: ids.Ben, assignedAt: gst(SAT, "18:50") });
  add("sunday", { owner: ids.Ben, assignedAt: gst(SUN, "15:00") });
  add("early", { owner: ids.Ben, assignedAt: at("08:00") });
  add("noteOwn", { owner: ids.Ben, extra: { notes: [sub({ content: "rang", author: ids.Ben, createdAt: at("10:30"), updatedAt: at("10:30") })] } });
  add("noteOther", { owner: ids.Cat, extra: { notes: [sub({ content: "for Cat", author: ids.Admin, createdAt: at("10:30"), updatedAt: at("10:30") })] } });
  add("noteBefore", { owner: ids.Cat, extra: { notes: [sub({ content: "old", author: ids.Cat, createdAt: at("09:59"), updatedAt: at("09:59") })] } });
  add("statusMoved", { owner: ids.Cat, status: "followup" });
  add("followUp", { owner: ids.Cat, extra: { followUps: [sub({ note: "spoke", followedUpAt: at("10:20"), followedUpBy: ids.Cat, createdAt: at("10:20"), updatedAt: at("10:20") })] } });
  add("reminder", { owner: ids.Dan, extra: { reminders: [sub({ title: "ring", remindAt: at("15:00"), createdBy: ids.Dan, isDone: false, createdAt: at("10:40"), updatedAt: at("10:40") })] } });
  add("statusViaEdit", { owner: ids.Dan, extra: { activityLogs: [sub({ action: "lead_updated", description: "Updated field(s): status", performedBy: ids.Dan, changes: { status: { from: "assigned", to: "callback" } }, createdAt: at("10:50") })] } });
  add("statusLog", { owner: ids.Dan, extra: { activityLogs: [sub({ action: "status_changed", description: "Status changed", performedBy: ids.Dan, createdAt: at("10:55") })] } });
  add("nameEdit", { owner: ids.Dan, extra: { activityLogs: [sub({ action: "lead_updated", description: "Updated field(s): name", performedBy: ids.Dan, changes: { name: { from: "a", to: "b" } }, createdAt: at("10:50") })] } });
  add("firstContact", { owner: ids.Dan, extra: { firstContactTime: at("10:05") } });
  add("lastContacted", { owner: ids.Dan, extra: { lastContactedAt: at("10:06") } });
  add("callButton", { owner: ids.Ann });
  add("callExt", { owner: ids.Ann });
  add("callExtMissedIn", { owner: ids.Ann });
  add("callOther", { owner: ids.Ann });
  add("tcxOut", { owner: ids.Ben });
  add("tcxNoAnswer", { owner: ids.Ben });
  add("tcxInMissed", { owner: ids.Ben });
  add("tcxInAnswered", { owner: ids.Ben });
  add("tcxOther", { owner: ids.Ben });
  add("tcxBefore", { owner: ids.Ben });
  add("ownSpot", { owner: ids.Ann, reporter: ids.Ann, createdAt: A10, assignedAt: new Date(A10.getTime() + 30_000) });
  add("handedBack", { owner: ids.Ann, reporter: ids.Ann, originalCreatedAt: gst(FRI, "10:00"), createdAt: A10, assignedAt: A10 });
  add("unassigned", { owner: null });
  add("closed", { owner: ids.Ann, status: "closed" });
  add("lost", { owner: ids.Ann, status: "lost" });
  add("noTeam", { owner: ids.Fay, team: null });
  add("goneOwner", { owner: ids.Eve, team: team.Echo });
  await seed(...Object.values(L));

  const callLog = (lead: string, o: Record<string, unknown>) => ({ leadId: L[lead]._id, phoneNumber: L[lead].phone, callDuration: 30, ...o });
  await CallLog.create([
    callLog("callButton", { callType: "Outbound", callDirection: "outbound", callDate: at("10:10"), initiatedBy: ids.Ann, source: "click_to_call" }),
    callLog("callExt", { callType: "Outbound", callDirection: "outbound", callDate: at("10:11"), agentExtension: "101" }),
    callLog("callExtMissedIn", { callType: "Missed", callDirection: "inbound", callDate: at("10:12"), agentExtension: "101" }),
    callLog("callOther", { callType: "Outbound", callDirection: "outbound", callDate: at("10:12"), initiatedBy: ids.Ben, source: "click_to_call" }),
  ]);
  const tcx = (lead: string, user: string, direction: "in" | "out", status: "answered" | "missed" | "no_answer", hhmm: string) => ({
    key: `${lead}-${hhmm}`, startedAt: at(hhmm), direction, status, answered: status === "answered", lead: L[lead]._id, user: ids[user],
  });
  await LeadCall.create([
    tcx("tcxOut", "Ben", "out", "answered", "10:15"),
    tcx("tcxNoAnswer", "Ben", "out", "no_answer", "10:16"),
    tcx("tcxInMissed", "Ben", "in", "missed", "10:17"),
    tcx("tcxInAnswered", "Ben", "in", "answered", "10:18"),
    tcx("tcxOther", "Cat", "out", "answered", "10:19"),
    tcx("tcxBefore", "Ben", "out", "answered", "09:30"),
  ]);

  const list = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  const got = new Map(list.items.map((i) => [i.name, i]));
  const expectInactive: Record<string, string> = {
    idle: "untouched for 2 h",
    edge45: "exactly the limit — counts",
    weekend: "Saturday evening, Sunday skipped",
    sunday: "landed on a Sunday — the clock starts Monday 10:00",
    early: "landed before the shift — the clock starts at 10:00",
    noteOther: "a note by somebody else is not the owner acting",
    noteBefore: "a note from before it was theirs",
    nameEdit: "editing the name is not acting on it",
    callExtMissedIn: "a call in at their extension that nobody answered",
    tcxInMissed: "a 3CX call in they missed",
    handedBack: "handed back to the person who first added it — timed from the hand-over, not the first add",
    noTeam: "no team — still listed",
    goneOwner: "its owner is deactivated — still listed",
    lastContacted: "a contact date alone — anyone's call sets it, so it isn't the owner acting",
  };
  const expectActed: Record<string, string> = {
    fresh: "30 min — under the limit",
    edge44: "44 min — under the limit",
    noteOwn: "the owner added a note",
    statusMoved: "the status moved past new/assigned",
    followUp: "the owner logged a follow-up",
    reminder: "the owner set a reminder",
    statusViaEdit: "the owner changed the status in the edit form",
    statusLog: "the owner changed the status",
    firstContact: "first contact stamped since it became theirs",
    callButton: "the owner pressed Call",
    callExt: "a call out from the owner's extension",
    tcxOut: "a 3CX call out by the owner",
    tcxNoAnswer: "a 3CX call out by the owner, unanswered — they tried",
    tcxInAnswered: "a 3CX call in the owner picked up",
    // A lead that was called is active, whoever called it, whenever (the user, 2026-10-17).
    callOther: "somebody else pressed Call",
    tcxOther: "a 3CX call by somebody else",
    tcxBefore: "a 3CX call from before it was theirs",
    ownSpot: "added it themselves and took it on the spot",
    unassigned: "nobody's",
    closed: "closed",
    lost: "lost",
  };
  for (const [k, why] of Object.entries(expectInactive)) check(`inactive: ${k} — ${why}`, got.has(k));
  for (const [k, why] of Object.entries(expectActed)) check(`not inactive: ${k} — ${why}`, !got.has(k));
  check("nothing else listed", list.items.length === Object.keys(expectInactive).length, list.items.map((i) => i.name));

  check("waiting: 2 h for the one untouched since 10:00", got.get("idle")?.waitingMinutes === 120, got.get("idle")?.waitingMinutes);
  check("waiting: exactly 45 min at the limit", got.get("edge45")?.waitingMinutes === 45, got.get("edge45")?.waitingMinutes);
  check("waiting: Saturday 18:50 → Monday noon is 2 h 10 min (Sunday skipped)", got.get("weekend")?.waitingMinutes === 130, got.get("weekend")?.waitingMinutes);
  check("waiting: Sunday → Monday noon is 2 h", got.get("sunday")?.waitingMinutes === 120, got.get("sunday")?.waitingMinutes);
  check("waiting: 08:00 Monday → noon is 2 h (from the start of the shift)", got.get("early")?.waitingMinutes === 120, got.get("early")?.waitingMinutes);
  const order = list.items.map((i) => i.name);
  check("longest waiting first", order[0] === "weekend" && order[1] === "sunday" && order[2] === "early" && order[order.length - 1] === "edge45", order);
  const idle = got.get("idle");
  check("a row carries its owner, team, phone, and no moves yet", idle?.owner?.name === "Ann" && idle.owner.active === true && idle.team?.name === "Alpha" && idle.phone === L.idle.phone && idle.moves === 0 && idle.lostBy.length === 0, idle);
  check("deactivated owner shown as such", got.get("goneOwner")?.owner?.active === false, got.get("goneOwner")?.owner);
  check("no team → team null", got.get("noTeam")?.team === null, got.get("noTeam")?.team);
  check("automatic moves off → every row says so", list.items.every((i) => i.autoMove === "off"), [...new Set(list.items.map((i) => i.autoMove))]);
  check("summary: 14 inactive, none stuck, not capped", list.summary.total === 14 && list.summary.stuck === 0 && list.summary.capped === false, list.summary);
  check("the rule: 45 min, off, the shift, in working hours at Monday noon", list.rule.limitMinutes === 45 && list.rule.autoReassign === false && list.rule.inWorkingHours === true && list.rule.workingHours.start === "10:00", list.rule);

  const byTeam = await svc.listInactiveLeads({ page: 1, limit: 100, teamId: String(team.Alpha) }, NOW);
  check("filter by team → Alpha's only", byTeam.items.length === 12 && byTeam.items.every((i) => i.team?.name === "Alpha"), byTeam.items.map((i) => i.name));
  const byOwner = await svc.listInactiveLeads({ page: 1, limit: 100, ownerId: String(ids.Ann) }, NOW);
  check("filter by owner → Ann's only", byOwner.items.map((i) => i.name).sort().join() === ["callExtMissedIn", "edge45", "handedBack", "idle"].sort().join(), byOwner.items.map((i) => i.name));
  const byName = await svc.listInactiveLeads({ page: 1, limit: 100, search: "WEEK" }, NOW);
  check("search by name, any case", byName.items.length === 1 && byName.items[0].name === "weekend", byName.items.map((i) => i.name));
  const byPhone = await svc.listInactiveLeads({ page: 1, limit: 100, search: L.sunday.phone.slice(-6) }, NOW);
  check("search by phone", byPhone.items.length === 1 && byPhone.items[0].name === "sunday", byPhone.items.map((i) => i.name));
  const byRegex = await svc.listInactiveLeads({ page: 1, limit: 100, search: "(.*)" }, NOW);
  check("search text is taken literally, not as a pattern", byRegex.items.length === 0, byRegex.items.length);
  const page2 = await svc.listInactiveLeads({ page: 2, limit: 5 }, NOW);
  check("paging: page 2 of 3, five rows, the 6th to the 10th", page2.items.length === 5 && page2.pagination.total === 14 && page2.pagination.totalPages === 3 && page2.items[0].name === order[5], { names: page2.items.map((i) => i.name), p: page2.pagination });
  const page9 = await svc.listInactiveLeads({ page: 9, limit: 5 }, NOW);
  check("paging past the end: no rows, the total still right", page9.items.length === 0 && page9.summary.total === 14, page9.summary);
  const sunday = await svc.listInactiveLeads({ page: 1, limit: 100 }, gst(SUN, "12:00"));
  check("on a Sunday: outside working hours, the rule says so", sunday.rule.inWorkingHours === false, sunday.rule.inWorkingHours);
}

section("Case 1 — the automatic mover (Alpha splits round robin: Ann, Ben, Cat, Dan)");
const S: Record<string, LeadRow> = {};
{
  await reset();
  S.one = leadDoc({ name: "Sweep One", owner: ids.Ann, assignedAt: A10 });
  S.two = leadDoc({ name: "Sweep Two", owner: ids.Ben, assignedAt: plus(A10, 1) });
  S.old = leadDoc({ name: "Sweep Old", owner: ids.Cat, assignedAt: gst(SAT, "18:00") });
  S.worked = leadDoc({ name: "Sweep Worked", owner: ids.Dan, assignedAt: plus(A10, 2), extra: { notes: [sub({ content: "done", author: ids.Dan, createdAt: gst(MON, "10:30"), updatedAt: gst(MON, "10:30") })] } });
  S.noTeam = leadDoc({ name: "Sweep No Team", owner: ids.Fay, team: null, assignedAt: plus(A10, 3) });
  await seed(...Object.values(S));
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(A10);

  const before = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  const state = Object.fromEntries(before.items.map((i) => [i.name, i.autoMove]));
  check("on since Monday 10:00: the two assigned since are due", state["Sweep One"] === "due" && state["Sweep Two"] === "due", state);
  check("…the one from Saturday is by hand only", state["Sweep Old"] === "before_switch", state);
  check("…the one with no team says so", state["Sweep No Team"] === "no_team", state);

  const startedAt = Date.now();
  const r1 = await svc.sweepInactiveLeads(NOW);
  check("first pass: 2 moved, 1 with nobody to take it", r1.moved === 2 && r1.stuck === 1, r1);
  check("Sweep One: Ann → Ben (Ann's turn skipped — she had it)", (await ownerOf(S.one._id)) === String(ids.Ben), who(await ownerOf(S.one._id)));
  check("Sweep Two: Ben → Cat (the next turn)", (await ownerOf(S.two._id)) === String(ids.Cat), who(await ownerOf(S.two._id)));
  check("the team's turn moved on twice, to Dan", (await cursor("Alpha")) === 3, await cursor("Alpha"));
  check("Sweep Old untouched (assigned before the switch)", (await ownerOf(S.old._id)) === String(ids.Cat));
  check("Sweep Worked untouched (Dan acted)", (await ownerOf(S.worked._id)) === String(ids.Dan));
  const one = await leadNow(S.one._id);
  check("moved lead: assigned now, status Assigned, first contact cleared", one?.assignedAt?.getTime() === NOW.getTime() && one?.status === "assigned" && one?.firstContactTime === null, { assignedAt: one?.assignedAt, status: one?.status });
  check("moved lead: Ann lost it, moved once, when", one?.inactivity?.lostBy?.map(String).join() === String(ids.Ann) && one?.inactivity?.moves === 1 && one?.inactivity?.lastMovedAt?.getTime() === NOW.getTime() && one?.inactivity?.stuckAt === null, one?.inactivity);
  const log = one?.activityLogs?.[one.activityLogs.length - 1];
  check("moved lead: logged as the system — no person", log?.action === "inactive_reassigned" && !log.performedBy, log);
  check("moved lead: the log says who to who and how long", /^Moved from Ann to Ben automatically — no action for 2 h of working time$/.test(log?.description ?? ""), log?.description);
  check("hand-over: arrives as a new lead for Ben (created now, first date kept)", (one?.createdAt?.getTime() ?? 0) >= startedAt - 1000 && one?.originalCreatedAt?.getTime() === A10.getTime(), { createdAt: one?.createdAt, originalCreatedAt: one?.originalCreatedAt });
  const stuck = await leadNow(S.noTeam._id);
  check("no team: left with Fay, flagged as nobody to take it", String(stuck?.assignedTo) === String(ids.Fay) && stuck?.inactivity?.stuckAt?.getTime() === NOW.getTime(), stuck?.inactivity);
  const moves = await LeadMove.find().sort({ createdAt: 1, _id: 1 }).lean();
  check("move log: two automatic moves, nobody's hand", moves.length === 2 && moves.every((m) => m.kind === "automatic" && m.by === null), moves.map((m) => [m.kind, m.by]));
  check("move log: from, to, team and the wait", who(moves[0]?.from) === "Ann" && who(moves[0]?.to) === "Ben" && String(moves[0]?.team) === String(team.Alpha) && moves[0]?.inactiveMinutes === 120 && moves[1]?.inactiveMinutes === 119, moves.map((m) => [who(m.from), who(m.to), m.inactiveMinutes]));

  const ann = await notices("Ann"), ben = await notices("Ben"), cat = await notices("Cat"), admin = await notices("Admin");
  check("Ann told she lost it", ann.length === 1 && ann[0].type === "inactive_lead_moved" && ann[0].title === "Lead moved to Ben" && ann[0].url === "/leads", ann.map((n) => [n.type, n.title]));
  check("Ben told he lost one and got one", ben.length === 2 && ben.some((n) => n.type === "inactive_lead_moved" && n.title === "Lead moved to Cat") && ben.some((n) => n.type === "lead_assigned" && n.title === "New lead: Sweep One" && n.url === `/leads/${S.one._id}`), ben.map((n) => [n.type, n.title]));
  check("Cat told she got one", cat.length === 1 && cat[0].type === "lead_assigned" && cat[0].title === "New lead: Sweep Two", cat.map((n) => [n.type, n.title]));
  check("the super admin told of both moves, and of the one nobody can take", admin.length === 2 && admin.some((n) => n.type === "inactive_leads_moved" && n.title === "2 inactive leads moved" && n.body.includes("Sweep One: Ann → Ben")) && admin.some((n) => n.type === "inactive_leads_stuck" && n.title === "Inactive lead needs you: Sweep No Team"), admin.map((n) => [n.type, n.title]));
  check("a deactivated super admin is not told", (await notices("OldAdmin")).length === 0);
  check("nobody else told", (await notices("Dan")).length === 0 && (await notices("Fay")).length === 0);

  const r2 = await svc.sweepInactiveLeads(NOW);
  check("the same minute again: nothing moves, nobody told twice", r2.moved === 0 && r2.stuck === 0 && (await Notification.countDocuments()) === 6, { r2, n: await Notification.countDocuments() });
  const after = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  check("the list: Sweep Old (by hand only) and Sweep No Team, one flagged", after.summary.total === 2 && after.summary.stuck === 1 && after.items.find((i) => i.name === "Sweep No Team")?.autoMove === "no_team", after.items.map((i) => [i.name, i.autoMove]));

  const r3 = await svc.sweepInactiveLeads(plus(NOW, 50));
  check("50 min later: both moved again", r3.moved === 2, r3);
  check("Sweep One: Ben → Dan (never back to Ann)", (await ownerOf(S.one._id)) === String(ids.Dan), who(await ownerOf(S.one._id)));
  check("Sweep Two: Cat → Ann (Ben lost it before)", (await ownerOf(S.two._id)) === String(ids.Ann), who(await ownerOf(S.two._id)));
  const r4 = await svc.sweepInactiveLeads(plus(NOW, 100));
  check("another 50 min: Sweep One → Cat, Sweep Two → Dan", r4.moved === 2 && (await ownerOf(S.one._id)) === String(ids.Cat) && (await ownerOf(S.two._id)) === String(ids.Dan), [who(await ownerOf(S.one._id)), who(await ownerOf(S.two._id))]);
  const adminBefore = (await notices("Admin")).length;
  const r5 = await svc.sweepInactiveLeads(plus(NOW, 150));
  check("everyone in the team has lost both: nothing moves, both flagged", r5.moved === 0 && r5.stuck === 2, r5);
  const adminNow = await notices("Admin");
  check("…the super admin told once, about both", adminNow.length === adminBefore + 1 && adminNow[adminNow.length - 1].title === "2 inactive leads need you", adminNow.map((n) => n.title));
  const r6 = await svc.sweepInactiveLeads(plus(NOW, 200));
  check("…and not again", r6.moved === 0 && r6.stuck === 0 && (await notices("Admin")).length === adminNow.length, r6);
  const stuckList = await svc.listInactiveLeads({ page: 1, limit: 100 }, plus(NOW, 200));
  check("the list shows them as nobody left", stuckList.items.filter((i) => i.autoMove === "stuck").map((i) => i.name).sort().join() === "Sweep One,Sweep Two" && stuckList.summary.stuck === 3, stuckList.items.map((i) => [i.name, i.autoMove]));
  const lostBy = stuckList.items.find((i) => i.name === "Sweep One")?.lostBy.map((p) => p.name).join();
  check("…with everyone who lost it, by name", lostBy === "Ann,Ben,Dan", lostBy);

  const byHand = await svc.reassignInactiveLeads({ leadIds: [String(S.one._id)], to: String(ids.Fay) }, String(ids.Admin), plus(NOW, 210));
  check("a super admin moves it by hand to Fay", byHand.moved.length === 1 && byHand.moved[0].to.name === "Fay" && byHand.moved[0].from.name === "Cat", byHand);
  const moved = await leadNow(S.one._id);
  check("…no longer flagged, Cat added to who lost it, moved 4 times", moved?.inactivity?.stuckAt === null && moved?.inactivity?.lostBy?.map(who).join() === "Ann,Ben,Dan,Cat" && moved?.inactivity?.moves === 4, moved?.inactivity);
  const handLog = moved?.activityLogs?.[moved.activityLogs.length - 1];
  check("…logged as the super admin's, from the page", handLog?.action === "inactive_reassigned" && String(handLog.performedBy) === String(ids.Admin) && /from the Inactive leads page/.test(handLog.description), handLog);
  const lastMove = await LeadMove.findOne().sort({ createdAt: -1, _id: -1 }).lean();
  check("…a hand move in the log, by the super admin", lastMove?.kind === "manual" && String(lastMove.by) === String(ids.Admin), lastMove);
  check("…Cat told, Fay told, the super admin not (it was them)", (await notices("Cat")).at(-1)?.title === "Lead moved to Fay" && (await notices("Fay")).at(-1)?.type === "lead_assigned" && (await notices("Admin")).length === adminNow.length);

  // The lead's own page and the next save after system entries in its log.
  const page = await api<{ activityLogs: Array<{ action: string; performedBy: unknown }> }>("GET", `/leads/${S.two._id}`, "Admin");
  const sys = page.body.data?.activityLogs?.filter((l) => l.action === "inactive_reassigned") ?? [];
  check("GET /leads/:id with the CRM's own log entries → 200, no person on them", page.status === 200 && sys.length === 3 && sys.every((l) => !l.performedBy), { status: page.status, sys });
  const note = await api("POST", `/leads/${S.two._id}/notes`, "Dan", { content: "Called them back" });
  const noted = await leadNow(S.two._id);
  check("its owner adds a note — the lead saves with those entries in its log", (note.status === 200 || note.status === 201) && noted?.notes?.length === 1, { status: note.status, message: note.body.message });

  const idleOff = await svc.sweepInactiveLeads(gst(SUN, "12:00"));
  check("a pass on Sunday: outside working hours, nothing looked at", idleOff.idle === "outside working hours" && idleOff.moved === 0, idleOff);
  const night = await svc.sweepInactiveLeads(gst(MON, "19:00"));
  check("a pass at 19:00: the shift is over", night.idle === "outside working hours", night);
  await settings({ inactiveLeads: { autoReassign: false } });
  const off = await svc.sweepInactiveLeads(plus(NOW, 400));
  check("switched off: a pass does nothing", off.idle === "off" && off.moved === 0, off);
}

section("Case 1 — the bell's stored notices");
{
  const mine = await api<{ items: NotificationDTO[]; unread: number }>("GET", "/notifications", "Ben");
  const inDb = await Notification.countDocuments({ user: ids.Ben });
  check("GET /notifications → Ben's own, all unread", mine.status === 200 && mine.body.data.items.length === inDb && mine.body.data.unread === inDb && inDb > 0, { status: mine.status, n: mine.body.data?.items?.length, inDb });
  const times = mine.body.data.items.map((n) => new Date(n.createdAt).getTime());
  check("…newest first, with type, title, link, read flag", times.every((t, i) => i === 0 || times[i - 1] >= t) && mine.body.data.items.every((n) => n.id && n.type && n.title && n.read === false), mine.body.data.items[0]);
  const catUnread = await Notification.countDocuments({ user: ids.Cat, readAt: null });
  const read = await api<{ updated: number }>("POST", "/notifications/read-all", "Ben");
  check("read all → Ben's marked read", read.status === 200 && read.body.data.updated === inDb, read.body);
  check("…nobody else's", (await Notification.countDocuments({ user: ids.Cat, readAt: null })) === catUnread);
  const again = await api<{ items: NotificationDTO[]; unread: number }>("GET", "/notifications", "Ben");
  check("…unread 0", again.body.data.unread === 0 && again.body.data.items.every((n) => n.read), again.body.data.unread);
  const first = again.body.data.items[0].id;
  const del = await api("DELETE", `/notifications/${first}`, "Ben");
  check("remove one → 200, gone", del.status === 200 && !(await Notification.exists({ _id: first })), del.status);
  check("remove it again → 404", (await api("DELETE", `/notifications/${first}`, "Ben")).status === 404);
  const catsOne = (await notices("Cat"))[0];
  const theirs = await api("DELETE", `/notifications/${catsOne._id}`, "Ben");
  check("someone else's → 404, and it stays", theirs.status === 404 && Boolean(await Notification.exists({ _id: catsOne._id })), theirs.status);
  const catCount = await Notification.countDocuments({ user: ids.Cat });
  const clear = await api<{ deleted: number }>("DELETE", "/notifications", "Ben");
  check("clear → Ben's all gone, Cat's untouched", clear.status === 200 && (await Notification.countDocuments({ user: ids.Ben })) === 0 && (await Notification.countDocuments({ user: ids.Cat })) === catCount, clear.body);
  await Notification.insertMany(Array.from({ length: 120 }, (_, i) => ({ user: ids.Gus, type: "lead_assigned", title: `N${i}`, body: "", url: "" })));
  const fifty = await api<{ items: NotificationDTO[]; unread: number }>("GET", "/notifications", "Gus");
  check("50 at a time by default, the unread count is all of them", fifty.body.data.items.length === 50 && fifty.body.data.unread === 120, { n: fifty.body.data.items.length, unread: fifty.body.data.unread });
  const most = await api<{ items: NotificationDTO[] }>("GET", "/notifications?limit=500", "Gus");
  check("at most 100 however many are asked for", most.body.data.items.length === 100, most.body.data.items.length);
  const junk = await api<{ items: NotificationDTO[] }>("GET", "/notifications?limit=lots", "Gus");
  check("a limit that isn't a number → the default 50", junk.status === 200 && junk.body.data.items.length === 50, junk.body.data?.items?.length);
}

section("Case 1 — moving by hand over HTTP, and the moves log");
const P: Record<string, LeadRow> = {};
{
  await reset();
  P.one = leadDoc({ name: "Past One", owner: ids.Ann, assignedAt: PAST });
  P.two = leadDoc({ name: "Past Two", owner: ids.Ben, assignedAt: PAST });
  P.noTeam = leadDoc({ name: "Past No Team", owner: ids.Fay, team: null, assignedAt: PAST });
  await seed(...Object.values(P));
  const list = await api<InactiveLeadList>("GET", "/inactive-leads", "Admin");
  check("GET /inactive-leads → 200 with rows, summary, rule and paging", list.status === 200 && list.body.data.items.length === 3 && list.body.data.summary.total === 3 && list.body.data.rule.autoReassign === false && list.body.pagination?.total === 3, { status: list.status, body: list.body });
  check("…moved today: none yet", list.body.data.summary.movedToday === 0, list.body.data.summary);

  const toGus = await api<ReassignResult>("POST", "/inactive-leads/reassign", "Admin", { leadIds: [String(P.one._id)], to: String(ids.Gus) });
  check("move to a person → 200 \"Moved 1 lead\"", toGus.status === 200 && toGus.body.message === "Moved 1 lead" && toGus.body.data.moved[0]?.to.name === "Gus" && toGus.body.data.moved[0]?.from.name === "Ann", toGus.body);
  check("…it is Gus's now", (await ownerOf(P.one._id)) === String(ids.Gus));
  const next = await api<ReassignResult>("POST", "/inactive-leads/reassign", "Admin", { leadIds: [String(P.two._id)] });
  check("next in the team → Ben's goes to Ann (her turn)", next.status === 200 && next.body.data.moved[0]?.to.name === "Ann", next.body);
  const none = await api<ReassignResult>("POST", "/inactive-leads/reassign", "Admin", { leadIds: [String(P.noTeam._id)] });
  check("no team and no person picked → skipped, says why", none.status === 200 && none.body.message === "No leads were moved" && none.body.data.skipped[0]?.reason === "It has no team — pick a person instead", none.body);
  check("…and the owner told, the receiver told", (await notices("Ann")).some((n) => n.type === "inactive_lead_moved") && (await notices("Gus")).some((n) => n.type === "lead_assigned" && n.url === `/leads/${P.one._id}`));

  const log = await api<LeadMoveDTO[]>("GET", "/inactive-leads/moves", "Admin");
  check("GET /inactive-leads/moves → both, newest first", log.status === 200 && log.body.data.length === 2 && log.body.data[0].lead.name === "Past Two" && log.body.data[1].lead.name === "Past One" && log.body.pagination?.total === 2, log.body.data?.map((m) => m.lead.name));
  const m0 = log.body.data[0];
  check("…from, to, team, by hand by whom, the wait", m0.from?.name === "Ben" && m0.to?.name === "Ann" && m0.team?.name === "Alpha" && m0.kind === "manual" && m0.by?.name === "Admin" && m0.inactiveMinutes > 45, m0);
  const auto = await api<LeadMoveDTO[]>("GET", "/inactive-leads/moves?kind=automatic", "Admin");
  const manual = await api<LeadMoveDTO[]>("GET", "/inactive-leads/moves?kind=manual", "Admin");
  check("filter by how: automatic none, by hand both", auto.body.data.length === 0 && manual.body.data.length === 2, [auto.body.data.length, manual.body.data.length]);
  const beta = await api<LeadMoveDTO[]>("GET", `/inactive-leads/moves?teamId=${team.Beta}`, "Admin");
  check("filter by team: none in Beta", beta.body.data.length === 0, beta.body.data.length);
  const paged = await api<LeadMoveDTO[]>("GET", "/inactive-leads/moves?limit=1&page=2", "Admin");
  check("paging the log", paged.body.data.length === 1 && paged.body.data[0].lead.name === "Past One" && paged.body.pagination?.totalPages === 2, paged.body.data?.map((m) => m.lead.name));
  const later = await api<InactiveLeadList>("GET", "/inactive-leads", "Admin");
  check("moved today: 2", later.body.data.summary.movedToday === 2, later.body.data.summary);
  const page = await api<{ activityLogs: Array<{ action: string; performedBy: { name?: string } | null }> }>("GET", `/leads/${P.one._id}`, "Admin");
  const entry = page.body.data?.activityLogs?.find((l) => l.action === "inactive_reassigned");
  check("the lead's own log names who moved it", entry?.performedBy?.name === "Admin", entry);
  const note = await api("POST", `/leads/${P.noTeam._id}/notes`, "Fay", { content: "Spoke to them" });
  const stillThere = (await api<InactiveLeadList>("GET", "/inactive-leads", "Admin")).body.data.items.some((i) => i.id === String(P.noTeam._id));
  check("its owner adds a note → it drops off the list", (note.status === 200 || note.status === 201) && !stillThere, { status: note.status, stillThere });
}

section("Case 1 — the team split, exactly as before");
{
  await reset();
  async function split(t: string, o: { source?: string } = {}, bypass = false) {
    const [doc] = await seed(leadDoc({ name: `split-${seq}`, owner: null, team: team[t], source: o.source }));
    await autoSplitLeadPublic(String(team[t]), String(doc._id), String(ids.Admin), undefined, bypass);
    return who((await leadNow(doc._id))?.assignedTo ?? "none");
  }
  const rr: string[] = [];
  for (let i = 0; i < 6; i++) rr.push(await split("Rho"));
  check("round robin: Ann, Ben, Cat, Dan, Ann, Ben", rr.join() === "Ann,Ben,Cat,Dan,Ann,Ben", rr);
  check("…the turn left at Cat", (await cursor("Rho")) === 2, await cursor("Rho"));
  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.roundRobinIndex": 0 } });
  const bySource = [await split("Rho", { source: "FB" }), await split("Rho", { source: "FB" }), await split("Rho", { source: "GG" }), await split("Rho", { source: "FB" }), await split("Rho", { source: "GG" })];
  check("each source has its own turn: FB Ann, Ben, Cat; GG Ann, Ben", bySource.join() === "Ann,Ben,Ann,Cat,Ben", bySource);
  const rho = await Team.findById(team.Rho).lean();
  const idx = rho?.settings?.sourceRoundRobinIndices as unknown as Map<string, number> | Record<string, number> | undefined;
  const idxOf = (k: string) => (idx instanceof Map ? idx.get(k) : idx?.[k]);
  check("…kept per source, the team's own turn untouched", idxOf("FB") === 3 && idxOf("GG") === 2 && rho?.settings?.roundRobinIndex === 0, { FB: idxOf("FB"), GG: idxOf("GG"), rr: rho?.settings?.roundRobinIndex });

  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.roundRobinIndex": 0, "settings.includedMembers": [ids.Ben, ids.Dan] } });
  const included = [await split("Rho"), await split("Rho"), await split("Rho")];
  check("only the included members: Ben, Dan, Ben", included.join() === "Ben,Dan,Ben", included);
  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.roundRobinIndex": 0, "settings.includedMembers": [], inactiveMembers: [ids.Cat] } });
  const noCat = [await split("Rho"), await split("Rho"), await split("Rho"), await split("Rho")];
  check("a member off auto-assign is skipped: Ann, Ben, Dan, Ann", noCat.join() === "Ann,Ben,Dan,Ann", noCat);
  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.roundRobinIndex": 0, inactiveMembers: [], absentToday: [{ userId: ids.Ann, date: TODAY }] } });
  const noAnn = [await split("Rho"), await split("Rho"), await split("Rho")];
  check("absent today is skipped: Ben, Cat, Dan", noAnn.join() === "Ben,Cat,Dan", noAnn);
  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.roundRobinIndex": 0, absentToday: [], "settings.sourceExclusions": { [String(ids.Ann)]: ["FB"] }, "settings.sourceRoundRobinIndices": {} } });
  const noFbForAnn = [await split("Rho", { source: "FB" }), await split("Rho", { source: "FB" }), await split("Rho", { source: "FB" }), await split("Rho", { source: "GG" })];
  check("a source kept from a member: FB never to Ann (Ben, Cat, Dan); GG still to her", noFbForAnn.join() === "Ben,Cat,Dan,Ann", noFbForAnn);
  await Team.collection.updateOne({ _id: team.Rho }, { $set: { "settings.sourceExclusions": {} } });

  await reset();
  await seed(
    leadDoc({ name: "since-a1", owner: ids.Ann, team: team.Since, assignedAt: gst("2026-10-05", "11:00") }),
    leadDoc({ name: "since-a2", owner: ids.Ann, team: team.Since, assignedAt: gst("2026-10-05", "11:00") }),
    leadDoc({ name: "since-b1", owner: ids.Ben, team: team.Since, assignedAt: gst("2026-10-05", "11:00") }),
    leadDoc({ name: "since-d0", owner: ids.Dan, team: team.Since, assignedAt: gst("2026-09-20", "11:00") }),
  );
  check("round robin from a start date: the fewest since then, first in order — Cat", (await split("Since")) === "Cat");
  check("…then Dan (his older lead doesn't count)", (await split("Since")) === "Dan");

  await seed(
    ...["Fay", "Fay", "Fay", "Gus"].map((m, i) => leadDoc({ name: `load-${i}`, owner: ids[m], team: team.Load, status: "followup" })),
    leadDoc({ name: "load-other-team", owner: ids.Gus, team: team.Beta, status: "followup" }),
    leadDoc({ name: "load-closed", owner: ids.Gus, team: team.Load, status: "closed" }),
  );
  check("equal load: the fewest open in this team — Gus (1 vs 3)", (await split("Load")) === "Gus");

  await reset();
  await seed(
    leadDoc({ name: "live-a-fb", owner: ids.Ann, team: team.Live, source: "FB", assignedAt: TODAY }),
    leadDoc({ name: "live-a-x", owner: ids.Ann, team: team.Live, source: "X", assignedAt: TODAY }),
    ...[0, 1, 2].map((i) => leadDoc({ name: `live-b-${i}`, owner: ids.Ben, team: team.Live, source: "X", assignedAt: TODAY })),
    leadDoc({ name: "live-c-x", owner: ids.Cat, team: team.Live, source: "X", assignedAt: TODAY }),
    leadDoc({ name: "live-d-fb", owner: ids.Dan, team: team.Live, source: "FB", assignedAt: TODAY }),
  );
  check("live split: fewest of this source today, then fewest in all — Cat", (await split("Live", { source: "FB" })) === "Cat");

  check("a split time set: the lead waits for it", (await split("Held")) === "none");
  check("…unless the split is run by hand", (await split("Held", {}, true)) === "Ann");
  check("auto-assign off: the lead stays with nobody", (await split("Manual")) === "none");
}

section("Case 1 — picking with people left out (moving an inactive lead on)");
{
  await reset();
  const [lead] = await seed(leadDoc({ name: "pick", owner: null, team: team.Rho }));
  const [fbLead] = await seed(leadDoc({ name: "pick-fb", owner: null, team: team.Rho, source: "FB" }));
  const pick = async (t: string, exclude: string[], l = lead, at?: Date) =>
    who((await pickSplitAssignee(await splitTeam(t), String(l._id), { exclude: exclude.map((n) => String(ids[n])), at })) ?? "none");
  const setCursor = (t: string, n: number) => Team.collection.updateOne({ _id: team[t] }, { $set: { "settings.roundRobinIndex": n, "settings.sourceRoundRobinIndices": {} } });

  await setCursor("Rho", 0);
  check("Ann's turn, Ann left out → Ben", (await pick("Rho", ["Ann"])) === "Ben");
  check("…and the turn moves on past Ben, to Cat", (await cursor("Rho")) === 2, await cursor("Rho"));
  await setCursor("Rho", 3);
  check("Dan's turn, Dan left out → round to Ann", (await pick("Rho", ["Dan"])) === "Ann" && (await cursor("Rho")) === 1);
  await setCursor("Rho", 1);
  check("Ben's turn, Ben and Cat left out → Dan, turn back to Ann", (await pick("Rho", ["Ben", "Cat"])) === "Dan" && (await cursor("Rho")) === 0);
  await setCursor("Rho", 2);
  check("everyone left out → nobody, and nobody's turn spent", (await pick("Rho", ["Ann", "Ben", "Cat", "Dan"])) === "none" && (await cursor("Rho")) === 2);
  await setCursor("Rho", 0);
  check("by source: FB's turn on Ann, Ann left out → Ben", (await pick("Rho", ["Ann"], fbLead)) === "Ben");
  const rho = await Team.findById(team.Rho).lean();
  const idx = rho?.settings?.sourceRoundRobinIndices as unknown as Map<string, number> | Record<string, number> | undefined;
  check("…FB's own turn moved on, the team's untouched", (idx instanceof Map ? idx.get("FB") : idx?.FB) === 2 && rho?.settings?.roundRobinIndex === 0);

  await seed(...["Fay", "Fay", "Gus"].map((m, i) => leadDoc({ name: `ld-${i}`, owner: ids[m], team: team.Load, status: "followup" })));
  check("equal load: Gus has fewest, Gus left out → Fay", (await pick("Load", ["Gus"])) === "Fay");
  await seed(
    leadDoc({ name: "sn-a", owner: ids.Ann, team: team.Since, assignedAt: gst("2026-10-05", "11:00") }),
    leadDoc({ name: "sn-b", owner: ids.Ben, team: team.Since, assignedAt: gst("2026-10-05", "11:00") }),
  );
  check("from a start date: Cat has fewest, Cat left out → Dan", (await pick("Since", ["Cat"])) === "Dan");
  await seed(
    leadDoc({ name: "lv-a", owner: ids.Ann, team: team.Live, assignedAt: TODAY }),
    leadDoc({ name: "lv-b", owner: ids.Ben, team: team.Live, assignedAt: TODAY }),
    leadDoc({ name: "lv-c", owner: ids.Cat, team: team.Live, assignedAt: TODAY }),
  );
  check("live: Dan has fewest today, Dan left out → Ann (first of the rest)", (await pick("Live", ["Dan"])) === "Ann");
}

/* ═══ Case 2 — edges ═════════════════════════════════════════════════════ */

section("Case 2 — 200 a pass, 2,000 a list");
{
  await reset();
  await seed(...Array.from({ length: 205 }, (_, i) => leadDoc({ name: `bulk-${i}`, owner: ids.Fay, team: team.Beta, assignedAt: plus(A10, i % 60) })));
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 5 } });
  await enabledAt(A10);
  const r1 = await svc.sweepInactiveLeads(gst(MON, "11:30"));
  check("first pass moves 200, the longest waiting", r1.moved === 200, r1);
  const fay = await notices("Fay"), gus = await notices("Gus"), admin = await notices("Admin");
  check("one notice each, however many leads: Fay \"200 of your leads were moved on\"", fay.length === 1 && fay[0].title === "200 of your leads were moved on", fay.map((n) => n.title));
  check("…Gus \"200 new leads for you\"", gus.length === 1 && gus[0].title === "200 new leads for you" && gus[0].url === "/leads", gus.map((n) => n.title));
  check("…the super admin \"200 inactive leads moved\", the first three named", admin.length === 1 && admin[0].title === "200 inactive leads moved" && admin[0].body.endsWith("and 197 more"), admin.map((n) => [n.title, n.body]));
  const r2 = await svc.sweepInactiveLeads(gst(MON, "11:31"));
  check("the next pass moves the other 5", r2.moved === 5 && (await LeadMove.countDocuments()) === 205, { r2, moves: await LeadMove.countDocuments() });
  await settings({ inactiveLeads: { autoReassign: false, limitMinutes: 45 } });

  await reset();
  await seed(...Array.from({ length: 2001 }, (_, i) => leadDoc({ name: `many-${i}`, owner: ids.Ann, assignedAt: plus(PAST, i) })));
  const big = await svc.listInactiveLeads({ page: 1, limit: 20 }, NOW);
  check("over 2,000: the 2,000 longest waiting, and it says so", big.summary.capped === true && big.summary.total === 2000 && big.pagination.total === 2000 && big.items[0].name === "many-0", big.summary);
}

section("Case 2 — a 5,000-character name, switched on with no time recorded, switched on a minute ago");
{
  await reset();
  const longName = "N".repeat(5000);
  const [long] = await seed(leadDoc({ name: longName, owner: ids.Ann, assignedAt: PAST }));
  const r = await svc.reassignInactiveLeads({ leadIds: [String(long._id)], to: String(ids.Gus) }, String(ids.Admin), NOW);
  const gus = await notices("Gus"), ann = await notices("Ann");
  check("moved, and both still told — cut to fit", r.moved.length === 1 && gus.length === 1 && ann.length === 1 && gus[0].title.length <= 200 && ann[0].body.length <= 1000, { moved: r.moved.length, gus: gus.length, ann: ann.length });

  await reset();
  await seed(leadDoc({ name: "Backlog", owner: ids.Ann, assignedAt: A10 }));
  await settings({ inactiveLeads: { autoReassign: true } });
  await enabledAt(null);
  const legacy = await svc.sweepInactiveLeads(NOW);
  const stamped = (await AppSetting.findOne({ key: "app" }).lean())?.inactiveLeads?.enabledAt;
  check("on, but no time recorded: the pass records now and moves none of the backlog", legacy.moved === 0 && stamped?.getTime() === NOW.getTime(), { legacy, stamped });
  await enabledAt(plus(NOW, -10));
  const recent = await svc.sweepInactiveLeads(NOW);
  check("switched on 10 min ago with a 45-min limit: nothing can be due yet", recent.moved === 0 && recent.stuck === 0 && recent.idle === undefined, recent);
  await settings({ inactiveLeads: { autoReassign: false } });
}

section("Case 2 — two passes and a hand move at the same moment");
{
  await reset();
  const docs = await seed(...Array.from({ length: 10 }, (_, i) => leadDoc({ name: `race-${i}`, owner: i % 2 ? ids.Ann : ids.Ben, assignedAt: A10 })));
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(A10);
  const [a, b, c] = await Promise.all([
    svc.sweepInactiveLeads(NOW),
    svc.sweepInactiveLeads(NOW),
    svc.reassignInactiveLeads({ leadIds: docs.map((d) => String(d._id)) }, String(ids.Admin), NOW),
  ]);
  const perLead = await LeadMove.aggregate<{ _id: Types.ObjectId; n: number }>([{ $group: { _id: "$lead", n: { $sum: 1 } } }]);
  check("every lead moved exactly once", perLead.length === 10 && perLead.every((p) => p.n === 1), perLead.map((p) => p.n));
  check("…the three between them account for all ten", a.moved + b.moved + c.moved.length === 10, [a.moved, b.moved, c.moved.length]);
  const after = await Lead.find({ _id: { $in: docs.map((d) => d._id) } }).lean();
  check("…each moved once, away from its owner", after.every((l) => l.inactivity?.moves === 1 && l.inactivity.lostBy?.length === 1 && String(l.assignedTo) !== String(l.inactivity.lostBy[0])), after.map((l) => l.inactivity));
  check("…a hand move that lost the race says so", c.skipped.every((s) => s.reason === "It changed while moving — refresh and try again" || s.reason === "Not inactive any more — it was worked, closed or moved"), c.skipped);
  await settings({ inactiveLeads: { autoReassign: false } });
}

section("Case 2 — deactivated people, every skip reason, a new limit at once");
{
  await reset();
  const E = await seed(
    leadDoc({ name: "Echo Fay", owner: ids.Fay, team: team.Echo, assignedAt: PAST }),
    leadDoc({ name: "Echo Eve", owner: ids.Eve, team: team.Echo, assignedAt: PAST }),
  );
  await Team.collection.updateOne({ _id: team.Echo }, { $set: { "settings.roundRobinIndex": 0 } });
  const r1 = await svc.reassignInactiveLeads({ leadIds: [String(E[0]._id)] }, String(ids.Admin));
  check("next in team skips a deactivated member: Fay's goes to Gus, never Eve", r1.moved[0]?.to.name === "Gus", r1);
  const r2 = await svc.reassignInactiveLeads({ leadIds: [String(E[1]._id)] }, String(ids.Admin));
  check("a deactivated owner's lead moves on to someone active", r2.moved.length === 1 && ["Fay", "Gus"].includes(r2.moved[0].to.name), r2);

  await reset();
  const K = await seed(
    leadDoc({ name: "Skip Same", owner: ids.Ann, assignedAt: PAST }),
    leadDoc({ name: "Skip Worked", owner: ids.Ann, assignedAt: PAST, status: "followup" }),
    leadDoc({ name: "Skip Solo", owner: ids.Ann, team: team.Solo, assignedAt: PAST }),
    leadDoc({ name: "Skip Dead Team", owner: ids.Fay, team: team.Dead, assignedAt: PAST }),
    leadDoc({ name: "Twice", owner: ids.Ben, assignedAt: PAST }),
  );
  const same = await svc.reassignInactiveLeads({ leadIds: [String(K[0]._id)], to: String(ids.Ann) }, String(ids.Admin));
  check("to whoever has it → skipped \"It is already Ann's\"", same.skipped[0]?.reason === "It is already Ann's" && same.moved.length === 0, same);
  const worked = await svc.reassignInactiveLeads({ leadIds: [String(K[1]._id)] }, String(ids.Admin));
  check("worked since the page loaded → skipped, says so", worked.skipped[0]?.reason === "Not inactive any more — it was worked, closed or moved", worked);
  const solo = await svc.reassignInactiveLeads({ leadIds: [String(K[2]._id)] }, String(ids.Admin));
  check("nobody else in its team → skipped, pick a person", solo.skipped[0]?.reason === "Nobody else in the team can take it — pick a person instead", solo);
  const dead = await svc.reassignInactiveLeads({ leadIds: [String(K[3]._id)] }, String(ids.Admin));
  check("its team is inactive → skipped, pick a person", dead.skipped[0]?.reason === "Nobody else in the team can take it — pick a person instead", dead);
  const ghost = new Types.ObjectId();
  const missing = await svc.reassignInactiveLeads({ leadIds: [String(ghost)] }, String(ids.Admin));
  check("a lead that doesn't exist → skipped \"Lead not found\"", missing.skipped[0]?.reason === "Lead not found" && missing.skipped[0]?.leadId === String(ghost), missing);
  const twice = await svc.reassignInactiveLeads({ leadIds: [String(K[4]._id), String(K[4]._id)], to: String(ids.Cat) }, String(ids.Admin));
  check("the same lead twice in one request → moved once", twice.moved.length === 1 && (await LeadMove.countDocuments({ lead: K[4]._id })) === 1, twice);

  await reset();
  const [fresh] = await seed(leadDoc({ name: "Limit Fresh", owner: ids.Ann, assignedAt: gst(MON, "11:30") }));
  const before = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  await api("PUT", "/settings/app", "Admin", { inactiveLeads: { limitMinutes: 5 } });
  const afterLimit = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  check("a new limit counts at once: 30 min isn't inactive at 45, is at 5", !before.items.some((i) => i.id === String(fresh._id)) && afterLimit.items.some((i) => i.id === String(fresh._id)) && afterLimit.rule.limitMinutes === 5, [before.items.length, afterLimit.items.length]);
  await api("PUT", "/settings/app", "Admin", { workingHours: { start: "12:00", end: "19:00" } });
  const shifted = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  check("…and new working hours: from 12:00, at noon nothing has waited yet", shifted.items.length === 0 && shifted.rule.inWorkingHours === true, shifted.items.map((i) => i.waitingMinutes));
  await api("PUT", "/settings/app", "Admin", { inactiveLeads: { limitMinutes: 45 }, workingHours: { start: "10:00", end: "19:00" } });
}

section("Case 2 — what the first test round found");
{
  // A lead its owner closes, or notes, while its move is on its way is left alone. The window: the move has checked
  // the lead in its team's queue and is reading the team for the pick.
  await reset();
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(A10);
  const realFindById = Team.findById;
  let midMove: (() => Promise<unknown>) | null = null;
  (Team as unknown as { findById: (...a: unknown[]) => unknown }).findById = (...args: unknown[]) => {
    const q = (realFindById as unknown as (...a: unknown[]) => { exec: () => Promise<unknown> }).apply(Team, args);
    const act = midMove;
    if (!act) return q;
    midMove = null;
    const exec = q.exec.bind(q);
    q.exec = async () => {
      await act();
      return exec();
    };
    return q;
  };
  const midMoveRun = async (label: string, act: (id: Types.ObjectId) => Promise<unknown>) => {
    const [lead] = await seed(leadDoc({ name: label, owner: ids.Ann, assignedAt: A10 }));
    await Team.collection.updateOne({ _id: team.Alpha }, { $set: { "settings.roundRobinIndex": 0 } });
    let opened = false;
    midMove = async () => {
      opened = true;
      await act(lead._id);
    };
    const r = await svc.sweepInactiveLeads(NOW);
    midMove = null;
    return { r, opened, after: await leadNow(lead._id), moves: await LeadMove.countDocuments({ lead: lead._id }) };
  };
  const closed = await midMoveRun("Closed Mid Move", (id) => Lead.collection.updateOne({ _id: id }, { $set: { status: "closed" } }));
  check("(the window was open: the move was reading its team)", closed.opened);
  check("closed while its move was on its way → stays closed, with its owner, not moved", closed.r.moved === 0 && closed.after?.status === "closed" && String(closed.after?.assignedTo) === String(ids.Ann) && closed.moves === 0, { r: closed.r, status: closed.after?.status, owner: who(closed.after?.assignedTo) });
  await Lead.collection.deleteMany({});
  const noted = await midMoveRun("Noted Mid Move", (id) =>
    Lead.collection.updateOne({ _id: id }, { $push: { notes: sub({ content: "on it", author: ids.Ann, createdAt: plus(NOW, 1), updatedAt: plus(NOW, 1) }) } } as never));
  check("noted by its owner while its move was on its way → not moved, not flagged", noted.opened && noted.r.moved === 0 && noted.r.stuck === 0 && String(noted.after?.assignedTo) === String(ids.Ann) && noted.moves === 0 && !noted.after?.inactivity?.stuckAt, { r: noted.r, owner: who(noted.after?.assignedTo) });
  (Team as unknown as { findById: typeof realFindById }).findById = realFindById;
  await settings({ inactiveLeads: { autoReassign: false } });

  // A called lead is active, whoever called it (2026-10-17) — a colleague's call as much as the owner's own call
  // straight from 3CX.
  await reset();
  const [byCat, byAnn] = await seed(
    leadDoc({ name: "Called By Cat", owner: ids.Ann, extra: { lastContactedAt: gst(MON, "10:20") } }),
    leadDoc({ name: "Called By Ann", owner: ids.Ann }),
  );
  await LeadCall.create([
    { key: "n2-cat", startedAt: gst(MON, "10:20"), direction: "out", status: "answered", answered: true, lead: byCat._id, user: ids.Cat },
    { key: "n2-ann", startedAt: gst(MON, "10:21"), direction: "out", status: "answered", answered: true, lead: byAnn._id, user: ids.Ann },
  ]);
  const called = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
  check("a colleague's call (3CX, contact date set) → not inactive", !called.items.some((i) => i.name === "Called By Cat"), called.items.map((i) => i.name));
  check("…the owner's own call straight from 3CX → not inactive", !called.items.some((i) => i.name === "Called By Ann"));

  // Leads their owners phoned don't fill the cap and hide newer inactive ones.
  await reset();
  const phoned = Array.from({ length: 2001 }, (_, i) => leadDoc({ name: `phoned-${i}`, owner: ids.Fay, team: team.Beta, assignedAt: plus(PAST, i) }));
  await seed(...phoned);
  await CallLog.collection.insertMany(phoned.map((l) => ({
    leadId: l._id, phoneNumber: l.phone, callType: "Outbound", callDirection: "outbound", callDuration: 30,
    callDate: plus(l.assignedAt as Date, 5), initiatedBy: ids.Fay, source: "click_to_call", createdAt: new Date(), updatedAt: new Date(),
  })));
  const [z] = await seed(leadDoc({ name: "Lead Z", owner: ids.Gus, team: team.Beta, assignedAt: A10 }));
  const zList = await svc.listInactiveLeads({ page: 1, limit: 20 }, NOW);
  check("2,001 older leads their owner phoned don't hide a newer inactive one from the list", zList.summary.total === 1 && zList.summary.capped === false && zList.items[0]?.name === "Lead Z", zList.summary);
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(PAST);
  const zSweep = await svc.sweepInactiveLeads(NOW);
  check("…nor from the mover: it moves Lead Z", zSweep.moved === 1 && (await ownerOf(z._id)) === String(ids.Fay), { zSweep, owner: who(await ownerOf(z._id)) });
  await settings({ inactiveLeads: { autoReassign: false } });

  // A pass and a hand move on the same lead: one move and one turn.
  await reset();
  const [x] = await seed(leadDoc({ name: "Race X", owner: ids.Ann, assignedAt: A10 }));
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(A10);
  const [pass, hand] = await Promise.all([
    svc.sweepInactiveLeads(NOW),
    svc.reassignInactiveLeads({ leadIds: [String(x._id)] }, String(ids.Admin), NOW),
  ]);
  check("a pass and a hand move on the same lead → moved once", pass.moved + hand.moved.length === 1 && (await LeadMove.countDocuments({ lead: x._id })) === 1, { pass, hand });
  check("…and one turn spent: Ann's passed to Ben, the other picked nobody", (await cursor("Alpha")) === 2, await cursor("Alpha"));
  await settings({ inactiveLeads: { autoReassign: false } });

  // Settings: time zone names, two half-saves at once, saving nothing, a day sent many times.
  const lower = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Admin", { workingHours: { timezone: "asia/kolkata" } });
  check("a time zone in any case is stored as its name: asia/kolkata → Asia/Kolkata", lower.status === 200 && lower.body.data.settings.workingHours.timezone === "Asia/Kolkata", lower.body.data?.settings?.workingHours);
  check("an offset instead of a zone name → 400", (await api("PUT", "/settings/app", "Admin", { workingHours: { timezone: "+04:00" } })).status === 400);
  await api("PUT", "/settings/app", "Admin", { workingHours: { timezone: "Asia/Dubai" } });
  const [early, late] = await Promise.all([
    api("PUT", "/settings/app", "Admin", { workingHours: { start: "18:00" } }),
    api("PUT", "/settings/app", "Admin", { workingHours: { end: "17:00" } }),
  ]);
  const wh = (await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings.workingHours;
  check("two half-saves at once can't leave the hours ending before they start", [early.status, late.status].sort().join() === "200,400" && wh.start < wh.end, { statuses: [early.status, late.status], wh });
  await api("PUT", "/settings/app", "Admin", { workingHours: { start: "10:00", end: "19:00" } });
  const before = (await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings;
  const empty = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Sue", {});
  check("saving nothing changes nothing — not even who saved last", empty.status === 200 && empty.body.data.settings.updatedAt === before.updatedAt && empty.body.data.settings.updatedBy === before.updatedBy, { before: [before.updatedAt, before.updatedBy], after: [empty.body.data?.settings?.updatedAt, empty.body.data?.settings?.updatedBy] });
  const dup = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Admin", { workingHours: { days: [1, 1, 1, 1, 1, 1, 1, 1, 2] } });
  check("a day sent many times counts once (not refused as more than 7)", dup.status === 200 && dup.body.data.settings.workingHours.days.join() === "1,2", dup.body.data?.settings?.workingHours?.days);
  await api("PUT", "/settings/app", "Admin", { workingHours: { days: [1, 2, 3, 4, 5, 6] } });

  // The page's own lists: teams for the filter (view), people for the Move dialog (edit) — no Teams / Users box.
  const teamsList = await api<Array<{ id: string; name: string }>>("GET", "/inactive-leads/teams", "Vic");
  check("teams for the filter with only Inactive Leads view — active teams only", teamsList.status === 200 && teamsList.body.data.some((t) => t.name === "Alpha") && !teamsList.body.data.some((t) => t.name === "Dead"), teamsList.body.data?.map((t) => t.name));
  check("people to move to need the edit: view → 403", (await api("GET", "/inactive-leads/people", "Vic")).status === 403);
  const found = await api<Array<{ name: string }>>("GET", "/inactive-leads/people?search=fa", "Max");
  check("…with edit: active people by name, searchable", found.status === 200 && found.body.data.map((p) => p.name).join() === "Fay", found.body.data?.map((p) => p.name));
  check("…deactivated people aren't offered", !(await api<Array<{ name: string }>>("GET", "/inactive-leads/people", "Max")).body.data.some((p) => p.name === "Eve"));
  check("…Sales Staff: 403 for both, signed out 401", (await api("GET", "/inactive-leads/teams", "Ann")).status === 403 && (await api("GET", "/inactive-leads/people", "Ann")).status === 403 && (await api("GET", "/inactive-leads/teams", null)).status === 401);
  check("…a search over 100 characters → 400", (await api("GET", `/inactive-leads/people?search=${"x".repeat(101)}`, "Max")).status === 400);

  // Log follow-up (pre-existing): saved, and now says so.
  await reset();
  const [fu] = await seed(leadDoc({ name: "Follow Up", owner: ids.Ann, assignedAt: PAST }));
  const logged = await api<{ followedUpBy?: { name?: string } }>("POST", `/leads/${fu._id}/followups`, "Ann", { note: "Spoke, call back Friday" });
  check("Log follow-up answers 201 with who logged it (was a 500 after saving)", logged.status === 201 && logged.body.data?.followedUpBy?.name === "Ann" && (await leadNow(fu._id))?.followUps?.length === 1, { status: logged.status, message: logged.body.message });
}

/* ═══ Case 3 — invalid input ═════════════════════════════════════════════ */

section("Case 3 — bad filters, bad moves, bad settings: 400 and nothing changed");
{
  await reset();
  const [lead] = await seed(leadDoc({ name: "Bad Input", owner: ids.Ann, assignedAt: PAST }));
  const bad = async (path: string) => (await api("GET", path, "Admin")).status;
  check("?page=0 → 400", (await bad("/inactive-leads?page=0")) === 400);
  check("?limit=0 → 400", (await bad("/inactive-leads?limit=0")) === 400);
  check("?limit=101 → 400", (await bad("/inactive-leads?limit=101")) === 400);
  check("?teamId=abc → 400", (await bad("/inactive-leads?teamId=abc")) === 400);
  check("?ownerId=123 → 400", (await bad("/inactive-leads?ownerId=123")) === 400);
  check("?search of 101 characters → 400", (await bad(`/inactive-leads?search=${"x".repeat(101)}`)) === 400);
  check("?teamId= (cleared) → 200, no filter", (await bad("/inactive-leads?teamId=&ownerId=&search=")) === 200);
  check("moves ?kind=robot → 400", (await bad("/inactive-leads/moves?kind=robot")) === 400);
  check("moves ?page=-1 → 400", (await bad("/inactive-leads/moves?page=-1")) === 400);

  const id = String(lead._id);
  const bodies: Array<[string, unknown]> = [
    ["no body", {}],
    ["no leads", { leadIds: [] }],
    ["a bad lead id", { leadIds: ["x"] }],
    ["leads not a list", { leadIds: id }],
    ["101 leads", { leadIds: Array.from({ length: 101 }, () => String(new Types.ObjectId())) }],
    ["a bad person id", { leadIds: [id], to: "x" }],
    ["an unknown field", { leadIds: [id], force: true }],
  ];
  for (const [label, body] of bodies) {
    const r = await api("POST", "/inactive-leads/reassign", "Admin", body);
    check(`reassign with ${label} → 400`, r.status === 400, r.status);
  }
  const nobody = await api("POST", "/inactive-leads/reassign", "Admin", { leadIds: [id], to: String(new Types.ObjectId()) });
  check("to a person who doesn't exist → 400, says so", nobody.status === 400 && nobody.body.message === "That person doesn't exist or is deactivated", nobody.body);
  const gone = await api("POST", "/inactive-leads/reassign", "Admin", { leadIds: [id], to: String(ids.Eve) });
  check("to a deactivated person → 400", gone.status === 400, gone.status);
  const max = await api<ReassignResult>("POST", "/inactive-leads/reassign", "Admin", { leadIds: Array.from({ length: 100 }, () => String(new Types.ObjectId())) });
  check("100 leads at once is allowed (all unknown → all skipped)", max.status === 200 && max.body.data.skipped.length === 100, max.status);
  check("…none of it moved anything", (await LeadMove.countDocuments()) === 0 && (await ownerOf(lead._id)) === String(ids.Ann));

  const settingsBefore = JSON.stringify((await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings);
  const badSettings: Array<[string, unknown]> = [
    ["a limit under 5 min", { inactiveLeads: { limitMinutes: 4 } }],
    ["a limit over 7 days", { inactiveLeads: { limitMinutes: 7 * 24 * 60 + 1 } }],
    ["a limit as text", { inactiveLeads: { limitMinutes: "60" } }],
    ["a fractional limit", { inactiveLeads: { limitMinutes: 45.5 } }],
    ["the switch time set by hand", { inactiveLeads: { enabledAt: "2026-01-01T00:00:00Z" } }],
    ["an unknown email setting", { email: { enabled: true } }],
    ["an idle limit over a day", { idleAlerts: { limitMinutes: 24 * 60 + 1 } }],
    ["no working days", { workingHours: { days: [] } }],
    ["a day 7", { workingHours: { days: [7] } }],
    ["25:00", { workingHours: { start: "25:00" } }],
    ["9:00 without the zero", { workingHours: { start: "9:00" } }],
    ["a time zone that doesn't exist", { workingHours: { timezone: "Mars/Olympus" } }],
    ["a start after the end", { workingHours: { start: "20:00" } }],
    ["a list for a body", []],
  ];
  for (const [label, body] of badSettings) {
    const r = await api("PUT", "/settings/app", "Admin", body);
    check(`settings with ${label} → 400`, r.status === 400, { status: r.status, message: r.body.message });
  }
  const after = JSON.stringify((await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings);
  check("…and the settings are exactly as they were", after === settingsBefore, { before: settingsBefore, after });
  const startAfterEnd = await api("PUT", "/settings/app", "Admin", { workingHours: { start: "20:00" } });
  check("a start after the end says why", startAfterEnd.body.message === "Working hours must end after they start", startAfterEnd.body.message);
  check("removing a notification with a bad id → 400", (await api("DELETE", "/notifications/not-an-id", "Admin")).status === 400);
}

/* ═══ Case 4 — who may ═══════════════════════════════════════════════════ */

section("Case 4 — signed out, Sales Staff, the Inactive Leads box, the Settings box");
{
  await reset();
  const [lead] = await seed(leadDoc({ name: "Perm Lead", owner: ids.Ann, assignedAt: PAST }));
  const open: Array<[string, string]> = [
    ["GET", "/inactive-leads"], ["GET", "/inactive-leads/moves"], ["POST", "/inactive-leads/reassign"],
    ["GET", "/settings/app"], ["PUT", "/settings/app"], ["GET", "/notifications"], ["POST", "/notifications/read-all"], ["DELETE", "/notifications"],
  ];
  for (const [m, p] of open) {
    const r = await api(m, p, null, m === "GET" ? undefined : {});
    check(`signed out: ${m} ${p} → 401`, r.status === 401, r.status);
  }
  check("a forged token → 401", (await api("GET", "/inactive-leads", "not-a-token")).status === 401);

  const staff: Array<[string, string, unknown]> = [
    ["GET", "/inactive-leads", undefined], ["GET", "/inactive-leads/moves", undefined],
    ["POST", "/inactive-leads/reassign", { leadIds: [String(lead._id)], to: String(ids.Ben) }],
    ["GET", "/settings/app", undefined], ["PUT", "/settings/app", { inactiveLeads: { autoReassign: true } }],
  ];
  for (const [m, p, b] of staff) {
    const r = await api(m, p, "Ann", b);
    check(`Sales Staff: ${m} ${p} → 403`, r.status === 403, r.status);
  }
  check("…nothing moved, nothing switched on", (await ownerOf(lead._id)) === String(ids.Ann) && (await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings.inactiveLeads.autoReassign === false);

  check("Inactive Leads view: the list → 200", (await api("GET", "/inactive-leads", "Vic")).status === 200);
  check("…the moves log → 200", (await api("GET", "/inactive-leads/moves", "Vic")).status === 200);
  const vicMove = await api("POST", "/inactive-leads/reassign", "Vic", { leadIds: [String(lead._id)], to: String(ids.Ben) });
  check("…moving → 403, nothing moved", vicMove.status === 403 && (await ownerOf(lead._id)) === String(ids.Ann), vicMove.status);
  const maxMove = await api<ReassignResult>("POST", "/inactive-leads/reassign", "Max", { leadIds: [String(lead._id)], to: String(ids.Ben) });
  check("Inactive Leads view + edit: moving → 200, moved, logged as theirs", maxMove.status === 200 && (await ownerOf(lead._id)) === String(ids.Ben) && (await LeadMove.findOne({ lead: lead._id }).lean())?.by?.toString() === String(ids.Max), maxMove.body);

  check("Settings view: read → 200", (await api("GET", "/settings/app", "Sid")).status === 200);
  const sidPut = await api("PUT", "/settings/app", "Sid", { inactiveLeads: { limitMinutes: 90 } });
  check("…change → 403, not saved", sidPut.status === 403 && (await api<{ settings: AppSettingsDTO }>("GET", "/settings/app", "Admin")).body.data.settings.inactiveLeads.limitMinutes === 45, sidPut.status);
  const suePut = await api<{ settings: AppSettingsDTO }>("PUT", "/settings/app", "Sue", { inactiveLeads: { limitMinutes: 90 } });
  check("Settings edit: change → 200, saved, by them", suePut.status === 200 && suePut.body.data.settings.inactiveLeads.limitMinutes === 90 && suePut.body.data.settings.updatedBy === String(ids.Sue), suePut.body);
  await api("PUT", "/settings/app", "Admin", { inactiveLeads: { limitMinutes: 45 } });
  check("anyone signed in has their own bell: Sales Staff → 200", (await api("GET", "/notifications", "Ann")).status === 200);
}

section("Breaks (as the Sales CRM, 2026-10-20: the owner's break doesn't count, and nothing of theirs moves in one)");
{
  const { BreakLog } = await import("../src/models/BreakLog.js");
  await reset();
  await BreakLog.collection.deleteMany({});
  await db.collection("users").updateMany({}, { $set: { breakSince: null, breakKind: null } });
  await settings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } });
  await enabledAt(gst(MON, "08:00"));
  const listAt = (at: Date) => svc.listInactiveLeads({ page: 1, limit: 100 }, at);

  // 1 — a break that ended: Ann's lead from 10:00; she took a break 10:10–10:30. The shift here is 10:00–19:00.
  const [brk] = await seed(leadDoc({ name: "Break Clock", owner: ids.Ann, assignedAt: gst(MON, "10:00") }));
  await BreakLog.create({ user: ids.Ann, start: gst(MON, "10:10"), end: gst(MON, "10:30") });
  let list = await listAt(gst(MON, "10:45"));
  check("10:45: 45 min less a 20-min break = 25 — not inactive", list.items.length === 0, list.items.map((i) => i.waitingMinutes));
  check("…and the mover leaves it", (await svc.sweepInactiveLeads(gst(MON, "10:45"))).moved === 0 && (await ownerOf(brk._id)) === String(ids.Ann));
  list = await listAt(gst(MON, "11:05"));
  check("11:05: 65 − 20 = 45 — inactive, due", list.items.length === 1 && list.items[0].waitingMinutes === 45 && list.items[0].autoMove === "due", list.items.map((i) => [i.waitingMinutes, i.autoMove]));
  const [benLead] = await seed(leadDoc({ name: "Ben Unbroken", owner: ids.Ben, assignedAt: gst(MON, "10:00") }));
  list = await listAt(gst(MON, "11:05"));
  check("somebody else's break doesn't stop Ben's clock: 65 min", list.items.find((i) => i.id === String(benLead._id))?.waitingMinutes === 65, list.items.map((i) => [i.name, i.waitingMinutes]));

  // 2 — on a break now: past the limit, listed, never moved by the mover while it lasts; the time in it doesn't count.
  await reset();
  await BreakLog.collection.deleteMany({});
  const [onBrk] = await seed(leadDoc({ name: "On Break", owner: ids.Ann, assignedAt: gst(MON, "10:00") }));
  const [benDue] = await seed(leadDoc({ name: "Ben Due", owner: ids.Ben, assignedAt: gst(MON, "10:00") }));
  await db.collection("users").updateOne({ _id: ids.Ann }, { $set: { breakSince: gst(MON, "11:30"), breakKind: "lunch" } });
  list = await listAt(gst(MON, "11:50"));
  const annRow = list.items.find((i) => i.id === String(onBrk._id));
  check("on a break since 11:30, at 11:50: 90 min counted (the break's 20 not), shown as on a break", annRow?.waitingMinutes === 90 && annRow?.autoMove === "on_break", annRow);
  const during = await svc.sweepInactiveLeads(gst(MON, "11:50"));
  check("…the mover leaves it while the break lasts", (await ownerOf(onBrk._id)) === String(ids.Ann), during);
  check("…others' due leads still move", during.moved === 1 && (await ownerOf(benDue._id)) !== String(ids.Ben), during);
  const byHand = await svc.reassignInactiveLeads({ leadIds: [String(onBrk._id)], to: String(ids.Cat) }, String(ids.Admin), gst(MON, "11:50"));
  check("…a super admin can still move it by hand", byHand.moved.length === 1 && (await ownerOf(onBrk._id)) === String(ids.Cat), byHand);
  await db.collection("users").updateOne({ _id: ids.Ann }, { $set: { breakSince: null, breakKind: null } });

  // 3 — a break left on from Saturday and never ended counts to Saturday's end, not on into Monday.
  await reset();
  const [weekend] = await seed(leadDoc({ name: "Left On", owner: ids.Ann, assignedAt: gst(SAT, "18:30") }));
  await db.collection("users").updateOne({ _id: ids.Ann }, { $set: { breakSince: gst(SAT, "18:40") } });
  list = await listAt(gst(MON, "10:35"));
  const left = list.items.find((i) => i.id === String(weekend._id));
  check("a break left on Saturday ends with Saturday: 30 − 20 = 10 min Sat + 35 Mon = 45, not on a break now", left?.waitingMinutes === 45 && left?.autoMove !== "on_break", left);
  await db.collection("users").updateOne({ _id: ids.Ann }, { $set: { breakSince: null } });
  await settings({ inactiveLeads: { autoReassign: false } });

  // 4 — the Take break button: everyone's own, each ended break written down once.
  await BreakLog.collection.deleteMany({});
  const g0 = await api<{ onBreak: boolean; since: string | null; kind: string | null }>("GET", "/break", "Ben");
  check("GET /break: not on one", g0.status === 200 && g0.body.data.onBreak === false && g0.body.data.since === null && g0.body.data.kind === null, g0.body);
  const on1 = await api<{ onBreak: boolean; since: string | null; kind: string | null }>("POST", "/break", "Ben", { on: true, kind: "tea" });
  const on2 = await api<{ onBreak: boolean; since: string | null; kind: string | null }>("POST", "/break", "Ben", { on: true, kind: "lunch" });
  check("Take break (tea) → on a break, none written yet", on1.status === 200 && on1.body.data.onBreak === true && on1.body.data.kind === "tea" && (await BreakLog.countDocuments({ user: ids.Ben })) === 0, on1.body);
  check("…pressed again: still the first one — same start, same kind", on2.status === 200 && on2.body.data.since === on1.body.data.since && on2.body.data.kind === "tea", on2.body);
  const g1 = await api<{ onBreak: boolean; since: string | null; kind: string | null }>("GET", "/break", "Ben");
  check("GET /break: on one since then, tea", g1.body.data.onBreak === true && g1.body.data.since === on1.body.data.since && g1.body.data.kind === "tea", g1.body);
  check("…nobody else's: Cat isn't on one", (await api<{ onBreak: boolean }>("GET", "/break", "Cat")).body.data.onBreak === false);
  await Bun.sleep(1100);
  const offs = await Promise.all([api("POST", "/break", "Ben", { on: false }), api("POST", "/break", "Ben", { on: false })]);
  const logs = await BreakLog.find({ user: ids.Ben }).lean();
  check("End break (pressed twice at once) → written once, start before end, its kind", offs.every((o) => o.status === 200) && logs.length === 1 && logs[0].end > logs[0].start && logs[0].kind === "tea", logs);
  const ben = await db.collection("users").findOne({ _id: ids.Ben });
  check("…and Ben is off it", ben?.breakSince === null && ben?.breakKind === null, ben);
  const leftDay = new Date(gstMidnight(new Date()).getTime() - 3 * 3_600_000);
  await db.collection("users").updateOne({ _id: ids.Ben }, { $set: { breakSince: leftDay } });
  const stale = await api<{ onBreak: boolean }>("GET", "/break", "Ben");
  check("a break left on from yesterday: not on one today", stale.body.data.onBreak === false, stale.body);
  await api("POST", "/break", "Ben", { on: true });
  const leftLog = await BreakLog.findOne({ user: ids.Ben, start: leftDay }).lean();
  check("…then a new one → yesterday's written to its midnight", leftLog?.end.getTime() === gstMidnight(new Date()).getTime(), leftLog);
  await api("POST", "/break", "Ben", { on: false });
  for (const [label, body] of [["no on", {}], ["on not a boolean", { on: "yes" }], ["a kind it doesn't know", { on: true, kind: "nap" }]] as const) {
    const b = await api("POST", "/break", "Ann", body);
    check(`POST /break with ${label} → 400`, b.status === 400, b.status);
  }
  check("…nothing started", (await db.collection("users").findOne({ _id: ids.Ann }))?.breakSince == null);
  check("signed out → 401", (await api("GET", "/break", null)).status === 401 && (await api("POST", "/break", null, { on: true })).status === 401);
}

section("Wiring");
{
  const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const gate = index.indexOf("if (env.RUN_SCHEDULERS)");
  const call = index.indexOf("startInactiveLeadScheduler()");
  check("the mover starts with the other schedulers, only where they run", gate >= 0 && call > gate, { gate, call });
  const routesText = await Bun.file(new URL("../src/routes/index.ts", import.meta.url)).text();
  check("/settings, /notifications, /inactive-leads and /break are mounted", ['"/settings"', '"/notifications"', '"/inactive-leads"', '"/break"'].every((p) => routesText.includes(p)));
}

/* ── Done ────────────────────────────────────────────────────────────────── */

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
