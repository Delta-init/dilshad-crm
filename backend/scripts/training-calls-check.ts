/**
 * Training calls (2026-11-03, as in the Sales CRM), end to end on a scratch database, a stand-in 3CX (its recordings) and a stand-in
 * storage (an S3 endpoint, in place of R2) — never the real phone system or bucket:
 *
 *   - Case 1: who may mark — the Super Admin, the Sales Manager, a leader of an active team; not a salesperson nor
 *     the leader of an inactive team; only a call they can see, with a recording; bad input refused;
 *   - Case 2: marking — the category, the note, who and when; the Calls page row carries it; changing it keeps who
 *     marked it first; its recordings copied into storage (several; a failure kept and retried by marking again);
 *   - Case 3: the Training calls page — every marked call for anyone with the module (not who lacks it), never the
 *     customer's number; filters by category, person, search; the counts per category and person;
 *   - Case 4: playing — a signed link for anyone on the page, streamed from the kept copy (with ranges), still
 *     playing after 3CX deleted it; a call not marked has no link here;
 *   - Case 5: unmarking — the mark and its kept recordings gone, off the page.
 *
 * Run by training-calls-check.sh. Scratch database only.
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

// ── A stand-in 3CX: a token and recordings ──────────────────────────────────
const CLIENT = "training-check-client", KEY = "training-check-key-SECRET";
const tokenValue = "tok-" + Math.random().toString(36).slice(2);
const recordings = new Map<number, Uint8Array>();
let recordingAsks = 0;
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);
const server3cx = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/connect/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      if (form.get("client_id") !== CLIENT || form.get("client_secret") !== KEY) return new Response("no", { status: 401 });
      return Response.json({ access_token: tokenValue, expires_in: 3600 });
    }
    if (req.headers.get("authorization") !== `Bearer ${tokenValue}`) return new Response("unauthorized", { status: 401 });
    const rec = decodeURIComponent(url.pathname).match(/^\/xapi\/v1\/Recordings\/Pbx\.DownloadRecording\(recId=(\d+)\)$/);
    if (rec) {
      recordingAsks++;
      const file = recordings.get(Number(rec[1]));
      if (!file) return new Response("gone", { status: 500 });
      return new Response(file, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="rec-${rec[1]}.wav"` } });
    }
    return new Response("not found", { status: 404 });
  },
});

// ── A stand-in storage: path-style S3 (PUT, GET with ranges, DELETE) ────────
const BUCKET = "training-check-bucket";
const store = new Map<string, { body: Uint8Array; type: string }>();
/** An aws-chunked upload body, unwrapped (the SDK may send one). */
function unchunk(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  let at = 0;
  const text = (a: number, b: number) => new TextDecoder().decode(raw.slice(a, b));
  while (at < raw.length) {
    const eol = raw.indexOf(13, at);
    const size = parseInt(text(at, eol).split(";")[0]!, 16);
    if (!size) break;
    out.push(...raw.slice(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Uint8Array.from(out);
}
const s3 = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (!path.startsWith(`/${BUCKET}/`)) return new Response("no bucket", { status: 404 });
    const key = path.slice(BUCKET.length + 2);
    if (req.method === "PUT") {
      let body = new Uint8Array(await req.arrayBuffer());
      if ((req.headers.get("content-encoding") ?? "").includes("aws-chunked") || /STREAMING/.test(req.headers.get("x-amz-content-sha256") ?? "")) body = unchunk(body);
      store.set(key, { body, type: req.headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    if (req.method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
    if (req.method === "GET") {
      const f = store.get(key);
      if (!f) return new Response("<Error><Code>NoSuchKey</Code><Message>none</Message></Error>", { status: 404, headers: { "content-type": "application/xml" } });
      const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const a = Number(range[1]), b = range[2] ? Number(range[2]) : f.body.length - 1;
        return new Response(f.body.slice(a, b + 1), { status: 206, headers: { "content-type": f.type, "content-range": `bytes ${a}-${b}/${f.body.length}`, "content-length": String(b - a + 1), "accept-ranges": "bytes" } });
      }
      return new Response(f.body, { headers: { "content-type": f.type, "content-length": String(f.body.length), "accept-ranges": "bytes" } });
    }
    return new Response("no", { status: 405 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "training-check-jwt", JWT_REFRESH_SECRET: "training-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false",
  THREECX_URL: `http://127.0.0.1:${server3cx.port}`, THREECX_CLIENT_ID: CLIENT, THREECX_API_KEY: KEY,
  R2_ACCOUNT_ID: "training-check", R2_ACCESS_KEY_ID: "check-access", R2_SECRET_ACCESS_KEY: "check-secret",
  R2_BUCKET_NAME: BUCKET, R2_PUBLIC_URL: "", R2_ENDPOINT: `http://127.0.0.1:${s3.port}`,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { User } = await import("../src/models/User.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
await LeadCall.init();
const { signAccessToken } = await import("../src/utils/jwt.js");

// ── People, teams, calls ────────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), tlRole = new Types.ObjectId(), noTrainingRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // No "trainingCalls" value stored — open by default, like Calls.
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { leads: { view: true } } },
  { _id: tlRole, roleName: "Team Leader", isSystemRole: false, permissions: { leads: { view: true } } },
  { _id: noTrainingRole, roleName: "No Training", isSystemRole: false, permissions: { leads: { view: true }, trainingCalls: { view: false, create: false, edit: false, delete: false, approve: false, export: false } } },
]);
const people: Record<string, { id: string; email: string; role: Types.ObjectId }> = {};
async function person(name: string, role: Types.ObjectId) {
  const email = `${name.toLowerCase()}@training.test`;
  const u = await User.create({ name, email, password: "Check-Pass-123!", role });
  people[name] = { id: String(u._id), email, role };
}
for (const [n, r] of [["Super", superRole], ["Lena", tlRole], ["Asha", bdeRole], ["Bilal", bdeRole], ["Sam", bdeRole], ["Omar", tlRole], ["Rita", noTrainingRole]] as const) await person(n, r);
const oid = (name: string) => new Types.ObjectId(people[name]!.id);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: oid("Sam"), excludedUsers: [] });
const team = new Types.ObjectId(), otherTeam = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: team, name: "TEAM LEGACY", leaders: [oid("Lena")], members: [oid("Asha")], status: "active", settings: {} },
  { _id: otherTeam, name: "OLD TEAM", leaders: [oid("Omar")], members: [oid("Bilal")], status: "inactive", settings: {} },
]);
let n = 0;
async function callOf(o: { by: string; recs?: number[]; team?: Types.ObjectId | null; leadName?: string }) {
  n++;
  // Every call here is with a lead (lead_calls): the lead's team and owner decide who sees it.
  const lead = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: lead, name: o.leadName ?? `Lead ${n}`, phone: `+97150000000${n}`, assignedTo: oid(o.by), team: o.team ?? null, reporter: oid("Super"), status: "assigned", notes: [], reminders: [], activityLogs: [] });
  const c = await LeadCall.create({
    key: `call:${n}`, startedAt: new Date(Date.now() - n * 60_000), direction: "out", status: "answered", answered: true, talkSeconds: 60 + n,
    number: `+97150000000${n}`, numberKey: `50000000${n}`, extension: `10${n}`, agentName: o.by, recordingIds: o.recs ?? [],
    lead, leadName: o.leadName ?? `Lead ${n}`, user: oid(o.by), userName: o.by, syncedAt: new Date(),
  });
  return String(c._id);
}
const c1 = await callOf({ by: "Asha", recs: [11], team, leadName: "Lina One" });
const c2 = await callOf({ by: "Asha", recs: [], team, leadName: "Lina One" });
const c3 = await callOf({ by: "Bilal", recs: [12], team: otherTeam, leadName: "Lal Two" });
const c4 = await callOf({ by: "Asha", recs: [13, 14], team, leadName: "Leo Three" });
const c5 = await callOf({ by: "Asha", recs: [15], team, leadName: "Lou Four" });
recordings.set(11, bytes(3000, 1));
recordings.set(12, bytes(500, 2));
recordings.set(13, bytes(800, 3));
recordings.set(14, bytes(900, 4));
// 15: 3CX can't give it yet.

