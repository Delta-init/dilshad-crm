/**
 * Checks the commission rules end to end on a scratch database, against a
 * stand-in for finance that answers the enrolment status call — with the LMS
 * and Tetra Commission's side, as finance passes them on.
 *
 *   - a sale is counted once its five steps are done (finance approved, LMS
 *     account, CS, onboarded, MT5 bonus — none promised counts as approved),
 *     once, with the plan of that day; until then it is in progress, saying
 *     which step it waits on; sales closed before 1 October never count;
 *   - Sales Staff to the closer, TL to the leader of the sale's team (or the
 *     closer's one team), SM to the Sales Manager; a TL or SM who closes earns
 *     the Sales Staff amount too; the Sales Manager's own team pays no TL;
 *   - a team with no leader or two, a closer in no team, or no Sales Manager
 *     holds the sale until fixed; shared logins earn nothing;
 *   - a voided invoice reverses the sale; the month is the sale's, in UAE time;
 *   - who sees what, the preview the closing dialog shows, and the API's
 *     refusals;
 *   - a Bangalore close (2026-10-10): its status asked of Bangalore's finance
 *     organization, never Dubai's, and counted on the same plan.
 *
 * Run by commission-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

// ── A stand-in for finance's enrolment status call ──────────────────────────
type Answer = { approval: string; status: string; invoiceNumber: string; lms?: unknown; commission?: unknown };
const finance = new Map<string, Answer>();
// Like finance, each enrolment lives in one organization, and a status call
// (x-delta-org) is answered only for that organization's own.
const DUBAI_ORG = "000000000000000000000001", BLR_ORG = "000000000000000000000002";
const orgOfSale = new Map<string, string>();
const statusCalls: { org: string; ids: string[] }[] = [];
let financeDown = false;
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/v1/integrations/enrolments/status") {
      const body = (await req.json()) as { externalIds: string[] };
      if (financeDown) return new Response("down", { status: 503 });
      const org = req.headers.get("x-delta-org") ?? "";
      statusCalls.push({ org, ids: body.externalIds });
      const data = body.externalIds.filter((id) => finance.has(id) && (orgOfSale.get(id) ?? DUBAI_ORG) === org).map((id) => {
        const a = finance.get(id)!;
        return {
          externalId: id, invoiceId: `inv-${id}`, invoiceNumber: a.invoiceNumber, status: a.status,
          approval: a.approval, returnedReason: "", issueDate: "2026-10-01", currency: "AED",
          totalMinor: 0, amountPaidMinor: 0, balanceMinor: 0,
          lms: a.lms ?? null, commission: a.commission ?? null,
        };
      });
      return Response.json({ data });
    }
    return new Response("not here", { status: 404 });
  },
});

// The routes load the push service, which wants VAPID keys the moment it loads.
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "commission-check-jwt",
  JWT_REFRESH_SECRET: "commission-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "true",
  FINANCE_API_URL: `http://127.0.0.1:${fake.port}`,
  FINANCE_CLIENT_ID: "commission-check",
  FINANCE_INTEGRATION_SECRET: "commission-check-secret",
  FINANCE_ORG_ID: DUBAI_ORG,
  FINANCE_ORG_ID_BANGALORE: BLR_ORG,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { Course } = await import("../src/models/Course.js");
const { CommissionSale } = await import("../src/models/CommissionSale.js");
const { CommissionSettings } = await import("../src/models/CommissionSettings.js");
await Promise.all([CommissionSale.init(), CommissionSettings.init(), Course.init()]);
const svc = await import("../src/services/commissionService.js");
const { sweepCommission, reverseVoidedSales, CommissionService, uaeMonthOf, followNow } = svc;
/** Two passes, each following every open sale now: what one pass holds, the next settles. */
const sweep = async () => { followNow(); await sweepCommission(); followNow(); await sweepCommission(); };
const service = new CommissionService();
// This CRM's TL rule: "zero_if_sm" (Sales CRM), "always" (Remote), "never" (Draw).
const RULE = svc.TL_RULE as "zero_if_sm" | "always" | "never";
const PAYS_TL = RULE !== "never";
/** What the TL line should read: the leader and amount, 0 where the SM leads under "zero_if_sm". */
const tlLine = (leader: string, amount: number) => (PAYS_TL ? `${leader}:${leader === "Abrar" && RULE === "zero_if_sm" ? 0 : amount}` : "—");
const LINES = PAYS_TL ? 3 : 2;
console.log(`TL rule: ${RULE}`);

