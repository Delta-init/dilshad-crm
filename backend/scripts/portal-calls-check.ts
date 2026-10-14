/**
 * Checks the calls this CRM gives the Root portal (2026-10-14: Root's "3CX
 * calls" page and the calls on its Pending page), on a scratch database,
 * through the API, with the portal secret:
 *
 *   - Case 1: the secret — none or a wrong one refused;
 *   - Case 2: every call (as a Super Admin sees them): the last 7 Dubai days by
 *     default, the totals, talk time and average, a row per person with their
 *     email, a missed call nobody took under "Nobody";
 *   - Case 3: the filters — dates, direction, result, a person, search, sort,
 *     paging, list=0 for the totals only, a bad date refused;
 *   - Case 4: a recording's link — signed by this server for 10 minutes, for
 *     Root; none for a call without one; a bad id refused.
 *
 * Run by portal-calls-check.sh. Scratch database only.
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

const SECRET = "portal-calls-check-secret-long-enough";
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "portal-calls-check-jwt", JWT_REFRESH_SECRET: "portal-calls-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", ROOT_ERP_SECRET: SECRET,
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const CALLS = db.collection("lead_calls");
const { checkRecordingLink } = await import("../src/services/callSyncService.js");

// ── People, calls ───────────────────────────────────────────────────────────
const role = new Types.ObjectId();
await db.collection("roles").insertOne({ _id: role, roleName: "Sales Staff", isSystemRole: false, permissions: {} });
const sally = new Types.ObjectId(), tom = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: sally, name: "Sally Sales", email: "Sally@Test.Local", password: "x", role, status: "active", extension: "101" },
  { _id: tom, name: "Tom Team", email: "tom@test.local", password: "x", role, status: "active", extension: "102" },
]);
const lead1 = new Types.ObjectId(), lead2 = new Types.ObjectId();
const UAE = 4 * 3_600_000;
const today = new Date(Date.now() + UAE).toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 10:00 Dubai on day n. */
const at = (n: number, h = 10) => new Date(Date.parse(`${day(n)}T${String(h).padStart(2, "0")}:00:00Z`) - UAE);
let k = 0;
const call = (o: Record<string, unknown>) => ({
  key: `k${++k}`, callId: `c${k}`, startedAt: at(0), direction: "out", status: "answered", answered: true, talkSeconds: 60, ringSeconds: 5,
  number: "971500000001", numberKey: "500000001", extension: "101", agentName: "Sally", recordingIds: [], recordingUrl: "", reason: "",
  rows: 1, lead: lead1, leadName: "Lena Lead", leadAssignedTo: sally, leadTeam: null, user: sally, userName: "Sally Sales", syncedAt: new Date(),
  createdAt: new Date(), updatedAt: new Date(), ...o,
});
const recorded = new Types.ObjectId();
await CALLS.insertMany([
  call({ _id: recorded, talkSeconds: 120, recordingIds: [5001] }),                 // Sally, today, out, connected, recorded
  call({ startedAt: at(-1), talkSeconds: 30 }),                                        // Sally, yesterday
  call({ startedAt: at(0, 9), status: "no_answer", answered: false, talkSeconds: 0 }), // Sally, not answered
  call({ user: tom, userName: "Tom Team", extension: "102", direction: "in", talkSeconds: 300, number: "971500000002", numberKey: "500000002", lead: lead2, leadName: "Omar Other" }),
  call({ user: null, userName: "", extension: "", agentName: "", direction: "in", status: "missed", answered: false, talkSeconds: 0, number: "971500000002", lead: lead2, leadName: "Omar Other" }),
  call({ startedAt: at(-10), talkSeconds: 999 }),                                      // Sally, 10 days ago: outside 7 days
]);

// ── The API ─────────────────────────────────────────────────────────────────
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
type Answer = { status: number; body: { data?: any; message?: string } };
async function get(path: string, secret: string | null = SECRET): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/service${path}`, { headers: secret === null ? {} : { "x-portal-secret": secret } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body).slice(0, 300)}`;

