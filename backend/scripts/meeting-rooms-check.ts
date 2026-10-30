/**
 * Checks the Meeting rooms page's API (2026-10-19) against a stand-in HRMS, on a scratch database:
 *
 *   - every call to the HRMS is signed exactly as the HRMS checks it (the stand-in recomputes the HMAC over
 *     METHOD, path with query, timestamp, nonce and sha256 of the raw body, and refuses a mismatch);
 *   - a day names this CRM and the signed-in person (viewerEmail); a booking is made as the signed-in person
 *     whatever the body says; a cancel passes any=1 only for a Super Admin;
 *   - the HRMS's 400 / 403 / 404 / 409 reach the person with its own message; the HRMS out of reach or failing
 *     is a 503, its refusing our credentials a 502 (never a 401 that would sign the person out);
 *   - "View as" only reads; not configured says so; not signed in is a 401.
 *
 * Run by meeting-rooms-check.sh. Scratch database only; the HRMS is a Bun.serve on a free port.
 */
import { createHash, createHmac } from "node:crypto";
import { Types } from "mongoose";

const CRM = "remote";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

/* ── The stand-in HRMS ──────────────────────────────────────────────────── */

const CLIENT = "crm-check-client", SECRET = "crm-check-secret-0123456789", ORG = "org-check-1";
type Call = { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null; signed: boolean };
const calls: Call[] = [];
let mode: "ok" | "500" | "401" = "ok";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const booking = (o: Record<string, unknown>) => ({
  id: "bk1", roomId: "r1", roomName: "Meeting Room 1", start: o.start, end: o.end, title: o.title, holder: o.bookerName, mine: true, fromThisCrm: true,
});

