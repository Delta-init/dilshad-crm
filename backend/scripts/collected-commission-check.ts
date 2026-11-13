/**
 * Collected-based commission, balance sync, repeat leads and Daily Closings (the user, 2026-10-31, as in the Sales
 * CRM) — four cases each, on a scratch database:
 *
 *   1. a repeat lead that became a client while it waited stays with its owner (status kept); a non-client is given
 *      out; enrolled but not "closed" is refused; a bad id is not found; only a leader of its team decides;
 *   2. an approved balance payment reaches its enrolment once — paid, pending, fee status — never on top of a hand
 *      edit; a pending or rejected one, or one in another currency, is left out;
 *   3. paid in full first (2026-10-31): a part-paid sale earns nothing — all of its commission waits; paid in full,
 *      all of it is earned in the month of the last payment (a September part included); an October sale finished in
 *      November earns in November, not October; no fee earns all on the sale day; My Pay's target is still the money
 *      received in the month; who sees which lines;
 *   4. Daily Closings: collected in the period only, the rest "paid outside"; commission earned and waiting; an
 *      empty period is zeros; a BDE sees no one else's commission;
 *   5. who sees whose closings: a Super Admin and the Sales Manager everyone's; a team leader their teams'; anyone
 *      else their own — whatever the filters ask; a bad team id narrows nothing and fails nothing;
 *   6. paid in rupees, earned in rupees (2026-11-13): which payments are marked as rupees — INR Transfer or typed in
 *      INR at the close, a balance payment or a lead payment by INR Transfer, a Bangalore close's rupees — and never
 *      cash, card, another currency or a guess; the rupee share earns the course's rupee amount, the rest AED.
 *
 * Run by collected-commission-check.sh. Scratch database only.
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
const j = (v: unknown) => JSON.stringify(v).slice(0, 500);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "collected-check-jwt", JWT_REFRESH_SECRET: "collected-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1" && mongoose.connection.host !== "localhost") { console.error("Refusing: not local"); process.exit(1); }
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const commission = await import("../src/services/commissionService.js");
const { refreshPaidShares, CommissionService } = commission;
const { applyApprovedBalances } = await import("../src/services/leadPaymentDecisions.js");
const { giveRepeatLead } = await import("../src/services/repeatLeadService.js");
const { StudentService } = await import("../src/services/studentService.js");
const { payRows } = await import("../src/services/salaryService.js");
const { CommissionSale } = await import("../src/models/CommissionSale.js");
const RULE = commission.TL_RULE as string;
const PAYS_TL = RULE !== "never";
console.log(`TL rule: ${RULE}`);

// ── People and teams ────────────────────────────────────────────────────────
const superRole = { _id: new Types.ObjectId(), roleName: "Super Admin", isSystemRole: true };
const bdeRole = { _id: new Types.ObjectId(), roleName: "BDE", isSystemRole: false };
await db.collection("roles").insertMany([{ ...superRole, permissions: {} }, { ...bdeRole, permissions: {} }]);
const ids: Record<string, Types.ObjectId> = {};
for (const name of ["Admin", "Manager", "Tina", "Bea", "Cal", "Otto", "Oli"]) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@e2e.test`, role: name === "Admin" ? superRole._id : bdeRole._id, status: "active" });
}
const T1 = new Types.ObjectId(), T2 = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: T1, name: "Team One", status: "active", leaders: [ids.Tina], members: [ids.Bea, ids.Cal] },
  { _id: T2, name: "Team Two", status: "active", leaders: [ids.Otto], members: [ids.Oli] },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Manager, excludedUsers: [] });
const viewer = (name: string) => ({ userId: String(ids[name]), role: name === "Admin" ? superRole : bdeRole } as never);

// ── Sales: a lead with its payments, the enrolment, and its counted commission ─────────────────────────────────
type Pay = { amount: number; paidAt: string; finance?: { externalId: string; state: string; sentAt: Date; method: string }; currency?: string; method?: string; note?: string };
/** A payment the close took: an amount in cash, or with its method and — typed in another currency — what was handed over. */
type ClosePay = number | { amount: number; method?: string; currency?: string; amountInCurrency?: number; exchangeRate?: number };
let n = 0;
async function sale(closer: string, team: Types.ObjectId, opts: {
  date: string; fee: number; pays: Pay[]; pending?: number; paid?: number; close?: ClosePay[]; counted?: boolean;
  /** The lines carry the course's rupee amounts (5,000 / 2,000 / 1,700), as Root's plan gives them. */
  inr?: boolean;
  academy?: string;
}) {
  n++;
  const leadId = new Types.ObjectId(), studentId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Lead ${n}`, phone: `97150000${String(n).padStart(4, "0")}`, status: "closed", assignedTo: ids[closer], activityLogs: [],
    payments: opts.pays.map((p) => ({
      amount: p.amount, paidAt: new Date(p.paidAt), ...(p.finance ? { finance: p.finance } : {}), ...(p.currency ? { currency: p.currency } : {}),
      ...(p.method ? { method: p.method } : {}), ...(p.note ? { note: p.note } : {}),
    })),
  });
  const paid = opts.paid ?? opts.pays.filter((p) => !p.finance || p.finance.state === "approved").reduce((s, p) => s + p.amount, 0);
  await db.collection("students").insertOne({
    _id: studentId, name: `Student ${n}`, enrollmentNumber: `EN-${n}`, leadId, team, assignedTo: ids[closer], courses: [], course: null,
    enrollmentDate: new Date(opts.date), status: "active", totalFee: opts.fee, paidAmount: paid,
    pendingAmount: opts.pending ?? Math.max(0, opts.fee - paid), feeStatus: paid >= opts.fee ? "paid" : paid > 0 ? "partial" : "pending",
    ...(opts.academy ? { academy: opts.academy } : {}),
    ...(opts.close ? {
      payments: opts.close.map((a) => (typeof a === "number"
        ? { amount: a, paidAt: new Date(opts.date), method: "cash" }
        : { paidAt: new Date(opts.date), method: "cash", ...a })),
    } : {}),
  });
  const leader = team.equals(T1) ? "Tina" : "Otto";
  const rupees = (amountInr: number) => (opts.inr ? { amountInr } : {});
  const lines = [
    { role: "sales", user: ids[closer], userName: closer, amount: 230, ...rupees(5000) },
    ...(PAYS_TL ? [{ role: "tl", user: ids[leader], userName: leader, amount: 100, ...rupees(2000) }] : []),
    { role: "sm", user: ids.Manager, userName: "Manager", amount: 85, ...rupees(1700) },
  ];
  if (opts.counted !== false) {
    const d = new Date(opts.date);
    await CommissionSale.create({
      student: studentId, studentName: `Student ${n}`, closer: ids[closer], closerName: closer, team, teamName: leader,
      saleDate: d, month: commission.uaeMonthOf(d), state: "counted", lines, fee: opts.fee, approvedAt: d, countedAt: d,
      plan: { sales: 230, tl: 100, sm: 85, creditUsd: 0 },
    });
  }
  return { leadId, studentId: String(studentId), name: `Student ${n}` };
}
const approvedBp = (id: string) => ({ externalId: id, state: "approved", sentAt: new Date(), method: "card" });

/* ── 1. Repeat leads ───────────────────────────────────────────────────── */
section("1. A repeat lead that is already a client stays with its owner");
async function repeatLead(owner: string, status: string, enrolled = false) {
  const _id = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id, name: `Repeat ${owner} ${status}`, phone: `97155${Math.floor(Math.random() * 1e7)}`, status, assignedTo: ids[owner], reporter: ids.Admin, activityLogs: [],
    repeat: { waiting: true, at: new Date(), team: T1, previousOwner: ids[owner], previousStatus: status, alreadyClient: false },
  });
  if (enrolled) await db.collection("students").insertOne({ _id: new Types.ObjectId(), name: "Enrolled", enrollmentNumber: `EN-R${_id}`, leadId: _id, team: T1, assignedTo: ids[owner], enrollmentDate: new Date(), totalFee: 0, paidAmount: 0, pendingAmount: 0 });
  return String(_id);
}
const lead = (id: string) => db.collection("leads").findOne({ _id: new Types.ObjectId(id) });
const tryGive = async (who: string, id: string, to: string) => { try { await giveRepeatLead(viewer(who), id, String(ids[to])); return 200; } catch (e) { if (!(e as { statusCode?: number }).statusCode) console.log("    (error)", (e as Error).message); return (e as { statusCode?: number }).statusCode ?? 500; } };
const r1 = await repeatLead("Bea", "followup");
check("happy: not a client — the leader gives it to another member, as a new lead", (await tryGive("Tina", r1, "Cal")) === 200
  && String((await lead(r1))?.assignedTo) === String(ids.Cal) && (await lead(r1))?.status === "assigned", j(await lead(r1)));
const r2 = await repeatLead("Bea", "followup");
await db.collection("leads").updateOne({ _id: new Types.ObjectId(r2) }, { $set: { status: "closed" } });   // closed while it waited
check("edge: closed since it came in — not given away", (await tryGive("Tina", r2, "Cal")) === 400 && String((await lead(r2))?.assignedTo) === String(ids.Bea));
check("…given back to its owner, it stays closed", (await tryGive("Tina", r2, "Bea")) === 200 && (await lead(r2))?.status === "closed" && (await lead(r2))?.repeat?.alreadyClient === true, j((await lead(r2))?.repeat));
const r3 = await repeatLead("Bea", "followup", true);
check("invalid: enrolled but still \"followup\" — refused (400); a bad lead id — not found (404)",
  (await tryGive("Tina", r3, "Cal")) === 400 && (await tryGive("Tina", "nope", "Cal")) === 404);
const r4 = await repeatLead("Bea", "followup");
check("permission: someone who doesn't lead its team can't decide it (403)", (await tryGive("Cal", r4, "Cal")) === 403 && (await tryGive("Otto", r4, "Cal")) === 403);

/* ── 2. Approved balance payments reach the enrolment ─────────────────── */
section("2. An approved balance payment reaches its enrolment");
const student = (id: string) => db.collection("students").findOne({ _id: new Types.ObjectId(id) });
// Paid 1,125 at the close, 562.50 approved since: 1,687.50 paid of 2,250.
const b1 = await sale("Bea", T1, { date: "2026-10-05T08:00:00Z", fee: 2250, close: [1125], paid: 1125, pending: 1125, counted: false,
  pays: [{ amount: 1125, paidAt: "2026-10-05T00:00:00Z" }, { amount: 562.5, paidAt: "2026-10-20T00:00:00Z", finance: approvedBp("bp-1") }] });
const applied = await applyApprovedBalances();
let st = await student(b1.studentId);
check("happy: 562.50 approved → paid 1,687.50, pending 562.50, part paid", applied === 1 && st?.paidAmount === 1687.5 && st?.pendingAmount === 562.5 && st?.feeStatus === "partial" && st?.balanceApplied?.includes("bp-1"), j(st));
await applyApprovedBalances();
st = await student(b1.studentId);
check("edge: run again — nothing added twice", st?.paidAmount === 1687.5, j(st?.paidAmount));
// Typed in by hand already (1,687.50) — the approval doesn't add it on top.
const b2 = await sale("Bea", T1, { date: "2026-10-06T08:00:00Z", fee: 2250, close: [1125], paid: 1687.5, pending: 562.5, counted: false,
  pays: [{ amount: 1125, paidAt: "2026-10-06T00:00:00Z" }, { amount: 562.5, paidAt: "2026-10-21T00:00:00Z", finance: approvedBp("bp-2") }] });
await applyApprovedBalances();
check("edge: a hand-edited enrolment isn't counted twice", (await student(b2.studentId))?.paidAmount === 1687.5, j((await student(b2.studentId))?.paidAmount));
const b3 = await sale("Bea", T1, { date: "2026-10-07T08:00:00Z", fee: 2250, close: [1125], paid: 1125, pending: 1125, counted: false, pays: [
  { amount: 1125, paidAt: "2026-10-07T00:00:00Z" },
  { amount: 500, paidAt: "2026-10-22T00:00:00Z", finance: { ...approvedBp("bp-3"), state: "pending" } },
  { amount: 400, paidAt: "2026-10-22T00:00:00Z", finance: { ...approvedBp("bp-4"), state: "rejected" } },
  { amount: 20000, paidAt: "2026-10-22T00:00:00Z", finance: approvedBp("bp-5"), currency: "INR" },
] });
await applyApprovedBalances();
check("invalid: pending, rejected and another currency's payments left out", (await student(b3.studentId))?.paidAmount === 1125 && !(await student(b3.studentId))?.balanceApplied, j(await student(b3.studentId)));

/* ── 3. Commission on the money received, in its month ────────────────── */
section("3. Paid in full first — earned whole in the month of the last payment");
// 75 % paid in October.
const s75 = await sale("Bea", T1, { date: "2026-10-05T08:00:00Z", fee: 2000, pays: [{ amount: 1500, paidAt: "2026-10-05T00:00:00Z" }] });
// Half before commission started (30 Sep), half in October.
const sSep = await sale("Cal", T1, { date: "2026-10-02T08:00:00Z", fee: 2000, pays: [{ amount: 1000, paidAt: "2026-09-30T00:00:00Z" }, { amount: 1000, paidAt: "2026-10-05T00:00:00Z" }] });
// Half in October, the balance in November.
const sNov = await sale("Oli", T2, { date: "2026-10-20T08:00:00Z", fee: 2000, pays: [{ amount: 1000, paidAt: "2026-10-20T00:00:00Z" }, { amount: 1000, paidAt: "2026-11-03T00:00:00Z", finance: approvedBp("bp-n") }] });
// No fee: all of it on the sale day.
const sFree = await sale("Oli", T2, { date: "2026-10-25T08:00:00Z", fee: 0, pays: [] });
await refreshPaidShares();
const saleOf = (id: string) => CommissionSale.findOne({ student: new Types.ObjectId(id) }).lean();
const svc = new CommissionService();
const oct = await svc.getEarnings(viewer("Admin"), "2026-10");
const nov = await svc.getEarnings(viewer("Admin"), "2026-11");
// The Commission page's rows carry the student's name, not the enrolment's id.
const saleRow = (e: typeof oct, sold: { name: string }) => (e.sales as any[]).find((x) => x.studentName === sold.name);
const s75Row = saleRow(oct, s75);
const s75Sales = s75Row?.lines?.find((l: any) => l.role === "sales");
check("happy: 75 % received, still owing → nothing earned, all 230 waiting; the sale says 75 % received this month",
  (await saleOf(s75.studentId))?.paidShare === 0.75 && s75Sales?.earned === 0 && s75Sales?.balance === 230 && s75Row?.monthShare === 0.75 && s75Row?.paidInFullAt === null, j({ s75Row }));
check(`…every line waits whole: SM 85${PAYS_TL ? ", TL 100" : ""}`, s75Row?.lines?.find((l: any) => l.role === "sm")?.earned === 0 && s75Row?.lines?.find((l: any) => l.role === "sm")?.balance === 85
  && (!PAYS_TL || s75Row?.lines?.find((l: any) => l.role === "tl")?.balance === 100), j(s75Row?.lines));
const sepRow = saleRow(oct, sSep);
check("edge: paid half on 30 Sep, half in October — paid in full in October, all 230 earned there",
  sepRow?.lines?.find((l: any) => l.role === "sales")?.earned === 230 && sepRow?.lines?.find((l: any) => l.role === "sales")?.balance === 0
  && new Date(sepRow?.paidInFullAt).toISOString().startsWith("2026-10-05"), j(sepRow));
const novOct = saleRow(oct, sNov), novNov = saleRow(nov, sNov);
check("edge: an October sale finished in November — nothing in October, all 230 in November",
  novOct?.lines?.find((l: any) => l.role === "sales")?.earned === 0 && novNov?.lines?.find((l: any) => l.role === "sales")?.earned === 230
  && new Date(novNov?.paidInFullAt).toISOString().startsWith("2026-11-03"), j({ oct: novOct?.lines, nov: novNov?.lines }));
check("edge: no fee — all of it on the sale day", saleRow(oct, sFree)?.lines?.find((l: any) => l.role === "sales")?.earned === 230, j(saleRow(oct, sFree)));
const bea = oct.people.find((p: any) => p.name === "Bea") as any;
check("the people: Bea has nothing earned, 230 waiting", bea?.total === 0 && bea?.balance === 230, j(bea));
check("totals: earned and balance", typeof oct.totals.balance === "number" && oct.totals.balance > 0, j(oct.totals));
// Who sees what.
const asBea = await svc.getEarnings(viewer("Bea"), "2026-10");
check("permission: a BDE sees only her own lines", asBea.sales.length > 0 && (asBea.sales as any[]).every((x) => x.lines.every((l: any) => l.userName === "Bea")), j(asBea.sales.map((x: any) => x.lines)));
const calOct = oct.people.find((p: any) => p.name === "Cal") as any;
check("the people: Cal, paid in full in October, 230 earned", calOct?.total === 230 && calOct?.balance === 0, j(calOct));
const asTina = await svc.getEarnings(viewer("Tina"), "2026-10");
check("permission: a team leader sees her team's lines, not the Sales Manager's", (asTina.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Bea"))
  && (asTina.sales as any[]).every((x) => x.lines.every((l: any) => l.role !== "sm")) && !(asTina.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Oli")), j(asTina.sales.map((x: any) => x.lines)));
const asManager = await svc.getEarnings(viewer("Manager"), "2026-10");
check("permission: the Sales Manager sees everyone's", (asManager.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Oli")) && (asManager.sales as any[]).some((x) => x.lines.some((l: any) => l.role === "sm")));
// My Pay: the target is what was received in the month.
const slabs = { sales: [{ name: "Base", target: 0, salary: 1000, percent: 100 }], tl: [{ name: "Base", target: 0, salary: 1000, percent: 100 }], sm: [{ name: "Base", target: 0, salary: 1000, percent: 100 }] } as never;
const rowsOct = await payRows("2026-10", slabs);
const beaPay = rowsOct.find((r) => r.name === "Bea");
check("My Pay: Bea's October target is still the 1,500 received, of a 2,000 fee; nothing earned, 230 waiting",
  beaPay?.sales.value === 1500 && beaPay?.sales.fee === 2000 && beaPay?.commission.earned === 0 && beaPay?.commission.balance === 230, j(beaPay));
const oliNov = (await payRows("2026-11", slabs)).find((r) => r.name === "Oli");
check("My Pay: Oli's November counts the 1,000 paid in November, and all 230 of the sale it finished", oliNov?.sales.value === 1000 && oliNov?.commission.earned === 230, j(oliNov));

/* ── 4. Daily Closings: collected in the period ───────────────────────── */
section("4. Daily Closings — collected in the period, commission earned and waiting");
const closings = new StudentService();
const octBook = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Manager") as never);
const row = (book: any, studentId: string) => book.days.flatMap((d: any) => d.enrolments).find((e: any) => String(e.id) === studentId);
check("happy: October — the 75 % sale shows 1,500 collected", row(octBook, s75.studentId)?.paidAmount === 1500, j(row(octBook, s75.studentId)));
check("edge: the half paid in September shows as paid outside the period, not collected", row(octBook, sSep.studentId)?.paidAmount === 1000 && row(octBook, sSep.studentId)?.paidOutside === 1000, j(row(octBook, sSep.studentId)));
check("…and the November balance is outside October too", row(octBook, sNov.studentId)?.paidAmount === 1000 && row(octBook, sNov.studentId)?.paidOutside === 1000, j(row(octBook, sNov.studentId)));
check("…commission on each closing: the part-paid one all waiting, the one paid in full all earned; totals",
  row(octBook, s75.studentId)?.commission?.earned === 0 && row(octBook, s75.studentId)?.commission?.balance === 230 + 85 + (PAYS_TL ? 100 : 0)
  && row(octBook, sSep.studentId)?.commission?.earned === 230 + 85 + (PAYS_TL ? 100 : 0) && octBook.totals.commissionEarned > 0, j({ c: row(octBook, s75.studentId)?.commission, t: octBook.totals }));
const empty = await closings.listDailyClosings({ dateFrom: "2026-12-01", dateTo: "2026-12-31" }, viewer("Manager") as never);
check("invalid: a period with no closings — zeros", empty.days.length === 0 && empty.totals.paidAmount === 0 && empty.totals.commissionEarned === 0, j(empty.totals));
const beaBook = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Bea") as never);
check("permission: a BDE's book has only her closings, and only her own commission", beaBook.view === "own"
  && beaBook.days.flatMap((d: any) => d.enrolments).every((e: any) => e.closedByName === "Bea") && row(beaBook, s75.studentId)?.commission?.balance === 230, j(row(beaBook, s75.studentId)));

/* ── 5. Who sees whose closings ───────────────────────────────────────── */
section("5. Daily Closings — each person their scope");
const names = (book: any) => [...new Set(book.days.flatMap((d: any) => d.enrolments).map((e: any) => e.closedByName))].sort().join();
const asAdmin = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Admin") as never);
check("happy: a Super Admin and the Sales Manager see everyone's", asAdmin.view === "all" && octBook.view === "all" && names(asAdmin).includes("Oli") && names(asAdmin).includes("Bea"), names(asAdmin));
const tinaBook = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Tina") as never);
check("edge: a team leader sees her teams' closings, with her teams to pick from", tinaBook.view === "team" && !names(tinaBook).includes("Oli") && names(tinaBook).includes("Bea")
  && tinaBook.teams.map((t: any) => t.name).join() === "Team One", `${names(tinaBook)} ${j(tinaBook.teams)}`);
const tinaMember = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31", user: String(ids.Cal) }, viewer("Tina") as never);
check("…filtered to her member", names(tinaMember) === "Cal", names(tinaMember));
const badTeam = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31", team: "not-an-id" }, viewer("Manager") as never);
check("invalid: a bad team id — the whole list, no error", names(badTeam) === names(octBook), names(badTeam));
const tinaOther = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31", team: String(T2) }, viewer("Tina") as never);
const beaAsks = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31", user: String(ids.Oli), team: String(T2) }, viewer("Bea") as never);
check("permission: a leader asking for another team, or a BDE for anyone, gets their own scope", !names(tinaOther).includes("Oli") && names(beaAsks) === "Bea", `${names(tinaOther)} / ${names(beaAsks)}`);

/* ── 6. Paid in rupees, earned in rupees (2026-11-13) ─────────────────── */
section("6. The part of a sale paid in rupees earns the course's rupee amount");
const atClose = (said: string) => `Collected at enrolment — Course · ${said}`;
// A quarter by INR Transfer at the close (typed in rupees, with its rate), the rest in cash — the rows as the close
// dialog puts them on the lead: each with its method, and what was handed over in its note.
const r25 = await sale("Cal", T1, { date: "2026-12-02T08:00:00Z", fee: 2000, inr: true,
  close: [{ amount: 500, method: "inr_bank_account", currency: "INR", amountInCurrency: 12800, exchangeRate: 0.0390625 }, 1500],
  pays: [{ amount: 500, paidAt: "2026-12-02T08:00:00Z", method: "inr_bank_account", note: atClose("INR Transfer · INR 12,800 at 1 AED = 25.6 INR") },
    { amount: 1500, paidAt: "2026-12-02T08:00:00Z", method: "cash", note: atClose("Cash") }] });
// Half in cash at the close, the balance later by INR Transfer — finance approved it.
const rBal = await sale("Cal", T1, { date: "2026-12-03T08:00:00Z", fee: 2000, inr: true, close: [1000],
  pays: [{ amount: 1000, paidAt: "2026-12-03T08:00:00Z", method: "cash", note: atClose("Cash") }, { amount: 1000, paidAt: "2026-12-10T00:00:00Z", finance: { ...approvedBp("bp-inr"), method: "inr_bank_account" } }] });
// All of it typed in rupees at the close under another method, and its row on the lead says only "Cash" (a note
// changed by hand): the close's own payment says rupees, and the row is that payment by its amount.
const rAll = await sale("Cal", T1, { date: "2026-12-04T08:00:00Z", fee: 800, inr: true,
  close: [{ amount: 800, method: "cash", currency: "INR", amountInCurrency: 20480, exchangeRate: 0.0390625 }],
  pays: [{ amount: 800, paidAt: "2026-12-04T08:00:00Z", method: "cash", note: atClose("Cash") }] });
// By INR Transfer, but the course has no rupee amount (its lines carry none): all in AED.
const rNone = await sale("Cal", T1, { date: "2026-12-05T08:00:00Z", fee: 1000, close: [{ amount: 1000, method: "inr_bank_account" }],
  pays: [{ amount: 1000, paidAt: "2026-12-05T08:00:00Z", method: "inr_bank_account", note: atClose("INR Transfer") }] });
// Half paid, by INR Transfer, half still owed: all of it waits, in AED.
const rOwing = await sale("Cal", T1, { date: "2026-12-06T08:00:00Z", fee: 2000, inr: true, close: [{ amount: 1000, method: "inr_bank_account" }],
  pays: [{ amount: 1000, paidAt: "2026-12-06T08:00:00Z", method: "inr_bank_account", note: atClose("INR Transfer") }] });
// Two payments of the same amount as a rupee one elsewhere, in cash and by card: neither is rupees.
const rCash = await sale("Cal", T1, { date: "2026-12-07T08:00:00Z", fee: 1000, inr: true, close: [500, { amount: 500, method: "card" }],
  pays: [{ amount: 500, paidAt: "2026-12-07T08:00:00Z", method: "cash", note: atClose("Cash") }, { amount: 500, paidAt: "2026-12-07T09:00:00Z", method: "card", note: atClose("Card") }] });
await refreshPaidShares();
const marks = async (s: { studentId: string }) => ((await saleOf(s.studentId))?.collections ?? []).map((c) => `${c.share}${c.inr ? "₹" : ""}`).join(" ");
check("the payments marked as rupees: INR Transfer at the close; a balance payment by INR Transfer; one typed in rupees under another method",
  (await marks(r25)) === "0.25₹ 0.75" && (await marks(rBal)) === "0.5 0.5₹" && (await marks(rAll)) === "1₹", `${await marks(r25)} / ${await marks(rBal)} / ${await marks(rAll)}`);
check("…cash and card are never rupees", (await marks(rCash)) === "0.5 0.5", await marks(rCash));
await refreshPaidShares();
check("…and a second pass changes nothing", (await refreshPaidShares()) === 0);
const dec = await svc.getEarnings(viewer("Admin"), "2026-12");
const salesLine = (sold: { name: string }) => saleRow(dec, sold)?.lines?.find((l: any) => l.role === "sales");
check("a quarter in rupees: AED 172.50 of the 230, and INR 1,250 of the 5,000", salesLine(r25)?.earned === 172.5 && salesLine(r25)?.earnedInr === 1250 && saleRow(dec, r25)?.rupeeShare === 0.25, j(saleRow(dec, r25)));
check("the balance paid by INR Transfer: half and half — AED 115 and INR 2,500", salesLine(rBal)?.earned === 115 && salesLine(rBal)?.earnedInr === 2500, j(salesLine(rBal)));
check("all in rupees: nothing in AED, the whole INR 5,000", salesLine(rAll)?.earned === 0 && salesLine(rAll)?.earnedInr === 5000, j(salesLine(rAll)));
check("no rupee amount on the course: all 230 in AED though it was paid in rupees", salesLine(rNone)?.earned === 230 && salesLine(rNone)?.earnedInr === 0, j(salesLine(rNone)));
check("still owing: all 230 waits, in AED — nothing in rupees yet", salesLine(rOwing)?.earned === 0 && salesLine(rOwing)?.earnedInr === 0 && salesLine(rOwing)?.balance === 230, j(salesLine(rOwing)));
check("paid in AED: all 230 in AED", salesLine(rCash)?.earned === 230 && salesLine(rCash)?.earnedInr === 0, j(salesLine(rCash)));
const calDec = dec.people.find((p: any) => p.name === "Cal") as any;
check("the people: Cal AED 747.50 and INR 8,750 earned, 230 waiting", calDec?.total === 747.5 && calDec?.totalInr === 8750 && calDec?.balance === 230 && calDec?.sales?.amountInr === 8750, j(calDec));
check("totals: the rupees apart from the AED", dec.totals.amountInr === 8750 + 1700 * 1.75 + (PAYS_TL ? 2000 * 1.75 : 0), j(dec.totals));
const calPay = (await payRows("2026-12", slabs)).find((r) => r.name === "Cal");
check("My Pay: the level's percent on each part — AED 747.50 and INR 8,750 payable", calPay?.commission.earned === 747.5 && calPay?.commission.earnedInr === 8750
  && calPay?.commission.payable === 747.5 && calPay?.commission.payableInr === 8750 && calPay?.total === 1747.5, j(calPay));
const decBook = await closings.listDailyClosings({ dateFrom: "2026-12-01", dateTo: "2026-12-31" }, viewer("Cal") as never);
check("Daily Closings: the closing's rupee part beside its AED, and the period's total", row(decBook, r25.studentId)?.commission?.earned === 172.5 && row(decBook, r25.studentId)?.commission?.earnedInr === 1250
  && row(decBook, rCash.studentId)?.commission?.earnedInr === undefined && decBook.totals.commissionEarnedInr === 8750, j({ c: row(decBook, r25.studentId)?.commission, t: decBook.totals }));

// Which payments are rupees, case by case — as this CRM records them (no commission counted on these).
const { collectionsOf } = await import("../src/utils/enrolmentCollections.js");
const paidIn = async (s: { studentId: string }) => {
  const st = await student(s.studentId);
  return ((await collectionsOf([st as never])).get(s.studentId) ?? []).map((c) => `${c.amount}${c.inr ? "₹" : ""}`).join(" ");
};
// Typed in US dollars at the close: another currency is not rupees.
const mUsd = await sale("Bea", T1, { date: "2027-01-05T08:00:00Z", fee: 1835, counted: false,
  close: [{ amount: 1835, method: "bank_transfer", currency: "USD", amountInCurrency: 500, exchangeRate: 3.67 }],
  pays: [{ amount: 1835, paidAt: "2027-01-05T08:00:00Z", method: "bank_transfer", note: atClose("Bank Transfer · USD 500 at 1 USD = 3.67 AED") }] });
check("a payment typed in US dollars is not rupees", (await paidIn(mUsd)) === "1835", await paidIn(mUsd));
// Two cash payments of the same amount at the close, the second typed in rupees — as the close dialog writes them:
// the note says which of the two was rupees.
const mTwo = await sale("Bea", T1, { date: "2027-01-05T10:00:00Z", fee: 1000, counted: false,
  close: [500, { amount: 500, method: "cash", currency: "INR", amountInCurrency: 12800, exchangeRate: 0.0390625 }],
  pays: [{ amount: 500, paidAt: "2027-01-05T10:00:00Z", method: "cash", note: atClose("Cash") }, { amount: 500, paidAt: "2027-01-05T11:00:00Z", method: "cash", note: atClose("Cash · INR 12,800 at 1 AED = 25.6 INR") }] });
check("two cash payments of the same amount, one typed in rupees: the one whose note says so", (await paidIn(mTwo)) === "500 500₹", await paidIn(mTwo));
// A corrected enrolment: its rows rewritten with amount and note only — the card row first, the same amount as the
// one typed in rupees. Only the one whose note says rupees is.
const mFix = await sale("Bea", T1, { date: "2027-01-06T08:00:00Z", fee: 1000, counted: false,
  close: [{ amount: 500, method: "card" }, { amount: 500, method: "cash", currency: "INR", amountInCurrency: 12800, exchangeRate: 0.0390625 }],
  pays: [{ amount: 500, paidAt: "2027-01-06T08:00:00Z", note: atClose("Card") }, { amount: 500, paidAt: "2027-01-06T09:00:00Z", note: atClose("Cash · INR 12,800 at 1 INR = 0.0390625 AED") }] });
check("a corrected enrolment's rows (no method on them): the one whose note says rupees, not the card row of the same amount", (await paidIn(mFix)) === "500 500₹", await paidIn(mFix));
// The same after a correction, by INR Transfer typed in AED: the note names the method.
const mNote = await sale("Bea", T1, { date: "2027-01-07T08:00:00Z", fee: 1000, counted: false,
  close: [{ amount: 400, method: "inr_bank_account" }, { amount: 600, method: "tabby" }],
  pays: [{ amount: 400, paidAt: "2027-01-07T08:00:00Z", note: atClose("INR Transfer") }, { amount: 600, paidAt: "2027-01-07T09:00:00Z", note: atClose("Tabby") }] });
check("…and one by INR Transfer, named in its note", (await paidIn(mNote)) === "400₹ 600", await paidIn(mNote));
// Paid on the lead before the close: one by INR Transfer, one in cash of the same amount as the close's rupee payment.
// The lead's own cash payment is never matched to the close's; the close's row with nothing said in its note is.
const mLead = await sale("Bea", T1, { date: "2027-01-08T08:00:00Z", fee: 1500, counted: false,
  close: [{ amount: 500, method: "cash", currency: "INR", amountInCurrency: 12800, exchangeRate: 0.0390625 }],
  pays: [{ amount: 300, paidAt: "2027-01-02T08:00:00Z", method: "inr_bank_account", note: "Advance" }, { amount: 500, paidAt: "2027-01-03T08:00:00Z", method: "cash", note: "Second advance" },
    { amount: 500, paidAt: "2027-01-08T08:00:00Z", note: "Collected at enrolment — Course" }, { amount: 200, paidAt: "2027-01-09T08:00:00Z", finance: { ...approvedBp("bp-card"), method: "card" } }] });
check("a payment added on the lead by INR Transfer is rupees; the lead's own cash of the same amount as the close's rupees is not; a card balance payment is not",
  (await paidIn(mLead)) === "300₹ 500 500₹ 200", await paidIn(mLead));
// A Bangalore close: its rupees are rupees, cash taken in AED is not; a balance payment in rupees once approved.
const mBlr = await sale("Bea", T1, { date: "2027-01-10T08:00:00Z", fee: 60000, counted: false, academy: "bangalore", paid: 50000,
  close: [{ amount: 20000, method: "bank_transfer" }, { amount: 22750, method: "cash", currency: "AED", amountInCurrency: 1000, exchangeRate: 22.75 }, { amount: 7250, method: "inr_bank_account" }],
  pays: [{ amount: 1000, paidAt: "2027-01-10T08:00:00Z", method: "cash", note: atClose("Cash · Bangalore · AED 1,000 at 1 AED = 22.75 INR") },
    { amount: 10000, paidAt: "2027-01-20T08:00:00Z", currency: "INR", finance: approvedBp("bp-blr") }, { amount: 5000, paidAt: "2027-01-21T08:00:00Z", currency: "INR", finance: { ...approvedBp("bp-blr-2"), state: "pending" } }] });
check("a Bangalore close: rupees at the close and an approved balance payment are rupees, cash taken in AED is not", (await paidIn(mBlr)) === "20000₹ 22750 7250₹ 10000₹", await paidIn(mBlr));

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