// ── People, teams, courses ──────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { enrolments: { view: true } } },
]);
const people: Record<string, Types.ObjectId> = {};
async function person(name: string, role = bdeRole, status = "active") {
  const _id = new Types.ObjectId();
  await db.collection("users").insertOne({
    _id, name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`, password: "x", role, status,
  });
  people[name] = _id;
  return _id;
}
for (const n of ["Abrar", "Ria", "Anfas", "Root user"]) await person(n, superRole);
for (const n of ["Theertha", "Neethu", "Shahana", "Loner", "DuoGuy", "Nobody", "Twin"]) await person(n);
await person("Gone", bdeRole, "inactive");

const teams: Record<string, Types.ObjectId> = {};
async function team(name: string, leaders: string[], members: string[], status = "active") {
  const _id = new Types.ObjectId();
  await db.collection("teams").insertOne({
    _id, name, status, leaders: leaders.map((n) => people[n]), members: members.map((n) => people[n]),
  });
  teams[name] = _id;
}
await team("TEAM TITAN", ["Ria"], ["Theertha", "Twin"]);
await team("TEAM MAVERICK", ["Anfas"], ["Neethu", "Twin"]);
await team("Team Legacy", ["Abrar"], ["Shahana"]);
await team("Team Duo", ["Ria", "Anfas"], ["DuoGuy"]);
await team("Team Headless", [], ["Nobody"]);

const c1 = await Course.create({ name: "COURSE 1 - WITH CREDIT", amount: 2250, commission: { sales: 230, tl: 100, sm: 85, creditUsd: 500 } });
const c2 = await Course.create({ name: "COURSE 2 - WITH CREDIT", amount: 5500, commission: { sales: 500, tl: 300, sm: 200, creditUsd: 1000 } });
const old = await Course.create({ name: "Market Breakout Theory", amount: 1200 });

await CommissionSettings.create({ key: "default", salesManager: people.Abrar, excludedUsers: [people["Root user"]] });

// ── Sales ───────────────────────────────────────────────────────────────────
let n = 0;
async function sale(closer: string | null, course: Types.ObjectId | null, teamName: string | null, opts: { date?: string; approval?: string; academy?: "dubai" | "bangalore" } = {}) {
  const _id = new Types.ObjectId();
  n++;
  await db.collection("students").insertOne({
    _id, name: `Student ${n}`, enrollmentNumber: `EN-${n}`, leadId: new Types.ObjectId(),
    course, team: teamName ? teams[teamName] : null, assignedTo: closer ? people[closer] : null,
    enrollmentDate: new Date(opts.date ?? "2026-10-10T08:00:00Z"), createdAt: new Date(), status: "active",
    ...(opts.academy ? { academy: opts.academy } : {}),
  });
  await db.collection("financehandovers").insertOne({
    studentId: _id, status: "sent", payload: {}, approvalState: opts.approval ?? "pending",
    invoiceNumber: `INV-${n}`, attempts: 0, nextAttemptAt: new Date(), flags: [],
    ...(opts.academy === "bangalore" ? { academy: "bangalore", financeOrgId: BLR_ORG } : opts.academy ? { academy: "dubai", financeOrgId: DUBAI_ORG } : {}),
  });
  return String(_id);
}
const DONE_LMS = { state: "created", courses: ["Market Break Out Trading Program"] };
/** Tetra Commission's side, as finance passes it on: a CS, the welcome sent, no bonus promised — unless told otherwise. */
const tc = (over: Record<string, unknown> = {}) => ({
  state: "sent", code: "STU-0001", cs: "Asha CS", team: "Team Asha", live: true,
  onboarded: { done: true, at: "2026-10-05T10:00:00.000Z", by: "Asha CS" }, bonus: { state: "none" }, ...over,
});
/** Finance approved, and nothing after it yet. */
const approve = (id: string, status = "sent") =>
  finance.set(id, { approval: "approved", status, invoiceNumber: `INV-${id.slice(-4)}`, lms: null, commission: null });
/** Every step done: the LMS account, a CS, the welcome, and the bonus — none promised, or as given. */
const complete = (id: string, bonus: Record<string, unknown> = { state: "none" }) =>
  finance.set(id, { approval: "approved", status: "sent", invoiceNumber: `INV-${id.slice(-4)}`, lms: DONE_LMS, commission: tc({ bonus }) });
/** The same enrolment, a step further. */
const at = (id: string, over: Partial<Answer>) => finance.set(id, { ...finance.get(id)!, ...over });
const saleOf = (id: string) => CommissionSale.findOne({ student: new Types.ObjectId(id) }).lean();
const lineOf = (s: Awaited<ReturnType<typeof saleOf>>, role: string) => s?.lines.find((l) => l.role === role);
const who = (s: Awaited<ReturnType<typeof saleOf>>, role: string) => {
  const l = lineOf(s, role);
  return l ? `${l.userName}:${l.amount}` : "—";
};

const staff = await sale("Theertha", c1._id, "TEAM TITAN");
const legacy = await sale("Shahana", c2._id, "Team Legacy");
const tlCloses = await sale("Ria", c1._id, "TEAM TITAN");
const smCloses = await sale("Abrar", c1._id, "Team Legacy");
const shared = await sale("Root user", c1._id, null);
const loner = await sale("Loner", c1._id, null);
const duo = await sale("DuoGuy", c2._id, "Team Duo");
const headless = await sale("Nobody", c1._id, "Team Headless");
const noTeamSale = await sale("Neethu", c1._id, null);
const twin = await sale("Twin", c1._id, null);
const oldCourse = await sale("Theertha", old._id, "TEAM TITAN");
const noCourse = await sale("Theertha", null, "TEAM TITAN");
const lateNight = await sale("Theertha", c1._id, "TEAM TITAN", { date: "2026-09-30T21:00:00Z" });
const before = await sale("Theertha", c1._id, "TEAM TITAN", { date: "2026-09-25T08:00:00Z" });
const stillPending = await sale("Theertha", c2._id, "TEAM TITAN");

for (const id of [staff, legacy, tlCloses, smCloses, shared, loner, duo, headless, noTeamSale, twin, oldCourse, noCourse, lateNight, before]) complete(id);
finance.set(stillPending, { approval: "pending", status: "sent", invoiceNumber: "INV-P" });

await sweep();

section("Case 1 — happy path: three people paid on each approved sale");
let s = await saleOf(staff);
check(`a BDE's sale: Sales Staff to her, ${PAYS_TL ? "TL to Ria, " : "no TL, "}SM to Abrar`,
  s?.state === "counted" && who(s, "sales") === "Theertha:230" && who(s, "tl") === tlLine("Ria", 100) && who(s, "sm") === "Abrar:85" && s.lines.length === LINES,
  JSON.stringify(s?.lines));
check("the plan of the day is kept on the sale", s?.plan.sales === 230 && s?.plan.creditUsd === 500);
s = await saleOf(legacy);
check(RULE === "zero_if_sm" ? "the Sales Manager's own team pays no TL — he is paid as SM"
  : RULE === "always" ? "the Sales Manager leading the team is paid TL and SM" : "no TL on the Sales Manager's team either",
  who(s, "tl") === tlLine("Abrar", 300) && who(s, "sm") === "Abrar:200" && who(s, "sales") === "Shahana:500" && (RULE !== "zero_if_sm" || Boolean(lineOf(s, "tl")?.note)));
s = await saleOf(tlCloses);
check(`a TL who closes earns Sales Staff${PAYS_TL ? " and TL" : ""}`, who(s, "sales") === "Ria:230" && who(s, "tl") === tlLine("Ria", 100) && who(s, "sm") === "Abrar:85");
s = await saleOf(smCloses);
check("the SM who closes in his own team earns Sales Staff and SM, and TL by the rule", who(s, "sales") === "Abrar:230" && who(s, "tl") === tlLine("Abrar", 100) && who(s, "sm") === "Abrar:85");
s = await saleOf(noTeamSale);
check("a sale with no team counts under the closer's one team", s?.state === "counted" && s?.teamName === "TEAM MAVERICK" && who(s, "tl") === tlLine("Anfas", 100));

section("Case 2 — edges: old approvals, zero plans, months, repeats");
check("a sale closed before 1 October is never counted, whatever its steps", (await saleOf(before)) === null);
s = await saleOf(stillPending);
check("a sale still pending in finance: in progress, waiting for finance, nothing paid", s?.state === "progress" && /^Next step: Finance approved/.test(s.reason) && s.lines.length === 0, s?.reason);
s = await saleOf(oldCourse);
check("a course with no plan counts at 0", s?.state === "counted" && s.lines.every((l) => l.amount === 0) && s.lines.length === LINES);
s = await saleOf(noCourse);
check("a sale with no course counts at 0", s?.state === "counted" && s.courseName === "" && s.lines.every((l) => l.amount === 0));
s = await saleOf(lateNight);
check("a sale at 01:00 UAE on 1 Oct (21:00 UTC on 30 Sep) is October's", s?.month === "2026-10", s?.month);
check("uaeMonthOf: 19:59 UTC on 30 Sep is still September", uaeMonthOf(new Date("2026-09-30T19:59:00Z")) === "2026-09");
const countBefore = await CommissionSale.countDocuments();
await sweep();
await sweep();
check("sweeping again records nothing twice", (await CommissionSale.countDocuments()) === countBefore, `${countBefore}`);
await Course.updateOne({ _id: c1._id }, { $set: { "commission.sales": 999 } });
await sweep();
s = await saleOf(staff);
check("a plan changed later leaves recorded sales as they were", who(s, "sales") === "Theertha:230");
await Course.updateOne({ _id: c1._id }, { $set: { "commission.sales": 230 } });

section("Case 3 — held and excluded sales, and how they settle");
s = await saleOf(shared);
check("a sale under an excluded login earns nobody anything", s?.state === "excluded" && s.lines.length === 0 && /earns no commission/.test(s.reason), s?.reason);
if (PAYS_TL) {
s = await saleOf(loner);
check("a closer in no team holds the sale", s?.state === "waiting" && /isn't in a team/.test(s.reason), s?.reason);
s = await saleOf(duo);
check("a team with two leaders holds the sale", s?.state === "waiting" && /2 leaders/.test(s.reason), s?.reason);
s = await saleOf(headless);
check("a team with no leader holds the sale", s?.state === "waiting" && /no leader/.test(s.reason), s?.reason);
s = await saleOf(twin);
check("a closer in two teams, on a sale with none, holds the sale", s?.state === "waiting" && /2 teams/.test(s.reason), s?.reason);
} else {
for (const [label, id, closer] of [["no team", loner, "Loner"], ["two leaders", duo, "DuoGuy"], ["no leader", headless, "Nobody"], ["two teams", twin, "Twin"]] as const) {
  s = await saleOf(id);
  check(`with no TL paid, a closer with ${label} is counted all the same`, s?.state === "counted" && s.lines.length === 2 && (lineOf(s, "sales")?.userName === closer), `${s?.state} ${s?.reason}`);
}
}

await db.collection("teams").updateOne({ _id: teams["TEAM TITAN"] }, { $push: { members: people.Loner } } as never);
await db.collection("teams").updateOne({ _id: teams["Team Duo"] }, { $set: { leaders: [people.Anfas] } });
await db.collection("students").updateOne({ _id: new Types.ObjectId(shared) }, { $set: { assignedTo: people.Theertha, team: teams["TEAM TITAN"] } });
await sweep();
if (PAYS_TL) {
s = await saleOf(loner);
check("put in a team, the closer's held sale is counted", s?.state === "counted" && who(s, "tl") === "Ria:100" && who(s, "sales") === "Loner:230");
s = await saleOf(duo);
check("a team down to one leader settles its held sale, at the plan of its approval", s?.state === "counted" && who(s, "tl") === "Anfas:300" && who(s, "sales") === "DuoGuy:500");
}
s = await saleOf(shared);
check("given to its real closer, an excluded sale is counted", s?.state === "counted" && who(s, "sales") === "Theertha:230" && s.closerName === "Theertha");

await CommissionSettings.updateOne({ key: "default" }, { $set: { salesManager: null } });
const noSm = await sale("Neethu", c1._id, "TEAM MAVERICK");
complete(noSm);
await sweep();
s = await saleOf(noSm);
check("with no Sales Manager set, a sale waits", s?.state === "waiting" && /No Sales Manager/.test(s.reason), s?.reason);
await CommissionSettings.updateOne({ key: "default" }, { $set: { salesManager: people.Abrar } });
await sweep();
s = await saleOf(noSm);
check("once one is set, it is counted", s?.state === "counted" && who(s, "sm") === "Abrar:85");

finance.set(staff, { ...finance.get(staff)!, status: "void" });
const reversed = await reverseVoidedSales();
s = await saleOf(staff);
check("an invoice voided in finance reverses its sale", reversed === 1 && s?.state === "reversed" && /voided/.test(s.reason), `${reversed} ${s?.reason}`);
check("a reversed sale is not reversed twice", (await reverseVoidedSales()) === 0);

section("The five steps: counted only when every one is done");
const journey = await sale("Neethu", c1._id, "TEAM MAVERICK");
finance.set(journey, { approval: "pending", status: "sent", invoiceNumber: "INV-J", lms: null, commission: null });
await sweep();
let j = await saleOf(journey);
check("closed, not approved yet: in progress, waiting for finance", j?.state === "progress" && /^Next step: Finance approved/.test(j.reason) && j.lines.length === 0, j?.reason);
approve(journey); await sweep(); j = await saleOf(journey);
check("approved: waiting for the LMS account", j?.state === "progress" && /^Next step: LMS account/.test(j.reason), j?.reason);
at(journey, { lms: DONE_LMS, commission: tc({ cs: "", onboarded: { done: false }, bonus: { state: "not_requested", amount: 500, currency: "USD" } }) });
await sweep(); j = await saleOf(journey);
check("in the LMS, waiting in Delta Open Students: waiting for a CS", /^Next step: CS assigned/.test(j?.reason ?? ""), j?.reason);
at(journey, { commission: tc({ onboarded: { done: false }, bonus: { state: "not_requested", amount: 500, currency: "USD" } }) });
await sweep(); j = await saleOf(journey);
check("given a CS: waiting for the welcome", /^Next step: Onboarded/.test(j?.reason ?? ""), j?.reason);
at(journey, { commission: tc({ bonus: { state: "pending", amount: 500, currency: "USD" } }) });
await sweep(); j = await saleOf(journey);
check("welcomed, the bonus pending: waiting for a broker admin", /^Next step: MT5 bonus — \$500 — onboarding verification pending/.test(j?.reason ?? ""), j?.reason);
at(journey, { commission: tc({ bonus: { state: "rejected", amount: 500, currency: "USD", reason: "Wrong MT5", by: "Bea Broker" } }) });
await sweep(); j = await saleOf(journey);
check("the bonus rejected: stopped there, nothing paid", j?.state === "progress" && /^Stopped at: MT5 bonus — Rejected: Wrong MT5/.test(j.reason) && j.lines.length === 0, j?.reason);
at(journey, { commission: tc({ bonus: { state: "approved", amount: 500, currency: "USD", by: "Bea Broker" } }) });
await sweep(); j = await saleOf(journey);
check("approved by the broker admin: counted, the plan of that day, when", j?.state === "counted" && who(j, "sales") === "Neethu:230" && !!j.stepsDoneAt && !!j.countedAt, JSON.stringify(j));
const plain = await sale("Neethu", c1._id, "TEAM MAVERICK");
complete(plain);
await sweep();
check("no bonus promised: counted once welcomed", (await saleOf(plain))?.state === "counted");
const notForex = await sale("Neethu", c1._id, "TEAM MAVERICK");
finance.set(notForex, { approval: "approved", status: "sent", invoiceNumber: "INV-DM", lms: DONE_LMS, commission: { state: "skipped", detail: "Not a Forex course" } });
await sweep();
check("a course Tetra Commission doesn't take: its steps aren't needed, counted after the LMS", (await saleOf(notForex))?.state === "counted");
const silent = await sale("Neethu", c1._id, "TEAM MAVERICK");
finance.set(silent, { approval: "approved", status: "sent", invoiceNumber: "INV-S", lms: DONE_LMS, commission: { state: "sent", code: "STU-9", cs: "Asha CS", team: "T", live: false } });
await sweep();
j = await saleOf(silent);
check("Tetra Commission not answering: not counted on a guess", j?.state === "progress" && /^Next step: Onboarded — Tetra Commission didn't say/.test(j.reason), j?.reason);
const early = await sale("Neethu", c1._id, "TEAM MAVERICK");
approve(early);
await CommissionSale.create({
  student: new Types.ObjectId(early), studentName: "Early", course: c1._id, courseName: c1.name, closer: people.Neethu, closerName: "Neethu",
  saleDate: new Date("2026-10-10T08:00:00Z"), month: "2026-10", approvedAt: new Date(), plan: { sales: 230, tl: 100, sm: 85, creditUsd: 500 },
  state: "counted", reason: "", lines: [{ role: "sales", user: people.Neethu, userName: "Neethu", amount: 230 }], countedAt: new Date(),
});
await sweep();
j = await saleOf(early);
check("counted by the rule before this one, its steps not done: back in progress, nothing paid", j?.state === "progress" && j.lines.length === 0 && /^Next step: LMS account/.test(j.reason), j?.reason);
complete(early);
await sweep();
j = await saleOf(early);
check("…counted again once they are", j?.state === "counted" && !!j.stepsDoneAt);
const voided = await sale("Neethu", c1._id, "TEAM MAVERICK");
approve(voided);
await sweep();
at(voided, { status: "void" });
await sweep();
check("voided while in progress: reversed", (await saleOf(voided))?.state === "reversed");
const quiet = await sale("Neethu", c1._id, "TEAM MAVERICK");
complete(quiet);
financeDown = true;
await sweep();
financeDown = false;
check("finance not answering: nothing recorded on a guess", (await saleOf(quiet)) === null);
await sweep();
check("…and counted once it answers", (await saleOf(quiet))?.state === "counted");

section("Who sees what");
const month = "2026-10";
const view = (name: string, role = bdeRole) => ({ userId: String(people[name]), role: { _id: role, roleName: role === superRole ? "Super Admin" : "BDE", isSystemRole: role === superRole } as never });
let e = await service.getEarnings(view("Theertha"), month);
check("a BDE sees only her own lines", e.scope === "own" && e.sales.every((x) => x.lines.every((l) => l.userName === "Theertha")) && e.sales.length > 0);
const theertha = e.people.find((p) => p.name === "Theertha");
// Counted October sales of hers: shared (reassigned) 230, oldCourse 0, noCourse 0, lateNight 230 = 460; staff reversed.
check("her total is her counted Sales Staff amounts, without the reversed sale", theertha?.total === 460 && theertha.sales.count === 4, JSON.stringify(theertha));
const riaView = { userId: String(people.Ria), role: { roleName: "BDE", isSystemRole: false } as never };
e = await service.getEarnings(riaView, month);
check("a team leader sees her team's sales, without the SM's line", e.scope === "team" && e.sales.some((x) => x.closerName === "Theertha") && e.sales.every((x) => x.lines.every((l) => l.role !== "sm")));
check("…and not another team's sale", !e.sales.some((x) => x.closerName === "Neethu"));
const abrarAsBde = { userId: String(people.Abrar), role: { roleName: "BDE", isSystemRole: false } as never };
e = await service.getEarnings(abrarAsBde, month);
check("the Sales Manager sees everything, whatever his role", e.scope === "all" && e.sales.some((x) => x.closerName === "Neethu"));
const abrar = e.people.find((p) => p.name === "Abrar");
check("the SM's tally counts his SM lines", (abrar?.sm.count ?? 0) >= 8 && (abrar?.sm.amount ?? 0) > 0, JSON.stringify(abrar));
e = await service.getEarnings(view("Anfas", superRole), "2026-11");
check("an empty month is empty, not an error", e.sales.length === 0 && e.people.length === 0 && e.totals.amount === 0);

section("Preview for the closing dialog");
// The preview answers what its viewer may see (2026-10-23): asked here as a Super Admin, who sees every line.
const asAdmin = { userId: String(people["Root user"] ?? Object.values(people)[0]), role: { roleName: "Super Admin", isSystemRole: true } as never };
let p = await service.preview({ course: String(c1._id), team: String(teams["TEAM TITAN"]), closer: String(people.Theertha) }, asAdmin);
check("a BDE closing Course 1 earns 230", p.state === "counted" && p.closerTotal === 230 && p.lines.length === LINES);
p = await service.preview({ course: String(c1._id), team: String(teams["TEAM TITAN"]), closer: String(people.Ria) }, asAdmin);
check(`the team's leader closing it earns ${PAYS_TL ? 330 : 230}`, p.closerTotal === (PAYS_TL ? 330 : 230));
p = await service.preview({ course: String(c1._id), team: String(teams["Team Legacy"]), closer: String(people.Abrar) }, asAdmin);
const smOwn = RULE === "always" ? 415 : 315;
check(`the Sales Manager closing in his own team earns ${smOwn}`, p.closerTotal === smOwn, `${p.closerTotal}`);
p = await service.preview({ course: String(c1._id), closer: String(people["Root user"]) }, asAdmin);
check("an excluded login earns nothing", p.state === "excluded" && p.closerTotal === 0);
p = await service.preview({ course: String(c2._id), team: String(teams["Team Headless"]), closer: String(people.Nobody) }, asAdmin);
check(PAYS_TL ? "on a team with no leader the closer's 500 shows, on hold" : "with no TL paid, a team with no leader is no hold",
  p.closerTotal === 500 && (PAYS_TL ? p.state === "waiting" && /no leader/.test(p.reason) : p.state === "counted"));
p = await service.preview({ course: String(old._id), team: String(teams["TEAM TITAN"]), closer: String(people.Theertha) }, asAdmin);
check("a course with no plan previews 0", p.closerTotal === 0 && p.plan.sales === 0);

section("Case 3/4 — the API: bad input and who may change the plan");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const token = (name: string, role: Types.ObjectId) => signAccessToken({ userId: String(people[name]), email: `${name}@test.local`, roleId: String(role) });
async function call(method: string, path: string, who?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who ? { authorization: `Bearer ${token(who, who === "Abrar" || who === "Ria" || who === "Anfas" ? superRole : bdeRole)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; message?: string } };
}
let r = await call("GET", "/commission/plan");
check("no token: 401", r.status === 401, `${r.status}`);
r = await call("GET", "/commission/plan", "Theertha");
check("a BDE reads the plan, without the edit lists", r.status === 200 && r.body.data?.canEdit === false && (r.body.data?.users as unknown[]).length === 0 && (r.body.data?.courses as unknown[]).length === 3);
// Read only (the user, 2026-10-09): no route edits the plan, its settings or the slabs — not even for a Super Admin.
r = await call("GET", "/commission/plan", "Abrar");
check("a Super Admin reads it read only too, with the sales on hold", r.status === 200 && r.body.data?.canEdit === false && r.body.data?.seesHeld === true);
for (const [path, body] of [
  [`/commission/plan/${c1._id}`, { sales: 1, tl: 1, sm: 1, creditUsd: 0 }],
  ["/commission/settings", { salesManager: String(people.Abrar) }],
  ["/commission/slabs/sales", { rows: [] }],
] as const) {
  r = await call("PUT", path, "Abrar", body);
  check(`no editing, even for a Super Admin: PUT ${path.replace(/[0-9a-f]{24}/, ":course")} is gone`, r.status === 404, `${r.status}`);
}
// What follows needs a course's row and the settings, set in the database as the plan now only can be.
await Course.updateOne({ _id: old._id }, { $set: { commission: { sales: 120, tl: 60, sm: 20, creditUsd: 0, updatedBy: people.Abrar, updatedAt: new Date() } } });
r = await call("PUT", `/courses/${old._id}`, "Abrar", { name: "Market Breakout Theory", commission: { sales: 5 } });
check("the course form cannot change commission", (await Course.findById(old._id).lean())?.commission?.sales === 120);
await CommissionSettings.updateOne({ key: "default" }, { $set: { salesManager: people.Abrar, excludedUsers: [people["Root user"]] } }, { upsert: true });
r = await call("GET", "/commission/earnings?month=2026-13", "Theertha");
check("a bad month: 400", r.status === 400);
r = await call("GET", "/commission/earnings?month=2026-10", "Theertha");
check("earnings over HTTP, scoped", r.status === 200 && r.body.data?.scope === "own");
r = await call("GET", `/commission/preview?course=${c1._id}&team=${teams["TEAM TITAN"]}&closer=${people.Theertha}`, "Theertha");
check("preview over HTTP", r.status === 200 && (r.body.data as { closerTotal?: number })?.closerTotal === 230);
r = await call("GET", "/commission/preview?course=bad", "Theertha");
check("a preview without a real course id: 400", r.status === 400);
r = await call("GET", "/students/enrolments/mine", "Neethu");
const mineRow = (r.body.data as unknown as { _id: string; steps?: { key: string; state: string }[] }[] | undefined)?.find((x) => x._id === journey);
check("My Enrolments: each card carries its five steps", r.status === 200 && mineRow?.steps?.length === 5 && mineRow.steps.every((x) => x.state === "done"), JSON.stringify(mineRow?.steps));
r = await call("GET", `/students/enrolments/${journey}`, "Neethu");
const page = r.body.data as unknown as { steps?: { state: string; by?: string }[]; commission?: { state: string; lines: { role: string }[] } } | undefined;
check("the enrolment's own page: its steps, who did them, and the closer's own commission line", r.status === 200 && page?.steps?.length === 5
  && page.steps[3]?.by === "Asha CS" && page.commission?.state === "counted" && page.commission.lines.length === 1 && page.commission.lines[0]?.role === "sales", JSON.stringify(page?.commission));
r = await call("GET", `/students/enrolments/${journey}`, "Abrar");
check("…a Super Admin sees every line", r.status === 200 && (r.body.data as unknown as { commission?: { lines: unknown[] } })?.commission?.lines.length === LINES);
r = await call("GET", `/students/enrolments/${journey}`, "Theertha");
check("…somebody else's, without students:view: 403", r.status === 403, `${r.status}`);
r = await call("GET", `/students/enrolments/${new Types.ObjectId()}`, "Abrar");
check("…one that doesn't exist: 404", r.status === 404, `${r.status}`);
r = await call("GET", "/students/enrolments/not-an-id", "Abrar");
check("…not an id: 404", r.status === 404, `${r.status}`);
r = await call("GET", `/students/enrolments/${journey}`);
check("…no token: 401", r.status === 401);
r = await call("GET", "/commission/plan", "Gone");
check("an inactive user is refused: 403", r.status === 403, `${r.status}`);

section("A Bangalore close: asked of Bangalore's finance organization, counted on the same plan");
const blrSale = await sale("Theertha", c1._id, "TEAM TITAN", { academy: "bangalore" });
orgOfSale.set(blrSale, BLR_ORG);
complete(blrSale);
statusCalls.length = 0;
await sweep();
s = await saleOf(blrSale);
check("counted once its steps are done, with the plan's amounts as any other sale",
  s?.state === "counted" && who(s, "sales") === "Theertha:230" && who(s, "sm") === "Abrar:85", `${s?.state} ${JSON.stringify(s?.lines)}`);
check("…its status asked of Bangalore's organization, and never of Dubai's",
  statusCalls.some((c) => c.org === BLR_ORG && c.ids.includes(blrSale)) && !statusCalls.some((c) => c.org === DUBAI_ORG && c.ids.includes(blrSale)),
  JSON.stringify(statusCalls.map((c) => ({ org: c.org.slice(-1), n: c.ids.length, blr: c.ids.includes(blrSale) }))));
statusCalls.length = 0;
at(blrSale, { status: "void" });
await reverseVoidedSales();
s = await saleOf(blrSale);
check("a void in Bangalore's organization reverses it — the void sweep asks there too",
  s?.state === "reversed" && statusCalls.some((c) => c.org === BLR_ORG && c.ids.includes(blrSale)) && !statusCalls.some((c) => c.org === DUBAI_ORG && c.ids.includes(blrSale)),
  `${s?.state} ${JSON.stringify(statusCalls.map((c) => ({ org: c.org.slice(-1), blr: c.ids.includes(blrSale) })))}`);
const strayDubai = await sale("Theertha", c1._id, "TEAM TITAN", { academy: "bangalore" });
complete(strayDubai);                                   // finance has it — but in Dubai's organization
await sweep();
check("an answer only Dubai's organization would give is never taken for a Bangalore close", (await saleOf(strayDubai))?.state !== "counted", (await saleOf(strayDubai))?.state);

server.close();
fake.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
