/**
 * Checks the 3CX call sync and the Calls page end to end on a scratch database,
 * against a stand-in 3CX served from this process (token, call log pages,
 * users, recording download). Never the real 3CX.
 *
 *   - Case 1: sync — rows grouped into calls by call history id (a queue call
 *     credited to whoever answered), keyed so a second and third run store
 *     nothing twice, 3CX's pages followed past 500 rows, the 90-day first run,
 *     the 3-hour overlap after it; calls with numbers no lead has, and internal
 *     calls, are not kept;
 *   - Case 2: phone matching on the last 9 digits whatever the format, a lead
 *     with two numbers, a number on two leads (the taker's own lead first);
 *     extensions from 3CX by email — a typed one (or one there from before)
 *     wins, the Users screen marks a changed one manual, a call taken on an
 *     extension nobody had is linked once someone gets it;
 *   - Case 3: totals, the per-person table, filters (Dubai days, direction,
 *     result, person, search by name / number), sorting, paging, CSV export,
 *     and who sees what (salesperson, team leader, Sales Manager, Super Admin,
 *     a role without Calls); a lead's calls; old call_logs not listed, and the
 *     older 3CX routes still answering;
 *   - Case 4: recordings — a link only for whoever may see the call, played
 *     through the backend (ranges pass through); expired, forged and altered
 *     links refused; 3CX not connected; the lock;
 *   - Case 5: Test connection (as in CS Portal) — Super Admin only;
 *     every step, the newest rows of the last 24 hours, a recording opened,
 *     never the key; 3CX unreachable; not connected;
 *   - Case 6: a lead's call counts from 3CX (calls / connected / not
 *     connected) — every lead with calls on the first run after deploy, the
 *     touched leads after that (a call moving between leads counts on both),
 *     updatedAt untouched; manual writes (counter routes, the lead form)
 *     ignored; the counts kept before 3CX's copied aside once, on the first run;
 *   - Case 7: Call from the CRM (stand-in Call Control) — makecall only for the
 *     caller's own leads, refused with no extension / no device / not
 *     connected / another's lead; the call window's state and hang-up only on
 *     the caller's own extension;
 *   - Case 8: after the call, the requests the popup sends, through this CRM's
 *     own status rules — Follow Up with what happened (and the next follow-up,
 *     a reminder), again on a lead already in Follow Up (one more follow-up),
 *     Meeting Scheduled with its time, Lost with a reason and notes, Call Back
 *     with a reminder, other statuses, closing through the enrolment (API
 *     side); pressing Call stamps the lead's contact dates, as before;
 *   - Case 9: the Leaderboard from lead_calls — calls, connected, talk time by
 *     the call's person, Dubai month boundaries, ranked by revenue / calls /
 *     talk time; the old click log no longer counted.
 *
 * Run by calls-check.sh. Scratch database only.
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

/* ── The stand-in 3CX ────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;
const ROWS: Row[] = [];
const THREECX_USERS = [
  { Id: 1, Number: "111", EmailAddress: "sam@test.local" },   // Sam typed 101 himself: his stays
  { Id: 2, Number: "102", EmailAddress: "TIA@test.local" },   // Tia has none: she gets 102 (email case ignored)
  { Id: 3, Number: "199", EmailAddress: "una@test.local" },   // Una's 104 was there before the sync: it stays
  { Id: 4, Number: "103", EmailAddress: "late@test.local" },  // nobody in the CRM yet
];
const KEY = "stand-in-key";
const seen = { tokens: 0, logWindows: [] as { from: number; to: number; skip: number }[], recordings: [] as string[], other: [] as string[] };
type CcParticipant = { id: number; status: string; callid: number; party_caller_id: string; party_dn: string };
const CC: Record<string, { devices: { device_id: string; user_agent: string }[]; participants: CcParticipant[] }> = {};
let ccIds = 100;
const ccSeen = { requests: [] as string[], makecalls: [] as { ext: string; device: string; destination: string; timeout: number }[], drops: [] as { ext: string; id: number }[] };
const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6, 7, 8]); // "RIFF…"

const threecx = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/connect/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      seen.tokens++;
      if (form.get("client_secret") !== KEY || form.get("grant_type") !== "client_credentials") return new Response("no", { status: 401 });
      return Response.json({ access_token: "tok-1", expires_in: 3600 });
    }
    if (req.headers.get("authorization") !== "Bearer tok-1") return new Response("unauthorized", { status: 401 });
    const log = path.match(/^\/xapi\/v1\/ReportCallLogData\/Pbx\.GetCallLogData\(periodFrom=([^,]+),periodTo=([^,]+),/);
    if (log) {
      const from = Date.parse(log[1]!), to = Date.parse(log[2]!);
      const skip = Number(url.searchParams.get("$skip") ?? 0), top = Number(url.searchParams.get("$top") ?? 100);
      seen.logWindows.push({ from, to, skip });
      const inWindow = ROWS.filter((r) => { const t = Date.parse(String(r.StartTime)); return t >= from && t < to; })
        .sort((a, b) => String(a.StartTime).localeCompare(String(b.StartTime)));
      if (/StartTime desc/.test(url.searchParams.get("$orderby") ?? "")) inWindow.reverse();
      return Response.json({ value: inWindow.slice(skip, skip + top) });
    }
    if (path === "/xapi/v1/Defs") return Response.json({ value: [] }, { headers: { "x-3cx-version": "20.0.1" } });
    if (path.startsWith("/xapi/v1/Users")) {
      const skip = Number(url.searchParams.get("$skip") ?? 0), top = Number(url.searchParams.get("$top") ?? 100);
      return Response.json({ value: THREECX_USERS.slice(skip, skip + top) });
    }
    const rec = path.match(/^\/xapi\/v1\/Recordings\/Pbx\.DownloadRecording\(recId=(\d+)\)$/);
    if (rec) {
      seen.recordings.push(rec[1]!);
      const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)?$/);
      const headers = { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="rec-${rec[1]}.wav"`, "accept-ranges": "bytes" };
      if (range) {
        const a = Number(range[1]), b = Math.min(Number(range[2] ?? AUDIO.length - 1), AUDIO.length - 1);
        return new Response(AUDIO.slice(a, b + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${a}-${b}/${AUDIO.length}`, "content-length": String(b - a + 1) } });
      }
      return new Response(AUDIO, { headers: { ...headers, "content-length": String(AUDIO.length) } });
    }
    // Call Control (the Call button): each extension's signed-in apps and calls.
    const cc = path.match(/^\/callcontrol\/([^/]+)(?:\/(devices\/([^/]+)\/makecall|makecall|participants\/(\d+)\/drop))?$/);
    if (cc) {
      const ext = cc[1]!;
      ccSeen.requests.push(`${req.method} ${path}`);
      const dn = CC[ext];
      if (!dn) return new Response("no such dn", { status: 404 });
      if (!cc[2] && req.method === "GET") return Response.json({ dn: ext, type: "Wextension", devices: dn.devices, participants: dn.participants });
      if (req.method !== "POST") return new Response("no", { status: 405 });
      if (cc[2]!.endsWith("makecall")) {
        if (cc[3] && !dn.devices.some((d) => d.device_id === decodeURIComponent(cc[3]!))) return new Response("no device", { status: 404 });
        const body = (await req.json()) as { destination: string; timeout: number };
        const p = { id: ++ccIds, status: "Dialing", callid: ccIds + 5000, party_caller_id: body.destination, party_dn: "" };
        dn.participants.push(p);
        ccSeen.makecalls.push({ ext, device: cc[3] ? decodeURIComponent(cc[3]) : "", ...body });
        return Response.json({ finalstatus: "Success", result: { id: p.id, callid: p.callid, status: p.status } });
      }
      const id = Number(cc[4]);
      const at = dn.participants.findIndex((x) => x.id === id);
      if (at < 0) return new Response("no participant", { status: 404 });
      dn.participants.splice(at, 1);
      ccSeen.drops.push({ ext, id });
      return Response.json({ finalstatus: "Success" });
    }
    seen.other.push(path);
    return new Response("not here", { status: 404 });
  },
});
const THREECX = `http://127.0.0.1:${threecx.port}`;
const connect = () => Object.assign(process.env, { THREECX_URL: THREECX, THREECX_CLIENT_ID: "crm-check", THREECX_API_KEY: KEY });
const disconnect = () => { process.env.THREECX_URL = ""; process.env.THREECX_CLIENT_ID = ""; process.env.THREECX_API_KEY = ""; };

/* ── The app ─────────────────────────────────────────────────────────────── */

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "calls-check-jwt",
  JWT_REFRESH_SECRET: "calls-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
});
disconnect();

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { User } = await import("../src/models/User.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const { CallLog } = await import("../src/models/CallLog.js");
await LeadCall.init();
const { signAccessToken } = await import("../src/utils/jwt.js");
const { dubaiDayStart, dubaiToday } = await import("../src/utils/dubaiDay.js");
const sync = await import("../src/services/callSyncService.js");
const { env } = await import("../src/config/env.js");

const express = (await import("express")).default;
const helmet = (await import("helmet")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(helmet());
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/* ── People, teams, leads ────────────────────────────────────────────────── */

const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId(), reporterRole = new Types.ObjectId();
const noCallsRole = new Types.ObjectId(), noExportRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // Saved before Calls had a row: the default (view + export) applies.
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: { leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false } } },
  { _id: reporterRole, roleName: "Reporter", isSystemRole: false, permissions: { leads: { view: true } } },
  { _id: noCallsRole, roleName: "No Calls", isSystemRole: false, permissions: { leads: { view: true }, calls: { view: false, create: false, edit: false, delete: false, approve: false, export: false } } },
  { _id: noExportRole, roleName: "No Export", isSystemRole: false, permissions: { leads: { view: true }, calls: { view: true, create: false, edit: false, delete: false, approve: false, export: false } } },
]);
const PASSWORD = "Check-Pass-123!";
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const email = `${name.toLowerCase()}@test.local`;
  const u = await User.create({ name, email, password: PASSWORD, role, ...extra });
  ids[name] = u._id;
  tokens[name] = signAccessToken({ userId: String(u._id), email, roleId: String(role) });
}
await person("Admin", superRole);
await person("Tom", salesRole);                                           // leads team Alpha
await person("Sam", salesRole, { extension: "101", extensionSource: "manual" });
await person("Tia", salesRole);
await person("Una", salesRole, { extension: "104" });                     // typed before the sync existed (no source)
await person("Mia", salesRole);                                           // the Sales Manager
await person("Rex", noCallsRole);
await person("Pat", noExportRole);
await person("Ria", reporterRole);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Mia, excludedUsers: [] });

