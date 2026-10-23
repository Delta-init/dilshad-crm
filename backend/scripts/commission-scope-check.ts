/**
 * Who sees whose commission (the user, 2026-10-23: "a salesperson only his own; the team leader his and his team
 * members'; the sales manager everyone"):
 *   Case 1  happy path   Earnings, the Plan, My Pay and the close-form preview: a salesperson their own, a team
 *                        leader their team's (no SM line or rate), the Sales Manager and a Super Admin everything
 *   Case 2  edge         a leader of a switched-off team: only their own; the enrolment page's rule (canSeeLine)
 *   Case 3  errors       the preview asked for someone else's sale: no lines, nothing of their total
 *   Case 4  permission   no session 401
 *
 * Run by commission-scope-check.sh. Scratch database only.
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
  JWT_SECRET: "commission-scope-check-jwt-0123456789", JWT_REFRESH_SECRET: "commission-scope-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "", FINANCE_API_URL: "", FINANCE_SERVICE_SECRET: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("not a local database");
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { canSeeLine, commissionScope, uaeMonthOf } = await import("../src/services/commissionService.js");

const admin = new Types.ObjectId(), staff = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staff, roleName: "Sales Staff", isSystemRole: false, permissions: { commission: { view: true }, pay: { view: true }, leads: { view: true } } },
]);
const id = () => new Types.ObjectId();
const P = { boss: id(), sm: id(), tl: id(), ann: id(), ben: id(), oldTl: id(), olly: id() };
const NAME: Record<string, string> = { boss: "Boss", sm: "Sam Manager", tl: "Tina Lead", ann: "Ann", ben: "Ben", oldTl: "Old Lead", olly: "Olly" };
await db.collection("users").insertMany(Object.entries(P).map(([k, _id]) => ({
  _id, name: NAME[k], email: `${k}@test.local`, password: "x", role: k === "boss" ? admin : staff, status: "active",
})));
const teamA = id(), teamB = id(), teamOld = id();
await db.collection("teams").insertMany([
  { _id: teamA, name: "Alpha", status: "active", leaders: [P.tl], members: [P.ann], settings: {} },
  { _id: teamB, name: "Beta", status: "active", leaders: [], members: [P.ben], settings: {} },
  { _id: teamOld, name: "Old team", status: "inactive", leaders: [P.oldTl], members: [P.olly], settings: {} },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: P.sm, excludedUsers: [] });
const course = id();
await db.collection("courses").insertOne({ _id: course, name: "Forex Pro", amount: 5000, status: "active", commission: { sales: 300, tl: 100, sm: 50, creditUsd: 10 } });

const month = uaeMonthOf(new Date());
const line = (role: string, who: keyof typeof P, amount: number) => ({ role, user: P[who], userName: NAME[who], amount });
await db.collection("commissionsales").insertMany([
  { student: id(), studentName: "S1", courseName: "Forex Pro", closer: P.ann, closerName: "Ann", team: teamA, teamName: "Alpha",
    saleDate: new Date(), month, state: "counted", lines: [line("sales", "ann", 300), line("tl", "tl", 100), line("sm", "sm", 50)] },
  { student: id(), studentName: "S2", courseName: "Forex Pro", closer: P.ben, closerName: "Ben", team: teamB, teamName: "Beta",
    saleDate: new Date(), month, state: "counted", lines: [line("sales", "ben", 300), line("sm", "sm", 50)] },
  { student: id(), studentName: "S3", courseName: "Forex Pro", closer: P.olly, closerName: "Olly", team: teamOld, teamName: "Old team",
    saleDate: new Date(), month, state: "counted", lines: [line("sales", "olly", 300), line("tl", "oldTl", 100), line("sm", "sm", 50)] },
]);

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const T = Object.fromEntries(Object.entries(P).map(([k, u]) => [k, signAccessToken({ userId: String(u), email: `${k}@test.local`, roleId: String(k === "boss" ? admin : staff) })]));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function get(path: string, who: keyof typeof P | null) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: who ? { authorization: `Bearer ${T[who]}` } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const names = (lines: Json[]) => lines.map((l) => `${l.role}:${l.userName}`).sort();
const earnings = async (who: keyof typeof P) => (await get(`/commission/earnings?month=${month}`, who)).body.data as Json;
const allLines = (e: Json) => (e?.sales ?? []).flatMap((s: Json) => s.lines);
const DRAW = process.env.CRM_KIND === "draw";
const preview = (who: keyof typeof P, closer: keyof typeof P, team: string) =>
  get(`/commission/preview?${DRAW ? "courses" : "course"}=${course}&closer=${P[closer]}&team=${team}`, who);

section("Case 1 — Earnings");
{
  const ann = await earnings("ann"), tl = await earnings("tl"), sm = await earnings("sm"), boss = await earnings("boss");
  check("a salesperson: only their own line, scope own", ann?.scope === "own" && JSON.stringify(names(allLines(ann))) === JSON.stringify(["sales:Ann"]), [ann?.scope, names(allLines(ann ?? {}))]);
  check("a team leader: their team's lines (Ann's and their own), no SM line, not Beta's", tl?.scope === "team"
    && JSON.stringify(names(allLines(tl))) === JSON.stringify(["sales:Ann", "tl:Tina Lead"]), [tl?.scope, names(allLines(tl ?? {}))]);
  check("the Sales Manager: every sale, every line", sm?.scope === "all" && allLines(sm).length === 8, [sm?.scope, allLines(sm ?? {}).length]);
  check("a Super Admin: every sale, every line", boss?.scope === "all" && allLines(boss).length === 8, boss?.scope);
}

section("Case 1 — the Plan");
{
  const ann = (await get("/commission/plan", "ann")).body.data as Json;
  const tl = (await get("/commission/plan", "tl")).body.data as Json;
  const sm = (await get("/commission/plan", "sm")).body.data as Json;
  const rate = (p: Json) => Object.keys(p?.courses?.[0]?.commission ?? {}).sort().join(",");
  check("a salesperson: view own, only the sales rate, no Sales Manager, no teams, only the sales slab",
    ann?.view === "own" && rate(ann) === "creditUsd,sales" && ann?.salesManager === null && (ann?.excludedUsers ?? []).length === 0
    && (ann?.teams ?? []).length === 0 && Object.keys(ann?.slabs ?? {}).every((k) => k === "sales"), { view: ann?.view, rate: rate(ann), sm: ann?.salesManager, teams: ann?.teams, slabs: Object.keys(ann?.slabs ?? {}) });
  check("a team leader: view team, sales + TL rate (no SM), their own team with its members", tl?.view === "team" && rate(tl) === "creditUsd,sales,tl"
    && tl?.salesManager === null && (tl?.teams ?? []).length === 1 && tl.teams[0].name === "Alpha" && tl.teams[0].members?.[0]?.name === "Ann", { view: tl?.view, rate: rate(tl), teams: tl?.teams });
  check("the Sales Manager: the whole plan, the SM rate and who the SM is", sm?.view === "all" && rate(sm) === "creditUsd,sales,sm,tl" && sm?.salesManager?.name === "Sam Manager", { view: sm?.view, rate: rate(sm) });
}

section("Case 1 — My Pay");
{
  const ann = (await get(`/commission/pay?month=${month}`, "ann")).body.data as Json;
  const tl = (await get(`/commission/pay?month=${month}`, "tl")).body.data as Json;
  const sm = (await get(`/commission/pay?month=${month}`, "sm")).body.data as Json;
  const allowed = new Set([String(P.tl), String(P.ann)]);
  check("a salesperson: no one else's pay", ann?.people === null && ann?.view === "own", { view: ann?.view, people: ann?.people });
  check("a team leader: view team, only their team's people", tl?.view === "team" && Array.isArray(tl?.people) && tl.people.every((r: Json) => allowed.has(r.user)), { view: tl?.view, people: (tl?.people ?? []).map((r: Json) => r.user) });
  check("the Sales Manager: everyone", sm?.view === "all" && Array.isArray(sm?.people), sm?.view);
}

section("Case 1 / 3 — the close-form preview");
{
  const own = (await preview("ann", "ann", String(teamA))).body.data as Json;
  check("closing their own sale: their own line, and their total", own && JSON.stringify(names(own.lines)) === JSON.stringify(["sales:Ann"]) && own.closerTotal === 300
    && !("sm" in (own.plan ?? {})), { lines: names(own?.lines ?? []), total: own?.closerTotal, plan: own?.plan });
  const other = (await preview("ben", "ann", String(teamA))).body.data as Json;
  check("someone else's sale: no lines, nothing of their total", other && other.lines.length === 0 && other.closerTotal === 0, { lines: names(other?.lines ?? []), total: other?.closerTotal });
  const lead = (await preview("tl", "ann", String(teamA))).body.data as Json;
  check("their team leader: the team's lines, no SM line", lead && !lead.lines.some((l: Json) => l.role === "sm") && lead.lines.some((l: Json) => l.userName === "Ann"), names(lead?.lines ?? []));
  const smv = (await preview("sm", "ann", String(teamA))).body.data as Json;
  check("the Sales Manager: every line, the SM's too", smv && smv.lines.some((l: Json) => l.role === "sm"), names(smv?.lines ?? []));
  const smClose = (await preview("ben", "sm", String(teamB))).body.data as Json;
  check("the Sales Manager's own close, asked by a salesperson: nothing of their share", smClose && smClose.closerTotal === 0 && smClose.lines.length === 0, { total: smClose?.closerTotal, lines: names(smClose?.lines ?? []) });
}

section("Case 2 — a leader of a switched-off team");
{
  const old = await earnings("oldTl");
  check("only their own lines (the old team's TL line), not Olly's", old?.scope === "own" && JSON.stringify(names(allLines(old))) === JSON.stringify(["tl:Old Lead"]), [old?.scope, names(allLines(old ?? {}))]);
  const plan = (await get("/commission/plan", "oldTl")).body.data as Json;
  check("…and the plan as a salesperson's", plan?.view === "own", plan?.view);
}
{
  const tlScope = await commissionScope({ userId: String(P.tl) });
  const ann = String(P.ann);
  check("the enrolment page's rule: a team leader sees a team sale's lines but the SM's",
    canSeeLine(tlScope, String(P.tl), { user: P.ann, role: "sales" }, ann) && !canSeeLine(tlScope, String(P.tl), { user: P.sm, role: "sm" }, ann));
  const annScope = await commissionScope({ userId: ann });
  check("…a salesperson only their own", canSeeLine(annScope, ann, { user: P.ann, role: "sales" }, ann) && !canSeeLine(annScope, ann, { user: P.tl, role: "tl" }, ann));
}

section("Case 4 — permission");
check("no session: 401", (await get(`/commission/earnings?month=${month}`, null)).status === 401);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
