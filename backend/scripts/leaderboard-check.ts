/**
 * Checks the Remote CRM's leaderboard — the signed-in board and the open one at /public/leaderboard (2026-10-15) — on
 * a scratch database: every figure (revenue, closings, follow-ups logged, 3CX calls from lead_calls / connected / talk
 * time this month and today, the leads each person holds by status), who is on it (not the Super Admin, not the
 * commission plan's excluded), the
 * three rankings, a past month, the targets, no emails on the open board, its 15-second memory, bad months / ranks,
 * and who may see which. And the live line (the TV board): the /public-leaderboard socket — open, "changed" only,
 * within a look of a change, the kept answers dropped, both screens told, nothing taken from screens, the signed-in
 * socket still guarded, the watching stopping when the screens go, the cap — and a pile of joins in one request
 * getting one screen. And the open door's limits: this month in any ranking from the watcher's one count, the same
 * ask counted once, at most two counts at a time (503 past 100 waiting), a slow count slowing the watcher, no
 * future months.
 *
 * Run by leaderboard-check.sh. Scratch database only.
 */
import { Types } from "mongoose";
import type { Leaderboard } from "../src/services/leaderboardService.js";

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
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "leaderboard-check-jwt", JWT_REFRESH_SECRET: "leaderboard-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use((await import("helmet")).default());
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = (await import("http")).createServer(app);
(await import("../src/socket.js")).initSocket(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

async function api<T>(path: string, who: string | null): Promise<{ status: number; body: { data: T; message: string }; raw: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} });
  const raw = await res.text();
  return { status: res.status, body: (raw ? JSON.parse(raw) : {}) as { data: T; message: string }, raw };
}

/** A screen on the socket, spoken to in Socket.IO's own wire format (this repo has no socket client). */
type Screen = { opened: Promise<{ ok: boolean; message?: string }>; events: Array<{ event: string; payload: unknown; raw: string }>; send(s: string): void; close(): void };
function screen(ns: string, auth?: Record<string, unknown>): Screen {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const head = ns === "/" ? "" : `${ns},`;
  const events: Screen["events"] = [];
  let settle!: (v: { ok: boolean; message?: string }) => void;
  const opened = new Promise<{ ok: boolean; message?: string }>((resolve) => (settle = resolve));
  ws.onmessage = (m) => {
    const t = String(m.data);
    if (t.startsWith("0{")) ws.send(`40${head}${auth ? JSON.stringify(auth) : ""}`); // the line is open → join the namespace
    else if (t === "2") ws.send("3"); // ping → pong
    else if (t.startsWith(`40${head}`)) settle({ ok: true });
    else if (t.startsWith(`44${head}`)) settle({ ok: false, message: (JSON.parse(t.slice(2 + head.length)) as { message?: string }).message });
    else if (t.startsWith(`42${head}`)) {
      const [event, payload] = JSON.parse(t.slice(2 + head.length)) as [string, unknown];
      events.push({ event, payload, raw: t });
    }
  };
  ws.onclose = () => settle({ ok: false, message: "closed" });
  ws.onerror = () => settle({ ok: false, message: "error" });
  return { opened, events, send: (s) => ws.send(s), close: () => ws.close() };
}
/** Join and leave the open namespace again and again on one connection; stays joined after the last round. */
async function cycleOnOneConnection(times: number): Promise<{ joined: number; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  let joined = 0;
  let wake: (() => void) | null = null;
  const next = () => new Promise<void>((resolve) => (wake = resolve));
  ws.onmessage = (m) => {
    const t = String(m.data);
    if (t.startsWith("0{")) wake?.();
    else if (t === "2") ws.send("3");
    else if (t.startsWith("40/public-leaderboard,")) {
      joined++;
      wake?.();
    }
  };
  await next();
  for (let i = 0; i <= times; i++) {
    const inNow = next();
    ws.send("40/public-leaderboard,");
    await inNow;
    if (i < times) {
      ws.send("41/public-leaderboard,");
      await sleep(15);
    }
  }
  return { joined, close: () => ws.close() };
}