const alpha = new Types.ObjectId(), beta = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: alpha, name: "Alpha", leaders: [ids.Tom], members: [ids.Sam, ids.Tia], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
  { _id: beta, name: "Beta", leaders: [], members: [ids.Una], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
]);

const now = Date.now();
const H = 3_600_000, D = 24 * H;
const lead = (name: string, phone: string, assignedTo: Types.ObjectId | null, team: Types.ObjectId | null, createdAt: Date) =>
  ({ _id: new Types.ObjectId(), name, phone, assignedTo, team, reporter: ids.Admin, status: "assigned", createdAt, updatedAt: createdAt, notes: [], reminders: [], activityLogs: [] });
const L1 = lead("Lina Lead", "050 123 4567", ids.Sam!, alpha, new Date(now - 40 * D));
const L2 = lead("Omar Two", "0551112222 / +971 52 333 4444", ids.Una!, beta, new Date(now - 40 * D));
const L3 = lead("Rami Three", "+971 56 777 8888", ids.Tia!, alpha, new Date(now - 40 * D));
const DUP_OLD = lead("Dup Old", "0589990000", ids.Una!, beta, new Date(now - 60 * D));
const DUP_NEW = lead("Dup New", "+971589990000", null, null, new Date(now - 5 * D));
// Counted by the old Call button and the + / − on the lead page; 3CX never called it.
const L0 = { ...lead("Hand Counted", "0541111111", ids.Sam!, alpha, new Date(now - 30 * D)), callCount: 6, callConnected: 0, callNotConnected: 2 };
await db.collection("leads").insertMany([L1, L2, L3, DUP_OLD, DUP_NEW, L0]);

/* ── 3CX's call log ──────────────────────────────────────────────────────── */

