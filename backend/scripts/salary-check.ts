/**
 * Checks the salary slabs end to end on a scratch database, against a stand-in
 * for finance that answers the enrolment status call (with the invoice total).
 *
 *   - a target counts the course fee of each sale finance approved and didn't
 *     void, in the month it was closed: Sales Staff their own (a team leader too: Remote
 *     has no TL slab), the Sales Manager every sale — a shared login's only his;
 *   - the fee is finance's invoice total, the student's own while finance has
 *     none; the sweep keeps it current;
 *   - the level is the highest target reached (the base below the first);
 *     pay = salary + commission counted that month × its percent;
 *   - who sees whose pay (everyone's: a Super Admin and the Sales Manager),
 *     slab versions by month, and the API's refusals.
 *
 * Run by salary-check.sh. Scratch database only.
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
type Answer = { approval: string; status: string; totalMinor: number; currency?: string; lms?: unknown; commission?: unknown };
const finance = new Map<string, Answer>();
// Finance's commission payouts for My Pay (2026-10-21), and who asked for them.
const payouts: Array<Record<string, unknown>> = [];
const payoutAsks: Array<{ crm: string | null; month: string | null; signed: boolean }> = [];
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/api/v1/integrations/enrolments/status") {
      const body = (await req.json()) as { externalIds: string[] };
      const data = body.externalIds.filter((id) => finance.has(id)).map((id) => {
        const a = finance.get(id)!;
        return {
          externalId: id, invoiceId: `inv-${id}`, invoiceNumber: `INV-${id.slice(-4)}`, status: a.status,
          approval: a.approval, returnedReason: "", issueDate: "2026-10-01", currency: a.currency ?? "AED",
          totalMinor: a.totalMinor, amountPaidMinor: 0, balanceMinor: 0,
          lms: a.lms ?? null, commission: a.commission ?? null,
        };
      });
      return Response.json({ data });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/integrations/crm-commission/payouts") {
      payoutAsks.push({ crm: url.searchParams.get("crm"), month: url.searchParams.get("month"), signed: !!req.headers.get("x-delta-signature") && req.headers.get("x-delta-client") === "salary-check" });
      return Response.json({ data: payouts });
    }
    return new Response("not here", { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "salary-check-jwt",
  JWT_REFRESH_SECRET: "salary-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${fake.port}`,
  FINANCE_CLIENT_ID: "salary-check",
  FINANCE_INTEGRATION_SECRET: "salary-check-secret",
  FINANCE_ORG_ID: "000000000000000000000001",
  ROOT_ERP_SECRET: "salary-check-portal-secret",
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
const { sweepCommission, reverseVoidedSales, followNow, uaeMonthOf } = svc;
const { SalaryService, levelOf } = await import("../src/services/salaryService.js");
const { DEFAULT_SLABS, saveSlab, slabsFor } = await import("../src/services/salarySlabs.js");
const sweep = async () => { followNow(); await sweepCommission(); followNow(); await sweepCommission(); };
const salary = new SalaryService();
const MONTH = uaeMonthOf(new Date());
console.log(`This month (UAE): ${MONTH}`);

// ── People, teams, courses ──────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: {} },
]);
const people: Record<string, Types.ObjectId> = {};
const roleOf: Record<string, Types.ObjectId> = {};
async function person(name: string, role = bdeRole, status = "active") {
  const _id = new Types.ObjectId();
  await db.collection("users").insertOne({
    _id, name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`, password: "x", role, status,
  });
  people[name] = _id;
  roleOf[name] = role;
}
await person("Owner", superRole);
await person("Root user", superRole);
for (const n of ["Dilshad", "Ria", "Anfas", "Theertha", "Neethu", "Shahana", "Idle", "Accounts"]) await person(n);
await person("Leaver", bdeRole, "inactive");
await person("Gone", bdeRole, "inactive");

const teams: Record<string, Types.ObjectId> = {};
async function team(name: string, leaders: string[], members: string[], status = "active") {
  const _id = new Types.ObjectId();
  await db.collection("teams").insertOne({
    _id, name, status, leaders: leaders.map((n) => people[n]), members: members.map((n) => people[n]),
  });
  teams[name] = _id;
}
await team("TEAM TITAN", ["Ria"], ["Theertha", "Idle"]);
await team("TEAM MAVERICK", ["Anfas"], ["Neethu"]);
await team("Team Legacy", ["Dilshad"], ["Shahana"]);

const c1 = await Course.create({ name: "COURSE 1", amount: 2250, commission: { sales: 230, tl: 100, sm: 85, creditUsd: 500 } });
const c2 = await Course.create({ name: "COURSE 2", amount: 5500, commission: { sales: 500, tl: 300, sm: 200, creditUsd: 1000 } });
await CommissionSettings.create({ key: "default", salesManager: people.Dilshad, excludedUsers: [people["Root user"]] });

// ── Sales ───────────────────────────────────────────────────────────────────
let n = 0;
async function sale(closer: string, course: Types.ObjectId, teamName: string | null, fee: number, date = "2026-10-03T08:00:00Z") {
  const _id = new Types.ObjectId();
  n++;
  // Paid in full at the close, on the lead (2026-10-31: commission and targets count the money received, in its month).
  const leadId = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: leadId, name: `Lead ${n}`, phone: `9715000${n}`, payments: [{ amount: fee, paidAt: new Date(date) }] });
  await db.collection("students").insertOne({
    _id, name: `Student ${n}`, enrollmentNumber: `EN-${n}`, leadId,
    course, team: teamName ? teams[teamName] : null, assignedTo: people[closer],
    enrollmentDate: new Date(date), createdAt: new Date(), status: "active", totalFee: fee, paidAmount: fee, pendingAmount: 0,
  });
  await db.collection("financehandovers").insertOne({
    studentId: _id, status: "sent", payload: {}, approvalState: "pending",
    invoiceNumber: `INV-${n}`, attempts: 0, nextAttemptAt: new Date(), flags: [],
  });
  return String(_id);
}
const DONE_LMS = { state: "created", courses: ["Market Break Out Trading Program"] };
const TC = {
  state: "sent", code: "STU-0001", cs: "Asha CS", team: "Team Asha", live: true,
  onboarded: { done: true, at: "2026-10-04T10:00:00.000Z", by: "Asha CS" }, bonus: { state: "none" },
};
/** Finance approved it — as its outcome poll would record it here too. */
async function approved(id: string, totalMinor: number) {
  finance.set(id, { approval: "approved", status: "sent", totalMinor, lms: null, commission: null });
  await db.collection("financehandovers").updateOne({ studentId: new Types.ObjectId(id) }, { $set: { approvalState: "approved" } });
}
/** Approved, and every step after it done: the sweep counts its commission. */
async function complete(id: string, totalMinor: number) {
  await approved(id, totalMinor);
  finance.set(id, { ...finance.get(id)!, lms: DONE_LMS, commission: TC });
}
const pending = (id: string, totalMinor: number) =>
  finance.set(id, { approval: "pending", status: "sent", totalMinor, lms: null, commission: null });