/** Many joins sent in one long-polling request — as a script could, to fill the namespace from one connection. */
async function pollingJoins(n: number): Promise<{ accepted: number; refused: number; reasons: string[]; close(): Promise<void> }> {
  const base = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
  const opened = await (await fetch(base)).text();
  const sid = (JSON.parse(opened.slice(opened.indexOf("{"))) as { sid: string }).sid;
  const url = `${base}&sid=${encodeURIComponent(sid)}`;
  await fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: Array.from({ length: n }, () => "40/public-leaderboard,").join("\x1e") });
  await sleep(300);
  const packets = (await (await fetch(url)).text()).split("\x1e");
  const head = "/public-leaderboard,";
  const reasons = packets.filter((t) => t.startsWith(`44${head}`)).map((t) => (JSON.parse(t.slice(2 + head.length)) as { message: string }).message);
  return {
    accepted: packets.filter((t) => t.startsWith(`40${head}`)).length,
    refused: reasons.length,
    reasons,
    close: async () => {
      await fetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: "1" });
    },
  };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(100);
  }
  return test();
}

/* ── People ──────────────────────────────────────────────────────────────── */

const role = { superAdmin: new Types.ObjectId(), staff: new Types.ObjectId(), noBoard: new Types.ObjectId() };
const perms = (m: Record<string, Record<string, boolean>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));
await db.collection("roles").insertMany([
  { _id: role.superAdmin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: role.staff, roleName: "Sales Staff", isSystemRole: false, permissions: perms({ leads: { view: true }, leaderboard: { view: true } }) },
  { _id: role.noBoard, roleName: "No Board", isSystemRole: false, permissions: perms({ leads: { view: true }, leaderboard: { view: false } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, r: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  const email = `${name.toLowerCase()}@board.test`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role: r, status: "active", ...extra });
  ids[name] = _id;
  tokens[name] = signAccessToken({ userId: String(_id), email, roleId: String(r) });
}
await person("Admin", role.superAdmin);
await person("Ann", role.staff, { extension: "101" });
await person("Ben", role.staff, { extension: "102" });
await person("Cat", role.staff, { extension: "103" });
await person("Dee", role.staff); // Closed leads with no enrolment, paid in rupees (2026-10-31)
await person("Xen", role.staff); // excluded from the commission plan
await person("Gone", role.staff, { status: "inactive" });
await person("Nob", role.noBoard);
await db.collection("commissionsettings").insertOne({ excludedUsers: [ids.Xen], createdAt: new Date(), updatedAt: new Date() });

/* ── Time ────────────────────────────────────────────────────────────────── */

const H = 3_600_000;
const dubai = new Date(Date.now() + 4 * H);
const MONTH = `${dubai.getUTCFullYear()}-${String(dubai.getUTCMonth() + 1).padStart(2, "0")}`;
const monthStart = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), 1) - 4 * H);
const todayStart = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), dubai.getUTCDate()) - 4 * H);
const prev = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth() - 1, 1));
const PREV = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
// Inside this month but not today (when today is the 1st, the month's start is today — the check allows for it).
const earlierThisMonth = new Date(monthStart.getTime() + 60_000);
const todayIsFirst = todayStart.getTime() === monthStart.getTime();
const today = new Date(Math.max(Date.now() - 10 * 60_000, todayStart.getTime() + 60_000));
const lastMonth = new Date(monthStart.getTime() - 2 * 24 * H);

/* ── Leads, closings, calls ──────────────────────────────────────────────── */

let n = 0;
const lead = (owner: string | null, status: string, extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), name: `L${++n}`, phone: `+97150${1_000_000 + n}`, status,
  assignedTo: owner ? ids[owner] : null, assignedAt: new Date(), reporter: ids.Admin,
  notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const pay = (amount: number, paidAt: Date) => ({ _id: new Types.ObjectId(), amount, paidAt, addedBy: ids.Admin });