const iso = (ms: number) => new Date(ms).toISOString();
let hid = 1000;
/** One row; `call` joins rows of one call (its MainCallHistoryId). */
function row(at: number, o: Partial<Row> & { call?: string | null }): Row {
  const { call, ...rest } = o;
  return {
    ...(call === null ? {} : { MainCallHistoryId: call ?? `mch-${hid++}` }),
    CallId: 1, SegmentId: 1, Indent: 1, StartTime: iso(at),
    SourceDn: "", SourceCallerId: "", SourceDisplayName: "", DestinationDn: "", DestinationCallerId: "", DestinationDisplayName: "",
    Answered: false, TalkingDuration: "PT0S", RingingDuration: "PT5S", Reason: "", ...rest,
  };
}
const todayStart = dubaiDayStart(dubaiToday())!.getTime();
const T = {
  A: now - 2 * D, B: now - 2 * D + H, C: todayStart + 60_000, C2: todayStart - 60_000, D: now - 3 * D,
  G: now - 4 * D, H: now - 1 * D, I: now - 10 * D + 5 * H, J: now - 2 * H, K: now - 5 * H,
};
ROWS.push(
  // A: Sam rings Lina, answered, two rows of one call, two recordings.
  row(T.A, { call: "A", SourceDn: "101", SourceDisplayName: "Sam S", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT1M30S", RingingDuration: "PT8S", SrcRecId: 11 }),
  row(T.A + 1000, { call: "A", SourceDn: "101", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "00:00:45", DstRecId: 12 }),
  // B: Omar's second number calls the sales queue; Tia (ext 102) answers on a row under it.
  row(T.B, { call: "B", SourceDn: "10000", SourceCallerId: "+971523334444", DestinationDn: "800", DestinationDisplayName: "Sales Queue", Answered: true, TalkingDuration: "PT2M" }),
  row(T.B + 2000, { call: "B", Indent: 2, SourceDn: "10000", SourceCallerId: "+971523334444", DestinationDn: "102", DestinationDisplayName: "Tia T", Answered: true, TalkingDuration: "PT2M" }),
  // C: Lina calls Sam a minute after midnight (Dubai) today; nobody answers.
  row(T.C, { SourceDn: "10000", SourceCallerId: "00971501234567", DestinationDn: "101", DestinationDisplayName: "Sam S", RingingDuration: "PT20S" }),
  // C2: Rami calls a minute before midnight yesterday; Tia talks 30s.
  row(T.C2, { SourceDn: "10000", SourceCallerId: "0567778888", DestinationDn: "102", DestinationDisplayName: "Tia T", Answered: true, TalkingDuration: "PT30S" }),
  // D: ext 103 (nobody in the CRM yet) rings Rami; no answer.
  row(T.D, { SourceDn: "103", SourceDisplayName: "Late L", DestinationDn: "10002", DestinationCallerId: "0567778888", RingingDuration: "PT25S" }),
  // E: a number no lead has — ignored.
  row(T.A + 5 * H, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971500000000", Answered: true, TalkingDuration: "PT3M" }),
  // F: an internal call, extension to extension — ignored.
  row(T.A + 6 * H, { SourceDn: "101", DestinationDn: "102", Answered: true, TalkingDuration: "PT1M" }),
  // G: no call history id at all (stands alone, keyed by its contents): Una rings the number on two leads.
  row(T.G, { call: null, SourceDn: "104", SourceDisplayName: "Una U", DestinationDn: "10002", DestinationCallerId: "0589990000", Answered: true, TalkingDuration: "PT10S" }),
  // H: Sam rings the same number — neither lead is his, so the newer one.
  row(T.H, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971589990000", RingingDuration: "PT30S" }),
);
// A busy day: 520 calls to numbers no lead has, and one with Omar 515th in the list (3CX's second page).
for (let k = 0; k < 520; k++) {
  ROWS.push(row(now - 10 * D + k * 60_000, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: `+97150${String(1000000 + k)}`, Answered: true, TalkingDuration: "PT1S" }));
}
ROWS.push(row(T.I, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "0551112222", Answered: true, TalkingDuration: "PT5S" }));
// Older than 90 days: not read.
ROWS.push(row(now - 100 * D, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT9S" }));

/* ── Helpers ─────────────────────────────────────────────────────────────── */

type Body = { success?: boolean; message?: string; data?: any; pagination?: any };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<{ status: number; body: Body; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body, headers: res.headers };
}
const list = (who: string, qs = "") => call("GET", `/calls/log?preset=30d${qs}`, who);
const byKey = async (k: string) => LeadCall.findOne({ key: `call:${k}` }).lean();

/* ── Case 1 ──────────────────────────────────────────────────────────────── */

section("Case 1 — the sync: grouping, keys, pages, the first 90 days and the overlap");
connect();
let s = await sync.syncCalls("check");
check("the first run succeeds", s.ok, s);
const firstFrom = Math.min(...seen.logWindows.map((w) => w.from));
check("…reading 90 days back, a day at a time", Math.abs(firstFrom - (now - 90 * D)) < 60_000 && s.windows >= 90 && s.windows <= 91, { windows: s.windows });
check("…following 3CX's pages past 500 rows", seen.logWindows.some((w) => w.skip === 500));
const total1 = await LeadCall.countDocuments();
check("eight calls with leads kept (A B C C2 D G H I; not E, F, the 520 unknown numbers, nor anything older than 90 days)", total1 === 8, total1);
const A = await byKey("A");
check("A: two rows → one call, talk = the longest row (90s), ring 8s, both recordings, Sam's extension",
  !!A && A.rows === 2 && A.talkSeconds === 90 && A.ringSeconds === 8 && A.recordingIds.join() === "11,12" && A.extension === "101" && A.direction === "out" && A.status === "answered", A);
check("…on Lina's lead, taken by Sam (his typed extension)", String(A?.lead) === String(L1._id) && String(A?.user) === String(ids.Sam) && A?.userName === "Sam");
const B = await byKey("B");
check("B: a queue call is Tia's — who answered under the queue's row", B?.extension === "102" && String(B?.user) === String(ids.Tia) && B?.direction === "in" && B?.talkSeconds === 120, B);
check("…matched by Omar's second number", String(B?.lead) === String(L2._id) && B?.numberKey === "523334444");
const C = await LeadCall.findOne({ startedAt: new Date(T.C) }).lean();
check("C: Lina called, nobody answered — missed, on '00971…' matched to '050 123 4567'", C?.status === "missed" && String(C?.lead) === String(L1._id) && C?.ringSeconds === 20, C);
const Dcall = await LeadCall.findOne({ startedAt: new Date(T.D) }).lean();
check("D: we called, no answer — not answered, ext 103 with nobody linked yet", Dcall?.status === "no_answer" && Dcall?.extension === "103" && Dcall?.user === null && Dcall?.agentName === "Late L", Dcall);
const G = await LeadCall.findOne({ startedAt: new Date(T.G) }).lean();
check("G: no call history id — kept under a key of its own contents", !!G && /^h:[0-9a-f]{40}$/.test(G.key), G?.key);
check("…a number on two leads: Una's own lead (Dup Old), not the newer one", String(G?.lead) === String(DUP_OLD._id));
const Hc = await LeadCall.findOne({ startedAt: new Date(T.H) }).lean();
check("H: Sam rings that number — neither is his, so the newest lead (Dup New)", String(Hc?.lead) === String(DUP_NEW._id));
const I = await LeadCall.findOne({ startedAt: new Date(T.I) }).lean();
check("I: 515th row of a busy day (3CX's second page) — kept", String(I?.lead) === String(L2._id) && I?.talkSeconds === 5);
check("no internal or unknown-number call kept", (await LeadCall.countDocuments({ numberKey: { $in: ["500000000", ""] } })) === 0);
const syncedTo = new Date((await sync.getCallSettings()).syncedTo!).getTime();

seen.logWindows = [];
s = await sync.syncCalls("check");
check("a second run straight after: nothing new, nothing doubled", s.ok && s.inserted === 0 && (await LeadCall.countDocuments()) === total1, s);
const secondFrom = Math.min(...seen.logWindows.map((w) => w.from));
check("…reading from 3 hours before where the last one got to", Math.abs(secondFrom - (syncedTo - sync.OVERLAP_MS)) < 5_000, { secondFrom, syncedTo });

// J ended inside the overlap (logged late), K before it.
ROWS.push(row(T.J, { call: "J", SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "101", DestinationDisplayName: "Sam S", Answered: true, TalkingDuration: "PT1M" }));
ROWS.push(row(T.K, { call: "K", SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "101", Answered: true, TalkingDuration: "PT1M" }));
s = await sync.syncCalls("check");
check("a call logged late, inside the overlap, is picked up (J)", s.inserted === 1 && !!(await byKey("J")), s);
check("…one before the overlap is not (K)", !(await byKey("K")));
await LeadCall.deleteOne({ key: "call:K" });
ROWS.splice(ROWS.findIndex((r) => r.MainCallHistoryId === "K"), 1);
s = await sync.syncCalls("check");
check("a third run: still nothing doubled", s.inserted === 0 && (await LeadCall.countDocuments()) === total1 + 1, s);
check("keys are unique in the database", (await LeadCall.collection.indexes()).some((i) => i.key?.key === 1 && i.unique));
// A call whose rows straddle the start of a day window — Lina rings the queue a second before it, Sam answers a second
// after — is read whole, not just the part on the later day.
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { syncedTo: new Date(now - 2 * D) } });
const edge = now - 2 * D - sync.OVERLAP_MS + D;   // where this run's second day starts
ROWS.push(
  row(edge - 1000, { call: "EDGE", SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "800", DestinationDisplayName: "Sales Queue", Answered: true, TalkingDuration: "PT20S" }),
  row(edge + 1000, { call: "EDGE", Indent: 2, SourceDn: "10000", SourceCallerId: "+971501234567", DestinationDn: "101", DestinationDisplayName: "Sam S", Answered: true, TalkingDuration: "PT20S", DstRecId: 31 }),
);
s = await sync.syncCalls("check");
const EDGE = await byKey("EDGE");
check("a call whose rows straddle the start of a day is read whole: both rows, Sam who answered under the queue, its recording",
  s.ok && EDGE?.rows === 2 && EDGE?.extension === "101" && EDGE?.recordingIds.join() === "31", EDGE);
await LeadCall.deleteOne({ key: "call:EDGE" });
ROWS.splice(ROWS.findIndex((r) => r.MainCallHistoryId === "EDGE"), 2);
await sync.recountLeadCalls([L1._id]);

/* ── Case 2 ──────────────────────────────────────────────────────────────── */

section("Case 2 — extensions from 3CX by email; typed ones win");
const ext = async (n: string) => User.findById(ids[n]).select("extension extensionSource").lean();
check("Tia had none: 102 from 3CX (email case ignored), marked 3cx", (await ext("Tia"))?.extension === "102" && (await ext("Tia"))?.extensionSource === "3cx");
check("Sam typed 101: kept, though 3CX says 111", (await ext("Sam"))?.extension === "101");
check("Una's 104 from before the sync (no source): kept, though 3CX says 199", (await ext("Una"))?.extension === "104");
let r = await call("PUT", `/users/${ids.Una}`, "Admin", { name: "Una", extension: "104" });
check("saving Una on the Users screen without changing it leaves its source alone", r.status === 200 && (await ext("Una"))?.extensionSource == null, r.body.message);
r = await call("PUT", `/users/${ids.Tia}`, "Admin", { extension: "122" });
check("a super admin types 122 for Tia: marked manual", r.status === 200 && (await ext("Tia"))?.extension === "122" && (await ext("Tia"))?.extensionSource === "manual", r.body.message);
await sync.syncExtensions();
check("…and 3CX's 102 no longer overwrites it", (await ext("Tia"))?.extension === "122");
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { syncedTo: new Date(T.B - H) } });
s = await sync.syncCalls("check");
const B2 = await byKey("B");
check("calls read again while their extension is nobody's keep who took them (B stays Tia's), nothing doubled",
  s.ok && String(B2?.user) === String(ids.Tia) && (await LeadCall.countDocuments()) === total1 + 1, { s, user: B2?.user });
r = await call("PUT", `/users/${ids.Tia}`, "Admin", { extension: "" });
check("cleared: no longer manual", (await ext("Tia"))?.extensionSource == null);
await sync.syncExtensions();
check("…so 3CX fills it again", (await ext("Tia"))?.extension === "102" && (await ext("Tia"))?.extensionSource === "3cx");
await person("Late", salesRole);
const ex = await sync.syncExtensions();
check("a new user with 3CX's email gets ext 103", (await ext("Late"))?.extension === "103", ex);
await sync.syncCalls("check");
const D2 = await LeadCall.findOne({ startedAt: new Date(T.D) }).lean();
check("…and the call ext 103 made before is now theirs", String(D2?.user) === String(ids.Late) && D2?.userName === "Late");

/* ── Case 3 ──────────────────────────────────────────────────────────────── */

section("Case 3 — totals, filters, sorting, who sees what");
r = await list("Admin");
const st = r.body.data?.stats;
check("Super Admin, 30 days: 9 calls", r.status === 200 && st?.total === 9 && r.body.data.calls.length === 9, st);
check("…4 incoming, 5 outgoing", st?.incoming === 4 && st?.outgoing === 5, st);
check("…6 connected, 1 missed, 2 not answered", st?.connected === 6 && st?.missed === 1 && st?.notAnswered === 2, st);
check("…315s talking, 53s average connected call, 1 recorded", st?.talkSeconds === 315 && st?.averageTalkSeconds === 53 && st?.recorded === 1, st);
check("…newest first", r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].startedAt >= c.startedAt));
const sam = r.body.data.people.find((p: any) => p.userId === String(ids.Sam));
check("per person: Sam 5 calls, 3 connected, 1 missed, 1 not answered, 155s, 52s average",
  sam?.total === 5 && sam?.connected === 3 && sam?.missed === 1 && sam?.notAnswered === 1 && sam?.talkSeconds === 155 && sam?.averageTalkSeconds === 52, sam);
check("…Tia, Una and Late too", ["Tia", "Una", "Late"].every((n) => r.body.data.people.some((p: any) => p.userId === String(ids[n]))));
check("a row carries the lead (live name + phone), who took it, and how many recordings",
  r.body.data.calls.some((c: any) => c.leadName === "Lina Lead" && c.leadPhone === "050 123 4567" && c.userName === "Sam" && c.recordings === 2));
check("old call_logs are not listed", (await CallLog.create({ leadId: L1._id, phoneNumber: "0501234567", callType: "Outbound", callDirection: "outbound", callDate: new Date(), source: "click_to_call" })) && (await list("Admin")).body.data.stats.total === 9);