const saleOf = (id: string) => CommissionSale.findOne({ student: new Types.ObjectId(id) }).lean();

// Theertha: 10,000 (finance has no total: her own fee is used) + 5,000 (finance's
// 5,000 though the student now says 5,500) = 15,000, level D; 6,000 still in finance.
const t1 = await sale("Theertha", c1._id, "TEAM TITAN", 10_000);
const t2 = await sale("Theertha", c2._id, "TEAM TITAN", 5_500);
const t3 = await sale("Theertha", c1._id, "TEAM TITAN", 6_000);
// Ria leads TITAN but is on the Sales Staff slab: her own 85,000 only.
const r1 = await sale("Ria", c2._id, "TEAM TITAN", 85_000);
// Neethu: 9,000 + 1,000 on a sale with no team (her one team's) = 10,000, level E.
const n1 = await sale("Neethu", c1._id, "TEAM MAVERICK", 9_000);
const n2 = await sale("Neethu", c1._id, null, 1_000);
const s1 = await sale("Shahana", c2._id, "Team Legacy", 48_000);
// A shared login's sale in TITAN: the Sales Manager's total only.
const x1 = await sale("Root user", c1._id, "TEAM TITAN", 40_000);
// Closed by somebody since gone, in no team: held, but approved — it still counts.
const l1 = await sale("Leaver", c1._id, null, 2_000);
const v1 = await sale("Theertha", c1._id, "TEAM TITAN", 20_000);
const sept = await sale("Theertha", c1._id, "TEAM TITAN", 30_000, "2026-09-20T08:00:00Z");

