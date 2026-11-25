/**
 * Finance's old books counted for their salesperson (the user, 2026-11-25), on a scratch database, against a
 * stand-in finance:
 *
 *   - Case 1: revenue — the old books' payments from 1 Nov on count for the user whose email finance has, on the day
 *     paid (leaderboard, closedBy); October money and a salesperson who isn't a user here count nowhere; a read-only
 *     pass writes nothing.
 *   - Case 2: commission — only once the invoice is paid in full with its last payment from 1 Nov on: a sale earned
 *     whole that month at the plan of the course matched by name (MBT → "Market Breakout Theory"; Digital Marketing
 *     → its course, plan 0 here); paid in full in October, or still owing: none; the sweeps leave it alone.
 *   - Case 3: later passes — the still-owing one paid in full is counted then, once; run again: nothing new; voided
 *     in finance: the sale taken back and its money off the figures; finance away: the tick carries on.
 *
 * Run by old-books-check.sh. Scratch database only.
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

/* ── A stand-in finance: the old books' list ── */
const SECRET = "old-books-check-secret-long-enough";
let invoices: any[] = [];
let away = false;
let asked = 0;
const { signRequest } = await import("../src/utils/signing.js");
const fin = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const ts = req.headers.get("x-delta-timestamp") ?? "", nonce = req.headers.get("x-delta-nonce") ?? "";
    if (req.headers.get("x-delta-signature") !== signRequest(SECRET, req.method, url.pathname + url.search, ts, nonce, "")) {
      return Response.json({ error: { message: "Bad signature" } }, { status: 401 });
    }
    if (away) return Response.json({ error: { message: "down" } }, { status: 503 });
    if (url.pathname === "/api/v1/integrations/old-books/payments") {
      asked++;
      const from = url.searchParams.get("from") ?? "";
      return Response.json({ data: invoices.filter((i) => i.payments.some((p: any) => p.paidOn >= from)) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "old-books-check-jwt", JWT_REFRESH_SECRET: "old-books-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", COMMISSION_FROM_ROOT: "",
  FINANCE_API_URL: `http://127.0.0.1:${fin.port}`, FINANCE_CLIENT_ID: "remote-crm-check", FINANCE_INTEGRATION_SECRET: SECRET,
  FINANCE_ORG_ID: "org-dubai", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
await import("../src/models/Role.js");
const { syncOldBooks, oldBooksTick } = await import("../src/services/oldBooks.js");
const { OldBooksSale } = await import("../src/models/OldBooksSale.js");
const { CommissionSale } = await import("../src/models/CommissionSale.js");
const commission = await import("../src/services/commissionService.js");
const { LeaderboardService } = await import("../src/services/leaderboardService.js");
const { closedBy } = await import("../src/services/rewardsService.js");

// ── People, a team, the plan ────────────────────────────────────────────────
const superRole = { _id: new Types.ObjectId(), roleName: "Super Admin", isSystemRole: true };
const bdeRole = { _id: new Types.ObjectId(), roleName: "BDE", isSystemRole: false };
await db.collection("roles").insertMany([{ ...superRole, permissions: {} }, { ...bdeRole, permissions: {} }]);
const ids: Record<string, Types.ObjectId> = {};
for (const name of ["Admin", "Manager", "Tina", "Athira", "Gopika", "Theertha"]) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@e2e.test`, role: name === "Admin" ? superRole._id : bdeRole._id, status: "active" });
}
const T1 = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: T1, name: "Team One", status: "active", leaders: [ids.Tina], members: [ids.Athira, ids.Gopika, ids.Theertha] });
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Manager, excludedUsers: [] });
const MBT = new Types.ObjectId(), DM = new Types.ObjectId(), C1 = new Types.ObjectId();
await db.collection("courses").insertMany([
  { _id: C1, name: "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", commission: { sales: 230, tl: 85, sm: 100, creditUsd: 500 } },
  { _id: MBT, name: "Market Breakout Theory", commission: { sales: 100, tl: 40, sm: 50, creditUsd: 0 } },
  { _id: DM, name: "Digital Marketing Course", commission: {} },
]);
const viewer = { userId: String(ids.Admin), role: superRole } as never;
const svc = new commission.CommissionService();

// ── Finance's old books ──────────────────────────────────────────────────────
const oid = () => String(new Types.ObjectId());
const inv = (n: string, who: string, course: string, total: number, pays: [string, number][], status?: string) => {
  const paid = pays.reduce((s, p) => s + p[1], 0);
  return {
    invoiceId: oid(), invoiceNumber: n, organizationId: "org-dubai", customerName: `Client ${n}`, salespersonName: who,
    salespersonEmail: `${who.toLowerCase()}@e2e.test`, course, currency: "AED", issueDate: pays[0]![0], totalMinor: total * 100,
    balanceMinor: (total - paid) * 100, status: status ?? (paid >= total ? "paid" : "partial"),
    payments: pays.map(([d, a]) => ({ id: oid(), paidOn: d, amountMinor: a * 100, method: "billexpro" })),
  };
};
const A = inv("DMDT006238", "Athira", "Market Break-out Trading Program — (× 0.5)", 1200, [["2026-06-18", 600], ["2026-11-11", 600]]);
const B = inv("DMDT006460", "Gopika", "Digital Marketing — (× 0.5)", 1300, [["2026-07-06", 650], ["2026-11-06", 650]]);
const C = inv("DMDT005211", "Arya", "Delta Wave Theory Program — upgraded from MBT", 2500, [["2025-12-31", 1500], ["2026-11-04", 1000]]);
const D = inv("DMDT007000", "Theertha", "Market Break-out Trading Program — (× 0.5)", 1050, [["2026-09-30", 300], ["2026-11-24", 300]]);
const E = inv("DMDT006982", "Athira", "Market Break-out Trading Program — (× 0.5)", 599.5, [["2026-10-03", 599.5]]);
invoices = [A, B, C, D, E];

const board = async (month: string) => new Map((await new LeaderboardService().getLeaderboard(month)).rows.map((r) => [r.name, r.revenue]));
const earnings = async (month: string) => svc.getEarnings(viewer, month);
const personTotal = (e: any, name: string) => (e.people as any[]).find((p) => p.name === name)?.total ?? 0;

// ── Case 1 ───────────────────────────────────────────────────────────────────
section("Case 1 — revenue: old books' money from 1 Nov counts for its salesperson");
const dry = await syncOldBooks({ write: false });
check("a read-only pass reports and writes nothing", dry.invoices === 4 && (await OldBooksSale.countDocuments()) === 0 && (await CommissionSale.countDocuments()) === 0, j({ dry, n: await OldBooksSale.countDocuments() }));
check("it lists the salesperson who isn't a user here", dry.notHere.length === 1 && dry.notHere[0]!.invoice === "DMDT005211" && dry.notHere[0]!.paidAed === 1000, j(dry.notHere));
check("finance is asked from 1 Nov", asked === 1);

const r1 = await syncOldBooks();
check("the ones with November money are kept (4: one with no user here), October-only one left out", (await OldBooksSale.countDocuments()) === 4 && r1.kept === 3, j(r1));
const a = await OldBooksSale.findOne({ invoiceNumber: "DMDT006238" }).lean();
check("kept for Athira, in her team, only the November payment counts", String(a?.assignedTo) === String(ids.Athira) && String(a?.team) === String(T1) && a?.payments.length === 1 && a?.payments[0]?.amount === 600 && a?.allPayments.length === 2, j(a));
check("matched to the course 'Market Breakout Theory' by name", String(a?.courseRef) === String(MBT), j(a?.courseRef));
const nov = await board("2026-11");
check("leaderboard November: Athira 600, Gopika 650, Theertha 300", nov.get("Athira") === 600 && nov.get("Gopika") === 650 && nov.get("Theertha") === 300, j([...nov]));
const oct = await board("2026-10");
check("leaderboard October: nothing (October money isn't taken in)", !oct.get("Athira") && !oct.get("Gopika"), j([...oct]));
const jun = await board("2026-06");
check("leaderboard June: the old first payments aren't counted", !jun.get("Athira"), j([...jun]));
const { ReportService } = await import("../src/services/reportService.js");
const ob = await new ReportService().getOldBooks("2026-11-01", "2026-11-30");
check("Reports' old-books card: 3 payments, 1,550, with salesperson and invoice", ob.count === 3 && ob.total === 1550 && ob.rows.some((r) => r.invoiceNumber === "DMDT006238" && r.name === "Athira" && r.amount === 600), j(ob));
const rev = await new ReportService().getRevenueOverview("2026-11-01", "2026-11-30");
check("the Reports revenue overview counts them in", JSON.stringify(rev).includes("1550"), j(rev).slice(0, 300));
check("rewards/team totals (closedBy) take it too: 1,550 for the team", (await closedBy([ids.Athira, ids.Gopika, ids.Theertha], "2026-11")) === 1550);

// ── Case 2 ───────────────────────────────────────────────────────────────────
section("Case 2 — commission only once paid in full, from 1 Nov on");
const sa = await CommissionSale.findOne({ invoiceNumber: "DMDT006238" }).lean();
check("Athira's MBT (paid in full 11 Nov): a counted old-books sale", sa?.state === "counted" && sa?.oldBooks === true && String(sa?.student) === A.invoiceId, j(sa));
check("at the 'Market Breakout Theory' plan: Sales 100, TL 40, SM 50", j(sa?.lines.map((l) => [l.role, l.userName, l.amount])) === j([["sales", "Athira", 100], ["tl", "Tina", 40], ["sm", "Manager", 50]]), j(sa?.lines));
check("paid in full on 11 Nov, nothing owed", commission.paidInFullAt(sa as never)?.toISOString().slice(0, 10) === "2026-11-10" && sa?.owedShare === 0, String(commission.paidInFullAt(sa as never)?.toISOString()));
const sb = await CommissionSale.findOne({ invoiceNumber: "DMDT006460" }).lean();
check("Gopika's Digital Marketing: counted at 0 (no plan amounts yet)", sb?.state === "counted" && sb!.lines.every((l) => l.amount === 0), j(sb?.lines));
check("Theertha's (still owing) and the October one: no sale; Arya: no user, no sale", !(await CommissionSale.exists({ invoiceNumber: { $in: ["DMDT007000", "DMDT006982", "DMDT005211"] } })));
const eNov = await earnings("2026-11");
check("November earnings: Athira 100, Tina 40, Manager 50", personTotal(eNov, "Athira") === 100 && personTotal(eNov, "Tina") === 40 && personTotal(eNov, "Manager") === 50, j(eNov.people));
check("the earnings list marks it as old books", (eNov.sales as any[]).some((s) => s.invoiceNumber === "DMDT006238" && s.oldBooks === true), j(eNov.sales));
const eOct = await earnings("2026-10");
check("October earnings: nothing from it", personTotal(eOct, "Athira") === 0, j(eOct.people));
await commission.refreshPaidShares();
await commission.reverseVoidedSales();
await commission.sweepCommission();
const sa2 = await CommissionSale.findOne({ invoiceNumber: "DMDT006238" }).lean();
check("the commission sweeps leave it as it was", sa2?.state === "counted" && sa2?.owedShare === 0 && j(sa2?.collections) === j(sa?.collections), j(sa2));

// ── Case 3 ───────────────────────────────────────────────────────────────────
section("Case 3 — later passes, a void, finance away");
D.payments.push({ id: oid(), paidOn: "2026-11-25", amountMinor: 45000, method: "billexpro" });
D.balanceMinor = 0; D.status = "paid";
await syncOldBooks();
const sd = await CommissionSale.findOne({ invoiceNumber: "DMDT007000" }).lean();
check("Theertha's paid in full on 25 Nov: counted then", sd?.state === "counted" && sd?.lines.find((l) => l.role === "sales")?.amount === 100, j(sd));
check("its November money now 750", (await board("2026-11")).get("Theertha") === 750);
await syncOldBooks();
check("run again: still one sale per invoice", (await CommissionSale.countDocuments({ oldBooks: true })) === 3, String(await CommissionSale.countDocuments({ oldBooks: true })));
A.status = "void";
await syncOldBooks();
const sv = await CommissionSale.findOne({ invoiceNumber: "DMDT006238" }).lean();
check("voided in finance: the sale taken back", sv?.state === "reversed" && /voided/.test(sv?.reason ?? ""), j(sv));
check("and its money off the leaderboard", !(await board("2026-11")).get("Athira"));
check("November earnings without it", personTotal(await earnings("2026-11"), "Athira") === 0);
away = true;
let threw = false;
try { await oldBooksTick(); } catch { threw = true; }
check("finance away: the tick doesn't throw, and what was kept stays", !threw && (await OldBooksSale.countDocuments()) === 4);

console.log(`\n${checks - failures}/${checks} checks passed`);
fin.stop(true);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