const totalOf = async (qs: string, who = "Admin") => (await list(who, qs)).body.data?.stats?.total;
check("direction in → 4, out → 5", (await totalOf("&direction=in")) === 4 && (await totalOf("&direction=out")) === 5);
check("result connected → 6, missed → 1, not answered → 2", (await totalOf("&result=connected")) === 6 && (await totalOf("&result=missed")) === 1 && (await totalOf("&result=not_answered")) === 2);
r = await list("Admin", `&person=u:${ids.Sam}`);
check("person Sam → 5 listed and counted; the table still lists everyone", r.body.data.stats.total === 5 && r.body.data.calls.length === 5 && r.body.data.people.length >= 4, r.body.data.stats);
check("search 'lina' → her 3 calls", (await totalOf("&search=lina")) === 3);
check("search '052 333 4444' (a number, any format) → 1", (await totalOf(`&search=${encodeURIComponent("052 333 4444")}`)) === 1);
const fixture = [T.A, T.B, T.C, T.C2, T.D, T.G, T.H, T.I, T.J];
const today = dubaiToday(), yesterday = dubaiToday(new Date(todayStart - 1));
r = await call("GET", "/calls/log?preset=today", "Admin");
check("Today (Dubai): from midnight Dubai, so C (00:01) is in and C2 (23:59 yesterday) is not",
  r.body.data.stats.total === fixture.filter((t) => dubaiToday(new Date(t)) === today).length && r.body.data.calls.some((c: any) => c.startedAt === iso(T.C)) && !r.body.data.calls.some((c: any) => c.startedAt === iso(T.C2)), r.body.data.period);
r = await call("GET", `/calls/log?from=${yesterday}&to=${yesterday}`, "Admin");
check("a custom day (yesterday): C2 in, C not", r.body.data.calls.some((c: any) => c.startedAt === iso(T.C2)) && !r.body.data.calls.some((c: any) => c.startedAt === iso(T.C))
  && r.body.data.stats.total === fixture.filter((t) => dubaiToday(new Date(t)) === yesterday).length);
check("7 days by default", (await call("GET", "/calls/log", "Admin")).body.data.stats.total === fixture.filter((t) => t >= dubaiDayStart(dubaiToday(new Date(now - 6 * D)))!.getTime()).length);
check("This month: from the 1st (Dubai)", (await call("GET", "/calls/log?preset=month", "Admin")).body.data.period.from === `${today.slice(0, 7)}-01`);
r = await list("Admin", "&sort=talk&order=desc");
check("sort by talk, longest first (B 120s)", r.body.data.calls[0].talkSeconds === 120 && r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].talkSeconds >= c.talkSeconds));
r = await list("Admin", "&sort=ring&order=asc");
check("sort by ring, shortest first", r.body.data.calls.every((c: any, i: number, a: any[]) => !i || a[i - 1].ringSeconds <= c.ringSeconds));
r = await list("Admin", "&sort=date&order=asc");
check("sort by date, oldest first", r.body.data.calls[0].startedAt === iso(T.I));
r = await list("Admin", "&limit=2&page=2");
check("paged: 2 a page, page 2 of 5, totals still over all 9", r.body.data.calls.length === 2 && r.body.data.pagination.totalPages === 5 && r.body.data.pagination.page === 2 && r.body.data.stats.total === 9, r.body.data.pagination);
r = await list("Admin", "&export=1&limit=5000");
check("CSV export: every row in one go", r.status === 200 && r.body.data.calls.length === 9);
r = await list("Pat", "&export=1&limit=5000");
check("…refused without Export on Calls (403)", r.status === 403, r.status);
check("…but Pat may still view", (await list("Pat")).status === 200);

const sees = async (who: string) => (await list(who)).body.data?.stats?.total;
check("Sam (salesperson): his own calls + every call on his leads = 5", (await sees("Sam")) === 5, await sees("Sam"));
check("Tom (team leader of Alpha): his team's calls + Alpha's leads = 8", (await sees("Tom")) === 8, await sees("Tom"));
check("Una (Beta): her call + calls on her leads = 3", (await sees("Una")) === 3, await sees("Una"));
check("Mia (the Sales Manager): everyone = 9", (await sees("Mia")) === 9);
check("Ria (Reporter, sees every lead): everyone = 9", (await sees("Ria")) === 9);
check("a role saved before Calls existed gets it by default (Sam: 200)", (await list("Sam")).status === 200);
check("a role with Calls unticked: 403", (await list("Rex")).status === 403);
check("no sign-in: 401", (await call("GET", "/calls/log")).status === 401);
r = await list("Sam");
check("Sam's 3CX note: connected, updated, first import done, no error shown to him",
  r.body.data.threecx.connected === true && !!r.body.data.threecx.updatedAt && r.body.data.threecx.firstImportDone === true && r.body.data.threecx.error === null && r.body.data.canSync === false);

const leadCalls = async (who: string, l: { _id: Types.ObjectId }) => (await call("GET", `/calls/log/lead/${l._id}`, who)).body.data;
check("a lead's calls: Sam on Lina (his) → all 3", (await leadCalls("Sam", L1))?.stats?.total === 3);
check("…Sam on Omar (Una's) → only the call he made himself (I)", (await leadCalls("Sam", L2))?.calls?.map((c: any) => c.startedAt).join() === iso(T.I));
check("…Una on Lina → none", (await leadCalls("Una", L1))?.stats?.total === 0);
check("…Admin on Rami → C2 and D, all time", (await leadCalls("Admin", L3))?.stats?.total === 2);
check("…an unknown lead → 404", (await call("GET", `/calls/log/lead/${new Types.ObjectId()}`, "Admin")).status === 404 && (await call("GET", "/calls/log/lead/nope", "Admin")).status === 404);

check("the older 3CX routes still answer: template", (await fetch(`http://127.0.0.1:${port}/api/v1/calls/3cx-template`)).status === 200);
r = await call("GET", "/calls/recent", "Admin");
check("…recent call_logs", r.status === 200 && r.body.data.calls.length === 1);
r = await call("GET", `/calls/lead/${L1._id}`, "Admin");
check("…a lead's call_logs", r.status === 200 && r.body.data.source === "local");

/* ── Case 4 ──────────────────────────────────────────────────────────────── */