await complete(t1, 0);
await approved(t2, 500_000);
pending(t3, 600_000);
await complete(r1, 8_500_000);
await complete(n1, 900_000);
await approved(n2, 100_000);
await complete(s1, 4_800_000);
await complete(x1, 4_000_000);
await complete(l1, 200_000);
await complete(v1, 2_000_000);
await complete(sept, 3_000_000);
await sweep();
finance.set(v1, { ...finance.get(v1)!, status: "void" });
await reverseVoidedSales();

section("The fee each sale counts");
check("finance's invoice total, when it has one", (await saleOf(t2))?.fee === 5_000, String((await saleOf(t2))?.fee));
check("the student's own fee while finance has none", (await saleOf(t1))?.fee === 10_000, String((await saleOf(t1))?.fee));
check("a voided sale is reversed and counts for nobody", (await saleOf(v1))?.state === "reversed");
check("a sale closed in September isn't on October's slabs", (await saleOf(sept)) === null);
finance.set(s1, { ...finance.get(s1)!, totalMinor: 4_850_000 });
await reverseVoidedSales();
check("finance changing a counted sale's total is picked up by the sweep", (await saleOf(s1))?.fee === 48_500, String((await saleOf(s1))?.fee));
finance.set(s1, { ...finance.get(s1)!, totalMinor: 4_800_000 });
await reverseVoidedSales();
check("…and back", (await saleOf(s1))?.fee === 48_000);

payouts.push(
  { userId: String(people.Ria), state: "approved", amount: 600, currency: "AED", approvedByName: "Mona Manager", approvedAt: "2026-10-21T08:00:00.000Z" },
  { userId: String(people.Theertha), state: "paid", amount: 115, currency: "AED", approvedByName: "Mona Manager", approvedAt: "2026-10-21T08:00:00.000Z",
    paidOn: "2026-11-02", paymentMethod: "bank_transfer", reference: "TRX-9" },
);
const pay = await salary.getPay({ userId: String(people.Owner), role: { roleName: "Super Admin", isSystemRole: true } as never }, MONTH);
const row = (name: string) => pay.people?.find((p) => p.name === name);
const brief = (name: string) => {
  const r = row(name);
  return r ? `${r.role} ${r.sales.value} ${r.level.name} ${r.salary}/${r.percent}% earned ${r.commission.earned} payable ${r.commission.payable} total ${r.total}` : "missing";
};