const fu = (by: string, at: Date) => ({ _id: new Types.ObjectId(), followedUpAt: at, followedUpBy: ids[by], createdAt: at, updatedAt: at });
const leads = [
  lead("Ann", "closed", { payments: [pay(1500, earlierThisMonth), pay(500, lastMonth)] }),
  lead("Ann", "followup", { followUps: [fu("Ann", earlierThisMonth), fu("Ann", lastMonth)] }),
  lead("Ann", "new"),
  lead("Ben", "closed", { payments: [pay(900.5, earlierThisMonth)] }),
  lead("Ben", "lost"),
  lead("Ben", "callback", { followUps: [fu("Ben", earlierThisMonth), fu("Ben", earlierThisMonth)] }),
  lead("Cat", "assigned"),
  // Marked Closed with no enrolment: counts on the day of its "closed" line — this month's does, last month's doesn't;
  // its rupees count in AED (₹2,275 at 22.75 = AED 100).
  lead("Dee", "closed", {
    activityLogs: [{ action: "status_changed", changes: { status: { from: "assigned", to: "closed" } }, createdAt: earlierThisMonth }],
    payments: [{ ...pay(2275, earlierThisMonth), currency: "INR" }],
  }),
  lead("Dee", "closed", { activityLogs: [{ action: "status_changed", changes: { status: { from: "followup", to: "closed" } }, createdAt: lastMonth }] }),
  lead("Xen", "closed", { payments: [pay(99_999, earlierThisMonth)] }),
  lead("Admin", "closed", { payments: [pay(77_777, earlierThisMonth)] }),
  lead(null, "new"),
  lead("Nob", "", { status: null }), // only a raw write could leave a lead with no status
  lead("Nob", ""),
];
await db.collection("leads").insertMany(leads);
await db.collection("students").insertMany([
  { _id: new Types.ObjectId(), name: "S1", enrollmentNumber: "LBC-1", leadId: leads[0]._id, assignedTo: ids.Ann, enrollmentDate: earlierThisMonth, status: "active" },
  { _id: new Types.ObjectId(), name: "S2", enrollmentNumber: "LBC-2", leadId: new Types.ObjectId(), assignedTo: ids.Ann, enrollmentDate: earlierThisMonth, status: "dropped" },
  { _id: new Types.ObjectId(), name: "S3", enrollmentNumber: "LBC-3", leadId: leads[3]._id, assignedTo: ids.Ben, enrollmentDate: earlierThisMonth, status: "active" },
  { _id: new Types.ObjectId(), name: "S4", enrollmentNumber: "LBC-4", leadId: new Types.ObjectId(), assignedTo: ids.Ben, enrollmentDate: lastMonth, status: "active" },
]);
let k = 0;
const call = (who: { user?: Types.ObjectId | null; extension?: string }, startedAt: Date, status: "answered" | "missed" | "no_answer", talkSeconds: number) => ({
  key: `call-${++k}`, startedAt, direction: "out", status, answered: status === "answered", talkSeconds,
  lead: leads[0]._id, user: who.user ?? null, extension: who.extension ?? "", rows: 1, createdAt: new Date(), updatedAt: new Date(),
});
await db.collection("lead_calls").insertMany([
  call({ user: ids.Ann }, today, "answered", 600),
  call({ user: ids.Ann }, today, "no_answer", 0),
  call({ user: ids.Ann }, earlierThisMonth, "answered", 3000),
  call({ user: ids.Ann }, lastMonth, "answered", 9999),
  call({ user: ids.Ben }, earlierThisMonth, "answered", 120),
  call({ extension: "102" }, earlierThisMonth, "answered", 777), // not linked to anyone by the sync — nobody's
  call({ user: ids.Ben }, today, "missed", 0),
  call({ user: ids.Admin }, today, "answered", 5000),
]);

