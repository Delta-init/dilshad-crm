/**
 * Checks the Root portal's Sales TV feed — GET /api/v1/service/sales-tv (2026-10-20) — on a scratch database:
 *
 *   - the shape, exactly the Sales CRM's: { crm: "remote", generatedAt, month, onBreak, closes, people };
 *   - people: only the sales staff — members and leaders of an active team, active — a Super Admin only when in a team (sent again
 *     2026-10-23: Root hides them on its Sales TV, shows them on its Manager TV); not someone
 *     in no team, not a deactivated person, not someone in an inactive team only, not the commission plan's excluded;
 *     their team; closings this month and today (the Dubai day; a dropped one and last month's left out); revenue this
 *     month; today's 3CX calls, connected and talk time (yesterday's left out);
 *   - onBreak: who pressed "Take break" today, since when, what for — a break left on from yesterday not shown;
 *   - closes: the last two hours by default, after `after` when given (never more than a day back), newest first, at
 *     most 20, dropped ones left out; the amount in the academy's currency (Dubai AED, Bangalore INR); never the
 *     student's name;
 *   - parts=live: only onBreak and closes;
 *   - the route refuses without Root's secret, or with a wrong one.
 *
 * Run by sales-tv-check.sh. Scratch database only.
 */
import { Types } from "mongoose";
import type { SalesTv } from "../src/services/salesTvService.js";

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
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
const SECRET = "sales-tv-check-root-secret-0123456789";
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "sales-tv-check-jwt", JWT_REFRESH_SECRET: "sales-tv-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", ROOT_ERP_SECRET: SECRET,
  HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { dubaiMonthRange } = await import("../src/services/leaderboardService.js");
const { gstMidnight } = await import("../src/services/breakClock.js");

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
async function tv(query = "", secret: string | null = SECRET): Promise<{ status: number; body: { data: SalesTv; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/service/sales-tv${query}`, { headers: secret === null ? {} : { "x-portal-secret": secret } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data: SalesTv; message: string } };
}

/* ── Time: the real clock (the feed reads it) ── */
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000);
const midnight = gstMidnight(new Date(NOW));
// Today in Dubai, a moment ago — never before today's midnight.
const TODAY = new Date(Math.max(NOW - 60_000, midnight.getTime() + 1000));
const month = dubaiMonthRange();
// Earlier this month but not today, when the month has such a day (not on the 1st).
const EARLIER = midnight.getTime() - month.from.getTime() >= 86_400_000 ? new Date(month.from.getTime() + 3_600_000) : null;
const LAST_MONTH = new Date(month.from.getTime() - 86_400_000);
const YESTERDAY = new Date(midnight.getTime() - 3 * 3_600_000);

/* ── People, roles, teams ── */
const role = { superAdmin: new Types.ObjectId(), staff: new Types.ObjectId() };
await db.collection("roles").insertMany([
  { _id: role.superAdmin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: role.staff, roleName: "Sales Staff", isSystemRole: false, permissions: {} },
]);
const ids: Record<string, Types.ObjectId> = {};
async function person(name: string, r: Types.ObjectId, extra: Record<string, unknown> = {}) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@test.local`, password: "x", role: r, status: "active", breakSince: null, breakKind: null, ...extra });
}
await person("Admin", role.superAdmin); // leads Alpha (as dilshad leads REMOTE TEAM): sent (Root decides where he shows, 2026-10-23)
await person("Root", role.superAdmin); // in no team: not
await person("Ann", role.staff, { breakSince: ago(10), breakKind: "tea" });
await person("Ben", role.staff, { breakSince: YESTERDAY, breakKind: "lunch" });
await person("Cal", role.staff);
await person("Nora", role.staff); // in no team
await person("Olly", role.staff, { status: "inactive" }); // deactivated, still in a team
await person("Exa", role.staff); // excluded from commission
await person("Dee", role.staff); // only in an inactive team
const team = { Alpha: new Types.ObjectId(), Beta: new Types.ObjectId(), Dead: new Types.ObjectId() };
const teamDoc = (_id: Types.ObjectId, name: string, leaders: string[], members: string[], status = "active") => ({
  _id, name, leaders: leaders.map((n) => ids[n]), members: members.map((n) => ids[n]), inactiveMembers: [], absentToday: [], status,
  settings: { autoAssign: false }, createdAt: new Date(), updatedAt: new Date(),
});
await db.collection("teams").insertMany([
  teamDoc(team.Alpha, "Alpha", ["Admin"], ["Ann", "Olly", "Exa"]),
  teamDoc(team.Beta, "Beta", ["Ben"], ["Cal"]),
  teamDoc(team.Dead, "Dead", [], ["Dee"], "inactive"),
]);
await db.collection("commissionsettings").insertOne({ excludedUsers: [ids.Exa], createdAt: new Date(), updatedAt: new Date() });

