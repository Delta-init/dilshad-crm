/**
 * Commission from Root (the user, 2026-11-01, stage 3) — services/rootCommission.ts and where it is used, against a
 * stand-in Root on a scratch database:
 *
 *   1. off (the default): who earns what, the slabs and My Pay are this CRM's own; Root is never asked;
 *   2. on: who earns what is Root's — from the course's row, a held sale at the amounts it was held at — asked with
 *      this CRM's secret; the closing preview shows Root's lines and amounts; a held sale settles with Root's answer;
 *      the slabs and My Pay (and so finance's payable) are Root's; Root's plan is copied into the CRM's settings,
 *      only what differs, and the sweep does it;
 *   3. Root unreachable, refusing, or not set up: a clear error — the sale is left as it was, to be tried again; Root
 *      answering for another CRM (this one's secret mixed up with another's): refused, nothing used or copied in;
 *   4. off again: back to this CRM's own figures.
 *
 * Run by commission-root-check.sh. Scratch database only.
 */
import http from "node:http";
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
async function fails(p: Promise<unknown>): Promise<{ message: string; statusCode?: number } | null> {
  try { await p; return null; } catch (e) { return e as { message: string; statusCode?: number }; }
}

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "rootcomm-check-jwt", JWT_REFRESH_SECRET: "rootcomm-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false",
});
delete process.env.COMMISSION_FROM_ROOT;

/* ── A stand-in Root: /api/v1/service/commission/{plan,resolve,pay}, behind this CRM's secret ───────────────── */
const SECRET = "rootcomm-check-secret";
const hits: Array<{ method: string; path: string; secret: unknown; body: any; query: Record<string, string> }> = [];
let answer: { plan: any; resolve: any; pay: any; status: number } = { plan: null, resolve: null, pay: null, status: 200 };
const rootApi = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = raw ? JSON.parse(raw) : null;
    hits.push({ method: req.method ?? "", path: url.pathname, secret: req.headers["x-org-secret"], body, query: Object.fromEntries(url.searchParams) });
    const send = (code: number, b: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.headers["x-org-secret"] !== SECRET) return send(401, { success: false, message: "Invalid service credential" });
    if (answer.status !== 200) return send(answer.status, { success: false, message: answer.status === 409 ? "This CRM's plan has not been copied to Root yet" : "Down" });
    const which = url.pathname.replace("/api/v1/service/commission/", "");
    const data = which === "plan" ? answer.plan : which === "resolve" ? (typeof answer.resolve === "function" ? answer.resolve(body) : answer.resolve) : which === "pay" ? answer.pay : null;
    if (!data) return send(404, { success: false, message: "Route not found" });
    send(200, { success: true, message: "ok", data });
  });
});
await new Promise<void>((ok) => rootApi.listen(0, "127.0.0.1", ok));
const ROOT_URL = `http://127.0.0.1:${(rootApi.address() as { port: number }).port}`;

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1" && mongoose.connection.host !== "localhost") { console.error("Refusing: not local"); process.exit(1); }
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const commission = await import("../src/services/commissionService.js");
const { resolveSale, loadConfig, planOf, sweepCommission, followNow, CommissionService, TL_RULE } = commission;
const { payRows, SalaryService } = await import("../src/services/salaryService.js");
const { slabsFor } = await import("../src/services/salarySlabs.js");
const { mirrorRootPlan, forgetRootPlan, PORTAL } = await import("../src/services/rootCommission.js");
const { CommissionSale } = await import("../src/models/CommissionSale.js");
const PAYS_TL = (TL_RULE as string) !== "never";