/* ═══ The board ══════════════════════════════════════════════════════════ */

section("Case 1 — the open board: every figure, no sign-in");
{
  const r = await api<Leaderboard>(`/public/leaderboard`, null);
  check("GET /public/leaderboard with no sign-in → 200", r.status === 200, r.status);
  const b = r.body.data;
  const row = (name: string) => b.rows.find((x) => x.name === name);
  check("this month, ranked by revenue, the current month, targets 100 / 1,000 min", b.month === MONTH && b.rankBy === "revenue" && b.currentMonth === true && b.targets.dayMinutes === 100 && b.targets.monthMinutes === 1000, { month: b.month, rankBy: b.rankBy, currentMonth: b.currentMonth, targets: b.targets });
  check("on the board: Ann, Ben, Cat, Nob — not the Super Admin, not the excluded, not the deactivated", b.rows.map((x) => x.name).sort().join() === "Ann,Ben,Cat,Dee,Nob", b.rows.map((x) => x.name));
  const ann = row("Ann"), ben = row("Ben"), cat = row("Cat");
  check("Ann: revenue 1,500 (this month's payment only), 1 closing (not the dropped), 1 follow-up", ann?.revenue === 1500 && ann.closings === 1 && ann.followUps === 1, ann);
  check("Ann: 3 calls this month (two today, one earlier), 2 connected, 3,600 s", ann?.calls === 3 && ann.connected === 2 && ann.talkSeconds === 3600, ann);
  // On the 1st, "earlier this month" is today too.
  check(`Ann today: ${todayIsFirst ? 3 : 2} calls, ${todayIsFirst ? 2 : 1} connected, ${todayIsFirst ? 3600 : 600} s`,
    ann?.callsToday === (todayIsFirst ? 3 : 2) && ann.connectedToday === (todayIsFirst ? 2 : 1) && ann.talkSecondsToday === (todayIsFirst ? 3600 : 600), ann);
  check("Ann holds 3 leads: closed, follow-up, new", ann?.totalLeads === 3 && ann.leadCounts?.closed === 1 && ann.leadCounts.followup === 1 && ann.leadCounts.new === 1, ann?.leadCounts);
  check("Ben: revenue 900.5, 1 closing, 2 follow-ups", ben?.revenue === 900.5 && ben.closings === 1 && ben.followUps === 2, ben);
  check("Ben: his linked call counts (not one the sync linked to nobody); a missed call today counts, not connected",
    ben?.calls === 2 && ben.connected === 1 && ben.talkSeconds === 120 && ben.callsToday === (todayIsFirst ? 2 : 1) && ben.connectedToday === (todayIsFirst ? 1 : 0), ben);
  check("Ben holds 3 leads: closed, lost, callback", ben?.totalLeads === 3 && ben.leadCounts?.lost === 1 && ben.leadCounts.callback === 1, ben?.leadCounts);
  const nob = row("Nob");
  check("a lead with no status counts as \"unknown\" — never \"null\" or \"\"", nob?.totalLeads === 2 && nob.leadCounts?.unknown === 2 && !("null" in (nob.leadCounts ?? {})) && !("" in (nob.leadCounts ?? {})), nob?.leadCounts);
  check("Cat: nothing this month, one lead assigned", cat?.revenue === 0 && cat.calls === 0 && cat.callsToday === 0 && cat.totalLeads === 1 && cat.leadCounts?.assigned === 1, cat);
  const dee = row("Dee");
  check("Dee: a Closed lead with no enrolment is a closing (this month's, not last month's); its rupees in AED (₹2,275 → 100)", dee?.closings === 1 && dee.revenue === 100, dee);
  check("ranked by revenue: Ann, Ben, then the rest", b.rows[0]?.name === "Ann" && b.rows[1]?.name === "Ben" && b.rows[0]?.rank === 1 && b.rows[1]?.rank === 2, b.rows.map((x) => [x.rank, x.name]));
  check("no email anywhere on the open board", !r.raw.includes("@board.test"), r.raw.slice(0, 200));
  check("when it was counted", typeof b.updatedAt === "string" && !Number.isNaN(Date.parse(b.updatedAt)), b.updatedAt);

  const calls = await api<Leaderboard>(`/public/leaderboard?rankBy=calls`, null);
  check("rank by calls: Ann (3), Ben (2)", calls.status === 200 && calls.body.data.rankBy === "calls" && calls.body.data.rows[0]?.name === "Ann" && calls.body.data.rows[1]?.name === "Ben", calls.body.data.rows.map((x) => x.name));
  const talk = await api<Leaderboard>(`/public/leaderboard?rankBy=talk`, null);
  check("rank by call time: Ann (3,600 s) first", talk.status === 200 && talk.body.data.rows[0]?.name === "Ann", talk.body.data.rows.map((x) => [x.name, x.talkSeconds]));
  const past = await api<Leaderboard>(`/public/leaderboard?month=${PREV}`, null);
  const pAnn = past.body.data.rows.find((x) => x.name === "Ann");
  check("last month: not the current one; Ann's revenue 500 and last month's call", past.status === 200 && past.body.data.currentMonth === false && pAnn?.revenue === 500 && pAnn.talkSeconds === 9999, { currentMonth: past.body.data.currentMonth, ann: pAnn });
}