// ── The API ─────────────────────────────────────────────────────────────────
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use((await import("helmet")).default());
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const tok = (name: string) => signAccessToken({ userId: people[name]!.id, email: people[name]!.email, roleId: String(people[name]!.role) });
type Answer = { status: number; body: any; text: string; headers: Headers; raw: Uint8Array };
async function call(method: string, path: string, who?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}${path.startsWith("/api/") ? path : `/api/v1${path}`}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tok(who)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(raw);
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text, headers: res.headers, raw };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const markOf = async (id: string) => (await LeadCall.findById(id).lean())?.training ?? null;
async function settled(id: string, want: (t: any) => boolean) {
  for (let i = 0; i < 60; i++) { const t = await markOf(id); if (t && want(t)) return t; await Bun.sleep(50); }
  return markOf(id);
}

section("Case 1 — who may mark");
for (const [who, can] of [["Super", true], ["Sam", true], ["Lena", true], ["Asha", false], ["Omar", false]] as const) {
  const a = await call("GET", "/calls/log", who);
  check(`${who}: ${can ? "may" : "may not"} mark (the Calls page is told)`, a.status === 200 && a.body.data?.canMarkTraining === can, JSON.stringify(a.body.data?.canMarkTraining));
}
let a = await call("PUT", `/calls/log/${c1}/training`, "Asha", { category: "closing", note: "x" });
check("a salesperson marking: 403", a.status === 403 && /Super Admin, the Sales Manager and team leaders/.test(a.body.message), a.text);
a = await call("PUT", `/calls/log/${c3}/training`, "Omar", { category: "closing" });
check("the leader of an inactive team: 403", a.status === 403, a.text);
a = await call("PUT", `/calls/log/${c3}/training`, "Lena", { category: "closing" });
check("a team leader, a call of another team: 403 (she can't open it)", a.status === 403 && /can't open/.test(a.body.message), a.text);
a = await call("PUT", `/calls/log/${c2}/training`, "Lena", { category: "closing" });
check("a call with no recording: 400", a.status === 400 && /with a recording/.test(a.body.message), a.text);
a = await call("PUT", `/calls/log/${c1}/training`, "Lena", { category: "best" });
check("an unknown category: 400", a.status === 400 && /Category is one of/.test(a.body.message), a.text);
a = await call("PUT", `/calls/log/${c1}/training`, "Lena", { category: "closing", note: "x".repeat(1001) });
check("a note over 1,000 characters: 400", a.status === 400, a.text);
check("a bad id: 400; a call that isn't there: 404",
  (await call("PUT", "/calls/log/nope/training", "Lena", { category: "closing" })).status === 400
  && (await call("PUT", `/calls/log/${new Types.ObjectId()}/training`, "Lena", { category: "closing" })).status === 404);
check("nothing marked by any of that", (await LeadCall.countDocuments({ training: { $ne: null } })) === 0);

section("Case 2 — marking, and the recording kept");
a = await call("PUT", `/calls/log/${c1}/training`, "Lena", { category: "closing", note: "  Handles the price question, then closes  " });
check("Lena (team leader) marks Asha's call: Closing, the note trimmed", a.status === 200 && a.body.data?.training?.category === "closing"
  && a.body.data.training.categoryLabel === "Closing" && a.body.data.training.note === "Handles the price question, then closes" && a.body.data.training.byName === "Lena", a.text);
let t: any = await settled(c1, (x) => (x.copies ?? []).length === 1);
check("…its recording copied into storage, the same bytes as 3CX's", t?.copies?.[0]?.key === `training-calls/${c1}/0.wav` && same(store.get(t.copies[0].key)?.body ?? new Uint8Array(), recordings.get(11)!)
  && t.copies[0].size === 3000 && t.copies[0].mimeType === "audio/wav", JSON.stringify(t?.copies));
const firstAt = t?.at;
a = await call("GET", "/calls/log", "Super");
const row = (a.body.data?.calls ?? []).find((c: any) => c.id === c1);
check("the Calls page row carries the mark", row?.training?.category === "closing" && row.training.byName === "Lena", JSON.stringify(row?.training));
check("…an unmarked call's is null", (a.body.data?.calls ?? []).find((c: any) => c.id === c2)?.training === null);
const asksBefore = recordingAsks;
a = await call("PUT", `/calls/log/${c1}/training`, "Sam", { category: "good_example", note: "Model call" });
t = await settled(c1, () => true);
check("the Sales Manager changes it: Good example; still Lena's mark, from when she marked it", a.status === 200 && t?.category === "good_example" && t.note === "Model call"
  && String(t.by) === people.Lena!.id && +new Date(t.at) === +new Date(firstAt) && +new Date(t.updatedAt) > +new Date(firstAt), JSON.stringify(t));
await Bun.sleep(150);
check("…its recording not copied again", recordingAsks === asksBefore && (await markOf(c1))?.copies?.length === 1, String(recordingAsks - asksBefore));
a = await call("PUT", `/calls/log/${c4}/training`, "Super", { category: "objection" });
t = await settled(c4, (x) => (x.copies ?? []).length === 2);
check("the Super Admin marks a call with two recordings: both kept", a.status === 200 && t?.copies?.length === 2 && same(store.get(`training-calls/${c4}/1.wav`)?.body ?? new Uint8Array(), recordings.get(14)!), JSON.stringify(t?.copies));
a = await call("PUT", `/calls/log/${c5}/training`, "Lena", { category: "avoid", note: "Talks over the client" });
t = await settled(c5, (x) => !!x.copyError);
check("3CX can't give a recording: marked, the failure kept, nothing stored", a.status === 200 && t?.copies?.length === 0 && /Recording 1 not kept yet: 3CX could not give the recording \(HTTP 500\) — mark it again to retry/.test(t.copyError ?? ""), JSON.stringify(t));
recordings.set(15, bytes(400, 5));
await call("PUT", `/calls/log/${c5}/training`, "Lena", { category: "avoid", note: "Talks over the client" });
t = await settled(c5, (x) => (x.copies ?? []).length === 1);
check("…marked again once 3CX has it: kept, the failure cleared", t?.copies?.length === 1 && t.copyError === "", JSON.stringify(t));

section("Case 3 — the Training calls page");
a = await call("GET", "/calls/log/training", "Asha");
const list = a.body.data?.calls ?? [];
check("a salesperson sees every marked call (open by default), newest mark first", a.status === 200 && list.map((c: any) => c.id).join() === [c5, c4, c1].join(), JSON.stringify(list.map((c: any) => c.id)));
check("…with the lead, the salesperson, the category, note and who marked it", list[2]?.leadName === "Lina One" && list[2].userName === "Asha" && list[2].training?.categoryLabel === "Good example"
  && list[2].training.note === "Model call" && list[2].training.byName === "Lena" && list[2].training.saved === true, JSON.stringify(list[2]));
check("…never the customer's number", !a.text.includes("+9715000000") && list.every((c: any) => !("number" in c)));
check("…she may not mark; the counts by category and person", a.body.data?.canMark === false && a.body.data.categories.find((c: any) => c.key === "objection")?.calls === 1
  && a.body.data.categories.find((c: any) => c.key === "closing")?.calls === 0 && a.body.data.people.map((p: any) => `${p.name}:${p.calls}`).join() === "Asha:3", JSON.stringify(a.body.data?.categories));
check("…paged", a.body.data?.pagination?.total === 3, JSON.stringify(a.body.data?.pagination));
check("a role without the module: 403", (await call("GET", "/calls/log/training", "Rita")).status === 403);
const idsOf = (x: Answer) => (x.body.data?.calls ?? []).map((c: any) => c.id).join();
check("by category: What not to do → the one", idsOf(await call("GET", "/calls/log/training?category=avoid", "Asha")) === c5);
check("…an unknown category → 400", (await call("GET", "/calls/log/training?category=nope", "Asha")).status === 400);
check("by person: Asha's → all three; Bilal's → none",
  idsOf(await call("GET", `/calls/log/training?person=${people.Asha!.id}`, "Asha")).split(",").length === 3 && idsOf(await call("GET", `/calls/log/training?person=${people.Bilal!.id}`, "Asha")) === "");
check("by search: the note, the lead's name", idsOf(await call("GET", "/calls/log/training?search=talks%20over", "Asha")) === c5 && idsOf(await call("GET", "/calls/log/training?search=leo", "Asha")) === c4
  && idsOf(await call("GET", "/calls/log/training?search=zzz", "Asha")) === "");

section("Case 4 — playing a training call");
a = await call("GET", `/calls/log/training/${c1}/recording-link`, "Asha");
check("a salesperson gets a signed link to a call she couldn't otherwise open", a.status === 200 && /^\/api\/v1\/calls\/log\/recording\?/.test(a.body.data?.url ?? ""), a.text);
recordings.delete(11);
const asks = recordingAsks;
let play = await call("GET", a.body.data.url);
check("…it plays from the kept copy — 3CX has deleted it, and isn't asked", play.status === 200 && same(play.raw, bytes(3000, 1)) && play.headers.get("content-type") === "audio/wav" && recordingAsks === asks, `${play.status} ${play.raw.length}`);
play = await call("GET", a.body.data.url, undefined, undefined, { range: "bytes=100-199" });
check("…with ranges, so it can be scrubbed", play.status === 206 && play.raw.length === 100 && play.headers.get("content-range") === "bytes 100-199/3000" && same(play.raw, bytes(3000, 1).slice(100, 200)), `${play.status} ${play.headers.get("content-range")}`);
check("…the cross-origin header kept (Root's page plays it too)", play.headers.get("cross-origin-resource-policy") === "cross-origin");
check("a call not marked: no link here", (await call("GET", `/calls/log/training/${c2}/recording-link`, "Asha")).status === 404);
check("a role without the module: no link", (await call("GET", `/calls/log/training/${c1}/recording-link`, "Rita")).status === 403);
a = await call("GET", `/calls/log/training/${c4}/recording-link?index=1`, "Asha");
play = await call("GET", a.body.data?.url ?? "/none");
check("the second recording of a call with two", play.status === 200 && same(play.raw, bytes(900, 4)));

section("Case 5 — no longer a training call");
check("a salesperson can't unmark: 403", (await call("DELETE", `/calls/log/${c1}/training`, "Asha")).status === 403);
a = await call("DELETE", `/calls/log/${c1}/training`, "Lena");
check("Lena unmarks it: the mark gone, its kept recording deleted", a.status === 200 && (await markOf(c1)) === null && !store.has(`training-calls/${c1}/0.wav`), a.text);
check("…off the page; no link any more", !idsOf(await call("GET", "/calls/log/training", "Asha")).includes(c1) && (await call("GET", `/calls/log/training/${c1}/recording-link`, "Asha")).status === 404);
check("…again: 404", (await call("DELETE", `/calls/log/${c1}/training`, "Lena")).status === 404);
check("the other marks untouched", !!(await markOf(c4)) && store.has(`training-calls/${c4}/0.wav`));

server.close();
server3cx.stop(true);
s3.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