section("Case 1 — happy path: each role on its own slab");
let r = row("Theertha");
check("Sales Staff: her own approved sales, 15,000 — exactly D: 2,500 and 50%", r?.role === "sales" && r.sales.value === 15_000 && r.sales.count === 2 && r.level.name === "D" && r.salary === 2_500 && r.percent === 50, brief("Theertha"));
check("…50% of the 230 counted: 115, so 2,615", r?.commission.earned === 230 && r.commission.payable === 115 && r.total === 2_615, brief("Theertha"));
check("…7,000 more to C", r?.next?.name === "C" && r.next.more === 7_000, JSON.stringify(r?.next));
check("…the sale still in finance waits outside the target", r?.awaitingFinance.count === 1 && r.awaitingFinance.value === 6_000);
check("…two sales still finishing their steps", r?.commission.notCountedYet === 2, String(r?.commission.notCountedYet));
r = row("Ria");
check("a team leader is on the Sales Staff slab with her own sales only: 85,000 is A — 4,000 at 100%", r?.role === "sales" && r.sales.value === 85_000 && r.level.name === "A" && r.salary === 4_000 && r.percent === 100, brief("Ria"));
check("…her own close's 500 and her TL lines (Remote pays TLs always: 900), all paid at 100%: 4,900", r?.commission.earned === 900 && r.commission.payable === 900 && r.total === 4_900, brief("Ria"));
r = row("Anfas");
check("a team leader who sold nothing: the base, 2,000", r?.role === "sales" && r.sales.value === 0 && r.level.name === "Base" && r.total === 2_000 && r.next?.name === "D", brief("Anfas"));
r = row("Dilshad");
check("Sales Manager: every approved sale, the shared login's and the held one included — 200,000, Level 2: 10,000 at 100%", r?.role === "sm" && r.sales.value === 200_000 && r.level.name === "Level 2" && r.salary === 10_000 && r.percent === 100, brief("Dilshad"));
check("…on the SM slab although he leads Team Legacy; all his commission paid", (r?.commission.earned ?? 0) > 0 && r?.commission.payable === r?.commission.earned && r?.total === 10_000 + r!.commission.earned, brief("Dilshad"));
r = row("Shahana");
check("48,000 is A: 4,000 and 100% — nothing above it", r?.level.name === "A" && r.total === 4_500 && r.next === null, brief("Shahana"));

section("Case 2 — edges: nothing sold, the floor, levels at their targets");
r = row("Idle");
check("in a team, nothing sold: the base — 2,000, nothing more", r?.sales.value === 0 && r.level.name === "Base" && r.total === 2_000 && r.next?.name === "D" && r.next.more === 15_000, brief("Idle"));
r = row("Neethu");
check("exactly 10,000 is E: 2,000 and 0% — her 230 pays nothing", r?.level.name === "E" && r.commission.earned === 230 && r.commission.payable === 0 && r.total === 2_000, brief("Neethu"));
r = row("Leaver");
check("gone since, with a sale this month: still listed on the base (the base pays 0%)", r?.role === "sales" && r.sales.value === 2_000 && r.level.name === "Base" && r.commission.payable === 0, brief("Leaver"));
check("gone, with nothing this month: not listed", !row("Gone"));
check("a shared login is never on the slabs", !row("Root user"));
check("somebody in no team with no sales isn't on the slabs", !row("Accounts") && !row("Owner"));
check("Sales Manager first, nobody on a TL slab", pay.people?.[0]?.name === "Dilshad" && pay.people.every((p) => p.role !== "tl"));
const sum = (k: "salary" | "total") => (pay.people ?? []).reduce((t, p) => t + p[k], 0);
check("the Super Admin's totals add up", pay.totals?.salary === sum("salary") && pay.totals?.total === sum("total"), JSON.stringify(pay.totals));
check("levelOf: under 120,000 the SM is on the base — 5,000 at 50%", levelOf(DEFAULT_SLABS.sm, 119_999).level.name === "Base" && levelOf(DEFAULT_SLABS.sm, 119_999).level.salary === 5_000 && levelOf(DEFAULT_SLABS.sm, 120_000).level.name === "Level 1");
check("levelOf: 9,999.99 is still the base", levelOf(DEFAULT_SLABS.sales, 9_999.99).level.name === "Base");
check("levelOf: far past the top stays at the top", levelOf(DEFAULT_SLABS.sm, 9_000_000).level.name === "Level 2" && levelOf(DEFAULT_SLABS.sm, 9_000_000).next === null);
await approved(t3, 600_000);
let again = await salary.getPay({ userId: String(people.Theertha) }, MONTH);
check("approved in finance, the 6,000 joins her target: 21,000, still D, 1,000 to C", again.me?.sales.value === 21_000 && again.me.level.name === "D" && again.me.next?.more === 1_000, JSON.stringify(again.me?.sales));
await CommissionSale.updateOne({ student: new Types.ObjectId(t2) }, { $unset: { fee: "" } });
again = await salary.getPay({ userId: String(people.Theertha) }, MONTH);
check("a sale recorded before the fee was kept counts the student's fee (5,500)", again.me?.sales.value === 21_500, String(again.me?.sales.value));
await CommissionSale.updateOne({ student: new Types.ObjectId(t2) }, { $set: { fee: 5_000 } });