section("Case 2 — kept 15 seconds; Case 3 — bad asks");
{
  const first = await api<Leaderboard>(`/public/leaderboard`, null);
  await db.collection("lead_calls").insertOne(call({ user: ids.Cat }, today, "answered", 60));
  const again = await api<Leaderboard>(`/public/leaderboard`, null);
  check("asked again within 15 s: the same answer (same moment counted)", again.body.data.updatedAt === first.body.data.updatedAt, [first.body.data.updatedAt, again.body.data.updatedAt]);
  const signedIn = await api<Leaderboard>(`/leaderboard`, "Ann");
  check("the signed-in board is counted fresh — Cat's new call is there", signedIn.status === 200 && signedIn.body.data.rows.find((x) => x.name === "Cat")?.callsToday === 1, signedIn.body.data.rows.find((x) => x.name === "Cat"));
  check("…with today's figures and lead counts too", signedIn.body.data.rows.every((x) => typeof x.callsToday === "number" && typeof x.totalLeads === "number"));
  for (const [label, q] of [["a month that isn't one", "month=2026-13"], ["a month in words", "month=october"], ["a rank that isn't one", "rankBy=money"]] as const) {
    const bad = await api(`/public/leaderboard?${q}`, null);
    check(`${label} → 400`, bad.status === 400, bad.status);
  }
  const nineties = await api<Leaderboard>(`/leaderboard?month=1999-12`, "Ann");
  check("the signed-in board still takes a month in the 1990s → 200", nineties.status === 200, nineties.status);
  const far = await api<Leaderboard>(`/public/leaderboard?month=2001-01`, null);
  check("a month long ago → 200, everyone at zero", far.status === 200 && far.body.data.rows.every((x) => x.revenue === 0 && x.calls === 0), far.status);
}

section("Case 4 — who sees which");
{
  check("the signed-in board signed out → 401", (await api(`/leaderboard`, null)).status === 401);
  check("…with the Leaderboard box unticked → 403", (await api(`/leaderboard`, "Nob")).status === 403);
  check("…Sales Staff (box ticked) → 200", (await api(`/leaderboard`, "Ann")).status === 200);
  check("the open board needs nobody — 200 signed out (above) and with any sign-in", (await api(`/public/leaderboard`, "Nob")).status === 200);
}

