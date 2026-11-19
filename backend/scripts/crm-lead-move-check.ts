/**
 * Moving leads to another sales CRM (the user, 2026-11-19), on a scratch database, with a stand-in Root:
 *
 *   Sending   Super Admins, the Sales Manager, team leaders (their teams' leads) — nobody else (403); only open leads;
 *             never to this CRM; what goes to Root (notes, history, owner, who moved it); a lead leaves only once
 *             Root says the other CRM took it — kept whole in crm_moved_leads; one it didn't take stays
 *   Undo      24 hours; the other CRM gives it back first (refused there → stays moved); back exactly; not twice
 *   Taking in the sheet key; to one person (in that team, active), split across a team (fewest open first, evenly),
 *             or the CRM's own split; a number already here → the repeat rule; what it brings (notes, history)
 *   Give back a lead made by the move goes (kept in crm_moved_leads); one closed here can't; a repeat stays
 *
 * Run by crm-lead-move-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

/* ── A stand-in Root ──────────────────────────────────────────────────────── */
const rootCalls: { path: string; secret: string; body: Record<string, unknown> }[] = [];
const refuseUndo = new Set<string>();
const fakeRoot = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    rootCalls.push({ path: `${req.method} ${url.pathname}`, secret: req.headers.get("x-org-secret") ?? "", body });
    const ok = (data: unknown) => Response.json({ success: true, message: "ok", data });
    if (url.pathname === "/api/v1/service/lead-moves/targets") return ok([{ code: "draw", name: "Draw CRM", ready: true, teams: [] }]);
    if (url.pathname === "/api/v1/service/lead-moves" && req.method === "POST") {
      const leads = (body.leads as { fromLeadId: string; name: string }[]) ?? [];
      return ok(leads.map((l) => l.name.includes("Refuse")
        ? { fromLeadId: l.fromLeadId, moved: false, reason: "Draw CRM: no phone" }
        : { fromLeadId: l.fromLeadId, moved: true, moveId: String(new Types.ObjectId()), to: body.to, toLeadId: String(new Types.ObjectId()), outcome: "created", holder: "Dee" }));
    }
    const undo = url.pathname.match(/^\/api\/v1\/service\/lead-moves\/([0-9a-f]{24})\/undo$/);
    if (undo) {
      if (refuseUndo.has(undo[1])) return Response.json({ success: false, message: "Draw CRM: L has been closed there — it can't be taken back" }, { status: 409 });
      return ok({});
    }
    return Response.json({ success: false, message: "nope" }, { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "crm-lead-move-check-jwt-0123456789", JWT_REFRESH_SECRET: "crm-lead-move-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
  SUPER_ADMIN_EMAIL: "admin@test.local", SHEETS_API_KEY: "sheet-key-check",
  ROOT_ERP_API_URL: `http://127.0.0.1:${fakeRoot.port}`, ROOT_ORG_SECRET: "remote-secret-check",
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

type Action = "view" | "create" | "edit" | "delete" | "approve" | "export";
const perms = (m: Record<string, Partial<Record<Action, boolean>>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));
const superRole = new Types.ObjectId(), staffRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: perms({ leads: { view: true, edit: true }, users: { view: true, edit: true } }) },
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
for (const n of ["Sam", "Tina", "Ann", "Ben", "Vic", "Wes", "Nia"]) await person(n);
await person("Old", staffRole, "inactive");
// Sam: the Sales Manager. Tina leads Alpha (Ann, Ben, Old). Vic leads Beta (Wes, Nia).
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Sam, excludedUsers: [], fullViewers: [] });
const teamSettings = {
  autoAssign: false, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0,
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
await makeTeam("Alpha", ["Tina"], ["Ann", "Ben", "Old"]);
await makeTeam("Beta", ["Vic"], ["Wes", "Nia"]);

interface ApiBody<T> { success: boolean; message: string; data: T }
async function api<T>(method: string, path: string, who: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}
const j = (v: unknown) => JSON.parse(JSON.stringify(v));

let n = 0;
const AT = new Date("2026-11-10T08:00:00.000Z");
async function lead(owner: string | null, teamName: string | null, o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "META", platform: "ig", campaign: "Camp", status: "assigned",
    assignedTo: owner ? ids[owner] : null, assignedAt: AT, team: teamName ? team[teamName] : null, reporter: ids.Admin,
    notes: [{ _id: new Types.ObjectId(), content: `note on L${n}`, author: ids.Admin, createdAt: AT, updatedAt: AT }],
    reminders: [{ _id: new Types.ObjectId(), createdBy: ids.Ann, title: "call back", remindAt: new Date(Date.now() + 86_400_000), isDone: false, createdAt: AT, updatedAt: AT }],
    payments: [], followUps: [], callCount: 0,
    activityLogs: [{ _id: new Types.ObjectId(), action: "lead_created", description: "Lead imported", performedBy: ids.Admin, createdAt: AT }],
    createdAt: AT, updatedAt: AT, ...o,
  });
  return _id;
}
const moved = () => db.collection("crm_moved_leads");
// This CRM, and the other two it can move to (the same check runs in the Sales, Draw and Remote CRMs).
const { PORTAL: SELF } = await import("../src/services/rootCommission.js");
const { CRM_NAME } = await import("../src/services/crmLeadMoveService.js");
const [A, B] = ["delta", "draw", "remote"].filter((c) => c !== SELF);