section("My Pay shows finance's approval and payment (2026-10-21)");
check("finance was asked, signed, for this CRM and month", payoutAsks.some((a) => a.crm === "remote" && a.month === MONTH && a.signed), JSON.stringify(payoutAsks));
check("the payouts are known", (pay as { payoutsKnown?: boolean }).payoutsKnown === true);
check("Ria: approved, 600, by the manager", row("Ria")?.payout?.state === "approved" && row("Ria")?.payout?.amount === 600 && row("Ria")?.payout?.approvedByName === "Mona Manager", JSON.stringify(row("Ria")?.payout));
check("Theertha: paid on 2 November by bank transfer, with the reference", row("Theertha")?.payout?.state === "paid" && row("Theertha")?.payout?.paidOn === "2026-11-02" && row("Theertha")?.payout?.reference === "TRX-9");
check("nobody else has one", row("Idle")?.payout === null && row("Shahana")?.payout === null);
const own = await salary.getPay({ userId: String(people.Theertha) }, MONTH);
check("…and her own My Pay says so too", own.me?.payout?.state === "paid");


section("Slab versions: a change holds from its month on");
await saveSlab("sales", [
  { name: "Base", target: 0, salary: 2_100, percent: 0 },
  { name: "Top", target: 20_000, salary: 5_000, percent: 100 },
], String(people.Owner), "2026-11");
check("October keeps the sheet", (await slabsFor("2026-10")).slabs.sales.length === 6 && (await slabsFor("2026-10")).from === null);
check("November has the change, the other roles carried over", (await slabsFor("2026-11")).slabs.sales[1]?.name === "Top" && (await slabsFor("2026-11")).slabs.sm.length === 3 && (await slabsFor("2026-11")).from === "2026-11");
check("December still has November's", (await slabsFor("2026-12")).slabs.sales[0]?.salary === 2_100);
await saveSlab("sm", DEFAULT_SLABS.sm, String(people.Owner), "2026-11");
check("saving again in the same month replaces that month's version", ((await CommissionSettings.findOne({ key: "default" }).lean())?.salarySlabs ?? []).length === 1);
await CommissionSettings.updateOne({ key: "default" }, { $unset: { salarySlabs: "" } });

section("Case 3/4 — the API: who sees what, bad input, who may change the slabs");
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
const token = (name: string) => signAccessToken({ userId: String(people[name]), email: `${name}@test.local`, roleId: String(roleOf[name]) });
async function call(method: string, path: string, who?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; message?: string } };
}
type PayBody = { me: { name: string; total: number; percent: number; commission: { payable: number } } | null; people: unknown[] | null; totals: unknown };
section("The Root portal's My Pay figures (2026-10-21)");
{
  const ask = (secret?: string) => fetch(`http://127.0.0.1:${port}/api/v1/service/pay?month=${MONTH}`, { headers: secret ? { "x-portal-secret": secret } : {} });
  let r = await ask("salary-check-portal-secret");
  const data = (await r.json()) as { data?: { people?: Array<{ user: string; payable: number; percent: number; earned: number; level: string }> } };
  const t = data.data?.people?.find((p) => p.user === String(people.Theertha));
  const mine = row("Theertha");
  check("the Root portal's /service/pay: everyone's payable, percent, earned and level, as My Pay works them out",
    r.status === 200 && !!t && t.payable === mine?.commission.payable && t.percent === mine?.percent && t.earned === mine?.commission.earned && t.level === mine?.level.name, JSON.stringify(t));
  r = await ask("wrong");
  check("…only with the portal's secret", r.status === 401, String(r.status));
  r = await fetch(`http://127.0.0.1:${port}/api/v1/service/pay?month=2026-13`, { headers: { "x-portal-secret": "salary-check-portal-secret" } });
  check("…and a real month", r.status === 400, String(r.status));
}