section("Case 5 — live: the /public-leaderboard socket (the TV board)");
{
  const { liveLeaderboardState, LEADERBOARD_CHANGED, LIVE_EVERY_MS, MAX_SCREENS, LINGER_MS } = await import("../src/services/leaderboardLive.js");
  const changed = (s: Screen) => s.events.filter((e) => e.event === LEADERBOARD_CHANGED);

  const a = screen("/public-leaderboard");
  check("a screen joins with no sign-in", (await a.opened).ok);
  check("…and the board is looked at while it's there", await until(() => liveLeaderboardState().watching, 2000), liveLeaderboardState());
  check("the first look says \"changed\" once — what a screen had may be 15 s old", await until(() => changed(a).length === 1, 3000), a.events);
  const first = changed(a)[0];
  const said = first?.payload as Record<string, unknown> | undefined;
  check("…carrying the month and when, nothing else", !!said && Object.keys(said).sort().join() === "at,month" && said.month === MONTH && typeof said.at === "string", said);
  check("…no names, no emails, no figures on the socket", !!first && !/@board\.test|Ann|Ben|Cat|1500/.test(first.raw), first?.raw);
  await sleep(LIVE_EVERY_MS + 1500);
  check("nothing changed over a look → nothing more said", changed(a).length === 1, changed(a).length);

  const before = (await api<Leaderboard>(`/public/leaderboard?month=${MONTH}&rankBy=calls`, null)).body.data;
  const catBefore = before.rows.find((x) => x.name === "Cat")?.callsToday ?? -1;
  await db.collection("lead_calls").insertOne(call({ user: ids.Cat }, today, "answered", 90));
  check("a 3CX call lands → \"changed\" within a look", await until(() => changed(a).length === 2, LIVE_EVERY_MS + 2000), changed(a).length);
  const byCalls = (await api<Leaderboard>(`/public/leaderboard?month=${MONTH}&rankBy=calls`, null)).body.data;
  check("…and the board fetched straight after has it — the watcher's own count", byCalls.rows.find((x) => x.name === "Cat")?.callsToday === catBefore + 1, [catBefore, byCalls.rows.find((x) => x.name === "Cat")]);
  const byRevenue = (await api<Leaderboard>(`/public/leaderboard`, null)).body.data;
  check("…in every ranking, with or without a month asked for", byRevenue.rows.find((x) => x.name === "Cat")?.callsToday === catBefore + 1, byRevenue.rows.find((x) => x.name === "Cat"));
  const byTalk = (await api<Leaderboard>(`/public/leaderboard?month=${MONTH}&rankBy=talk`, null)).body.data;
  check("…all three rankings from the one count (the same moment counted), each in its own order",
    byCalls.updatedAt === byRevenue.updatedAt && byTalk.updatedAt === byRevenue.updatedAt && byCalls.rankBy === "calls" && byTalk.rankBy === "talk" && byCalls.rows[0]?.rank === 1,
    [byRevenue.updatedAt, byCalls.updatedAt, byTalk.updatedAt]);

  const b = screen("/public-leaderboard");
  check("a second screen joins the running watch and is told once, straight away", (await b.opened).ok && (await until(() => changed(b).length === 1, 1000)), changed(b).length);
  await sleep(300);
  check("…the first screen isn't told again for it", changed(a).length === 2, changed(a).length);
  await db.collection("leads").updateOne({ _id: leads[6]._id }, { $set: { status: "followup" } });
  check("a lead changing status → both screens told", await until(() => changed(a).length === 3 && changed(b).length === 2, LIVE_EVERY_MS + 2000), [changed(a).length, changed(b).length]);

  a.send(`42/public-leaderboard,["${LEADERBOARD_CHANGED}",{"month":"1999-01"}]`);
  a.send(`42/public-leaderboard,["anything",{"x":1}]`);
  await sleep(500);
  check("what a screen sends is ignored — nothing passed on, both still there", changed(b).length === 2 && liveLeaderboardState().screens === 2, [changed(b).length, liveLeaderboardState()]);

  const noToken = screen("/");
  const refused = await noToken.opened;
  check("the signed-in socket still turns away a screen with no token", !refused.ok && refused.message === "Authentication required", refused);
  noToken.close();
  const withToken = screen("/", { token: tokens.Ann });
  check("…and lets a signed-in person in, as before", (await withToken.opened).ok);
  withToken.close();

  const before2 = liveLeaderboardState().screens;
  const pile = await pollingJoins(250);
  check("a pile of 250 joins in one request → one screen, 249 turned away", pile.accepted === 1 && pile.refused === 249 && liveLeaderboardState().screens === before2 + 1, { ...pile, screens: liveLeaderboardState().screens });
  check("…told why", pile.reasons.every((r) => r === "This connection already has a screen"), [...new Set(pile.reasons)]);
  await pile.close();
  check("…and gone when that connection goes", await until(() => liveLeaderboardState().screens === before2 && liveLeaderboardState().joining === 0, 3000), liveLeaderboardState());

  a.close();
  b.close();
  await sleep(1000);
  check("every screen gone → still watched for a while (a TV reloading comes straight back)", liveLeaderboardState().watching && liveLeaderboardState().screens === 0, liveLeaderboardState());
  check("…then the board isn't looked at any more", await until(() => !liveLeaderboardState().watching && liveLeaderboardState().screens === 0, LINGER_MS + 3000), liveLeaderboardState());

  const many = Array.from({ length: MAX_SCREENS }, () => screen("/public-leaderboard"));
  const joined = await Promise.all(many.map((s) => s.opened));
  check(`${MAX_SCREENS} screens at once all join`, joined.every((o) => o.ok), joined.filter((o) => !o.ok).length);
  const extra = screen("/public-leaderboard");
  const turnedAway = await extra.opened;
  check("one more is turned away — it refreshes every 30 s instead", !turnedAway.ok && /Too many screens/.test(turnedAway.message ?? ""), turnedAway);
  check("…and every one of the others was told exactly once as it joined — before the first look or after it", await until(() => many.every((s) => changed(s).length === 1), 3000) && (await sleep(500), many.every((s) => changed(s).length === 1)), many.filter((s) => changed(s).length !== 1).length);
  extra.close();
  for (const s of many) s.close();
  check("…when they go, the watching stops (after the linger)", await until(() => !liveLeaderboardState().watching, LINGER_MS + 5000), liveLeaderboardState());
}

