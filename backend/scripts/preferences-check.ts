/**
 * Checks the per-person currency (GET / PUT /api/v1/auth/preferences, 2026-10-15) on a scratch database: kept on the
 * person's own account and read back on any device, only the currencies the app offers, nobody else's touched, and
 * only by the person themself — signed out 401, deactivated 403, and a "View as" pass can read but never write (where
 * this CRM has View as).
 *
 *   - Case 1: never picked → null; pick AED → saved, read back, on the profile too; another person untouched;
 *   - Case 2: every offered currency saves and reads back; the same twice is fine; a new account starts with none; the
 *     newest pick wins by when it was picked — one sent late (picked an hour ago), older than what's kept, isn't kept;
 *   - Case 3: nothing, an unknown code, lower case, null, a list, an extra field, a bad "picked ago" → 400, and nothing
 *     changes;
 *   - Case 4: signed out / a bad token → 401, deactivated → 403, a View-as pass → reads, can't write (403).
 *
 * Run by preferences-check.sh. Scratch database only.
 */
import { existsSync } from "node:fs";
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

// Throwaway settings, for this check only. Some sign-in code loads the push service, which wants VAPID keys.
const webpush = (await import("web-push")).default;
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  JWT_SECRET: "preferences-check-throwaway-access-secret-01",
  JWT_REFRESH_SECRET: "preferences-check-throwaway-refresh-secret-1",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const express = (await import("express")).default;
const authRoutes = (await import("../src/routes/authRoutes.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const jwtUtils = await import("../src/utils/jwt.js");
const app = express();
app.use(express.json());
app.use("/api/v1/auth", authRoutes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

interface Body<T> { success: boolean; message: string; data: T }
async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: Body<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body<T> };
}

const adminRole = new Types.ObjectId(), staffRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: adminRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: staffRole, roleName: "Sales Staff", isSystemRole: false, permissions: {} },
]);
const ids: Record<string, Types.ObjectId> = {};
const tokens: Record<string, string> = {};
async function person(name: string, role: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  const email = `${name.toLowerCase()}@prefs.test`;
  await db.collection("users").insertOne({ _id, name, email, password: "x", role, status: "active", ...extra });
  ids[name] = _id;
  tokens[name] = jwtUtils.signAccessToken({ userId: String(_id), email, roleId: String(role) });
}
await person("Admin", adminRole);
await person("Ann", staffRole);
await person("Ben", staffRole);
await person("Off", staffRole, { status: "inactive" });
const currencyOf = async (name: string) => (await db.collection("users").findOne({ _id: ids[name] }))?.currency ?? null;
type Prefs = { currency: string | null; currencyAt?: string | null; applied?: boolean };

section("Case 1 — kept on the person's own account");
{
  const first = await api<Prefs>("GET", "/preferences", tokens.Ann);
  check("never picked → null", first.status === 200 && first.body.data?.currency === null, first);
  const put = await api<Prefs>("PUT", "/preferences", tokens.Ann, { currency: "AED" });
  check("picks AED → 200, AED", put.status === 200 && put.body.data?.currency === "AED", put);
  const again = await api<Prefs>("GET", "/preferences", tokens.Ann);
  check("…read back on another device (another request): AED, with when it was picked", again.body.data?.currency === "AED" && !!again.body.data?.currencyAt && (await currencyOf("Ann")) === "AED", again.body.data);
  const profile = await api<{ currency?: string }>("GET", "/profile", tokens.Ann);
  check("…and on the profile", profile.status === 200 && profile.body.data?.currency === "AED", profile.body.data?.currency);
  check("someone else's stays as it was (none)", (await currencyOf("Ben")) === null && (await api<Prefs>("GET", "/preferences", tokens.Ben)).body.data?.currency === null);
}

