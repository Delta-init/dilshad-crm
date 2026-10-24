/**
 * Repeat leads, the rest of the doors (the user, 2026-10-23: "2" — keep the team leader's Repeat leads, and add):
 *   Case 1  happy path   the sheet matches a number on its last 9 digits ("+971 50 …", "0501…", "00971…" are one
 *                        person): held for the team leader, never a second lead; Root's batch the same
 *   Case 2  edge         an Excel upload: a known number held for its team leader (not refused), a new one created;
 *                        a known number with no owner or team split again; a short number matches only itself; two
 *                        copies of a number — the one marked "repeated" is the last choice
 *   Case 3  errors       adding a known number by hand: 409 saying it went to the team leader, no second lead
 *   Case 4  permission   the sheet without its key: 401
 *
 * Run by repeat-extras-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "repeat-extras-check-jwt-0123456789", JWT_REFRESH_SECRET: "repeat-extras-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
  WHATSAPP_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "", WHATSAPP_ACCESS_TOKEN: "",
  SHEETS_API_KEY: "repeat-extras-check-sheets-key", SUPER_ADMIN_EMAIL: "root@test.local",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("not a local database");
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");

const admin = new Types.ObjectId(), agent = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: agent, roleName: "Sales Agent", isSystemRole: false, permissions: { leads: { view: true, create: true, edit: true } } },
]);
const root = new Types.ObjectId(), tara = new Types.ObjectId(), ann = new Types.ObjectId(), ben = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: root, name: "Root", email: "root@test.local", password: "x", role: admin, status: "active" },
  { _id: tara, name: "Tara Lead", email: "tara@test.local", password: "x", role: agent, status: "active" },
  { _id: ann, name: "Ann", email: "ann@test.local", password: "x", role: agent, status: "active" },
  { _id: ben, name: "Ben", email: "ben@test.local", password: "x", role: agent, status: "active" },
]);
const team = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: team, name: "Falcons", status: "active", members: [ann, ben], leaders: [tara], settings: { autoAssign: false } });

const longAgo = new Date(Date.now() - 20 * 86_400_000);
let n = 0;
async function lead(o: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: `L${++n}`, phone: `+97150${1000000 + n}`, email: `l${n}@test.local`, source: "META", status: "followup", assignedTo: ann, assignedAt: longAgo,
    team, reporter: root, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0,
    createdAt: longAgo, updatedAt: longAgo, ...o,
  });
  return _id;
}
const read = async (id: Types.ObjectId) => (await Lead.collection.findOne({ _id: id }))!;
const leadsWith = async (tail: string) => (await Lead.collection.find({}).toArray()).filter((l) => String(l.phone).replace(/\D/g, "").endsWith(tail));
const heldByTara = async (id: Types.ObjectId) => { const l = await read(id); return String(l.assignedTo) === String(tara) && l.repeat?.waiting === true && (l.repeatCount ?? 0) >= 1; };

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const tokenOf = (u: Types.ObjectId, r: Types.ObjectId, email: string) => signAccessToken({ userId: String(u), email, roleId: String(r) });
const ROOT = tokenOf(root, admin, "root@test.local"), BEN = tokenOf(ben, agent, "ben@test.local");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const isForm = body instanceof FormData;
  const r = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method, headers: { ...(isForm || body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const sheet = (row: Json, key = "repeat-extras-check-sheets-key") => call("POST", "/sheets/sync", row, { "x-api-key": key });

section("Case 1 — the sheet: the same number typed another way");
{
  const id = await lead({ phone: "+971 50 123 4567" });
  const r = await sheet({ full_name: "Asha again", phone_number: "p:0501234567", platform: "ig" });
  check("answered as a duplicate with the existing lead's id (Root's counts hold)", r.status === 200 && r.body.data?.duplicate === true && r.body.data?.leadId === String(id), r.body);
  check("…held for the team leader (Tara), counted", await heldByTara(id), await read(id));
  check("…no second lead for that number", (await leadsWith("501234567")).length === 1);
}
{
  const id = await lead({ phone: "0502220005", assignedTo: ben });
  const r = await call("POST", "/sheets/sync/batch", { rows: [
    { full_name: "Known", phone_number: "00971502220005" },
    { full_name: "Brand new", phone_number: "+971509990001" },
  ] }, { "x-api-key": "repeat-extras-check-sheets-key" });
  const res = r.body.data?.results ?? [];
  check("Root's batch: the known number (00971…) a duplicate of its lead, the new one created", r.status === 201
    && res[0]?.status === "duplicate" && res[0]?.leadId === String(id) && res[1]?.status === "created", res);
  check("…and held for Tara", await heldByTara(id));
}

section("Case 2 — an upload, short numbers, copies");
{
  const known = await lead({ phone: "+971502220006", status: "callback" });
  const orphan = await lead({ phone: "+971502220016", assignedTo: null, team: null, status: "new" });
  const csv = "Name,Phone,Source\nKnown again,0502220006,EXCEL\nFresh one,+971509990002,EXCEL\nNobody's,971502220016,EXCEL\n";
  const fd = new FormData();
  fd.append("file", new Blob([csv], { type: "text/csv" }), "leads.csv");
  const r = await call("POST", "/leads/upload", fd, { authorization: `Bearer ${ROOT}` });
  const d = r.body.data ?? {};
  const det = (d.repeatDetails ?? []) as Json[];
  check("the new row created; the two known ones came in again — not refused as invalid", r.status === 201 && d.created === 1 && d.cameAgain === 2 && d.invalid === 0, d);
  check("…the known one held for Tara, the upload says so", await heldByTara(known)
    && /sent to the team leader to verify/.test(det.find((x) => x.leadId === String(known))?.message ?? ""), det);
  check("…the one nobody held: split again, the upload says so", det.find((x) => x.leadId === String(orphan))?.outcome === "split"
    && /split again/.test(det.find((x) => x.leadId === String(orphan))?.message ?? ""), det);
  check("…no second lead for either", (await leadsWith("502220006")).length === 1 && (await leadsWith("502220016")).length === 1);
}
{
  const id = await lead({ phone: "12345" });
  const r = await sheet({ full_name: "Short", phone_number: "12345" });
  const r2 = await sheet({ full_name: "Short2", phone_number: "912345" });
  check("a number shorter than 9 digits matches only itself exactly", r.body.data?.leadId === String(id) && r.body.data?.duplicate === true && r2.body.data?.duplicate === false, [r.body.data, r2.body.data]);
}
{
  const copy = await lead({ phone: "+971502220004", status: "repeated", updatedAt: new Date() });
  const real = await lead({ phone: "0502220004", status: "followup", assignedTo: ben, updatedAt: longAgo });
  const r = await sheet({ full_name: "Two copies", phone_number: "+971 50 222 0004" });
  check("two copies of a number: the one marked Repeated is the last choice", r.body.data?.leadId === String(real) && (await read(copy)).status === "repeated", r.body.data);
}

section("Case 3 — adding a known number by hand");
{
  const known = await lead({ phone: "+971502220007" });
  const r = await call("POST", "/leads", { name: "Typed again", phone: "050 222 0007", source: "WALK-IN" }, { authorization: `Bearer ${BEN}` });
  check("409, saying it went to the team leader", r.status === 409 && /team leader/.test(r.body.message ?? ""), r);
  check("…no second lead; held for Tara", (await leadsWith("502220007")).length === 1 && await heldByTara(known));
  const fresh = await call("POST", "/leads", { name: "Brand new by hand", phone: "+971509990003", source: "WALK-IN" }, { authorization: `Bearer ${BEN}` });
  check("a new number by hand: created as before", fresh.status === 201, fresh.status);
}

section("Case 4 — permission");
check("the sheet without its key: 401", (await sheet({ full_name: "X", phone_number: "+971501234567" }, "wrong-key")).status === 401);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