section("Case 4 — recordings, 3CX not connected, the lock");
r = await call("GET", `/calls/log/${A!._id}/recording-link`, "Una");
check("Una may not open Sam's call on Sam's lead (403)", r.status === 403, r.status);
r = await call("GET", `/calls/log/${A!._id}/recording-link`, "Sam");
check("Sam gets a 10-minute link", r.status === 200 && r.body.data.url.startsWith("/api/v1/calls/log/recording?") && r.body.data.expiresIn === 600, r.body);
const link = String(r.body.data.url);
check("…that holds no 3CX key", !link.includes(KEY) && !link.includes("tok-1"));
let audio = await fetch(`http://127.0.0.1:${port}${link}`);
let bytes = new Uint8Array(await audio.arrayBuffer());
check("…plays through the backend: audio/wav, the recording's bytes", audio.status === 200 && audio.headers.get("content-type") === "audio/wav" && bytes.length === AUDIO.length && seen.recordings.at(-1) === "11");
check("…playable from the web app's origin (not helmet's same-origin)", audio.headers.get("cross-origin-resource-policy") === "cross-origin");
audio = await fetch(`http://127.0.0.1:${port}${link}`, { headers: { range: "bytes=0-3" } });
check("…ranges pass through (206, bytes 0-3)", audio.status === 206 && audio.headers.get("content-range") === `bytes 0-3/${AUDIO.length}` && (await audio.arrayBuffer()).byteLength === 4);
r = await call("GET", `/calls/log/${A!._id}/recording-link?index=1`, "Tom");
audio = await fetch(`http://127.0.0.1:${port}${r.body.data?.url}`);
check("part 2 for Tom (his team): the second recording", audio.status === 200 && seen.recordings.at(-1) === "12");
check("a call without a recording: 404", (await call("GET", `/calls/log/${Dcall!._id}/recording-link`, "Admin")).status === 404);
check("an unknown call: 404", (await call("GET", `/calls/log/${new Types.ObjectId()}/recording-link`, "Admin")).status === 404);
const expired = sync.recordingPath(String(A!._id), 0, String(ids.Sam), Date.now() - 11 * 60_000);
check("an expired link: 403", (await fetch(`http://127.0.0.1:${port}${expired}`)).status === 403);
const forged = link.replace(/s=[^&]+/, "s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
check("a forged signature: 403", (await fetch(`http://127.0.0.1:${port}${forged}`)).status === 403);
const other = link.replace(/c=[a-f0-9]{24}/, `c=${String(Dcall!._id)}`);
check("the same signature on another call: 403", (await fetch(`http://127.0.0.1:${port}${other}`)).status === 403);
const later = link.replace(/e=(\d+)/, (_m, e) => `e=${Number(e) + 3600}`);
check("a link stretched to last longer: 403", (await fetch(`http://127.0.0.1:${port}${later}`)).status === 403);
check("…and someone else's name on it: 403", (await fetch(`http://127.0.0.1:${port}${link.replace(/u=[a-f0-9]{24}/, `u=${ids.Una}`)}`)).status === 403);
check("…or no signature: 403", (await fetch(`http://127.0.0.1:${port}/api/v1/calls/log/recording?c=${A!._id}&i=0`)).status === 403);

r = await call("POST", "/calls/log/sync", "Sam");
check("Sync now: Super Admin only (403 for Sam)", r.status === 403);
r = await call("POST", "/calls/log/sync", "Admin");
check("…Super Admin: runs, up to date", r.status === 200 && r.body.data?.inserted === 0, r.body);

disconnect();
s = await sync.syncCalls("check");
check("3CX not connected: the sync does nothing and says so", !s.ok && s.skipped === "3CX is not connected", s);
r = await list("Admin");
check("…the Calls page still lists what it has, and says 3CX is not connected", r.body.data.threecx.connected === false && r.body.data.stats.total === 9);
check("…Sync now: 400", (await call("POST", "/calls/log/sync", "Admin")).status === 400);
const logs: string[] = [];
const keep = console.log;
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
sync.startCallSyncWorker();
(env as { RUN_SCHEDULERS: boolean }).RUN_SCHEDULERS = true;
sync.startCallSyncWorker();
(env as { RUN_SCHEDULERS: boolean }).RUN_SCHEDULERS = false;
console.log = keep;
check("the worker: off with RUN_SCHEDULERS=false, then off for 3CX not connected — each with a line", /RUN_SCHEDULERS is off/.test(logs[0] ?? "") && /3CX not connected/.test(logs[1] ?? ""), logs);
const before = seen.tokens;
const playing = await fetch(`http://127.0.0.1:${port}${(await (async () => { connect(); const x = await call("GET", `/calls/log/${A!._id}/recording-link`, "Sam"); disconnect(); return x; })()).body.data.url}`);
check("…a recording while not connected: 502, and nothing is asked of 3CX", playing.status === 502 && seen.tokens === before);
connect();

check("the lock: taken once", await sync.takeLock());
check("…not twice", !(await sync.takeLock()));
s = await sync.syncCalls("check");
check("…a sync while it is held is skipped", !s.ok && s.skipped === "A sync is already running", s);
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
check("…a lock left behind expires (15 minutes) and can be taken", await sync.takeLock());
await sync.releaseLock();
const both = await Promise.all([sync.syncCalls("one"), sync.syncCalls("two")]);
check("two syncs at once: one runs, the other is skipped", both.filter((x) => x.ok).length === 1 && both.filter((x) => x.skipped === "A sync is already running").length === 1, both);
check("…and still nothing doubled", (await LeadCall.countDocuments()) === total1 + 1);
section("Case 5 — Test connection, as in CS Portal");
// Half an hour ago: Sam rings Lina, answered, recorded — and 250 calls to nobody's numbers before it, more than the test reads.
for (let k = 0; k < 250; k++) ROWS.push(row(now - 20 * H + k * 60_000, { SourceDn: "101", DestinationDn: "10002", DestinationCallerId: `+97155${String(1000000 + k)}`, Answered: true, TalkingDuration: "PT1S" }));
ROWS.push(row(now - 30 * 60_000, { call: "TEST", SourceDn: "101", SourceDisplayName: "Sam S", DestinationDn: "10002", DestinationCallerId: "+971501234567", Answered: true, TalkingDuration: "PT40S", SrcRecId: 21 }));
r = await call("POST", "/calls/log/test", "Sam");
check("Super Admin only (403 for Sam)", r.status === 403);
r = await call("POST", "/calls/log/test", "Admin");
const t = r.body.data;
check("every step, in order, all passed", r.status === 200 && t?.ok === true
  && (t.steps ?? []).map((x: { name: string }) => x.name).join(",") === "Settings,Sign in,Extensions,Call log,Recordings", t?.steps);
check("…settings show the address and client, never the key", t?.steps?.[0]?.detail?.includes(THREECX) && t.steps[0].detail.includes("crm-check") && !JSON.stringify(r.body).includes(KEY));
check("…signed in, with 3CX's version", /Connected — 3CX 20\.0\.1/.test(t?.steps?.[1]?.detail ?? ""), t?.steps?.[1]);
check("…3CX's users matched by email", /3CX users; \d+ matched to CRM users by email/.test(t?.steps?.[2]?.detail ?? ""), t?.steps?.[2]);
check("…the newest 200 rows of the last 24 hours, with Sam's call to Lina in them", /200 rows in the last 24 hours/.test(t?.steps?.[3]?.detail ?? "")
  && (t.parsed ?? []).some((c: { lead: string | null }) => c.lead === "Lina Lead"), t?.steps?.[3]);
check("…its recording opened (asked of 3CX with a range)", /A recording opened/.test(t?.steps?.[4]?.detail ?? "") && seen.recordings.at(-1) === "21", t?.steps?.[4]);
check("…and a few rows as 3CX sends them", Array.isArray(t?.sample) && t.sample.length === 3);
process.env.THREECX_URL = "http://127.0.0.1:9";
r = await call("POST", "/calls/log/test", "Admin");
check("3CX unreachable: it stops at Sign in and says why", r.status === 200 && r.body.data?.ok === false && r.body.data.steps.at(-1)?.name === "Sign in"
  && /reach 3CX|did not answer/.test(r.body.data.steps.at(-1)?.detail ?? ""), r.body.data?.steps);
disconnect();
r = await call("POST", "/calls/log/test", "Admin");
check("not connected: one failed step, saying what to set", r.body.data?.ok === false && r.body.data.steps.length === 1 && /THREECX_API_KEY/.test(r.body.data.steps[0].detail));
connect();

/* ── Case 6 ──────────────────────────────────────────────────────────────── */

section("Case 6 — a lead's call counts from 3CX; manual writes ignored");
const { Lead } = await import("../src/models/Lead.js");
const counts = async (id: Types.ObjectId) => {
  const l = await db.collection("leads").findOne({ _id: id });
  return { total: l?.callCount, connected: l?.callConnected, notConnected: l?.callNotConnected, updatedAt: l?.updatedAt as Date | undefined };
};
check("the first runs counted every lead once (countsVersion 2)", (await sync.getCallSettings()).countsVersion === 2);
const handCopies = () => db.collection(sync.HAND_COUNTS).find({}).toArray();
let copies = await handCopies();
check("the first run copied the counts kept before 3CX's aside first — only the lead that had some (Hand Counted 6 / 0 / 2)",
  copies.length === 1 && String(copies[0]?._id) === String(L0._id) && copies[0]?.callCount === 6 && copies[0]?.callNotConnected === 2 && copies[0]?.savedAt instanceof Date, copies);
const c0 = await counts(L0._id);
check("…then 3CX's replaced them: Hand Counted 0 / 0 / 0", c0.total === 0 && c0.connected === 0 && c0.notConnected === 0, c0);
s = await sync.syncCalls("check");
let c1 = await counts(L1._id);
check("Lina: 4 calls (A, C, J and Case 5's call), 3 connected, 1 not connected (C missed)", s.ok && c1.total === 4 && c1.connected === 3 && c1.notConnected === 1, { s, c1 });
let c3 = await counts(L3._id);
check("Rami: 2 calls, 1 connected (C2), 1 not connected (D not answered)", c3.total === 2 && c3.connected === 1 && c3.notConnected === 1, c3);
const L4 = lead("Nadia None", "0549999999", ids.Sam!, alpha, new Date(now - 3 * D));
await db.collection("leads").insertOne({ ...L4, callCount: 7, callNotConnected: 2 });
const L5 = lead("Zara Zero", "0548888888", ids.Sam!, alpha, new Date(now - 3 * D));
await db.collection("leads").insertOne({ ...L5, callCount: 0, callConnected: 0, callNotConnected: 0 });
const L6 = lead("Hana Hand", "0547777777", ids.Tia!, alpha, new Date(now - 3 * D));
await db.collection("leads").insertOne({ ...L6, callConnected: 3 });   // only callConnected typed
await db.collection("leads").updateOne({ _id: L3._id }, { $set: { callCount: 99, callConnected: 99, callNotConnected: 99 } });
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { countsVersion: 0 } });
s = await sync.syncCalls("check");
c3 = await counts(L3._id);
check("the first run after deploy counts every lead with 3CX calls again (Rami's hand-kept 99s → 2 / 1 / 1)", c3.total === 2 && c3.connected === 1 && c3.notConnected === 1 && (s.leadsRecounted ?? 0) >= 1, { c3, s });
check("…and marks it done (countsVersion 2)", (await sync.getCallSettings()).countsVersion === 2);
copies = await handCopies();
check("…the counts kept before were copied once only: a later count-all run copies nothing more", copies.length === 1 && String(copies[0]?._id) === String(L0._id), copies.length);
check("…and the copy is marked done (handCountsCopiedAt)", !!(await sync.getCallSettings()).handCountsCopiedAt);
// A copy cut short (a restart, a database error) before it was marked done: the next run finishes it first.
const LA = lead("Ana Again", "0545550001", ids.Sam!, alpha, new Date(now - 3 * D));
const LB = lead("Bo Behind", "0545550002", ids.Sam!, alpha, new Date(now - 3 * D));
await db.collection("leads").insertMany([{ ...LA, callCount: 4, callConnected: 1 }, { ...LB, callCount: 2, callNotConnected: 2 }]);
await db.collection(sync.HAND_COUNTS).insertOne({ _id: LA._id, callCount: 9, callConnected: 9, callNotConnected: 9, savedAt: new Date(now - H) } as any);
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $unset: { handCountsCopiedAt: "" }, $set: { countsVersion: 0 } });
s = await sync.syncCalls("check");
const copyOf = async (id: Types.ObjectId) => db.collection(sync.HAND_COUNTS).findOne({ _id: id });
const [cpA, cpB] = [await copyOf(LA._id), await copyOf(LB._id)];
check("a copy cut short: the next run copies the leads still missing (Bo 2 / 0 / 2) before replacing any count",
  s.ok && cpB?.callCount === 2 && cpB?.callNotConnected === 2 && (await counts(LB._id)).total === 0, { cpB, s });