// ── This CRM's own plan ────────────────────────────────────────────────────────────────────────────────────────────
const superRole = { _id: new Types.ObjectId(), roleName: "Super Admin", isSystemRole: true };
await db.collection("roles").insertOne({ ...superRole, permissions: {} });
const ids: Record<string, Types.ObjectId> = {};
for (const name of ["Abrar", "Lena", "Ria", "Shared"]) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@e2e.test`, role: superRole._id, status: "active" });
}
const TEAM = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: TEAM, name: "Gladiators", status: "active", leaders: [ids.Lena], members: [ids.Ria] });
const MBT = new Types.ObjectId(), DWT = new Types.ObjectId();
await db.collection("courses").insertMany([
  { _id: MBT, name: "MBT", amount: 2250, status: "active", commission: { sales: 230, tl: 85, sm: 100, creditUsd: 500 } },
  { _id: DWT, name: "DWT", amount: 5500, status: "active", commission: { sales: 500, tl: 200, sm: 300, creditUsd: 1000 } },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Abrar, excludedUsers: [ids.Shared] });
const viewer = { userId: String(ids.Ria), role: superRole } as never;
const linesOf = (r: { lines: Array<{ role: string; userName: string; amount: number }> }) => r.lines.map((l) => `${l.role}:${l.userName}:${l.amount}`).join(" ");
const OWN = PAYS_TL ? "sales:Ria:230 tl:Lena:85 sm:Abrar:100" : "sales:Ria:230 sm:Abrar:100";

section("1. Off (the default): this CRM's own figures, Root never asked");
let config = await loadConfig();
let r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf({ commission: { sales: 230, tl: 85, sm: 100 } }), course: MBT }, config);
check("who earns what is the CRM's own", r.state === "counted" && linesOf(r) === OWN && !r.plan, j(r));
const ownSlabs = await slabsFor("2026-10");
check("…its own slabs (the built-in ones)", ownSlabs.from === null && ownSlabs.slabs.sales[0]?.salary === 2000, j(ownSlabs));
check("…its own My Pay", Array.isArray(await payRows("2026-10", ownSlabs.slabs)));
check("…and Root was never asked", hits.length === 0, j(hits));

section("2. On: Root works it out");
Object.assign(process.env, { COMMISSION_FROM_ROOT: "on", ROOT_ERP_API_URL: `${ROOT_URL}/`, ROOT_ORG_SECRET: SECRET });
// Root's plan for this CRM, as its own settings stand — asked first, to check Root answers for this CRM.
const PLAN_NOW = {
  portal: PORTAL, tlRule: TL_RULE, tlSlab: true, tlPaidOnOwnClose: false,
  salesManager: { id: String(ids.Abrar), name: "Abrar" }, excluded: [{ id: String(ids.Shared), name: "Shared" }],
  courses: [{ courseId: String(MBT), name: "MBT", sales: 230, tl: 85, sm: 100, creditUsd: 500 }],
  month: "2026-11", slabsFrom: "2000-01",
  slabs: { sales: [{ name: "Base", target: 0, salary: 2000, percent: 0 }], tl: [{ name: "Base", target: 0, salary: 4000, percent: 50 }], sm: [{ name: "Base", target: 0, salary: 5000, percent: 50 }] },
};
answer.plan = PLAN_NOW;
const line = (role: string, who: string, amount: number, note?: string) => ({ role, user: String(ids[who]), userName: who, amount, ...(note ? { note } : {}) });
answer.resolve = (body: any) => ({
  state: "counted", reason: "", team: String(TEAM), teamName: "Gladiators",
  plan: body.amounts ? { creditUsd: 0, ...body.amounts } : { sales: 250, tl: 90, sm: 100, creditUsd: 500 },
  lines: body.amounts
    ? [line("sales", "Ria", body.amounts.sales), line("tl", "Lena", body.amounts.tl), line("sm", "Abrar", body.amounts.sm)]
    : [line("sales", "Ria", 250), line("tl", "Lena", 90, "a note from Root"), line("sm", "Abrar", 100)],
});
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf({ commission: { sales: 230, tl: 85, sm: 100 } }), course: MBT }, config);
let hit = hits.at(-1)!;
check("who earns what from Root: its amounts (250 / 90 / 100), not the CRM's 230", r.state === "counted" && linesOf(r) === "sales:Ria:250 tl:Lena:90 sm:Abrar:100" && r.plan?.sales === 250, j(r));
check("…asked with this CRM's secret, the closer, team and course", hit.method === "POST" && hit.path === "/api/v1/service/commission/resolve" && hit.secret === SECRET
  && hit.body.closer === String(ids.Ria) && hit.body.team === String(TEAM) && hit.body.course === String(MBT) && !hit.body.amounts, j(hit));
check("…the people as ids, the team too, Root's note kept", r.lines[0]!.user instanceof Types.ObjectId && String(r.lines[1]!.user) === String(ids.Lena)
  && r.team instanceof Types.ObjectId && r.lines[1]!.note === "a note from Root", j(r.lines));
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0 } }, config);
hit = hits.at(-1)!;
check("a held sale (no course): Root asked at the amounts it was held at", hit.body.amounts?.sales === 200 && hit.body.amounts.tl === 70 && !hit.body.course
  && linesOf(r) === "sales:Ria:200 tl:Lena:70 sm:Abrar:90", j(hit.body));
const svc = new CommissionService();
const pv = await svc.preview({ course: String(MBT), team: String(TEAM), closer: String(ids.Ria) }, viewer);
check("the closing preview: Root's lines and amounts", pv.state === "counted" && pv.lines.map((l: any) => l.amount).join() === "250,90,100" && (pv.plan as any).sales === 250 && pv.closerTotal === 250, j(pv));

// The course's rupee amounts (2026-11-13): kept on the lines that have one and on the plan, shown in the preview, and
// sent back to Root for a held sale.
const plainResolve = answer.resolve;
const inrLine = (role: string, who: string, amount: number, amountInr: number) => ({ ...line(role, who, amount), amountInr });
answer.resolve = (body: any) => ({
  state: "counted", reason: "", team: String(TEAM), teamName: "Gladiators",
  plan: body.amounts ? { creditUsd: 0, salesInr: 0, tlInr: 0, smInr: 0, ...body.amounts } : { sales: 250, tl: 90, sm: 100, creditUsd: 500, salesInr: 5000, tlInr: 0, smInr: 2500 },
  lines: body.amounts
    ? [inrLine("sales", "Ria", body.amounts.sales, body.amounts.salesInr ?? 0), inrLine("tl", "Lena", body.amounts.tl, body.amounts.tlInr ?? 0), inrLine("sm", "Abrar", body.amounts.sm, body.amounts.smInr ?? 0)]
    : [inrLine("sales", "Ria", 250, 5000), inrLine("tl", "Lena", 90, 0), inrLine("sm", "Abrar", 100, 2500)],
});
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf({ commission: { sales: 230, tl: 85, sm: 100 } }), course: MBT }, config);
check("Root's rupee amounts kept on the lines that have one, and on the plan", r.lines[0]!.amountInr === 5000 && !("amountInr" in r.lines[1]!) && r.lines[2]!.amountInr === 2500
  && r.plan?.salesInr === 5000 && r.plan.smInr === 2500 && linesOf(r) === "sales:Ria:250 tl:Lena:90 sm:Abrar:100", j(r));
const pvInr = await svc.preview({ course: String(MBT), team: String(TEAM), closer: String(ids.Ria) }, viewer);
check("…shown in the closing preview beside the AED", pvInr.lines.map((l: any) => l.amountInr).join() === "5000,0,2500" && pvInr.closerTotalInr === 5000 && pvInr.closerTotal === 250, j(pvInr));
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0, salesInr: 4000, tlInr: 0, smInr: 0 } }, config);
hit = hits.at(-1)!;
check("a held sale: Root asked at its held rupee amounts too", hit.body.amounts?.salesInr === 4000 && hit.body.amounts.sales === 200 && r.lines[0]!.amountInr === 4000, j(hit.body));
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0 } }, config);
hit = hits.at(-1)!;
check("…one held with none: none sent, none kept", !("salesInr" in hit.body.amounts) && !("amountInr" in r.lines[0]!), j(hit.body));
const heldInr = new Types.ObjectId();
await CommissionSale.create({ student: heldInr, studentName: "Held in rupees", closer: ids.Ria, closerName: "Ria", team: TEAM, saleDate: new Date("2026-10-21T08:00:00Z"), month: "2026-10",
  state: "waiting", reason: "Gladiators has no leader", plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0, salesInr: 4000, tlInr: 0, smInr: 1500 }, lines: [] });
followNow();
await sweepCommission();
const settledInr = await CommissionSale.findOne({ student: heldInr }).lean();
check("a held sale settles with its rupee amounts kept on its lines and plan", settledInr?.state === "counted" && settledInr.lines[0]?.amountInr === 4000 && settledInr.lines[1]?.amountInr === undefined
  && settledInr.lines[2]?.amountInr === 1500 && settledInr.plan.salesInr === 4000, j(settledInr));

// A sale counted before the rupee amounts: the recount gives it Root's rupee amounts, and nothing else moves.
const { recountRupees, undoRecountRupees } = await import("../src/scripts/recountRupeeCommission.js");
const os = await import("node:os"), fs = await import("node:fs");
const oldSale = new Types.ObjectId();
await CommissionSale.create({ student: oldSale, studentName: "Counted before rupees", invoiceNumber: "IN-70001", course: MBT, courseName: "MBT", closer: ids.Ria, closerName: "Ria", team: TEAM,
  saleDate: new Date("2026-12-03T08:00:00Z"), month: "2026-12", state: "counted", plan: { sales: 230, tl: 85, sm: 100, creditUsd: 0 }, owedShare: 0,
  lines: [{ role: "sales", user: ids.Ria, userName: "Ria", amount: 230 }, { role: "tl", user: ids.Lena, userName: "Lena", amount: 0, note: "Closed it themselves" }, { role: "sm", user: ids.Abrar, userName: "Abrar", amount: 100 }],
  collections: [{ paidAt: new Date("2026-12-03T08:00:00Z"), share: 1, inr: true }] });
const oldNow = () => CommissionSale.findOne({ student: oldSale }).lean();
const inrOf = (s: Awaited<ReturnType<typeof oldNow>>) => (s?.lines ?? []).map((l) => `${l.role}:${l.amount}:${l.amountInr ?? "-"}`).join(" ");
let rc = await recountRupees({ month: "2026-12", write: false });
check("the recount, looking only: one sale to give rupee amounts, nothing written", rc.count === 1 && inrOf(await oldNow()) === "sales:230:- tl:0:- sm:100:-" && /100% paid in rupees/.test(rc.lines.join("\n")), rc.lines.join(" | "));
const undoFile = `${os.tmpdir()}/recount-rupee-check-${Date.now()}.json`;
rc = await recountRupees({ month: "2026-12", write: true, undoFile });
let oldDoc = await oldNow();
check("…written: Root's rupee amounts on the lines — the AED amounts as counted, a line that paid nothing still nothing", rc.count === 1 && inrOf(oldDoc) === "sales:230:5000 tl:0:- sm:100:2500"
  && oldDoc?.plan.sales === 230 && oldDoc.plan.salesInr === 5000 && oldDoc.plan.smInr === 2500 && oldDoc.lines[1]?.note === "Closed it themselves", j(oldDoc));
check("…again: nothing left to change", (await recountRupees({ month: "2026-12", write: true, undoFile })).count === 0);
const undone = await undoRecountRupees(undoFile);
oldDoc = await oldNow();
check("…undone: the sale exactly as it was", undone === 1 && inrOf(oldDoc) === "sales:230:- tl:0:- sm:100:-" && oldDoc?.plan.salesInr === undefined, j(oldDoc));
fs.unlinkSync(undoFile);
await CommissionSale.deleteOne({ student: oldSale });
answer.resolve = plainResolve;

const held = new Types.ObjectId();
await CommissionSale.create({ student: held, studentName: "Held", closer: ids.Ria, closerName: "Ria", team: TEAM, saleDate: new Date("2026-10-20T08:00:00Z"), month: "2026-10",
  state: "waiting", reason: "Gladiators has no leader", plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0 }, lines: [] });
const before = hits.length;
followNow();
await sweepCommission();
const settled = await CommissionSale.findOne({ student: held }).lean();
check("a held sale settles with Root's answer, at its held amounts", settled?.state === "counted" && settled.lines.map((l) => l.amount).join() === "200,70,90"
  && hits.slice(before).some((h) => h.body?.amounts?.sales === 200), j(settled));

forgetRootPlan();
answer.plan = {
  portal: PORTAL, tlRule: TL_RULE, tlSlab: true, tlPaidOnOwnClose: false,
  salesManager: { id: String(ids.Lena), name: "Lena" }, excluded: [{ id: String(ids.Shared), name: "Shared" }, { id: String(ids.Abrar), name: "Abrar" }],
  courses: [{ courseId: String(MBT), name: "MBT", sales: 250, tl: 90, sm: 100, creditUsd: 500 }, { courseId: String(new Types.ObjectId()), name: "Gone", sales: 1, tl: 1, sm: 1, creditUsd: 0 }],
  month: "2026-10", slabsFrom: "2000-01",
  slabs: { sales: [{ name: "Base", target: 0, salary: 2600, percent: 0 }], tl: [{ name: "Base", target: 0, salary: 4100, percent: 50 }], sm: [{ name: "Base", target: 0, salary: 5100, percent: 50 }] },
};
const rootRow = { user: String(ids.Ria), name: "Ria", role: "sales", teams: [], sales: { count: 1, value: 15000, fee: 15000 }, awaitingFinance: { count: 0, value: 0 },
  level: { name: "D", target: 15000, salary: 2500, percent: 50, index: 2 }, next: null, salary: 2500, percent: 50,
  commission: { earned: 250, balance: 0, payable: 125, notCountedYet: 0 }, total: 2625 };
answer.pay = { month: "2026-10", slabsFrom: "2000-01", slabs: answer.plan.slabs, people: [rootRow] };
const slabs = await slabsFor("2026-10");
check("the slabs are Root's (built-in there: no month)", slabs.from === null && slabs.slabs.sales[0]?.salary === 2600, j(slabs));
answer.plan = { ...answer.plan, tlSlab: false, month: "2026-09" };
forgetRootPlan();
check("…a CRM with no TL slab (Draw, Remote) gets none", !("tl" in (await slabsFor("2026-09")).slabs));
answer.plan = { ...answer.plan, tlSlab: true, month: "2026-11", slabsFrom: "2026-11" };
forgetRootPlan();
check("…a month Root changed them in is given", (await slabsFor("2026-11")).from === "2026-11");
const rows = await payRows("2026-10", ownSlabs.slabs);
check("My Pay is Root's — what finance's payable reads too", rows.length === 1 && rows[0]!.commission.payable === 125 && rows[0]!.level.name === "D"
  && hits.at(-1)!.path === "/api/v1/service/commission/pay" && hits.at(-1)!.query.month === "2026-10", j(rows));
const pay = await new SalaryService().getPay({ userId: String(ids.Ria), role: superRole } as never, "2026-10");
check("…the My Pay page: her row and Root's slabs", pay.me?.total === 2625 && (pay.slabs as any).sales[0].salary === 2600, j(pay.me));

const changed = await mirrorRootPlan("2026-10");
const settings = await db.collection("commissionsettings").findOne({ key: "default" });
const mbt = await db.collection("courses").findOne({ _id: MBT });
check("Root's plan copied in: the Sales Manager, who earns nothing, MBT's amounts", String(settings?.salesManager) === String(ids.Lena)
  && (settings?.excludedUsers ?? []).map(String).sort().join() === [String(ids.Shared), String(ids.Abrar)].sort().join()
  && mbt?.commission?.sales === 250 && mbt.commission.tl === 90 && changed.length === 2, j({ changed, settings, mbt: mbt?.commission }));
const dwt = await db.collection("courses").findOne({ _id: DWT });
check("…a course Root doesn't list is left as it is; one Root lists that isn't here is skipped", dwt?.commission?.sales === 500 && !changed.includes("Gone"), j(changed));
check("…a second copy changes nothing", (await mirrorRootPlan("2026-10")).length === 0);
config = await loadConfig();
check("…and the CRM's settings now read Root's Sales Manager", String(config.salesManager) === String(ids.Lena));
answer.plan = { ...answer.plan, salesManager: { id: String(ids.Abrar), name: "Abrar" } };
followNow();
const planHits = hits.filter((h) => h.path.endsWith("/plan")).length;
await sweepCommission();
check("the sweep copies Root's plan in (every five minutes)", hits.filter((h) => h.path.endsWith("/plan")).length === planHits + 1
  && String((await db.collection("commissionsettings").findOne({ key: "default" }))?.salesManager) === String(ids.Abrar));

section("3. Root unreachable, refusing, not set up, or answering for another CRM");
const mine = answer.plan;
answer.plan = { ...mine, portal: PORTAL === "remote" ? "delta" : "remote", salesManager: { id: String(new Types.ObjectId()), name: "Another CRM's manager" } };
forgetRootPlan();
let err: Awaited<ReturnType<typeof fails>>;
const settingsBefore = JSON.stringify(await db.collection("commissionsettings").findOne({ key: "default" }));
err = await fails(resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf(null), course: MBT }, config));
check("Root answering for another CRM: who earns what refused, saying the secret is mixed up", !!err && /answered for the \w+ CRM, not this one/.test(err.message) && /ROOT_ORG_SECRET/.test(err.message), j(err));
check("…My Pay refused too", /answered for the/.test((await fails(payRows("2026-10", ownSlabs.slabs)))?.message ?? ""));
check("…its plan not copied in: the settings as they were", /answered for the/.test((await fails(mirrorRootPlan("2026-11")))?.message ?? "")
  && JSON.stringify(await db.collection("commissionsettings").findOne({ key: "default" })) === settingsBefore);
answer.plan = mine;
forgetRootPlan();
answer.status = 503;
err = await fails(resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf(null), course: MBT }, config));
check("Root down: who earns what fails, clearly", !!err && /Root couldn't work out the commission/.test(err.message) && err.statusCode === 502, j(err));
const held2 = new Types.ObjectId();
await CommissionSale.create({ student: held2, studentName: "Held 2", closer: ids.Ria, closerName: "Ria", team: TEAM, saleDate: new Date("2026-10-21T08:00:00Z"), month: "2026-10",
  state: "waiting", reason: "Gladiators has no leader", plan: { sales: 230, tl: 85, sm: 100, creditUsd: 0 }, lines: [] });
followNow();
await sweepCommission();
check("…a held sale is left as it was, to be tried again", (await CommissionSale.findOne({ student: held2 }).lean())?.state === "waiting");
err = await fails(new SalaryService().getPay({ userId: String(ids.Ria), role: superRole } as never, "2026-10"));
check("…My Pay says Root can't give it — no old figures", !!err && /Root couldn't/.test(err.message), j(err));
answer.status = 409;
err = await fails(payRows("2026-10", ownSlabs.slabs));
check("the plan not in Root yet → a clear error", !!err && /not been copied/.test(err.message) && err.statusCode === 503, j(err));
answer.status = 200;
process.env.ROOT_ORG_SECRET = "a-wrong-secret";
err = await fails(resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf(null), course: MBT }, config));
check("a wrong secret → refused", !!err && /Invalid service credential/.test(err.message), j(err));
delete process.env.ROOT_ORG_SECRET;
err = await fails(payRows("2026-10", ownSlabs.slabs));
check("on, but Root not set up here → says what to set", !!err && /ROOT_ERP_API_URL and ROOT_ORG_SECRET/.test(err.message), j(err));

section("4. Off again: back to this CRM's own");
process.env.COMMISSION_FROM_ROOT = "off";
const n = hits.length;
r = await resolveSale({ closer: ids.Ria, saleTeam: TEAM, plan: planOf({ commission: { sales: 230, tl: 85, sm: 100 } }), course: MBT }, await loadConfig());
check("who earns what is the CRM's own again (Root's Sales Manager copied in stays)", r.state === "counted" && !r.plan && hits.length === n, j(r));
check("…its slabs too", (await slabsFor("2026-10")).slabs.sales[0]?.salary === 2000 && hits.length === n);

console.log(`\n${checks - failures}/${checks} checks passed`);
rootApi.close();
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
