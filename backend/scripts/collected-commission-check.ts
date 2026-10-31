/**
 * Collected-based commission, balance sync, repeat leads and Daily Closings (the user, 2026-10-31, as in the Sales
 * CRM) — four cases each, on a scratch database:
 *
 *   1. a repeat lead that became a client while it waited stays with its owner (status kept); a non-client is given
 *      out; enrolled but not "closed" is refused; a bad id is not found; only a leader of its team decides;
 *   2. an approved balance payment reaches its enrolment once — paid, pending, fee status — never on top of a hand
 *      edit; a pending or rejected one, or one in another currency, is left out;
 *   3. commission is earned on the money received, in the month received: 75 % paid earns 75 %, the rest is balance;
 *      money before 1 October never earns; a balance paid in November earns in November; no fee earns all on the
 *      sale day; My Pay's target is the money received in the month; who sees which lines;
 *   4. Daily Closings: collected in the period only, the rest "paid outside"; commission earned and balance; an
 *      empty period is zeros; a BDE sees no one else's commission;
 *   5. who sees whose closings: a Super Admin and the Sales Manager everyone's; a team leader their teams'; anyone
 *      else their own — whatever the filters ask; a bad team id narrows nothing and fails nothing.
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
type Pay = { amount: number; paidAt: string; finance?: { externalId: string; state: string; sentAt: Date; method: string }; currency?: string };
let n = 0;
async function sale(closer: string, team: Types.ObjectId, opts: { date: string; fee: number; pays: Pay[]; pending?: number; paid?: number; close?: number[]; counted?: boolean }) {
  n++;
  const leadId = new Types.ObjectId(), studentId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Lead ${n}`, phone: `97150000${String(n).padStart(4, "0")}`, status: "closed", assignedTo: ids[closer], activityLogs: [],
    payments: opts.pays.map((p) => ({ amount: p.amount, paidAt: new Date(p.paidAt), ...(p.finance ? { finance: p.finance } : {}), ...(p.currency ? { currency: p.currency } : {}) })),
  });
  const paid = opts.paid ?? opts.pays.filter((p) => !p.finance || p.finance.state === "approved").reduce((s, p) => s + p.amount, 0);
  await db.collection("students").insertOne({
    _id: studentId, name: `Student ${n}`, enrollmentNumber: `EN-${n}`, leadId, team, assignedTo: ids[closer], courses: [], course: null,
    enrollmentDate: new Date(opts.date), status: "active", totalFee: opts.fee, paidAmount: paid,
    pendingAmount: opts.pending ?? Math.max(0, opts.fee - paid), feeStatus: paid >= opts.fee ? "paid" : paid > 0 ? "partial" : "pending",
    ...(opts.close ? { payments: opts.close.map((a) => ({ amount: a, paidAt: new Date(opts.date), method: "cash" })) } : {}),
  });
  const leader = team.equals(T1) ? "Tina" : "Otto";
  const lines = [
    { role: "sales", user: ids[closer], userName: closer, amount: 230 },
    ...(PAYS_TL ? [{ role: "tl", user: ids[leader], userName: leader, amount: 100 }] : []),
    { role: "sm", user: ids.Manager, userName: "Manager", amount: 85 },
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
section("3. Commission on the money received, in the month received");
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
check("happy: 75 % received → 172.50 of 230 earned, 57.50 balance; the sale says 75 % this month",
  (await saleOf(s75.studentId))?.paidShare === 0.75 && s75Sales?.earned === 172.5 && s75Sales?.balance === 57.5 && s75Row?.monthShare === 0.75, j({ s75Row }));
check(`…every line the same share: SM 63.75${PAYS_TL ? ", TL 75" : ""}`, s75Row?.lines?.find((l: any) => l.role === "sm")?.earned === 63.75
  && (!PAYS_TL || s75Row?.lines?.find((l: any) => l.role === "tl")?.earned === 75), j(s75Row?.lines));
const sepRow = saleRow(oct, sSep);
check("edge: paid half on 30 Sep, half in October — 50 % in October, the September half never",
  sepRow?.monthShare === 0.5 && sepRow?.lines?.find((l: any) => l.role === "sales")?.earned === 115 && (await saleOf(sSep.studentId))?.paidShare === 0.5, j(sepRow));
const novOct = saleRow(oct, sNov), novNov = saleRow(nov, sNov);
check("edge: an October sale's balance paid in November earns in November",
  novOct?.monthShare === 0.5 && novNov?.monthShare === 0.5 && novNov?.lines?.find((l: any) => l.role === "sales")?.earned === 115, j({ oct: novOct?.monthShare, nov: novNov?.monthShare }));
check("edge: no fee — all of it on the sale day", saleRow(oct, sFree)?.monthShare === 1, j(saleRow(oct, sFree)));
const bea = oct.people.find((p: any) => p.name === "Bea") as any;
check("the people: Bea's earned and balance", bea?.total === 172.5 && bea?.balance === 57.5, j(bea));
check("totals: earned and balance", typeof oct.totals.balance === "number" && oct.totals.balance > 0, j(oct.totals));
// Who sees what.
const asBea = await svc.getEarnings(viewer("Bea"), "2026-10");
check("permission: a BDE sees only her own lines", asBea.sales.length > 0 && (asBea.sales as any[]).every((x) => x.lines.every((l: any) => l.userName === "Bea")), j(asBea.sales.map((x: any) => x.lines)));
const asTina = await svc.getEarnings(viewer("Tina"), "2026-10");
check("permission: a team leader sees her team's lines, not the Sales Manager's", (asTina.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Bea"))
  && (asTina.sales as any[]).every((x) => x.lines.every((l: any) => l.role !== "sm")) && !(asTina.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Oli")), j(asTina.sales.map((x: any) => x.lines)));
const asManager = await svc.getEarnings(viewer("Manager"), "2026-10");
check("permission: the Sales Manager sees everyone's", (asManager.sales as any[]).some((x) => x.lines.some((l: any) => l.userName === "Oli")) && (asManager.sales as any[]).some((x) => x.lines.some((l: any) => l.role === "sm")));
// My Pay: the target is what was received in the month.
const slabs = { sales: [{ name: "Base", target: 0, salary: 1000, percent: 100 }], tl: [{ name: "Base", target: 0, salary: 1000, percent: 100 }], sm: [{ name: "Base", target: 0, salary: 1000, percent: 100 }] } as never;
const rowsOct = await payRows("2026-10", slabs);
const beaPay = rowsOct.find((r) => r.name === "Bea");
check("My Pay: Bea's October target is the 1,500 received, of a 2,000 fee; 172.50 earned + 57.50 balance",
  beaPay?.sales.value === 1500 && beaPay?.sales.fee === 2000 && beaPay?.commission.earned === 172.5 && beaPay?.commission.balance === 57.5, j(beaPay));
const oliNov = (await payRows("2026-11", slabs)).find((r) => r.name === "Oli");
check("My Pay: Oli's November counts the 1,000 paid in November on his October sale", oliNov?.sales.value === 1000 && oliNov?.commission.earned === 115, j(oliNov));

/* ── 4. Daily Closings: collected in the period ───────────────────────── */
section("4. Daily Closings — collected in the period, commission and balance");
const closings = new StudentService();
const octBook = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Manager") as never);
const row = (book: any, studentId: string) => book.days.flatMap((d: any) => d.enrolments).find((e: any) => String(e.id) === studentId);
check("happy: October — the 75 % sale shows 1,500 collected", row(octBook, s75.studentId)?.paidAmount === 1500, j(row(octBook, s75.studentId)));
check("edge: the half paid in September shows as paid outside the period, not collected", row(octBook, sSep.studentId)?.paidAmount === 1000 && row(octBook, sSep.studentId)?.paidOutside === 1000, j(row(octBook, sSep.studentId)));
check("…and the November balance is outside October too", row(octBook, sNov.studentId)?.paidAmount === 1000 && row(octBook, sNov.studentId)?.paidOutside === 1000, j(row(octBook, sNov.studentId)));
check("…commission on each closing: earned and balance; totals", row(octBook, s75.studentId)?.commission?.earned === 172.5 + 63.75 + (PAYS_TL ? 75 : 0) && octBook.totals.commissionEarned > 0, j({ c: row(octBook, s75.studentId)?.commission, t: octBook.totals }));
const empty = await closings.listDailyClosings({ dateFrom: "2026-12-01", dateTo: "2026-12-31" }, viewer("Manager") as never);
check("invalid: a period with no closings — zeros", empty.days.length === 0 && empty.totals.paidAmount === 0 && empty.totals.commissionEarned === 0, j(empty.totals));
const beaBook = await closings.listDailyClosings({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, viewer("Bea") as never);
check("permission: a BDE's book has only her closings, and only her own commission", beaBook.view === "own"
  && beaBook.days.flatMap((d: any) => d.enrolments).every((e: any) => e.closedByName === "Bea") && row(beaBook, s75.studentId)?.commission?.earned === 172.5, j(row(beaBook, s75.studentId)));

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

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
