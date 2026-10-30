/**
 * A Super Admin acting through "View as" (the owner, 2026-10-30: "super admin can impersonate and do the actions"):
 *
 *   - Case 1: a change goes through, made as the person viewed — a lead's status, a note — and the line written on the
 *     lead says who really did it ("(by Admin using View as)"); the session keeps a record of each change.
 *   - Case 2: the person's own account is still out of reach — password, settings, signing out, their WhatsApp link.
 *   - Case 3: the same change made by the person themselves carries no note; an ended or expired session is refused.
 *
 * Run by view-as-acting-check.sh (a throwaway mongod). Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a local scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  JWT_SECRET: "view-as-check-throwaway-access-secret-0001",
  JWT_REFRESH_SECRET: "view-as-check-throwaway-refresh-secret-01",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", WHATSAPP: "off",
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const jwtUtils = await import("../src/utils/jwt.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

type Ans = { status: number; body: { success?: boolean; message?: string; data?: any } };
async function api(method: string, path: string, token: string, body?: unknown): Promise<Ans> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Ans["body"] };
}

const adminRole = new Types.ObjectId(), staffRole = new Types.ObjectId();
const perms = { leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false }, whatsapp: { view: true, create: true, edit: false, delete: false, approve: false, export: false } };
await db.collection("roles").insertMany([
  { _id: adminRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staffRole, roleName: "Sales Staff", isSystemRole: false, permissions: perms },
]);
const admin = new Types.ObjectId(), ann = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: admin, name: "Admin", email: "admin@va.test", password: "x", role: adminRole, status: "active" },
  { _id: ann, name: "Ann", email: "ann@va.test", password: "x", role: staffRole, status: "active" },
]);
const leadId = new Types.ObjectId();
await db.collection("leads").insertOne({ _id: leadId, name: "Client One", phone: "+971501112233", status: "assigned", assignedTo: ann, reporter: ann, activityLogs: [], notes: [], createdAt: new Date(), updatedAt: new Date() });

const session = new Types.ObjectId();
await db.collection("impersonations").insertOne({ _id: session, admin, adminEmail: "admin@va.test", target: ann, targetEmail: "ann@va.test", startedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60_000), endedAt: null, ip: "", userAgent: "", device: "", actions: [] });
const signPass = (jwtUtils as unknown as { signImpersonationToken: (p: unknown, iat: number) => string }).signImpersonationToken;
const pass = signPass({ userId: String(ann), email: "ann@va.test", roleId: String(staffRole), impersonation: { id: String(session), by: String(admin) } }, Math.floor(Date.now() / 1000));
const annToken = jwtUtils.signAccessToken({ userId: String(ann), email: "ann@va.test", roleId: String(staffRole) });
const lead = () => db.collection("leads").findOne({ _id: leadId }) as Promise<any>;

try {
  section("Case 1 — acting as Ann");
  let r = await api("PATCH", `/leads/${leadId}/status`, pass, { status: "lost", lostReason: "other", lostNotes: "looking for the digital marketing course" });
  let l = await lead();
  check("a status change goes through (was View only)", r.status === 200 && l?.status === "lost", [r.status, r.body.message]);
  const statusLog = (l?.activityLogs ?? []).at(-1);
  check("…made as Ann", String(statusLog?.performedBy) === String(ann), statusLog);
  check("…and the lead's line says who really did it", /\(by Admin using View as\)$/.test(statusLog?.description ?? ""), statusLog?.description);
  r = await api("POST", `/leads/${leadId}/notes`, pass, { content: "Called — call back next week" });
  l = await lead();
  check("adding a note goes through, written as Ann", r.status < 300 && (l?.notes ?? []).some((n: any) => n.content === "Called — call back next week" && String(n.author) === String(ann)), [r.status, r.body.message]);
  check("…its line on the lead says View as too", (l?.activityLogs ?? []).some((a: any) => a.action === "note_added" && /using View as\)$/.test(a.description)), (l?.activityLogs ?? []).map((a: any) => a.description));
  await new Promise((res) => setTimeout(res, 150));
  const s = await db.collection("impersonations").findOne({ _id: session });
  check("the session records each change: what, how it went, when", (s?.actions ?? []).length === 2 && s!.actions[0].method === "PATCH" && s!.actions[0].path === `/api/v1/leads/${leadId}/status` && s!.actions[0].status === 200 && s!.actions[0].at instanceof Date, s?.actions);
  r = await api("GET", `/leads/${leadId}`, pass);
  await new Promise((res) => setTimeout(res, 100));
  check("reading isn't recorded as a change", r.status === 200 && ((await db.collection("impersonations").findOne({ _id: session }))?.actions ?? []).length === 2);

  section("Case 2 — Ann's own account stays out of reach");
  const blocked: [string, string, unknown][] = [
    ["PUT", "/auth/change-password", { currentPassword: "x", newPassword: "Newpass-123" }],
    ["PUT", "/auth/preferences", { currency: "EUR" }],
    ["POST", "/auth/logout", {}],
    ["POST", "/whatsapp/connect", {}],
    ["POST", "/whatsapp/disconnect", {}],
  ];
  for (const [m, p, b] of blocked) {
    r = await api(m, p, pass, b);
    check(`${m} ${p}: refused (403), her account`, r.status === 403 && /Not while viewing as someone/.test(r.body.message ?? ""), [r.status, r.body.message]);
  }

  section("Case 3 — Ann herself; an ended session");
  r = await api("PATCH", `/leads/${leadId}/status`, annToken, { status: "assigned" });
  l = await lead();
  check("Ann's own change carries no View-as note", r.status === 200 && !/View as/.test((l?.activityLogs ?? []).at(-1)?.description ?? ""), (l?.activityLogs ?? []).at(-1)?.description);
  await db.collection("impersonations").updateOne({ _id: session }, { $set: { endedAt: new Date() } });
  r = await api("PATCH", `/leads/${leadId}/status`, pass, { status: "lost", lostReason: "other" });
  check("an ended session: refused (401), nothing changed", r.status === 401 && (await lead())?.status === "assigned", [r.status, r.body.message]);
} finally {
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