section("Case 6 — the open door's limits");
{
  const { LeaderboardService } = await import("../src/services/leaderboardService.js");
  const { liveLeaderboardState, LIVE_EVERY_MS, LIVE_SLOWEST_MS, LINGER_MS, PUBLIC_LEADERBOARD_NAMESPACE } = await import("../src/services/leaderboardLive.js");
  const { getIO } = await import("../src/socket.js");
  const real = LeaderboardService.prototype.getLeaderboard;
  let counted = 0, running = 0, mostAtOnce = 0;
  const slowBy = { ms: 0 };
  LeaderboardService.prototype.getLeaderboard = async function (this: InstanceType<typeof LeaderboardService>, ...args: Parameters<typeof real>) {
    counted++;
    running++;
    mostAtOnce = Math.max(mostAtOnce, running);
    try {
      if (slowBy.ms) await sleep(slowBy.ms);
      return await real.apply(this, args);
    } finally {
      running--;
    }
  };
  try {
    const future = await api(`/public/leaderboard?month=2099-12`, null);
    check("a month that hasn't started → 400", future.status === 400, future.status);
    const nextMonth = (() => { const d = new Date(Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth() + 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; })();
    const soon = await api<Leaderboard>(`/public/leaderboard?month=${nextMonth}`, null);
    check("…but next month → 200, empty (a TV clock a little ahead at midnight on the 1st)", soon.status === 200 && soon.body.data.rows.every((x) => x.revenue === 0 && x.calls === 0), soon.status);
    const old = await api(`/public/leaderboard?month=0099-12`, null);
    check("a year like 0099 → 400 (Date.UTC would read it as 1999); 1900–2099 only", old.status === 400, old.status);

    counted = 0;
    slowBy.ms = 200;
    const same = await Promise.all(Array.from({ length: 10 }, () => api<Leaderboard>(`/public/leaderboard?month=2025-03&rankBy=calls`, null)));
    check("10 asks for the same month at once → counted once, one answer", counted === 1 && same.every((r) => r.status === 200 && r.body.data.updatedAt === same[0]!.body.data.updatedAt), counted);

    counted = 0;
    slowBy.ms = 400;
    const months = Array.from({ length: 110 }, (_, i) => { const d = new Date(Date.UTC(2010, i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
    const flood = await Promise.all(months.map((m) => api(`/public/leaderboard?month=${m}`, null)));
    const busy = flood.filter((r) => r.status === 503).length, ok = flood.filter((r) => r.status === 200).length;
    check("110 different months at once → 2 counted at a time, 100 wait, the other 8 → 503", busy === 8 && ok === 102 && counted === 102, { busy, ok, counted });
    check("…and the 503 says to try again", flood.find((r) => r.status === 503)?.body.message === "The leaderboard is busy — try again in a moment");
    slowBy.ms = 0;
    const after = await api(`/public/leaderboard?month=2024-01`, null);
    check("…then answering again at once", after.status === 200, after.status);

    const watcher = screen("/public-leaderboard");
    check("a screen joins: counted every 5 s while a count is quick", (await watcher.opened).ok && (await until(() => liveLeaderboardState().watching, 2000)) && liveLeaderboardState().everyMs === LIVE_EVERY_MS, liveLeaderboardState());
    slowBy.ms = 450;
    await until(() => liveLeaderboardState().everyMs > LIVE_EVERY_MS, LIVE_EVERY_MS + 3000);
    const every = liveLeaderboardState().everyMs;
    check("a count taking ~0.45 s → the next waits ~9 s (20×), never past a minute", every >= 8_500 && every <= 11_000 && every <= LIVE_SLOWEST_MS, every);
    slowBy.ms = 0;
    watcher.close();
    await until(() => liveLeaderboardState().screens === 0, 3000);

    // Coming and going on one connection, quickly, with slow counts, nobody else watching (a night with no TV on):
    // one watch, one count at a time.
    const nsp = getIO().of(PUBLIC_LEADERBOARD_NAMESPACE);
    const firstListeners = await (async () => {
      const once = screen("/public-leaderboard");
      await once.opened;
      const n = [...nsp.sockets.values()][0]?.conn.listenerCount("close") ?? -1;
      once.close();
      await until(() => liveLeaderboardState().screens === 0, 3000);
      return n;
    })();
    await until(() => !liveLeaderboardState().watching, LINGER_MS + 3000);
    slowBy.ms = 300;
    counted = 0;
    running = 0;
    mostAtOnce = 0;
    const cycled = await cycleOnOneConnection(20);
    await sleep(500);
    check("20 joins and leaves on one connection, nobody else watching, slow counts → one count, never two at a time", cycled.joined === 21 && counted === 1 && mostAtOnce === 1, { joined: cycled.joined, counted, mostAtOnce });
    const nowListeners = [...nsp.sockets.values()][0]?.conn.listenerCount("close") ?? -2;
    check("…and the connection's close listeners don't pile up", nowListeners === firstListeners, { firstListeners, nowListeners });
    cycled.close();
    slowBy.ms = 0;
    check("…watching stops when the last screen has gone (after the linger)", await until(() => !liveLeaderboardState().watching, LINGER_MS + 3000), liveLeaderboardState());
  } finally {
    LeaderboardService.prototype.getLeaderboard = real;
  }
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