/* ── Courses, closes, payments, calls ── */
const course = { fx: new Types.ObjectId(), algo: new Types.ObjectId() };
await db.collection("courses").insertMany([
  { _id: course.fx, name: "Forex Mastery", status: "active" },
  { _id: course.algo, name: "Algo Trading", status: "active" },
]);
let seq = 0;
function close(o: { owner: string | null; createdAt: Date; enrollmentDate?: Date; course?: Types.ObjectId; fee?: number; academy?: string; status?: string; name?: string }) {
  seq++;
  return {
    _id: new Types.ObjectId(), enrollmentNumber: `ENR-${String(seq).padStart(4, "0")}`, name: o.name ?? `Secret Student ${seq}`,
    phone: `+9715${String(20_000_000 + seq)}`, email: `student${seq}@test.local`, course: o.course ?? course.fx, team: team.Alpha,
    assignedTo: o.owner ? ids[o.owner] : null, leadId: new Types.ObjectId(), enrollmentDate: o.enrollmentDate ?? o.createdAt,
    feeStatus: "partial", totalFee: o.fee ?? 5000, paidAmount: 1000, pendingAmount: (o.fee ?? 5000) - 1000,
    ...(o.academy ? { academy: o.academy } : {}), status: o.status ?? "active", createdAt: o.createdAt, updatedAt: o.createdAt,
  };
}
const C = {
  old3h: close({ owner: "Ann", createdAt: ago(180), enrollmentDate: TODAY }),
  b90: close({ owner: "Cal", createdAt: ago(90), enrollmentDate: TODAY, course: course.algo, fee: 7300 }),
  c10: close({ owner: "Ann", createdAt: ago(10), enrollmentDate: TODAY, academy: "bangalore", fee: 250000 }),
  noOwner: close({ owner: null, createdAt: ago(20), enrollmentDate: TODAY }),
  dropped: close({ owner: "Ann", createdAt: ago(5), enrollmentDate: TODAY, status: "dropped" }),
  day30h: close({ owner: "Cal", createdAt: ago(30 * 60), enrollmentDate: ago(30 * 60) }),
  lastMonth: close({ owner: "Ann", createdAt: LAST_MONTH }),
  ...(EARLIER ? { earlier: close({ owner: "Ann", createdAt: EARLIER }) } : {}),
};
await db.collection("students").insertMany(Object.values(C));
// Revenue: payments on the leads each person holds, dated this month.
await db.collection("leads").insertMany([
  { _id: new Types.ObjectId(), name: "Paying lead", phone: "+971500000001", status: "closed", assignedTo: ids.Ann, payments: [
    { _id: new Types.ObjectId(), amount: 1500, paidAt: TODAY }, { _id: new Types.ObjectId(), amount: 999, paidAt: LAST_MONTH }] },
]);
// 3CX calls with leads (lead_calls), by the call's person.
let k = 0;
const call = (who: string, startedAt: Date, status: string, talkSeconds: number) => ({
  _id: new Types.ObjectId(), key: `c-${++k}`, callId: String(k), segmentId: "", startedAt, direction: "out", status, answered: status === "answered", talkSeconds, ringSeconds: 5,
  number: "971500000000", numberKey: "500000000", extension: "101", agentName: "", recordingIds: [], rows: 1, lead: new Types.ObjectId(), leadName: "", user: ids[who], userName: who,
  syncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
});
await db.collection("lead_calls").insertMany([
  call("Ann", TODAY, "answered", 100),
  call("Ann", TODAY, "answered", 200),
  call("Ann", TODAY, "no_answer", 0),
  call("Ann", YESTERDAY, "answered", 999),
  call("Cal", TODAY, "answered", 60),
]);

/* ═══ The full answer ═══ */
section("The full answer — its shape");
const full = await tv();
const d = full.body.data;
check("200 with Root's secret", full.status === 200, full.status);
same("top-level keys, exactly the Sales CRM's", Object.keys(d ?? {}).sort(), ["closes", "crm", "generatedAt", "month", "onBreak", "people"]);
check("crm: remote", d.crm === "remote", d.crm);
check("generatedAt: now", Math.abs(Date.parse(d.generatedAt) - Date.now()) < 60_000, d.generatedAt);
check("month: this Dubai month", d.month === month.month, d.month);
same("a person's keys", Object.keys(d.people?.[0] ?? {}).sort(),
  ["callsToday", "closingsMonth", "closingsToday", "connectedToday", "email", "id", "name", "revenueMonth", "talkSecondsToday", "team"]);