try {
  /* ── Sending ──────────────────────────────────────────────────────────────── */
  section("Who may move");
  check("a salesperson: may = false", (await api<{ may: boolean }>("GET", "/crm-lead-moves/may", "Ann")).body.data?.may === false);
  for (const who of ["Admin", "Sam", "Tina"]) check(`${who}: may = true`, (await api<{ may: boolean }>("GET", "/crm-lead-moves/may", who)).body.data?.may === true);
  const a1 = await lead("Ann", "Alpha", { status: "followup" });
  check("a salesperson can't move (403)", (await api("POST", "/crm-lead-moves", "Ann", { leadIds: [String(a1)], to: A, mode: "split" })).status === 403);
  check("…nor see the other CRMs (403)", (await api("GET", "/crm-lead-moves/targets", "Ann")).status === 403);
  const t = await api<{ code: string }[]>("GET", "/crm-lead-moves/targets", "Tina");
  check("a team leader sees Root's other CRMs", t.status === 200 && t.body.data?.[0]?.code === "draw", t.body);
  check("…asked with this CRM's Root secret", rootCalls.at(-1)?.secret === "remote-secret-check");

  section("What moves");
  const a2 = await lead("Ann", "Alpha", { status: "closed" });
  const a3 = await lead("Ann", "Alpha", { status: "lost" });
  const b1 = await lead("Wes", "Beta");
  check("to this CRM itself → 400", (await api("POST", "/crm-lead-moves", "Tina", { leadIds: [String(a1)], to: SELF, mode: "split" })).status === 400);
  check("to a CRM there isn't → 400", (await api("POST", "/crm-lead-moves", "Tina", { leadIds: [String(a1)], to: "banglore", mode: "split" })).status === 400);
  rootCalls.length = 0;
  const r1 = await api<{ moved: { leadId: string; moveId: string; holder: string }[]; refused: { leadId: string; reason: string }[] }>(
    "POST", "/crm-lead-moves", "Tina", { leadIds: [String(a1), String(a2), String(a3), String(b1)], to: A, mode: "person", teamId: "t1", userId: "u1" });
  check("Tina moves her team's open lead", r1.status === 200 && r1.body.data.moved.length === 1 && r1.body.data.moved[0].leadId === String(a1), r1.body);
  const why = new Map(r1.body.data.refused.map((x) => [x.leadId, x.reason]));
  check("…a closed one stays (its enrolment is here)", /Closed/.test(why.get(String(a2)) ?? ""), r1.body.data.refused);
  check("…a lost one stays", /Lost/.test(why.get(String(a3)) ?? ""));
  check("…another team's lead isn't hers to move", /team you lead/.test(why.get(String(b1)) ?? ""));
  const sent = rootCalls.find((c) => c.path === "POST /api/v1/service/lead-moves")?.body as Record<string, unknown> & { leads: Record<string, unknown>[] };
  check("Root is asked once, only with the lead that may go", sent?.leads?.length === 1 && sent.leads[0].fromLeadId === String(a1), sent);
  check("…to the CRM picked, to a person, with the team and person picked", sent?.to === A && sent.mode === "person" && sent.teamId === "t1" && sent.userId === "u1");
  check("…who moved it, whose it was, its status, team", sent?.byName === "Tina" && sent.leads[0].ownerName === "Ann" && sent.leads[0].status === "followup" && sent.leads[0].teamName === "Alpha", sent?.leads?.[0]);
  check("…its phone, email, source, platform, campaign", sent?.leads[0].phone === "+971501000001" && sent.leads[0].email === "l1@test.local" && sent.leads[0].source === "META" && sent.leads[0].platform === "ig" && sent.leads[0].campaign === "Camp");
  check("…its notes and history", (sent?.leads[0].notes as { content: string }[])?.[0]?.content === "note on L1" && /Lead imported/.test(String(sent?.leads[0].history)));
  check("the moved lead has left the leads", !(await Lead.collection.findOne({ _id: a1 })));
  const m1 = await moved().findOne({ _id: a1 });
  check("…kept whole in crm_moved_leads (notes, reminders, history)", m1?.lead?.notes?.length === 1 && m1?.lead?.reminders?.length === 1 && m1?.lead?.activityLogs?.length === 1 && m1?.to === A && m1?.toName === CRM_NAME[A], m1);
  check("…with Root's move id, who has it there, who moved it", m1?.moveId === r1.body.data.moved[0].moveId && m1?.holder === "Dee" && m1?.byName === "Tina" && m1?.ownerName === "Ann");
  check("the ones that didn't go are still here", !!(await Lead.collection.findOne({ _id: a2 })) && !!(await Lead.collection.findOne({ _id: b1 })));

  const refuse = await lead("Wes", "Beta", { name: "Refuse me" });
  const r2 = await api<{ moved: unknown[]; refused: { reason: string }[] }>("POST", "/crm-lead-moves", "Admin", { leadIds: [String(refuse), String(b1)], to: B, mode: "split" });
  check("a Super Admin moves any team's leads", r2.body.data?.moved?.length === 1, r2.body);
  check("one the other CRM didn't take stays, with its reason", !!(await Lead.collection.findOne({ _id: refuse })) && /no phone/.test(r2.body.data.refused[0]?.reason ?? ""), r2.body.data);
  const s1 = await lead("Nia", "Beta");
  check("the Sales Manager moves too", (await api<{ moved: unknown[] }>("POST", "/crm-lead-moves", "Sam", { leadIds: [String(s1)], to: B, mode: "split" })).body.data?.moved?.length === 1);
  check("a lead already moved → refused, not sent twice", /already moved/.test((await api<{ refused: { reason: string }[] }>("POST", "/crm-lead-moves", "Admin", { leadIds: [String(a1)], to: A, mode: "split" })).body.data?.refused?.[0]?.reason ?? ""));

  section("A person's open leads (Users → Transfer leads)");
  const w1 = await lead("Wes", "Beta"), w2 = await lead("Wes", "Beta", { status: "callback" }), w3 = await lead("Wes", "Beta", { status: "closed" });
  const fu = await api<{ moved: { leadId: string }[]; refused: unknown[] }>("POST", "/crm-lead-moves", "Vic", { fromUserId: String(ids.Wes), to: A, mode: "split" });
  const fuIds = new Set(fu.body.data?.moved?.map((m) => m.leadId));
  check("Vic moves all Wes's open leads; the closed one stays", fu.status === 200 && fuIds.has(String(w1)) && fuIds.has(String(w2)) && !fuIds.has(String(w3)) && !!(await Lead.collection.findOne({ _id: w3 })), fu.body);
  check("…someone with none → 400", (await api("POST", "/crm-lead-moves", "Admin", { fromUserId: String(ids.Old), to: A, mode: "split" })).status === 400);
  for (const id of [w1, w2]) await moved().deleteOne({ _id: id });

  section("Moved out list and the lead's page");
  const list = await api<{ id: string; toName: string; canUndo: boolean }[]>("GET", "/crm-lead-moves", "Admin");
  check("a Super Admin sees every lead moved out", list.body.data?.length === 3 && list.body.data.every((x) => x.canUndo), list.body);
  const tl = await api<{ id: string }[]>("GET", "/crm-lead-moves", "Vic");
  check("Vic sees only his team's (Beta: 2)", tl.body.data?.length === 2 && !tl.body.data.some((x) => x.id === String(a1)), tl.body);
  check("a salesperson can't (403)", (await api("GET", "/crm-lead-moves", "Ann")).status === 403);
  const page = await api<{ lead: { name: string }; toName: string }>("GET", `/crm-lead-moves/${a1}`, "Tina");
  check("the moved lead's page: read only, where it went", page.body.data?.lead?.name === "L1" && page.body.data.toName === CRM_NAME[A], page.body);

  section("Undo");
  check("someone else's team → 403", (await api("POST", `/crm-lead-moves/${a1}/undo`, "Vic")).status === 403);
  const u1 = await api("POST", `/crm-lead-moves/${a1}/undo`, "Tina");
  const back = await Lead.collection.findOne({ _id: a1 });
  check("Tina undoes it: back here, same id", u1.status === 200 && !!back, u1.body);
  check("…as it was (owner, team, status, notes, reminders)", String(back?.assignedTo) === String(ids.Ann) && String(back?.team) === String(team.Alpha) && back?.status === "followup" && back?.notes?.length === 1 && back?.reminders?.length === 1, back);
  check("…with a line saying the move was undone", back?.activityLogs?.at(-1)?.action === "lead_moved" && /undone by Tina/.test(back?.activityLogs?.at(-1)?.description), back?.activityLogs);
  check("…Root was asked to have it given back first", rootCalls.some((c) => c.path === `POST /api/v1/service/lead-moves/${m1?.moveId}/undo` && c.body.byName === "Tina"));
  check("…the moved row says undone", !!(await moved().findOne({ _id: a1 }))?.undoneAt);
  check("not twice (409)", (await api("POST", `/crm-lead-moves/${a1}/undo`, "Tina")).status === 409);
  const again = await api<{ moved: { leadId: string }[] }>("POST", "/crm-lead-moves", "Tina", { leadIds: [String(a1)], to: A, mode: "split" });
  check("moved again after an Undo: it goes (its old undone row replaced)", again.body.data?.moved?.length === 1 && !(await Lead.collection.findOne({ _id: a1 })) && !(await moved().findOne({ _id: a1 }))?.undoneAt, again.body);
  await api("POST", `/crm-lead-moves/${a1}/undo`, "Tina");
  const m2 = await moved().findOne({ _id: s1 });
  refuseUndo.add(m2!.moveId);
  const u2 = await api("POST", `/crm-lead-moves/${s1}/undo`, "Admin");
  check("the other CRM refuses (closed there) → 409, it stays moved", u2.status === 409 && /closed there/.test(u2.body.message) && !(await Lead.collection.findOne({ _id: s1 })), u2.body);
  await moved().updateOne({ _id: b1 }, { $set: { at: new Date(Date.now() - 25 * 3_600_000) } });
  check("after 24 hours → 409", (await api("POST", `/crm-lead-moves/${b1}/undo`, "Admin")).status === 409);

  section("From Root's Lead moves page (the sheet key)");
  const rootSend = (b: unknown, key = "sheet-key-check") => api<{ moved: { leadId: string }[]; refused: { reason: string }[] }>("POST", "/sheets/lead-moves/send", null, b, { "x-api-key": key });
  const r9 = await lead("Ann", "Alpha"), r10 = await lead("Wes", "Beta", { status: "closed" });
  check("without the sheet key → 401", (await rootSend({ leadIds: [String(r9)], to: A, mode: "split" }, "nope")).status === 401);
  const rs = await rootSend({ leadIds: [String(r9), String(r10)], to: A, mode: "split", byName: "Rhea" });
  check("Root moves any team's open lead; a closed one stays", rs.status === 200 && rs.body.data.moved.length === 1 && rs.body.data.moved[0].leadId === String(r9) && /Closed/.test(rs.body.data.refused[0]?.reason ?? ""), rs.body);
  const rm = await moved().findOne({ _id: r9 });
  check("…kept in Moved leads, by the root admin (Root), no CRM user", rm?.byName === "Rhea (Root)" && rm?.by === null, rm);
  check("…Root was told who moved it", rootCalls.find((c) => c.path === "POST /api/v1/service/lead-moves" && c.body.byName === "Rhea (Root)") !== undefined);
  const ru = await api("POST", "/sheets/lead-moves/undo", null, { leadId: String(r9), byName: "Rhea" }, { "x-api-key": "sheet-key-check" });
  const rb = await Lead.collection.findOne({ _id: r9 });
  check("Root undoes it: back here, the line names the root admin", ru.status === 200 && !!rb && /undone by Rhea \(Root\)/.test(rb?.activityLogs?.at(-1)?.description) && !rb?.activityLogs?.at(-1)?.performedBy, { ru: ru.body, last: rb?.activityLogs?.at(-1) });

  /* ── Taking in ───────────────────────────────────────────────────────────── */
  const sheet = (body: unknown, key = "sheet-key-check") => api<{ results: { index: number; status: string; leadId?: string; holder?: string; reason?: string }[] }>("POST", "/sheets/lead-moves", null, body, { "x-api-key": key });
  const incoming = (i: number, o: Record<string, unknown> = {}) => ({
    fromLeadId: `src${i}`, name: `In${i}`, phone: `+97155${2000000 + i}`, email: `in${i}@x.com`, source: "SRC", platform: "fb", campaign: "C",
    ownerName: "Dee", teamName: "Draw A", status: "followup", history: "2026-11-01 Lead imported", notes: [{ content: `hello ${i}`, at: "2026-11-02T10:00:00.000Z" }], ...o,
  });
  section("Taking in — the door");
  check("without the sheet key → 401", (await sheet({ from: "draw", mode: "split", leads: [incoming(1)] }, "wrong")).status === 401);

  section("Taking in — to one person");
  const p1 = await sheet({ from: "draw", mode: "person", teamId: String(team.Alpha), userId: String(ids.Ben), byName: "Dee Boss", leads: [incoming(1)] });
  const l1 = p1.body.data?.results?.[0];
  const in1 = l1?.leadId ? await Lead.collection.findOne({ _id: new Types.ObjectId(l1.leadId) }) : null;
  check("created, with Ben", p1.status === 200 && l1?.status === "created" && l1.holder === "Ben", p1.body);
  check("…Ben's, in Alpha, Assigned", String(in1?.assignedTo) === String(ids.Ben) && String(in1?.team) === String(team.Alpha) && in1?.status === "assigned", in1);
  check("…its name, phone, email, source, platform, campaign", in1?.name === "In1" && in1?.phone === "+971552000001" && in1?.email === "in1@x.com" && in1?.source === "SRC" && in1?.platform === "fb" && in1?.campaign === "C");
  check("…where it came from", in1?.movedFrom?.crm === "draw" && in1?.movedFrom?.leadId === "src1" && in1?.movedFrom?.ownerName === "Dee" && in1?.movedFrom?.byName === "Dee Boss", in1?.movedFrom);
  check("…a note saying so, with its history there", /Moved in from Draw CRM by Dee Boss/.test(in1?.notes?.[0]?.content) && /Dee's lead \(Draw A\), status followup/.test(in1?.notes?.[0]?.content) && /Lead imported/.test(in1?.notes?.[0]?.content), in1?.notes?.[0]);
  check("…its notes there, dated", /^\[Draw CRM · 2026-11-02\] hello 1$/.test(in1?.notes?.[1]?.content), in1?.notes?.[1]);
  check("…a line in its activity", in1?.activityLogs?.some((a: { action: string; description: string }) => a.action === "lead_moved" && /Moved in from Draw CRM by Dee Boss — to Ben/.test(a.description)), in1?.activityLogs);
  check("someone not in that team → 400, nothing made", (await sheet({ from: "draw", mode: "person", teamId: String(team.Alpha), userId: String(ids.Wes), leads: [incoming(2)] })).status === 400 && !(await Lead.collection.findOne({ name: "In2" })));
  check("someone deactivated → 400", (await sheet({ from: "draw", mode: "person", teamId: String(team.Alpha), userId: String(ids.Old), leads: [incoming(2)] })).status === 400);
  check("no team → 400", (await sheet({ from: "draw", mode: "person", userId: String(ids.Ben), leads: [incoming(2)] })).status === 400);

  section("Taking in — split across a team");
  await lead("Wes", "Beta"); await lead("Wes", "Beta"); // Wes has the most open leads now
  const before = await Lead.collection.countDocuments({ assignedTo: ids.Nia, status: { $nin: ["closed", "lost"] } });
  const tm = await sheet({ from: "delta", mode: "team", teamId: String(team.Beta), byName: "S", leads: [incoming(3), incoming(4), incoming(5), incoming(6)] });
  const holders = tm.body.data?.results?.map((r) => r.holder) ?? [];
  const count = (who: string) => holders.filter((h) => h === who).length;
  check("all four made, across Beta", tm.status === 200 && tm.body.data.results.every((r) => r.status === "created"), tm.body);
  check("…evenly in turn, the one with fewest open leads first", holders[0] !== "Wes" && count("Vic") + count("Wes") + count("Nia") === 4 && Math.max(count("Vic"), count("Wes"), count("Nia")) === 2, { holders, before });
  const tmLeads = await Lead.collection.find({ name: { $in: ["In3", "In4", "In5", "In6"] } }).toArray();
  check("…each in Beta, Assigned", tmLeads.every((l) => String(l.team) === String(team.Beta) && l.status === "assigned"), tmLeads.map((l) => [l.team, l.status]));

  section("Taking in — the CRM's own split");
  const sp = await sheet({ from: "delta", mode: "split", leads: [incoming(7)] });
  const in7 = await Lead.collection.findOne({ name: "In7" });
  check("made, waiting for the split (no team splits here)", sp.body.data?.results?.[0]?.status === "created" && in7?.status === "new" && !in7?.assignedTo, { r: sp.body, in7 });

  section("Taking in — a number already here, one without");
  const known = await lead("Ann", "Alpha");
  const knownPhone = (await Lead.collection.findOne({ _id: known }))!.phone;
  const rp = await sheet({ from: "draw", mode: "person", teamId: String(team.Beta), userId: String(ids.Wes), leads: [incoming(8, { phone: `00${knownPhone.replace(/\D/g, "")}` }), incoming(9, { phone: "" })] });
  const kn = await Lead.collection.findOne({ _id: known });
  check("a number already here: the repeat rule, not a second lead", rp.body.data?.results?.[0]?.status === "repeat" && rp.body.data.results[0].leadId === String(known), rp.body);
  check("…held by its team leader (Tina), counted, with the move's note", String(kn?.assignedTo) === String(ids.Tina) && kn?.repeatCount === 1 && kn?.notes?.some((x: { content: string }) => /Moved in from Draw CRM/.test(x.content)), kn);
  check("no phone → that one invalid", rp.body.data?.results?.[1]?.status === "invalid", rp.body.data?.results?.[1]);

  section("Giving one back");
  const give = (b: unknown) => api("POST", "/sheets/lead-moves/take-back", null, b, { "x-api-key": "sheet-key-check" });
  const g1 = await give({ from: "draw", leadId: l1!.leadId, outcome: "created", fromLeadId: "src1" });
  check("one the move made goes", g1.status === 200 && !(await Lead.collection.findOne({ _id: new Types.ObjectId(l1!.leadId) })), g1.body);
  check("…kept in crm_moved_leads as given back", (await moved().findOne({ _id: new Types.ObjectId(l1!.leadId) }))?.outcome === "taken_back");
  const r3 = tm.body.data.results[0].leadId!;
  await Lead.collection.updateOne({ _id: new Types.ObjectId(r3) }, { $set: { status: "closed" } });
  const g2 = await give({ from: "delta", leadId: r3, outcome: "created", fromLeadId: "src3" });
  check("one closed here can't (409)", g2.status === 409 && !!(await Lead.collection.findOne({ _id: new Types.ObjectId(r3) })), g2.body);
  const g3 = await give({ from: "draw", leadId: String(known), outcome: "repeat", fromLeadId: "src8" });
  check("a repeat stays", g3.status === 200 && !!(await Lead.collection.findOne({ _id: known })), g3.body);
  const g4 = await give({ from: "draw", leadId: String(tm.body.data.results[1].leadId), outcome: "created", fromLeadId: "someone-else" });
  check("asked for a lead it didn't make → it stays", g4.status === 200 && !!(await Lead.collection.findOne({ _id: new Types.ObjectId(tm.body.data.results[1].leadId!) })), g4.body);
} finally {
  server.close();
  fakeRoot.stop(true);
  await mongoose.disconnect();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