const hrms = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text();
    const pathWithQuery = url.pathname + url.search;
    const ts = req.headers.get("x-delta-timestamp") ?? "", nonce = req.headers.get("x-delta-nonce") ?? "";
    const expected = createHmac("sha256", SECRET)
      .update([req.method, pathWithQuery, ts, nonce, createHash("sha256").update(raw).digest("hex")].join("\n"))
      .digest("hex");
    const signed = req.headers.get("x-delta-client") === CLIENT && req.headers.get("x-delta-signature") === expected
      && pathWithQuery.startsWith("/api/v1/integrations") && Math.abs(Date.now() - Number(ts)) < 60_000 && nonce.length >= 16;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, signed });
    if (!signed) return json(401, { success: false, message: "Bad signature" });
    if (mode === "500") return json(500, { success: false, message: "boom" });
    if (mode === "401") return json(401, { success: false, message: "Unknown client" });

    if (req.method === "GET" && url.pathname === "/api/v1/integrations/meetings/crm-rooms") {
      const day = url.searchParams.get("day");
      return json(200, { success: true, data: {
        day, timeZone: "Asia/Dubai", open: "10:00", close: "19:00",
        rooms: [{ id: "r1", name: "Meeting Room 1", capacity: 6, location: "" }, { id: "r2", name: "Meeting Room 2", capacity: 4, location: "" }],
        bookings: [{ id: "b0", roomId: "r1", roomName: "Meeting Room 1", start: `${day}T07:00:00.000Z`, end: `${day}T08:00:00.000Z`, title: "Stand-up", holder: "Jalwa", mine: false, fromThisCrm: true }],
      } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/integrations/meetings/crm-bookings") {
      if (body?.roomId === "r9") return json(403, { success: false, message: "That room can't be booked from this CRM" });
      if (body?.title === "taken") return json(409, { success: false, message: "Meeting Room 1 is already booked then (Sales CRM · Jalwa)" });
      if (body?.title === "late") return json(400, { success: false, message: "Rooms can be booked between 10:00 and 19:00 (Dubai)" });
      return json(201, { success: true, data: booking(body ?? {}) });
    }
    const del = url.pathname.match(/^\/api\/v1\/integrations\/meetings\/crm-bookings\/([^/]+)$/);
    if (req.method === "DELETE" && del) {
      if (del[1] === "gone") return json(404, { success: false, message: "That booking isn't there any more" });
      if (del[1] === "theirs") return json(403, { success: false, message: "Only the person who booked it can cancel it" });
      return json(200, { success: true, data: { cancelled: true } });
    }
    return json(404, { success: false, message: "Not found" });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "meeting-rooms-check-jwt-0123456789", JWT_REFRESH_SECRET: "meeting-rooms-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false",
  HRMS_API_URL: `http://127.0.0.1:${hrms.port}`, HRMS_CLIENT_ID: CLIENT, HRMS_INTEGRATION_SECRET: SECRET, HRMS_ORG_ID: ORG,
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
  FINANCE_API_URL: "", FINANCE_CLIENT_ID: "", FINANCE_INTEGRATION_SECRET: "", LMS_API_URL: "", LMS_SERVICE_SECRET: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { env } = await import("../src/config/env.js");
const { signAccessToken, signImpersonationToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/* ── People ──────────────────────────────────────────────────────────────── */

const superRole = new Types.ObjectId(), staffRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // No module at all: the rooms need none.
  { _id: staffRole, roleName: "Sales", isSystemRole: false, permissions: {} },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role: Types.ObjectId) {
  const _id = new Types.ObjectId();
  ids[name] = _id;
  const email = `${name.toLowerCase()}@test.local`;
  await db.collection("users").insertOne({ _id, name: `${name} Person`, email, password: "x", role, status: "active", createdAt: new Date(), updatedAt: new Date() });
  // The token's email is deliberately not the account's: the API must read the database, not the token.
  tokens[name] = signAccessToken({ userId: String(_id), email: `token-${email}`, roleId: String(role) });
}
await person("Admin", superRole);
await person("Sam", staffRole);
const session = new Types.ObjectId();
await db.collection("impersonations").insertOne({
  _id: session, admin: ids.Admin, adminEmail: "admin@test.local", target: ids.Sam, targetEmail: "sam@test.local",
  startedAt: new Date(), expiresAt: new Date(Date.now() + 20 * 60_000), endedAt: null, ip: "", userAgent: "", device: "",
});
tokens.ViewAs = signImpersonationToken(
  { userId: String(ids.Sam), email: "sam@test.local", roleId: String(staffRole), impersonation: { id: String(session), by: String(ids.Admin) } },
  Math.floor(Date.now() / 1000),
);

interface ApiBody<T> { success: boolean; message: string; data: T }
async function api<T>(method: string, path: string, who: string | null, body?: unknown): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/meeting-rooms${path}`, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}
const last = () => calls[calls.length - 1];
const fresh = () => { calls.length = 0; };
type Day = { day: string; rooms: Array<{ id: string; name: string }>; bookings: Array<{ id: string }>; you: { superAdmin: boolean; viewOnly: boolean } };
const good = { roomId: "r1", start: "2026-10-20T08:00:00.000Z", end: "2026-10-20T09:00:00.000Z", title: "Client call" };

section("Not signed in");
{
  fresh();
  const g = await api("GET", "/day?date=2026-10-20", null);
  const p = await api("POST", "/bookings", null, good);
  const d = await api("DELETE", "/bookings/bk1", null);
  check("day, book and cancel: 401", g.status === 401 && p.status === 401 && d.status === 401, [g.status, p.status, d.status]);
  check("…and the HRMS is never asked", calls.length === 0, calls);
}

section("A day");
{
  fresh();
  const r = await api<Day>("GET", "/day?date=2026-10-20", "Sam");
  const c = last();
  check("200 with the HRMS's rooms and bookings", r.status === 200 && r.body.data?.rooms.length === 2 && r.body.data.bookings.length === 1, r.body);
  check("signed as the HRMS checks it", c?.signed === true, c);
  check(`asks crm-rooms with crm=${CRM}, the organization and the day`, c?.method === "GET" && c.path === "/api/v1/integrations/meetings/crm-rooms"
    && c.query.crm === CRM && c.query.organizationId === ORG && c.query.day === "2026-10-20", c);
  check("viewerEmail is the signed-in person's, from the database", c?.query.viewerEmail === "sam@test.local", c?.query);
  check("someone who isn't a super admin: superAdmin false", r.body.data?.you?.superAdmin === false && r.body.data.you.viewOnly === false, r.body.data?.you);
  const a = await api<Day>("GET", "/day?date=2026-10-20", "Admin");
  check("a Super Admin: superAdmin true", a.body.data?.you?.superAdmin === true, a.body.data?.you);
  fresh();
  const t = await api<Day>("GET", "/day", "Sam");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
  check("no date: today in Dubai", t.status === 200 && last()?.query.day === today, [t.status, last()?.query.day, today]);
  fresh();
  const bad = await api("GET", "/day?date=2026-02-30", "Sam");
  const worse = await api("GET", "/day?date=tomorrow", "Sam");
  check("a date that isn't one: 400, the HRMS not asked", bad.status === 400 && worse.status === 400 && calls.length === 0, [bad.status, worse.status, calls.length]);
}

section("Booking");
{
  fresh();
  const r = await api<{ id: string; holder: string }>("POST", "/bookings", "Sam", { ...good, bookerEmail: "evil@test.local", bookerName: "Evil", crm: "other", organizationId: "x" });
  const c = last();
  check("201 with the HRMS's booking", r.status === 201 && r.body.data?.id === "bk1", r);
  check("signed over the exact body sent", c?.signed === true, c);
  check("booked as the signed-in person, not the body's", c?.body?.bookerEmail === "sam@test.local" && c.body.bookerName === "Sam Person", c?.body);
  check(`crm=${CRM}, the organization, the room, the times and the title passed on`, c?.body?.crm === CRM && c.body.organizationId === ORG
    && c.body.roomId === "r1" && c.body.start === good.start && c.body.end === good.end && c.body.title === "Client call", c?.body);
  check("nothing else from the body reaches the HRMS", Object.keys(c?.body ?? {}).sort().join() === "bookerEmail,bookerName,crm,end,organizationId,roomId,start,title", c?.body);
  fresh();
  const z = await api("POST", "/bookings", "Sam", { ...good, start: "2026-10-20T12:00:00+04:00", end: "2026-10-20T13:00:00+04:00" });
  check("a time with an offset is sent as an ISO instant", z.status === 201 && last()?.body?.start === "2026-10-20T08:00:00.000Z", last()?.body);

  fresh();
  const taken = await api("POST", "/bookings", "Sam", { ...good, title: "taken" });
  check("taken: the HRMS's 409 and its message", taken.status === 409 && taken.body.message === "Meeting Room 1 is already booked then (Sales CRM · Jalwa)", taken);
  const room = await api("POST", "/bookings", "Sam", { ...good, roomId: "r9" });
  check("a room not allowed: the HRMS's 403 and its message", room.status === 403 && /can't be booked/.test(room.body.message), room);
  const late = await api("POST", "/bookings", "Sam", { ...good, title: "late" });
  check("outside hours: the HRMS's 400 and its message", late.status === 400 && /10:00 and 19:00/.test(late.body.message), late);
  check("the failures are success:false", taken.body.success === false && room.body.success === false && late.body.success === false);

  fresh();
  const noTitle = await api("POST", "/bookings", "Sam", { ...good, title: "  " });
  const backwards = await api("POST", "/bookings", "Sam", { ...good, end: good.start });
  const noRoom = await api("POST", "/bookings", "Sam", { ...good, roomId: "" });
  const notTime = await api("POST", "/bookings", "Sam", { ...good, start: "soon" });
  check("no title / ends before it starts / no room / not a time: 400 here, the HRMS not asked",
    [noTitle, backwards, noRoom, notTime].every((x) => x.status === 400) && calls.length === 0,
    [noTitle.status, backwards.status, noRoom.status, notTime.status, calls.length]);
  check("…with a sentence", /title/i.test(noTitle.body.message) && /end after/i.test(backwards.body.message), [noTitle.body.message, backwards.body.message]);
}

section("Cancelling");
{
  fresh();
  const s = await api<{ cancelled: boolean }>("DELETE", "/bookings/bk1", "Sam");
  let c = last();
  check("200, cancelled", s.status === 200 && s.body.data?.cancelled === true, s);
  check("signed, crm, organization, the person's email, no any", c?.signed === true && c.method === "DELETE" && c.path === "/api/v1/integrations/meetings/crm-bookings/bk1"
    && c.query.crm === CRM && c.query.organizationId === ORG && c.query.bookerEmail === "sam@test.local" && !("any" in c.query), c);
  fresh();
  const a = await api("DELETE", "/bookings/bk1", "Admin");
  c = last();
  check("a Super Admin: any=1, with their own email", a.status === 200 && c?.query.any === "1" && c.query.bookerEmail === "admin@test.local", c?.query);
  const gone = await api("DELETE", "/bookings/gone", "Sam");
  check("not there: the HRMS's 404 and its message", gone.status === 404 && /isn't there/.test(gone.body.message), gone);
  const theirs = await api("DELETE", "/bookings/theirs", "Sam");
  check("someone else's: the HRMS's 403 and its message", theirs.status === 403 && /Only the person/.test(theirs.body.message), theirs);
  fresh();
  const odd = await api("DELETE", `/bookings/${encodeURIComponent("a/../b")}`, "Sam");
  check("an id that isn't one: 400, the HRMS not asked", odd.status === 400 && calls.length === 0, [odd.status, calls.length]);
}

section("View as");
{
  fresh();
  const g = await api<Day>("GET", "/day?date=2026-10-20", "ViewAs");
  check("reads the day as the person viewed (their email), not view only (2026-10-30), not a super admin",
    g.status === 200 && last()?.query.viewerEmail === "sam@test.local" && g.body.data?.you.viewOnly === false && g.body.data.you.superAdmin === false, [g.status, g.body.data?.you]);
  fresh();
  const p = await api("POST", "/bookings", "ViewAs", good);
  const d = await api("DELETE", "/bookings/bk1", "ViewAs");
  check("booking and cancelling go through, as the person viewed (2026-10-30: View as acts)", p.status === 201 && d.status === 200, [p.status, d.status, p.body.message]);
  check("…booked and cancelled in their name", calls.length === 2 && calls.every((c: any) => (c.body?.bookerEmail ?? c.query?.bookerEmail) === "sam@test.local"), calls);
}

section("The HRMS failing or out of reach");
{
  mode = "500";
  const g = await api("GET", "/day?date=2026-10-20", "Sam");
  check("the HRMS answering 500: 503 with a sentence", g.status === 503 && /isn't answering/.test(g.body.message), g);
  mode = "401";
  const p = await api("POST", "/bookings", "Sam", good);
  check("the HRMS refusing our credentials: 502, never a 401 that would sign the person out", p.status === 502 && /credentials/.test(p.body.message), p);
  mode = "ok";
  const was = env.HRMS_API_URL;
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  env.HRMS_API_URL = `http://127.0.0.1:${dead.port}`;
  dead.stop(true);
  const u1 = await api("GET", "/day?date=2026-10-20", "Sam");
  const u2 = await api("POST", "/bookings", "Sam", good);
  const u3 = await api("DELETE", "/bookings/bk1", "Sam");
  check("unreachable: 503 \"could not be reached\" for day, book and cancel",
    [u1, u2, u3].every((x) => x.status === 503 && /could not be reached/.test(x.body.message)), [u1, u2, u3].map((x) => [x.status, x.body.message]));
  env.HRMS_API_URL = was;
}

section("Not configured");
{
  const NOT_SET_UP = "Meeting rooms aren't set up on this server (HRMS settings missing)";
  for (const key of ["HRMS_API_URL", "HRMS_CLIENT_ID", "HRMS_INTEGRATION_SECRET", "HRMS_ORG_ID"] as const) {
    const was = env[key];
    env[key] = "";
    fresh();
    const g = await api("GET", "/day?date=2026-10-20", "Sam");
    const p = await api("POST", "/bookings", "Sam", good);
    const d = await api("DELETE", "/bookings/bk1", "Sam");
    check(`${key} unset: day, book and cancel say "${NOT_SET_UP}" (503), nothing sent`,
      [g, p, d].every((x) => x.status === 503 && x.body.message === NOT_SET_UP) && calls.length === 0, [g, p, d].map((x) => [x.status, x.body.message]));
    env[key] = was;
  }
  const back = await api("GET", "/day?date=2026-10-20", "Sam");
  check("set again: works", back.status === 200, back.status);
}

section("Every call the HRMS got was signed correctly");
check("no bad signatures", calls.every((c) => c.signed), calls.filter((c) => !c.signed));

server.close();
hrms.stop(true);
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
