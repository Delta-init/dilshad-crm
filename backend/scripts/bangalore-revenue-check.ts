/**
 * Checks that a Bangalore enrolment's money counts in the revenue figures (2026-10-28, utils/bangaloreRevenue.ts) on
 * a scratch database: rupees at the Settings rate, a payment in another currency by its rupee figure, the AED cash a
 * close put on the lead once (on the lead and on the enrolment), the payment already on the lead before the close
 * once, a dropped enrolment not at all, an older close with no payment list by its paid amount — on the leaderboard
 * (and so the Sales TV), the Reports (revenue overview, timeline, team revenue, user and team rankings, sources), the
 * team pages, a user's own revenue and a new rate. Nothing stored changes.
 *
 * Run by bangalore-revenue-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, JWT_SECRET: "blr-check-jwt", JWT_REFRESH_SECRET: "blr-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false" });

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { LeaderboardService } = await import("../src/services/leaderboardService.js");
const { ReportService } = await import("../src/services/reportService.js");
const { TeamService } = await import("../src/services/teamService.js");
const { salesTv } = await import("../src/services/salesTvService.js");
const { getUserRevenue } = await import("../src/controllers/leadController.js");
const { updateAppSettings, getAppSettings } = await import("../src/services/settingsService.js");
const { updateAppSettingsSchema } = await import("../src/validations/settingsValidation.js");

const id = () => new Types.ObjectId();
const now = new Date(Date.now() - 60_000);
const lastMonth = new Date(Date.now() - 40 * 86_400_000);
const role = id(), ria = id(), ben = id(), team = id();
const [l1, l2, l3, l4, l5] = [id(), id(), id(), id(), id()];

await db.collection("roles").insertOne({ _id: role, roleName: "Sales", isSystemRole: false, permissions: [] });
await db.collection("users").insertMany([
  { _id: ria, name: "Ria", email: "ria@scratch.test", status: "active", role },
  { _id: ben, name: "Ben", email: "ben@scratch.test", status: "active", role },
]);
await db.collection("teams").insertOne({ _id: team, name: "TEAM A", status: "active", members: [ria, ben], leaders: [] });
const lead = (_id: Types.ObjectId, who: Types.ObjectId, payments: unknown[] = []) =>
  ({ _id, name: `Lead ${_id}`, phone: `+9715${String(_id).slice(-8)}`, status: "closed", source: "facebook", assignedTo: who, team, createdAt: now, payments });
await db.collection("leads").insertMany([
  lead(l1, ria, [
    // On the lead before the Bangalore close (collectedBefore on the enrolment)
    { amount: 200, paidAt: now, note: "Advance" },
    // The AED cash the close put on the lead (leadPaymentOf / leadAmountOf)
    { amount: 100, paidAt: now, note: "Collected at enrolment — Course · Cash · Bangalore · AED 100 at 1 AED = 22.75 INR", method: "cash" },
  ]),
  lead(l2, ben, [{ amount: 1000, paidAt: now, note: "Collected at enrolment — Course · Cash" }]),
  lead(l3, ben),
  lead(l4, ria),
  lead(l5, ria),
]);
const student = (leadId: Types.ObjectId, who: Types.ObjectId, extra: Record<string, unknown>) =>
  ({ _id: id(), leadId, assignedTo: who, team, name: "S", enrollmentNumber: `E-${leadId}`, status: "active", enrollmentDate: now, createdAt: now, ...extra });
await db.collection("students").insertMany([
  student(l1, ria, {
    academy: "bangalore", totalFee: 200000, paidAmount: 74825,
    payments: [
      { method: "bank_transfer", amount: 45500, paidAt: now },                                                          // ₹45,500 → AED 2,000
      { method: "card", amount: 22750, paidAt: now, currency: "USD", amountInCurrency: 272.5, exchangeRate: 83.48624 }, // ₹22,750 → AED 1,000
      { method: "cash", amount: 2275, paidAt: now, currency: "AED", amountInCurrency: 100, exchangeRate: 22.75 },        // AED 100 — on the lead
      { method: "cash", amount: 4550, paidAt: now, collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.75 },
    ],
  }),
  student(l2, ben, { academy: "dubai", totalFee: 1000, paidAmount: 1000, payments: [{ method: "cash", amount: 1000, paidAt: now }] }),
  student(l3, ben, { academy: "bangalore", status: "dropped", paidAmount: 22750, payments: [{ method: "upi", amount: 22750, paidAt: now }] }),
  student(l4, ria, { academy: "bangalore", enrollmentDate: lastMonth, paidAmount: 22750, payments: [{ method: "upi", amount: 22750, paidAt: lastMonth }] }),
  student(l5, ria, { academy: "bangalore", paidAmount: 11375 }), // a close that sent no list
]);

const board = async () => new Map((await new LeaderboardService().getLeaderboard()).rows.map((r) => [r.name, r.revenue]));

section("Leaderboard (and so the Sales TV / Manager TV)");
let b = await board();
check("Ria: 200 + AED 100 cash on the lead + ₹45,500 → 2,000 + USD paid ₹22,750 → 1,000 + no-list close ₹11,375 → 500 = 3,800", b.get("Ria") === 3800, b.get("Ria"));
check("Ben: his Dubai 1,000 only — the dropped Bangalore enrolment not counted", b.get("Ben") === 1000, b.get("Ben"));
const tv = await salesTv({});
check("Sales TV revenueMonth for Ria is 3,800", tv.people?.find((p) => p.name === "Ria")?.revenueMonth === 3800, tv.people);

section("Reports");
const rs = new ReportService();
const ov = await rs.getRevenueOverview();
check("Revenue overview total 5,800 (all time: + last month's ₹22,750 → 1,000)", ov.totalRevenue === 5800, ov.totalRevenue);
check("7 payments counted (3 on leads, 4 from Bangalore enrolments — the AED cash once)", ov.paymentCount === 7, ov.paymentCount);
check("4 paying leads (a lead with its own and Bangalore money once)", ov.payingLeadCount === 4, ov.payingLeadCount);
check("Top agent Ria 4,800", ov.topAgent?.name === "Ria" && ov.topAgent.revenue === 4800, ov.topAgent);
const tl = await rs.getRevenueTimeline("monthly");
const tlTotal = tl.timeline.reduce((s: number, r: Record<string, unknown>) => s + (r.total as number), 0);
check("Revenue timeline adds to 5,800", tlTotal === 5800, tl.timeline);
const rt = await rs.getRevenueTeams();
const rtTotal = (rt as unknown as { revenue?: number }[]).reduce((s, t) => s + (t.revenue ?? 0), 0);
check("Revenue by team adds to 5,800", rtTotal === 5800, rt);
const tr = await rs.getTeamRevenue(String(team));
check("Team revenue 5,800", tr.totalRevenue === 5800, tr.totalRevenue);
const ttl = await rs.getTeamRevenueTimeline(String(team), "monthly");
const ttlTotal = (ttl.timeline as Record<string, unknown>[]).reduce((s, r) => s + (r.total as number), 0);
check("Team revenue timeline adds to 5,800", ttlTotal === 5800, ttl.timeline);
const ranks = await rs.getUserRankings();
const rank = new Map(ranks.map((r) => [r.name as string, r.revenue as number]));
check("User rankings: Ria 4,800, Ben 1,000", rank.get("Ria") === 4800 && rank.get("Ben") === 1000, Object.fromEntries(rank));
const teamRanks = await rs.getTeamRankings();
check("Team rankings: TEAM A 5,800", (teamRanks as { name?: string; totalPayments?: number }[]).find((t) => t.name === "TEAM A")?.totalPayments === 5800, teamRanks);
const sources = await rs.getSourceAnalytics();
check("Source analytics: facebook 5,800", sources.find((s) => s.source === "facebook")?.revenue === 5800, sources);

section("Team pages");
const ts = new TeamService();
const split = await ts.getTeamMemberSplit(String(team));
check("Member split: Ria 4,800", split.find((r) => r.name === "Ria")?.revenue === 4800, split);
const dash = await ts.getTeamDashboard(String(team));
check("Team dashboard: Ria 4,800 total payments", dash.memberRankings.find((m) => (m.user as { name?: string }).name === "Ria")?.totalPayments === 4800, dash.memberRankings.map((m) => m.totalPayments));
const member = await ts.getTeamMemberById(String(team), String(ria), String(id()), { isSystemRole: true, roleName: "Super Admin" });
check("Team member page: Ria 4,800 total payments", member.stats.totalPayments === 4800, member.stats.totalPayments);

section("A user's own revenue");
let body: { data?: { totalRevenue?: number; paymentCount?: number; leadCount?: number } } = {};
const res = { status() { return res; }, json(v: typeof body) { body = v; return res; } };
let failed: unknown = null;
await getUserRevenue({ params: { userId: String(ria) }, query: {} } as never, res as never, ((e: unknown) => { failed = e; }) as never);
check("Ria all time: 4,800 from 6 payments on 3 leads", body.data?.totalRevenue === 4800 && body.data.paymentCount === 6 && body.data.leadCount === 3, failed ?? body.data);

section("A new rate");
check("Default rate 22.75", (await getAppSettings()).bangaloreRevenue.inrPerAed === 22.75);
check("Rate 0 refused", !updateAppSettingsSchema.safeParse({ bangaloreRevenue: { inrPerAed: 0 } }).success);
check("Rate 45.5 accepted", updateAppSettingsSchema.safeParse({ bangaloreRevenue: { inrPerAed: 45.5 } }).success);
await updateAppSettings({ bangaloreRevenue: { inrPerAed: 45.5 } }, String(ria));
check("Rate saved as 45.5", (await getAppSettings()).bangaloreRevenue.inrPerAed === 45.5);
b = await board();
check("At 45.5: Ria 200 + 100 + 1,000 + 500 + 250 = 2,050 (the AED cash stays 100)", b.get("Ria") === 2050, b.get("Ria"));

section("Nothing stored changed");
const l1Doc = await db.collection("leads").findOne({ _id: l1 });
check("Ria's lead still has its two payments", l1Doc?.payments?.length === 2, l1Doc?.payments);
check("No other lead got payments", (await db.collection("leads").countDocuments({ _id: { $in: [l3, l4, l5] }, "payments.0": { $exists: true } })) === 0);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