check("…a lead copied before keeps its first copy (Ana's 9s stay), and the copy is marked done", cpA?.callCount === 9 && !!(await sync.getCallSettings()).handCountsCopiedAt, cpA);
const c4 = await counts(L4._id);
check("…a lead with hand-typed counts and no 3CX calls goes back to 0 / 0 / 0", c4.total === 0 && c4.connected === 0 && c4.notConnected === 0, c4);
check("…without touching its updatedAt", c4.updatedAt?.getTime() === (L4.updatedAt as Date).getTime());
const c6 = await counts(L6._id);
check("…one with only callConnected typed: 0 too", c6.total === 0 && c6.connected === 0 && c6.notConnected === 0, c6);
const c5 = await counts(L5._id);
check("…a lead already at 0 is left alone", c5.total === 0 && c5.updatedAt?.getTime() === (L5.updatedAt as Date).getTime());
await db.collection("leads").updateOne({ _id: L4._id }, { $set: { callCount: 5 } });
await sync.syncCalls("check");
check("…once only: after it, a run counts just the leads it touched (a later hand-typed 5 on a lead without calls stays)", (await counts(L4._id)).total === 5);
await db.collection("leads").updateOne({ _id: L4._id }, { $set: { callCount: 0 } });
const ramiUpdated = c3.updatedAt?.getTime();
ROWS.push(row(now - 10 * 60_000, { call: "NEWR", SourceDn: "101", SourceDisplayName: "Sam S", DestinationDn: "10002", DestinationCallerId: "+971567778888", RingingDuration: "PT30S" }));
s = await sync.syncCalls("check");
c3 = await counts(L3._id);
check("a new call with Rami (not answered): counted on the next run — 3 calls, 1 connected, 2 not connected", s.inserted === 1 && c3.total === 3 && c3.connected === 1 && c3.notConnected === 2, { s, c3 });
check("…without touching the lead's updatedAt", c3.updatedAt?.getTime() === ramiUpdated);
check("…and a run with nothing new changes no lead's counts", (await sync.syncCalls("check")).leadsRecounted === 0);
// A call read again can move to another lead with that number: both leads are counted again.
const dupBefore = { old: await counts(DUP_OLD._id), nw: await counts(DUP_NEW._id) };
check("before: Dup Old has G (connected), Dup New has H (not answered)", dupBefore.old.total === 1 && dupBefore.old.connected === 1 && dupBefore.nw.total === 1 && dupBefore.nw.notConnected === 1, dupBefore);
await db.collection("leads").updateOne({ _id: DUP_OLD._id }, { $set: { assignedTo: ids.Sam } });
await db.collection("app_settings").updateOne({ _id: "threecx_calls" as any }, { $set: { syncedTo: new Date(now - 5 * D) } });
s = await sync.syncCalls("check");
const dupAfter = { old: await counts(DUP_OLD._id), nw: await counts(DUP_NEW._id) };
check("Dup Old handed to Sam, the calls read again: H moves to Dup Old, G to Dup New — both counted again",
  dupAfter.old.total === 1 && dupAfter.old.notConnected === 1 && dupAfter.old.connected === 0 && dupAfter.nw.total === 1 && dupAfter.nw.connected === 1 && dupAfter.nw.notConnected === 0, dupAfter);
check("…the counts always equal the lead's calls in lead_calls",
  (await Promise.all([L1, L2, L3, DUP_OLD, DUP_NEW].map(async (l) => (await counts(l._id)).total === (await LeadCall.countDocuments({ lead: l._id }))))).every(Boolean));

r = await call("PATCH", `/leads/${L1._id}/call-count`, "Sam", { action: "increment" });
c1 = await counts(L1._id);
check("PATCH call-count (an old web app): 200, nothing changed, says the counts are 3CX's", r.status === 200 && r.body.data?.fromThreecx === true && r.body.data?.callCount === 4 && c1.total === 4, r.body);
r = await call("PATCH", `/leads/${L1._id}/call-not-connected`, "Sam", { action: "decrement" });
check("PATCH call-not-connected: nothing changed either", r.status === 200 && (await counts(L1._id)).notConnected === 1, r.body);
r = await call("PUT", `/leads/${L1._id}`, "Admin", { hasWhatsapp: true, callCount: 50, callConnected: 40, callNotConnected: 10 });
c1 = await counts(L1._id);
check("the lead form (PUT) with counts in it: saved, counts ignored", r.status === 200 && c1.total === 4 && c1.connected === 3 && c1.notConnected === 1, { status: r.status, c1 });
check("the lead's page shows the three counts", (await call("GET", `/leads/${L1._id}`, "Admin")).body.data?.callConnected === 3);

/* ── Case 7 ──────────────────────────────────────────────────────────────── */

section("Case 7 — Call from the CRM through 3CX: makecall, the call window, hang up");
const errCode = (x: { body: Body }) => (x.body as { errors?: { code?: string } }).errors?.code;
r = await call("GET", "/calls/click-to-call", "Sam");
check("Sam (ext 101): 3CX calls on, with the web client's address", r.status === 200 && r.body.data?.enabled === true && r.body.data.extension === "101" && r.body.data.webClientUrl === THREECX, r.body.data);
r = await call("GET", "/calls/click-to-call", "Tom");
check("Tom (no extension): off — Phone call only", r.body.data?.enabled === false && r.body.data.extension === "" && r.body.data.connected === true, r.body.data);
check("no sign-in: 401", (await call("GET", "/calls/click-to-call")).status === 401);
ccSeen.requests = [];
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "050 123 4567" });
check("3CX has no extension 101: 502, says so", r.status === 502 && /no extension 101/.test(r.body.message ?? ""), r.body);
CC["101"] = { devices: [], participants: [] };
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "050 123 4567" });
check("nothing signed in on 101: 409 no_device — 'open your 3CX app or web client'", r.status === 409 && errCode(r) === "no_device" && /open your 3CX app or web client/.test(r.body.message ?? ""), r.body);
check("…and no call was placed", ccSeen.makecalls.length === 0);
CC["101"].devices.push({ device_id: "d-phone", user_agent: "3CX Android 18" });
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "050 123 4567" });
check("only the phone app signed in: 409 no_device — 'open your 3CX app or web client', nothing placed",
  r.status === 409 && errCode(r) === "no_device" && /open your 3CX app or web client/.test(r.body.message ?? "") && ccSeen.makecalls.length === 0, r.body);
CC["101"].devices.push({ device_id: "d-iphone", user_agent: "3CX iOS (iPhone)" });
check("…the iPhone app too: still 409 no_device", errCode(await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id) })) === "no_device" && ccSeen.makecalls.length === 0);
CC["101"].devices.push({ device_id: "d-desk", user_agent: "3CX Desktop App (Windows)" });
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "050 123 4567" });
check("the desktop app signed in: the call goes there", r.status === 200 && ccSeen.makecalls.at(-1)?.device === "d-desk", { body: r.body, mc: ccSeen.makecalls });
await call("POST", "/calls/3cx/hang-up", "Sam", { participantId: r.body.data?.participantId });
ccSeen.makecalls = [];
ccSeen.drops = [];
CC["101"].devices.push({ device_id: "d-web", user_agent: "3CX WebClient (Chrome)" });
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "050 123 4567" });
const placed = r.body.data;
check("Sam calls Lina (his lead): placed on his web client, to her number as typed (digits only), 30s timeout",
  r.status === 200 && ccSeen.makecalls.length === 1 && ccSeen.makecalls[0]!.ext === "101" && ccSeen.makecalls[0]!.device === "d-web" && ccSeen.makecalls[0]!.destination === "0501234567" && ccSeen.makecalls[0]!.timeout === 30, { body: r.body, mc: ccSeen.makecalls });
check("…returns the call and participant ids for the call window", !!placed?.callId && !!placed?.participantId && placed.extension === "101" && /WebClient/.test(placed.device), placed);
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L2._id) });
check("Sam calls Omar (Una's lead, not in his list): 403, nothing placed", r.status === 403 && errCode(r) === "not_yours" && ccSeen.makecalls.length === 1, r.body);
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id), dial: "0509999999" });
check("a number that is not the lead's: 400", r.status === 400 && ccSeen.makecalls.length === 1, r.body);
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(new Types.ObjectId()) });
check("an unknown lead: 404; no lead id: 400", r.status === 404 && (await call("POST", "/calls/3cx/call", "Sam", {})).status === 400);
r = await call("POST", "/calls/3cx/call", "Tom", { leadId: String(L3._id) });
check("Tom (team leader, Rami is in his team) but no extension: 409 no_extension", r.status === 409 && errCode(r) === "no_extension", r.body);
r = await call("POST", "/calls/3cx/call", "Rex", { leadId: String(L1._id) });
check("a role without Edit on Leads: 403", r.status === 403);
check("…Sam's own extension is the only one 3CX was asked about", ccSeen.requests.every((x) => /^(GET|POST) \/callcontrol\/101(\/|$)/.test(x)), ccSeen.requests);