try {
  section("Case 1 — the secret");
  check("no secret: 401", (await get("/calls", null)).status === 401);
  check("a wrong secret: 401", (await get("/calls", "nope")).status === 401);

  section("Case 2 — every call");
  let r = await get("/calls");
  const d = r.body.data;
  check("the last 7 days by default: 5 calls, not the one 10 days ago", r.status === 200 && d?.stats?.calls === 5 && d.total === 5 && d.calls.length === 5, show(r));
  check("the totals: out 3, in 2, connected 3, missed 1, not answered 1, talk 450s, average 150s",
    d.stats.outgoing === 3 && d.stats.incoming === 2 && d.stats.connected === 3 && d.stats.missed === 1 && d.stats.notAnswered === 1
    && d.stats.talkSeconds === 450 && d.stats.avgTalkSeconds === 150 && d.stats.recorded === 1, JSON.stringify(d.stats));
  const ps = new Map<string, any>(d.people.map((p: any) => [p.key, p]));
  check("a row per person, with their email (lowercased)", ps.get(`u:${sally}`)?.calls === 3 && ps.get(`u:${sally}`)?.email === "sally@test.local"
    && ps.get(`u:${tom}`)?.calls === 1 && ps.get(`u:${tom}`)?.email === "tom@test.local" && ps.get(`u:${tom}`)?.talkSeconds === 300, JSON.stringify(d.people));
  check("the missed call nobody took: under Nobody, no email", ps.get("-")?.calls === 1 && ps.get("-")?.email === "" && /Nobody/.test(ps.get("-")?.name ?? ""));
  const c0 = d.calls[0];
  check("a call: newest first, who took it with their email, the lead, the recording count", d.calls.every((c: any, i: number) => i === 0 || c.startedAt <= d.calls[i - 1].startedAt)
    && d.calls.some((c: any) => c.id === String(recorded) && c.recordings === 1 && c.userEmail === "sally@test.local" && c.contact === "Lena Lead" && c.contactKind === "lead" && c.person === `u:${sally}`),
    JSON.stringify(c0));

  section("Case 3 — the filters");
  r = await get(`/calls?from=${day(-10)}&to=${today}`);
  check("from 10 days ago: all 6", r.body.data?.stats?.calls === 6 && r.body.data.stats.talkSeconds === 1449, show(r));
  r = await get(`/calls?from=${today}&to=${today}`);
  check("today only: 4", r.body.data?.stats?.calls === 4, show(r));
  check("incoming only: 2", (await get("/calls?direction=in")).body.data?.stats?.calls === 2);
  check("connected only: 3", (await get("/calls?result=connected")).body.data?.stats?.calls === 3);
  r = await get(`/calls?person=u:${sally}`);
  check("one person: Sally's 3 — the people table still lists everyone", r.body.data?.stats?.calls === 3 && r.body.data.calls.length === 3 && r.body.data.people.length === 3, show(r));
  check("search by lead name and by number", (await get("/calls?search=omar")).body.data?.stats?.calls === 2
    && (await get("/calls?search=500000002")).body.data?.stats?.calls === 2);
  r = await get("/calls?sort=talk&order=desc&limit=2&page=1");
  check("sorted by talk time, a page of 2", r.body.data?.calls?.length === 2 && r.body.data.calls[0].talkSeconds === 300 && r.body.data.calls[1].talkSeconds === 120 && r.body.data.total === 5, show(r));
  r = await get("/calls?sort=talk&order=desc&limit=2&page=3");
  check("…its third page: the last one", r.body.data?.calls?.length === 1 && r.body.data.page === 3);
  r = await get("/calls?list=0");
  check("list=0: the totals and people, no calls", r.body.data?.stats?.calls === 5 && r.body.data.calls.length === 0 && r.body.data.people.length === 3, show(r));
  check("a bad date, and from after to: 400", (await get("/calls?from=yesterday")).status === 400 && (await get(`/calls?from=${today}&to=${day(-1)}`)).status === 400);

  section("Case 4 — a recording's link");
  r = await get(`/calls/${recorded}/recording-link?index=0`);
  const link = r.body.data?.path ?? "";
    const checked = checkRecordingLink(new URL(`http://x${link}`).searchParams);
  check("signed here for Root, 10 minutes, for that call", r.status === 200 && link.startsWith("/api/v1/calls/") && r.body.data.expiresIn === 600
    && checked?.callId === String(recorded) && checked?.userId === "root-portal", show(r));
  r = await get(`/calls/${new Types.ObjectId()}/recording-link`);
  check("a call without one, or unknown: 404", r.status === 404 && (await get(`/calls/${d.calls.find((c: any) => c.recordings === 0).id}/recording-link`)).status === 404, show(r));
  check("a bad id or index: 400", (await get("/calls/nope/recording-link")).status === 400 && (await get(`/calls/${recorded}/recording-link?index=x`)).status === 400);
} finally {
  server.close();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