section("Case 2 — every currency the app offers");
{
  const offered = ["USD", "INR", "EUR", "GBP", "AED", "SAR", "CAD", "AUD", "SGD", "JPY", "MYR"];
  const results = [];
  for (const c of offered) {
    const r = await api<Prefs>("PUT", "/preferences", tokens.Ben, { currency: c });
    results.push(r.status === 200 && r.body.data?.currency === c && (await currencyOf("Ben")) === c);
  }
  check("all 11 save and read back", results.every(Boolean), results);
  const twice = [await api("PUT", "/preferences", tokens.Ben, { currency: "INR" }), await api("PUT", "/preferences", tokens.Ben, { currency: "INR" })];
  check("the same twice → 200 both times", twice.every((r) => r.status === 200) && (await currencyOf("Ben")) === "INR");
  await person("New", staffRole);
  check("a new account starts with none", (await api<Prefs>("GET", "/preferences", tokens.New)).body.data?.currency === null);

  // The newest pick wins, by when it was picked: a pick saved late (the app was offline) after a newer one isn't kept.
  const late = await api<Prefs>("PUT", "/preferences", tokens.Ann, { currency: "EUR", pickedAgoMs: 3_600_000 });
  check("a pick made an hour ago, sent now, after AED was picked → not kept (applied false), AED stays", late.status === 200 && late.body.data?.applied === false && late.body.data?.currency === "AED" && (await currencyOf("Ann")) === "AED", late.body.data);
  const recent = await api<Prefs>("PUT", "/preferences", tokens.Ann, { currency: "SGD", pickedAgoMs: 0 });
  check("…one picked just now (0 ms ago) → kept", recent.body.data?.applied === true && (await currencyOf("Ann")) === "SGD", recent.body.data);
  const saved = Date.parse(recent.body.data?.currencyAt ?? "");
  const now = await api<Prefs>("PUT", "/preferences", tokens.Ann, { currency: "GBP" });
  check("…one sent at once (no time) is now — kept, and dated by this server", now.body.data?.applied === true && Date.parse(now.body.data?.currencyAt ?? "") >= saved && Date.parse(now.body.data?.currencyAt ?? "") <= Date.now() + 1000, now.body.data);
  const back = await api<Prefs>("PUT", "/preferences", tokens.Ann, { currency: "AED" });
  check("…so the next pick still wins", back.body.data?.applied === true && (await currencyOf("Ann")) === "AED", back.body.data);
}

section("Case 3 — only what the app offers");
{
  for (const [label, body] of [
    ["nothing", {}],
    ["an unknown code (XYZ)", { currency: "XYZ" }],
    ["lower case (aed)", { currency: "aed" }],
    ["null", { currency: null }],
    ["a list", { currency: ["AED"] }],
    ["an extra field", { currency: "EUR", theme: "dark" }],
    ["a number", { currency: 840 }],
    ["picked a negative time ago", { currency: "EUR", pickedAgoMs: -5 }],
    ["picked a fraction of a ms ago", { currency: "EUR", pickedAgoMs: 1.5 }],
    ["picked \"an hour\" ago (text)", { currency: "EUR", pickedAgoMs: "3600000" }],
    ["picked over a year ago", { currency: "EUR", pickedAgoMs: 367 * 86_400_000 }],
    ["the old pickedAt", { currency: "EUR", pickedAt: new Date().toISOString() }],
  ] as const) {
    const r = await api("PUT", "/preferences", tokens.Ann, body);
    check(`${label} → 400`, r.status === 400, r.status);
  }
  check("…and Ann's is still AED", (await currencyOf("Ann")) === "AED");
}

section("Case 4 — only the person themself");
{
  check("signed out: GET 401, PUT 401", (await api("GET", "/preferences", null)).status === 401 && (await api("PUT", "/preferences", null, { currency: "EUR" })).status === 401);
  check("a bad token → 401", (await api("PUT", "/preferences", "not-a-token", { currency: "EUR" })).status === 401);
  const off = await api("PUT", "/preferences", tokens.Off, { currency: "EUR" });
  check("deactivated → 403, nothing saved", off.status === 403 && (await currencyOf("Off")) === null, off.status);
  // View as — where this CRM has it: the pass reads the person's own, and can never change it.
  if (existsSync(new URL("../src/models/Impersonation.ts", import.meta.url))) {
    const session = new Types.ObjectId();
    await db.collection("impersonations").insertOne({ _id: session, admin: ids.Admin, adminEmail: "admin@prefs.test", target: ids.Ann, targetEmail: "ann@prefs.test", startedAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60_000), endedAt: null, ip: "", userAgent: "", device: "" });
    const signPass = (jwtUtils as unknown as { signImpersonationToken: (p: unknown, iat: number) => string }).signImpersonationToken;
    const pass = signPass({ userId: String(ids.Ann), email: "ann@prefs.test", roleId: String(staffRole), impersonation: { id: String(session), by: String(ids.Admin) } }, Math.floor(Date.now() / 1000));
    const read = await api<Prefs>("GET", "/preferences", pass);
    const write = await api("PUT", "/preferences", pass, { currency: "EUR" });
    check("a View-as pass: reads Ann's (AED), can't change it (403)", read.status === 200 && read.body.data?.currency === "AED" && write.status === 403 && (await currencyOf("Ann")) === "AED", [read.status, write.status]);
  } else {
    console.log("  (this CRM has no View as — skipped)");
  }
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