let h = await call("GET", "/commission/pay");
check("no token: 401", h.status === 401, `${h.status}`);
h = await call("GET", "/commission/pay", "Gone");
check("an inactive user: 403", h.status === 403, `${h.status}`);
h = await call("GET", `/commission/pay?month=${MONTH}`, "Theertha");
let body = h.body.data as unknown as PayBody;
check("Sales Staff see their own, nobody else's", h.status === 200 && body.me?.name === "Theertha" && body.people === null && body.totals === null);
h = await call("GET", "/commission/pay", "Dilshad");
body = h.body.data as unknown as PayBody;
check("the Sales Manager sees everyone's too, his own month with it; no month means this month", h.status === 200 && body.me?.name === "Dilshad"
  && (body.people?.length ?? 0) === 8 && body.totals !== null && (h.body.data as { month?: string }).month === MONTH, `${body.people?.length}`);
h = await call("GET", "/commission/pay", "Ria");
body = h.body.data as unknown as PayBody;
// Since 2026-10-23 a team leader sees her team's people too — not everyone's.
check("a team leader sees her own and her team's, not everyone's", h.status === 200 && body.me?.name === "Ria" && (h.body.data as { view?: string }).view === "team"
  && (body.people ?? []).some((r) => r.name === "Ria") && (body.people?.length ?? 0) < 8 && body.totals !== null, JSON.stringify((body.people ?? []).map((r) => r.name)));
h = await call("GET", "/commission/pay", "Owner");
body = h.body.data as unknown as PayBody;
check("a Super Admin sees everyone — and has no row of their own", h.status === 200 && body.me === null && (body.people?.length ?? 0) === 8, `${body.people?.length}`);
h = await call("GET", "/commission/pay", "Accounts");
body = h.body.data as unknown as PayBody;
check("somebody not on the slabs gets no row, and no error", h.status === 200 && body.me === null && body.people === null);
for (const [label, month] of [["not a month", "2026-13"], ["before the slabs began", "2026-09"], ["a month to come", "2099-01"]] as const) {
  h = await call("GET", `/commission/pay?month=${month}`, "Theertha");
  check(`${label}: 400`, h.status === 400, `${h.status} ${h.body.message}`);
}

const good = [
  { name: "Base", target: 0, salary: 2_000, percent: 0 },
  { name: "D", target: 15_000, salary: 2_500, percent: 60 },
  { name: "A", target: 32_000, salary: 4_000, percent: 100 },
];
h = await call("PUT", "/commission/slabs/sales", "Owner", { rows: good });
check("no editing a slab, even for a Super Admin: the route is gone", h.status === 404, `${h.status}`);
// Set in the database, as the slabs now only can be.
await saveSlab("sales", good, String(people.Owner), MONTH);
h = await call("GET", "/commission/pay", "Theertha");
body = h.body.data as unknown as PayBody;
check("Theertha's month follows it: D now pays 60% — 21,000 → 2,500 + 138", body.me?.percent === 60 && body.me.commission.payable === 138 && body.me.total === 2_638, JSON.stringify(body.me));
h = await call("GET", "/commission/plan", "Theertha");
const plan = h.body.data as { slabs?: { sales: unknown[]; sm: unknown[]; tl?: unknown[] }; slabsFrom?: string; slabsMonth?: string };
// A salesperson's plan carries only their own slab since 2026-10-23; a Super Admin's every one.
check("the plan carries this month's slabs, and when they were set — a salesperson only the sales one", h.status === 200 && plan.slabs?.sales.length === 3 && !plan.slabs.sm && !plan.slabs.tl && plan.slabsFrom === MONTH && plan.slabsMonth === MONTH, JSON.stringify(Object.keys(plan.slabs ?? {})));
h = await call("GET", "/commission/plan", "Owner");
const ownerPlan = h.body.data as { slabs?: { sales: unknown[]; sm: unknown[]; tl?: unknown[] } };
check("…a Super Admin's the Sales Manager's too", h.status === 200 && ownerPlan.slabs?.sales.length === 3 && ownerPlan.slabs.sm.length === 3);


server.close();
fake.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