r = await call("GET", `/calls/3cx/state?callId=${placed?.callId}&dial=0501234567`, "Sam");
check("the call window: 3CX says Dialing → calling", r.status === 200 && r.body.data?.participant?.stage === "calling" && r.body.data.participant.id === placed?.participantId, r.body.data);
CC["101"].participants[0]!.status = "Connected";
r = await call("GET", `/calls/3cx/state?callId=${placed?.callId}`, "Sam");
check("…Connected → connected", r.body.data?.participant?.stage === "connected", r.body.data);
CC["102"] = { devices: [{ device_id: "t-web", user_agent: "3CX WebClient" }], participants: [{ id: 900, status: "Connected", callid: 9900, party_caller_id: "0567778888", party_dn: "" }] };
ccSeen.requests = [];
r = await call("GET", "/calls/3cx/state?callId=9900", "Sam");
check("Sam asking for Tia's call id sees only his own extension's call, never hers", r.body.data?.participant?.id !== 900 && ccSeen.requests.every((x) => x.startsWith("GET /callcontrol/101")), { d: r.body.data, req: ccSeen.requests });
r = await call("POST", "/calls/3cx/hang-up", "Sam", { participantId: 900 });
check("Sam hanging up Tia's call: 404, and 3CX is asked to drop nothing", r.status === 404 && ccSeen.drops.length === 0 && CC["102"].participants.length === 1, r.body);
check("…no participant id: 400", (await call("POST", "/calls/3cx/hang-up", "Sam", {})).status === 400);
r = await call("POST", "/calls/3cx/hang-up", "Sam", { participantId: placed?.participantId });
check("Sam hangs up his own call: dropped on his extension", r.status === 200 && ccSeen.drops.length === 1 && ccSeen.drops[0]!.ext === "101" && ccSeen.drops[0]!.id === placed?.participantId, r.body);
r = await call("GET", `/calls/3cx/state?callId=${placed?.callId}`, "Sam");
check("…the call window then sees it ended (no participant)", r.status === 200 && r.body.data?.participant === null, r.body.data);
r = await call("GET", "/calls/3cx/state", "Tia");
check("Tia's own window sees her call", r.body.data?.participant?.id === 900 && r.body.data.extension === "102");
check("state / hang-up without an extension: 409", (await call("GET", "/calls/3cx/state", "Tom")).status === 409 && (await call("POST", "/calls/3cx/hang-up", "Tom", { participantId: 900 })).status === 409);
disconnect();
r = await call("POST", "/calls/3cx/call", "Sam", { leadId: String(L1._id) });
check("3CX not connected: 409 not_connected; click-to-call off", r.status === 409 && errCode(r) === "not_connected" && (await call("GET", "/calls/click-to-call", "Sam")).body.data?.enabled === false, r.body);
check("…state 409 too", (await call("GET", "/calls/3cx/state", "Sam")).status === 409);
connect();

/* ── Case 8 ──────────────────────────────────────────────────────────────── */

section("Case 8 — after the call: what the popup sends, through this CRM's own status rules");
await db.collection("roles").updateOne({ _id: salesRole }, { $set: { "permissions.reminders": { view: true, create: true, edit: true, delete: true, approve: false, export: false }, "permissions.students": { view: true, create: true, edit: false, delete: false, approve: false, export: false } } });
const nextAt = new Date(Date.now() + 2 * D).toISOString();
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "followup" });
check("Follow Up with nothing about the call: 400 (this CRM wants what happened)", r.status === 400 && (await Lead.findById(L1._id).lean())?.status === "assigned", r.body);
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "followup", followUpNote: "Wants the weekend batch", followUpAt: new Date().toISOString(), nextFollowUpAt: nextAt });
let doc = await Lead.findById(L1._id).lean();
check("Follow Up with what happened and the next follow-up: status Follow Up, one follow-up in its history",
  r.status === 200 && doc?.status === "followup" && doc.followUps.length === 1 && doc.followUps[0]?.note === "Wants the weekend batch" && String(doc.followUps[0]?.followedUpBy) === String(ids.Sam), r.body);
check("…the next follow-up kept on the lead and made a reminder (Follow-up due)",
  new Date(doc!.nextFollowUpAt as Date).toISOString() === nextAt && doc!.reminders.some((x) => new Date(x.remindAt).toISOString() === nextAt && x.title === "Follow-up due"));
check("…recorded in the lead's history (status_changed)", doc!.activityLogs.some((a) => a.action === "status_changed" && (a.changes as any)?.status?.to === "followup"));
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "followup", followUpNote: "No next one", followUpAt: new Date().toISOString() });
check("Follow Up without a next follow-up: fine too (it is optional here)", r.status === 200, r.body);
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "followup", followUpNote: "x".repeat(1001), followUpAt: new Date().toISOString() });
const r1000 = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "followup", followUpNote: "y".repeat(1000), followUpAt: new Date().toISOString() });
check("a follow-up's note: 1,000 characters kept, 1,001 refused (400) — so the popup sends at most 1,000", r.status === 400 && r1000.status === 200, { s1001: r.status, s1000: r1000.status });
await Lead.updateOne({ _id: L1._id }, { $pull: { followUps: { note: "y".repeat(1000) } } });
// Picked again on a lead already in Follow Up: one more follow-up, not a status change.
await Lead.updateOne({ _id: L1._id }, { $pull: { followUps: { note: "No next one" } } });
const logsBefore = (await Lead.findById(L1._id).lean())!.activityLogs.filter((a) => a.action === "status_changed").length;
const againAt = new Date(Date.now() + 3 * D).toISOString();
const rem = await call("POST", `/leads/${L1._id}/reminders`, "Sam", { title: "Follow-up due", note: "Call after payday", remindAt: againAt });
r = await call("POST", `/leads/${L1._id}/followups`, "Sam", { note: "Call after payday", followedUpAt: new Date().toISOString(), nextFollowUpAt: againAt });
doc = await Lead.findById(L1._id).lean();
check("Follow Up again on a lead already in it: the reminder, and a second follow-up in its history",
  rem.status === 201 && r.status === 201 && doc?.status === "followup" && doc.followUps.length === 2 && doc.reminders.some((x) => x.title === "Follow-up due" && new Date(x.remindAt).toISOString() === againAt), { rem: rem.status, r: r.body });
check("…answered 201 with the entry and who logged it (it used to save, then answer 500)", r.body.data?.note === "Call after payday" && r.body.data?.followedUpBy?.name === "Sam", r.body.data);
check("…the next follow-up moved on, and no status change logged",
  new Date(doc!.nextFollowUpAt as Date).toISOString() === againAt && doc!.activityLogs.filter((a) => a.action === "status_changed").length === logsBefore);
r = await call("POST", `/leads/${L1._id}/reminders`, "Sam", { title: "Call back", remindAt: new Date(Date.now() - 2 * D).toISOString() });
check("a reminder time in the past is refused (400)", r.status === 400);
r = await call("POST", `/leads/${L1._id}/notes`, "Sam", { content: "Call through 3CX — connected · Follow Up, 16 Oct, 3:00 PM GST\nWants the weekend batch" });
doc = await Lead.findById(L1._id).lean();
check("the call's notes: a lead note + a note_added activity", r.status === 201 && doc!.notes.some((n) => /Call through 3CX — connected/.test(n.content)) && doc!.activityLogs.some((a) => a.action === "note_added"));

const meetAt = new Date(Date.now() + D).toISOString();
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "meeting_scheduled" });
check("Meeting Scheduled without a time: 400", r.status === 400, r.body);
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "meeting_scheduled", meetingAt: new Date(Date.now() - D).toISOString() });
check("…with a time already gone: 400", r.status === 400, r.body);
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "meeting_scheduled", meetingAt: meetAt, meetingNote: "At the office" });
doc = await Lead.findById(L3._id).lean();
check("…with its time: status Meeting Scheduled, the meeting a reminder", r.status === 200 && doc?.status === "meeting_scheduled" && doc.reminders.some((x) => x.title === "Meeting scheduled" && new Date(x.remindAt).toISOString() === meetAt), r.body);

r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "lost" });
check("Lost without a reason: 400", r.status === 400, r.body);
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "lost", lostReason: "price_too_high" });
check("…a reason but no notes: 400", r.status === 400, r.body);
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "lost", lostReason: "too_pricey", lostNotes: "x" });
check("…a reason this CRM doesn't have: 400", r.status === 400, r.body);
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "lost", lostReason: "price_too_high", lostNotes: "Too expensive for now" });
doc = await Lead.findById(L3._id).lean();
check("…one of its reasons and notes: status Lost, both kept on the lead", r.status === 200 && doc?.status === "lost" && doc.lostReason === "price_too_high" && doc.lostNotes === "Too expensive for now", r.body);