same("a break's keys", Object.keys(d.onBreak[0] ?? {}).sort(), ["email", "id", "kind", "name", "since", "team"]);
same("a close's keys", Object.keys(d.closes[0] ?? {}).sort(), ["academy", "amount", "at", "closer", "closerEmail", "courses", "currency", "id"]);

section("People — only the sales staff");
const names = (d.people ?? []).map((p) => p.name).sort();
same("Admin (a Super Admin leading a team — dilshad, sent again 2026-10-23), Ann, Ben, Cal — not the Super Admin in no team, nobody in no team, nobody deactivated, nobody in an inactive team only, not the excluded", names, ["Admin", "Ann", "Ben", "Cal"]);
{
  const { LeaderboardService } = await import("../src/services/leaderboardService.js");
  const own = (await new LeaderboardService().getLeaderboard()).rows.map((r) => r.name);
  same("the CRM's own leaderboard still leaves every Super Admin out", own.filter((n) => n === "Admin" || n === "Root"), []);
}
const P = (n: string) => (d.people ?? []).find((p) => p.name === n);
check("each with their team and email", P("Ann")?.team === "Alpha" && P("Ben")?.team === "Beta" && P("Cal")?.team === "Beta" && P("Ann")?.email === "ann@test.local", d.people);
check("each with their id", P("Ann")?.id === String(ids.Ann), P("Ann"));
// Ann: old3h, c10 today (dropped not, last month not), and the earlier-this-month one when the month has one.
same("Ann's closings: this month and today (a dropped one and last month's left out)", [P("Ann")?.closingsMonth, P("Ann")?.closingsToday], [EARLIER ? 3 : 2, 2]);
const calMonth = C.day30h.enrollmentDate >= month.from ? 2 : 1;
const calToday = C.day30h.enrollmentDate >= midnight ? 2 : 1;
same("Cal's closings: this month and today (yesterday's not today)", [P("Cal")?.closingsMonth, P("Cal")?.closingsToday], [calMonth, calToday]);
same("Ben: none", [P("Ben")?.closingsMonth, P("Ben")?.closingsToday, P("Ben")?.callsToday, P("Ben")?.revenueMonth], [0, 0, 0, 0]);
check("Ann's revenue this month: 1,500 (last month's 999 not)", P("Ann")?.revenueMonth === 1500, P("Ann")?.revenueMonth);
same("Ann's calls today: 3, 2 connected, 300 s talk (yesterday's not)", [P("Ann")?.callsToday, P("Ann")?.connectedToday, P("Ann")?.talkSecondsToday], [3, 2, 300]);
same("Cal's calls today: 1, 1, 60 s", [P("Cal")?.callsToday, P("Cal")?.connectedToday, P("Cal")?.talkSecondsToday], [1, 1, 60]);
check("ordered by closings this month first", d.people?.[0]?.name === "Ann", d.people?.map((p) => p.name));

section("A Closed lead with no enrolment (2026-10-31: the AI Academy's students)");
await db.collection("leads").insertOne({
  _id: new Types.ObjectId(), name: "Academy student", phone: "+971500000002", status: "closed", assignedTo: ids.Ben,
  activityLogs: [{ action: "status_changed", changes: { status: { from: "assigned", to: "closed" } }, createdAt: TODAY }],
  payments: [{ _id: new Types.ObjectId(), amount: 2275, currency: "INR", paidAt: TODAY }],
});
{
  const again = (await tv()).body.data;
  const ben = (again.people ?? []).find((p) => p.name === "Ben");
  same("Ben: a closing this month and today; his ₹2,275 as AED 100", [ben?.closingsMonth, ben?.closingsToday, ben?.revenueMonth], [1, 1, 100]);
}

section("Who is on a break");
same("Ann only — Ben's break from yesterday is over", d.onBreak.map((b) => b.name), ["Ann"]);
check("since when, what for, her team and email", d.onBreak[0]?.since === ago(10).toISOString() && d.onBreak[0]?.kind === "tea" && d.onBreak[0]?.team === "Alpha" && d.onBreak[0]?.email === "ann@test.local", d.onBreak[0]);