const cbAt = new Date(Date.now() + 5 * H).toISOString();
const cb = await call("POST", `/leads/${L3._id}/reminders`, "Tia", { title: "Call back", remindAt: cbAt });
r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: "callback" });
doc = await Lead.findById(L3._id).lean();
check("Call Back: its reminder, then the status (and Lost's reason cleared)", cb.status === 201 && r.status === 200 && doc?.status === "callback" && doc.reminders.some((x) => x.title === "Call back") && doc.lostReason == null, { cb: cb.body, r: r.body });
for (const st of ["not_connected", "cnc", "pending_response", "mia", "wrong_number"]) {
  r = await call("PATCH", `/leads/${L3._id}/status`, "Tia", { status: st });
  if (r.status !== 200) check(`status ${st}`, false, r.body);
}
check("not connected, CNC, pending response, MIA, wrong number: the plain status path", (await Lead.findById(L3._id).lean())?.status === "wrong_number");
r = await call("GET", `/students/by-lead/${L1._id}`, "Sam");
check("closing: the enrolment dialog first loads the lead's enrolment (none yet)", r.status === 200 && (r.body.data === null || r.body.data === undefined), r.body);
check("…the lead stays as it was until an enrolment is saved (the web holds 'closed')", (await Lead.findById(L1._id).lean())?.status === "followup");
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "closed" });
check("…then the status path closes it", r.status === 200 && (await Lead.findById(L1._id).lean())?.status === "closed");
r = await call("PATCH", `/leads/${L1._id}/status`, "Sam", { status: "won" });
check("an unknown status: 400", r.status === 400);

// Pressing Call (3CX or phone) logs the click — and, as the old call counter did, stamps the contact dates.
const L7 = lead("Fresh Lead", "0546666666", ids.Sam!, alpha, new Date(now - H));
await db.collection("leads").insertOne({ ...L7, assignedAt: new Date(now - H), firstContactTime: null });
const stamps = async (id: Types.ObjectId) => db.collection("leads").findOne({ _id: id }, { projection: { firstContactTime: 1, lastContactedAt: 1, lastFollowupDate: 1, callCount: 1 } });
r = await call("POST", `/calls/click?phone_number=${encodeURIComponent("0546666666")}&lead_id=${L7._id}`, "Ria");
let st7 = await stamps(L7._id);
check("Call pressed by someone who may only view leads (Ria, Reporter): logged, nothing stamped — it keeps no lead off Inactive Leads",
  r.status === 200 && st7?.lastContactedAt == null && st7?.lastFollowupDate == null && st7?.firstContactTime == null, st7);
r = await call("POST", `/calls/click?phone_number=${encodeURIComponent("0546666666")}&lead_id=${L7._id}`, "Admin");
st7 = await stamps(L7._id);
check("Call pressed by someone else (Admin): logged, last contacted + last follow-up stamped, first contact not (not the owner's)",
  r.status === 200 && st7?.lastContactedAt instanceof Date && st7?.lastFollowupDate instanceof Date && st7?.firstContactTime == null, st7);
r = await call("POST", `/calls/click?phone_number=${encodeURIComponent("0546666666")}&lead_id=${L7._id}`, "Sam");
st7 = await stamps(L7._id);
const firstAt = st7?.firstContactTime as Date | undefined;
check("…by its owner (Sam): first contact stamped too", r.status === 200 && firstAt instanceof Date && Math.abs(firstAt.getTime() - Date.now()) < 60_000, st7);
check("…the call count is not touched (3CX's)", (st7?.callCount ?? 0) === 0, st7);
check("…and the click is in call_logs, for Inactive Leads", (await CallLog.countDocuments({ leadId: L7._id, initiatedBy: ids.Sam })) === 1);
await Bun.sleep(20);
r = await call("POST", `/calls/click?phone_number=${encodeURIComponent("0546666666")}&lead_id=${L7._id}`, "Sam");
st7 = await stamps(L7._id);
check("…a second call: first contact kept, last contacted moves on", (st7?.firstContactTime as Date).getTime() === firstAt!.getTime() && (st7?.lastContactedAt as Date).getTime() > firstAt!.getTime(), st7);
r = await call("POST", `/calls/click?phone_number=0500000000&lead_id=${new Types.ObjectId()}`, "Sam");
check("an unknown lead: still logged, nothing stamped, no error", r.status === 200);
r = await call("POST", `/calls/click?phone_number=0500000000`, "Sam");
check("no lead (a number only): logged", r.status === 200);
check("no sign-in: 401", (await call("POST", `/calls/click?phone_number=0546666666&lead_id=${L7._id}`)).status === 401);

/* ── Case 9 ──────────────────────────────────────────────────────────────── */

section("Case 9 — the Leaderboard counts 3CX calls (lead_calls), by the call's person, on the Dubai calendar");
const lc = (at: string, user: Types.ObjectId | null, status: "answered" | "missed" | "no_answer", talk: number, ext = "") => ({
  key: `lb:${at}:${String(user)}:${talk}:${status}`, startedAt: new Date(at), direction: "out", status, answered: status === "answered",
  talkSeconds: talk, ringSeconds: 5, number: "0501234567", numberKey: "501234567", extension: ext, agentName: "", recordingIds: [],
  recordingUrl: "", reason: "", rows: 1, lead: L1._id, leadName: "Lina Lead", user, userName: "", syncedAt: new Date(),
});
await LeadCall.insertMany([
  lc("2026-05-31T20:30:00Z", ids.Sam!, "answered", 60),  // 1 June 00:30 in Dubai — June
  lc("2026-06-10T08:00:00Z", ids.Sam!, "answered", 30),
  lc("2026-06-11T08:00:00Z", ids.Sam!, "no_answer", 0),
  lc("2026-06-30T21:00:00Z", ids.Sam!, "answered", 999), // 1 July 01:00 in Dubai — not June
  lc("2026-05-31T19:00:00Z", ids.Sam!, "answered", 999), // 31 May 23:00 in Dubai — not June
  lc("2026-06-12T08:00:00Z", ids.Tia!, "answered", 200),
  lc("2026-06-13T08:00:00Z", ids.Tia!, "answered", 10),
  lc("2026-06-14T08:00:00Z", ids.Una!, "missed", 0),
  lc("2026-06-15T08:00:00Z", null, "answered", 500, "199"),   // nobody's extension: nobody's call
]);
await CallLog.create({ phoneNumber: "0501234567", callType: "Outbound", callDirection: "outbound", callDate: new Date("2026-06-20T08:00:00Z"), initiatedBy: ids.Tom, source: "click_to_call" });
const board = async (qs: string) => (await call("GET", `/leaderboard?month=2026-06${qs}`, "Admin")).body.data;
let lb = await board("&rankBy=calls");
const rowOf = (b: any, n: string) => b?.rows?.find((x: any) => x.userId === String(ids[n]));
check("June by calls: Sam 3 calls (2 connected, 90s talk) — the 1 June 00:30 Dubai call in, 31 May 23:00 and 1 July 01:00 out",
  rowOf(lb, "Sam")?.calls === 3 && rowOf(lb, "Sam")?.connected === 2 && rowOf(lb, "Sam")?.talkSeconds === 90, rowOf(lb, "Sam"));
check("…Tia 2 calls, 2 connected, 210s; Una 1 call, 0 connected", rowOf(lb, "Tia")?.calls === 2 && rowOf(lb, "Tia")?.talkSeconds === 210 && rowOf(lb, "Una")?.calls === 1 && rowOf(lb, "Una")?.connected === 0);
check("…ranked by calls: Sam 1st, Tia 2nd, Una 3rd", lb?.rankBy === "calls" && rowOf(lb, "Sam")?.rank === 1 && rowOf(lb, "Tia")?.rank === 2 && rowOf(lb, "Una")?.rank === 3, lb?.rows?.slice(0, 4));
check("…the old click-to-call log no longer counts (Tom 0 calls)", rowOf(lb, "Tom")?.calls === 0);
check("…a call on nobody's extension is nobody's; Super Admin not on the board", !lb.rows.some((x: any) => x.talkSeconds === 500) && !rowOf(lb, "Admin"));
lb = await board("&rankBy=talk");
check("by talk time: Tia 1st (210s), Sam 2nd (90s)", lb?.rankBy === "talk" && rowOf(lb, "Tia")?.rank === 1 && rowOf(lb, "Sam")?.rank === 2);
lb = await board("");
check("by default still revenue, then closings, follow-ups, calls (nobody earned: Sam's 3 calls first)", lb?.rankBy === "revenue" && rowOf(lb, "Sam")?.rank === 1 && rowOf(lb, "Tia")?.rank === 2);
check("rankBy=bogus: 400", (await call("GET", "/leaderboard?rankBy=bogus", "Admin")).status === 400);
lb = (await call("GET", "/leaderboard", "Admin")).body.data;
check("no month: this month on the Dubai calendar", lb?.month === dubaiToday().slice(0, 7));

check("the stand-in 3CX was asked nothing it doesn't serve", seen.other.length === 0, seen.other);

/* ── Done ────────────────────────────────────────────────────────────────── */

server.close();
threecx.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