section("Closes");
same("by default the last two hours, newest first, dropped left out", d.closes.map((c) => c.id), [String(C.c10._id), String(C.noOwner._id), String(C.b90._id)]);
const c10 = d.closes.find((c) => c.id === String(C.c10._id));
check("a Bangalore close: its fee in INR", c10?.amount === 250000 && c10?.currency === "INR" && c10?.academy === "bangalore", c10);
const b90 = d.closes.find((c) => c.id === String(C.b90._id));
check("a Dubai close (no academy said = Dubai): its fee in AED, its course, who closed it", b90?.amount === 7300 && b90?.currency === "AED" && b90?.academy === "dubai"
  && JSON.stringify(b90?.courses) === JSON.stringify(["Algo Trading"]) && b90?.closer === "Cal" && b90?.closerEmail === "cal@test.local", b90);
check("…when it was closed", b90?.at === ago(90).toISOString(), b90?.at);
const lone = d.closes.find((c) => c.id === String(C.noOwner._id));
check("a close with no salesperson: no closer, nothing made up", lone?.closer === "" && lone?.closerEmail === "", lone);
check("never the student's name, anywhere", !JSON.stringify(d).includes("Secret Student"), "a student's name is in the answer");

const after4h = (await tv(`?after=${encodeURIComponent(ago(240).toISOString())}`)).body.data;
same("after 4 hours ago: the 3-hour-old one too", after4h.closes.map((c) => c.id), [String(C.c10._id), String(C.noOwner._id), String(C.b90._id), String(C.old3h._id)]);
const after2d = (await tv(`?after=${encodeURIComponent(ago(48 * 60).toISOString())}`)).body.data;
check("after 2 days ago: never more than a day back — the 30-hour-old one not", after2d.closes.length === 4 && !after2d.closes.some((c) => c.id === String(C.day30h._id)), after2d.closes.map((c) => c.at));
const afterB = (await tv(`?after=${encodeURIComponent(ago(90).toISOString())}`)).body.data;
same("after the newest seen: only the ones since", afterB.closes.map((c) => c.id), [String(C.c10._id), String(C.noOwner._id)]);
const bad = await tv("?after=yesterday-ish");
check("an after that isn't a time: the last two hours", bad.status === 200 && bad.body.data.closes.length === 3, bad.body.data?.closes?.length);

section("parts=live — only the breaks and the closes");
const live = await tv(`?parts=live&after=${encodeURIComponent(ago(30).toISOString())}`);
same("keys: crm, generatedAt, onBreak, closes — no people, no month", Object.keys(live.body.data ?? {}).sort(), ["closes", "crm", "generatedAt", "onBreak"]);
same("…its closes after `after`, and who is on a break", [live.body.data.closes.map((c) => c.id), live.body.data.onBreak.map((b) => b.name)], [[String(C.c10._id), String(C.noOwner._id)], ["Ann"]]);
const ended = await db.collection("users").updateOne({ _id: ids.Ann }, { $set: { breakSince: null, breakKind: null } });
check("Ann ends her break → nobody on one", ended.modifiedCount === 1 && (await tv("?parts=live")).body.data.onBreak.length === 0);

section("The newest 20");
const many = Array.from({ length: 23 }, (_, i) => close({ owner: "Cal", createdAt: ago(1 + i), enrollmentDate: TODAY }));
await db.collection("students").insertMany(many);
const capped = (await tv("?parts=live")).body.data;
check("23 more in the last half hour: the newest 20, newest first", capped.closes.length === 20 && capped.closes[0].id === String(many[0]._id)
  && capped.closes.every((c, i, all) => i === 0 || Date.parse(all[i - 1].at) >= Date.parse(c.at)), capped.closes.map((c) => c.at));

section("Root's secret");
const none = await tv("", null);
check("no secret → 401, nothing in it", none.status === 401 && !("data" in (none.body as object) && (none.body as { data?: unknown }).data), none);
const wrong = await tv("", "not-the-secret");
check("a wrong secret → 401", wrong.status === 401, wrong.status);
const almost = await tv("", SECRET.slice(0, -1) + "x");
check("one character off → 401", almost.status === 401, almost.status);

section("Wiring");
{
  const routesText = await Bun.file(new URL("../src/routes/portalRoutes.ts", import.meta.url)).text();
  const guard = routesText.indexOf("router.use(portalOnly)");
  const route = routesText.indexOf('"/sales-tv"');
  check("/sales-tv sits behind the portal secret (after router.use(portalOnly))", guard >= 0 && route > guard, { guard, route });
}

/* ── Done ── */
server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
