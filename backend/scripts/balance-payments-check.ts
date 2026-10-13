/**
 * Checks the Balance payments page (the user, 2026-10-13: part-paid courses
 * followed up in the sales CRM, each payment with its receipt, approved in
 * finance), on a scratch database, through the API, against a stand-in
 * finance:
 *
 *   - Case 1: who sees what — a salesperson their own closes, a team leader
 *     their teams' (a close with no team by its closer's team), the Sales
 *     Manager and a Super Admin everyone's; only closes part paid at the close.
 *   - Case 2: what finance says — paid, left, the next due date and whether it
 *     is overdue or due soon, each payment and each balance payment with where
 *     it stands; the tabs, search, counts, and finance unreachable.
 *   - Case 3: recording a payment — sent to finance signed, to the close's own
 *     org, with its receipt and who recorded it; one id per payment; checked
 *     first (receipt, amount, method, day, id); finance's own refusals passed
 *     on; out of scope refused; finance down.
 *   - Case 4: the sidebar count; the module's permissions.
 *
 * Run by balance-payments-check.sh. Scratch database only.
 */
import crypto from "node:crypto";
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

/* ── A stand-in finance ── */
const SECRET = "balance-payments-check-secret-long-enough";
type Fin = Record<string, unknown> & { externalId: string };
const finance = new Map<string, Fin>();
const received: { org: string; body: any }[] = [];
let financeMode: "ok" | "down" = "ok";
let refuseNext: { status: number; message: string } | null = null;
const fin = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text();
    const ts = req.headers.get("x-delta-timestamp") ?? "", nonce = req.headers.get("x-delta-nonce") ?? "";
    const canonical = ["POST", url.pathname, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
    if (req.headers.get("x-delta-signature") !== crypto.createHmac("sha256", SECRET).update(canonical).digest("hex")) {
      return Response.json({ error: { message: "Bad signature" } }, { status: 401 });
    }
    if (financeMode === "down") return Response.json({ error: { message: "down" } }, { status: 503 });
    const org = req.headers.get("x-delta-org") ?? "";
    const body = JSON.parse(raw || "{}");
    if (url.pathname === "/api/v1/integrations/enrolments/status") {
      return Response.json({ data: (body.externalIds as string[]).map((id) => finance.get(`${org}:${id}`)).filter(Boolean) });
    }
    if (url.pathname === "/api/v1/integrations/enrolments/balance-payments") {
      received.push({ org, body });
      if (refuseNext) { const r = refuseNext; refuseNext = null; return Response.json({ error: { message: r.message } }, { status: r.status }); }
      return Response.json({ data: { id: "bp-fin-1", externalId: body.externalId, amountMinor: body.amountMinor, currency: "AED", method: body.method, paidOn: body.paidOn, status: "pending" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

// The routes load the push service, which wants VAPID keys the moment it loads.
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "balance-payments-check-jwt",
  JWT_REFRESH_SECRET: "balance-payments-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${fin.port}`,
  FINANCE_CLIENT_ID: "sales-crm-check",
  FINANCE_INTEGRATION_SECRET: SECRET,
  FINANCE_ORG_ID: "org-dubai",
  FINANCE_ORG_ID_BANGALORE: "org-bangalore",
  R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");

/* ── People and teams ── */
const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId(), plainRole = new Types.ObjectId(), shutRole = new Types.ObjectId(), lookRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // No value for the module: open by default, view and record.
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: {} },
  { _id: plainRole, roleName: "Team Leader", isSystemRole: false, permissions: {} },
  { _id: shutRole, roleName: "Closed", isSystemRole: false, permissions: { balancePayments: { view: false, create: false, edit: false, delete: false, approve: false, export: false } } },
  { _id: lookRole, roleName: "Look only", isSystemRole: false, permissions: { balancePayments: { view: true, create: false, edit: false, delete: false, approve: false, export: false } } },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Root", superRole], ["Sally", salesRole], ["Sam", salesRole], ["Tina", plainRole], ["Omar", salesRole], ["Mona", salesRole], ["Shut", shutRole], ["Lou", lookRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const P = (n: string) => people[n]!.id;
const alpha = new Types.ObjectId(), beta = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: alpha, name: "Alpha", status: "active", leaders: [P("Tina")], members: [P("Sally"), P("Sam")] },
  { _id: beta, name: "Beta", status: "active", leaders: [], members: [P("Omar")] },
]);
// Mona is the Sales Manager.
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: P("Mona"), excludedUsers: [] });

/* ── Days ── */
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ── Closes ── */
let n = 0;
async function close(opts: { who: string; team?: Types.ObjectId | null; pending?: number; sent?: boolean; academy?: string; fin?: Partial<Fin> | null }) {
  n++;
  const _id = new Types.ObjectId();
  await db.collection("students").insertOne({
    _id, enrollmentNumber: `ENR-${n}`, name: `Client ${n}`, phone: `+9715000${n}`, email: `client${n}@test.local`,
    leadId: new Types.ObjectId(), assignedTo: P(opts.who), team: opts.team === undefined ? null : opts.team,
    totalFee: 1000, paidAmount: 1000 - (opts.pending ?? 600), pendingAmount: opts.pending ?? 600, feeStatus: (opts.pending ?? 600) > 0 ? "partial" : "paid",
    enrollmentDate: new Date(`${plus(today, -40 + n)}T08:00:00.000Z`), academy: opts.academy ?? "dubai", status: "active",
  });
  const org = opts.academy === "bangalore" ? "org-bangalore" : "org-dubai";
  if (opts.sent !== false) {
    await db.collection("financehandovers").insertOne({ studentId: _id, status: "sent", payload: {}, academy: opts.academy ?? "dubai", financeOrgId: org, approvalState: "approved" });
  }
  if (opts.fin !== null) {
    finance.set(`${org}:${_id}`, {
      externalId: String(_id), invoiceId: `inv-${n}`, invoiceNumber: `IN-${String(n).padStart(5, "0")}`, status: "partial", approval: "approved",
      returnedReason: "", issueDate: plus(today, -30), currency: opts.academy === "bangalore" ? "INR" : "AED",
      totalMinor: 100_000, amountPaidMinor: 40_000, balanceMinor: 60_000, course: "Market Breakout", nextDueOn: plus(today, 10),
      payments: [{ amountMinor: 40_000, paidOn: plus(today, -19), method: "cash" }], balancePayments: [],
      ...(opts.fin ?? {}),
    });
  }
  return String(_id);
}
const sallyOverdue = await close({ who: "Sally", team: alpha, fin: { nextDueOn: plus(today, -2) } });
const sallySoon = await close({ who: "Sally", team: alpha, fin: {
  nextDueOn: plus(today, 2),
  balancePayments: [
    { externalId: "bp-a", amountMinor: 10_000, currency: "AED", method: "card", paidOn: plus(today, -1), status: "approved", decidedBy: "Accounts", decidedAt: new Date().toISOString(), receiptNumber: "RCT-00009" },
    { externalId: "bp-b", amountMinor: 5_000, currency: "AED", method: "cash", paidOn: plus(today, -1), status: "rejected", reason: "Receipt unreadable" },
    { externalId: "bp-c", amountMinor: 7_000, currency: "AED", method: "cash", paidOn: today, status: "pending" },
  ],
} });
const sallyPaid = await close({ who: "Sally", team: alpha, fin: { balanceMinor: 0, amountPaidMinor: 100_000, status: "paid", nextDueOn: "" } });
const sallyFull = await close({ who: "Sally", team: alpha, pending: 0 });
const samNoTeam = await close({ who: "Sam", team: null });
const samUnapproved = await close({ who: "Sam", team: alpha, fin: { approval: "pending" } });
const samNotSent = await close({ who: "Sam", team: alpha, sent: false, fin: null });
const omar = await close({ who: "Omar", team: beta, fin: { nextDueOn: plus(today, 20) } });
const omarBlr = await close({ who: "Omar", team: beta, academy: "bangalore" });
const omarWaiting = await close({ who: "Omar", team: beta, fin: { balanceMinor: 7_000, balancePayments: [{ externalId: "bp-w", amountMinor: 7_000, currency: "AED", method: "cash", paidOn: today, status: "pending" }] } });

/* ── The API ── */
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const token = (name: string) => signAccessToken({ userId: String(people[name]!.id), email: `${name.toLowerCase()}@test.local`, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: any; message?: string } };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
const ids = (a: Answer) => new Set<string>((a.body.data?.rows ?? []).map((r: any) => r.studentId));
const same = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
const list = (who: string, qs = "") => call("GET", `/balance-payments${qs ? `?${qs}` : ""}`, who);

try {
  section("Case 1 — who sees what");
  let r = await list("Sally", "state=all");
  check("a salesperson: their own part-paid closes only (paid in full at the close never listed)", r.status === 200 && same(ids(r), [sallyOverdue, sallySoon, sallyPaid]), JSON.stringify([...ids(r)]));
  r = await list("Tina", "state=all");
  check("a team leader: their team's, a close with no team by its closer's team", same(ids(r), [sallyOverdue, sallySoon, sallyPaid, samNoTeam, samUnapproved, samNotSent]), JSON.stringify([...ids(r)]));
  r = await list("Omar", "state=all");
  check("another team's salesperson: only theirs", same(ids(r), [omar, omarBlr, omarWaiting]));
  r = await list("Mona", "state=all");
  check("the Sales Manager: everyone's", ids(r).size === 9);
  r = await list("Root", "state=all");
  check("a Super Admin: everyone's", ids(r).size === 9);
  r = await list("Tina", "state=all&mine=true");
  check("\"only mine\": the team leader's own closes — none", ids(r).size === 0);

  section("Case 2 — what finance says");
  r = await list("Sally");
  const rows = r.body.data?.rows ?? [];
  check("owing by default, overdue first, then due soon", rows.map((x: any) => x.studentId).join() === [sallyOverdue, sallySoon].join(), JSON.stringify(rows.map((x: any) => x.studentId)));
  const ov = rows[0], soon = rows[1];
  check("overdue: paid, left, next due, course and invoice from finance", ov?.dueState === "overdue" && ov.invoice?.paidMinor === 40_000
    && ov.invoice?.balanceMinor === 60_000 && ov.invoice?.nextDueOn === plus(today, -2) && ov.course === "Market Breakout" && ov.invoice?.number === "IN-00001"
    && ov.closedBy?.name === "Sally" && ov.team === "Alpha" && ov.canRecord === true, JSON.stringify(ov));
  check("due in 2 days: due soon; each balance payment approved / rejected / pending; what waits", soon?.dueState === "due_soon"
    && soon.balancePayments.map((b: any) => b.status).join() === "approved,rejected,pending" && soon.balancePayments[1].reason === "Receipt unreadable"
    && soon.balancePayments[0].receiptNumber === "RCT-00009" && soon.waitingMinor === 7_000, JSON.stringify(soon));
  const c = r.body.data?.counts;
  check("counts across the whole scope", c?.owing === 2 && c.overdue === 1 && c.dueSoon === 1 && c.waiting === 1 && c.paidOff === 1
    && c.left?.[0]?.currency === "AED" && c.left[0].balanceMinor === 120_000, JSON.stringify(c));
  r = await list("Sally", "state=paid");
  check("Paid off: the one finance says is paid", same(ids(r), [sallyPaid]) && r.body.data.rows[0].canRecord === false && r.body.data.rows[0].whyNot === "Paid in full");
  r = await list("Tina", "state=all");
  const byId = new Map<string, any>((r.body.data?.rows ?? []).map((x: any) => [x.studentId, x]));
  check("not approved by finance yet: listed, can't record yet", byId.get(samUnapproved)?.canRecord === false && /approved/.test(byId.get(samUnapproved)?.whyNot ?? ""));
  check("not in finance yet: listed, can't record", byId.get(samNotSent)?.invoice === null && byId.get(samNotSent)?.whyNot === "Not in finance yet");
  r = await list("Omar", "state=all");
  const om = new Map<string, any>((r.body.data?.rows ?? []).map((x: any) => [x.studentId, x]));
  check("a Bangalore close: asked of the Bangalore org, in rupees", om.get(omarBlr)?.invoice?.currency === "INR", JSON.stringify(om.get(omarBlr)?.invoice));
  check("the rest already waiting for finance: can't record more", om.get(omarWaiting)?.canRecord === false && /waiting/.test(om.get(omarWaiting)?.whyNot ?? ""));
  check("due in 20 days: later", om.get(omar)?.dueState === "later");
  r = await list("Mona", "state=all&search=Client%202");
  check("search by name", same(ids(r), [sallySoon]), JSON.stringify([...ids(r)]));
  financeMode = "down";
  r = await list("Sally");
  check("finance unreachable: the closes still listed, saying so", r.status === 200 && r.body.data?.reachable === false && ids(r).size === 3
    && r.body.data.rows.every((x: any) => x.canRecord === false && x.whyNot === "Finance could not be reached"), JSON.stringify(r.body.data?.rows?.[0]));
  financeMode = "ok";

  section("Case 3 — recording a payment");
  const receipt = { name: "receipt.jpg", url: "https://files.test.local/balance-receipts/r.jpg", key: "balance-receipts/r.jpg", size: 1200, mimeType: "image/jpeg" };
  const good = { key: "k1234567890", amount: 250.5, method: "bank_transfer", paidOn: plus(today, -1), receipt, note: "Second instalment" };
  r = await call("POST", `/balance-payments/${sallyOverdue}`, "Sally", good);
  const sent = received.at(-1);
  check("sent to finance: the close, the payment's own id, minor units, the receipt, who recorded it", r.status === 201 && r.body.data?.status === "pending"
    && sent?.org === "org-dubai" && sent.body.source === "crm" && sent.body.enrolmentExternalId === sallyOverdue && sent.body.externalId === "bp-k1234567890"
    && sent.body.amountMinor === 25_050 && sent.body.method === "bank_transfer" && sent.body.paidOn === plus(today, -1) && sent.body.receipt?.url === receipt.url
    && sent.body.note === "Second instalment" && sent.body.recordedBy?.name === "Sally" && sent.body.recordedBy?.email === "sally@test.local", `${r.status} ${JSON.stringify(sent)}`);
  r = await call("POST", `/balance-payments/${sallyOverdue}`, "Sally", good);
  check("saved twice: the same id, so finance keeps one", received.at(-1)?.body.externalId === "bp-k1234567890");
  r = await call("POST", `/balance-payments/${omarBlr}`, "Omar", { ...good, key: "kblr12345678" });
  check("a Bangalore close: to the Bangalore org", r.status === 201 && received.at(-1)?.org === "org-bangalore");
  r = await call("POST", `/balance-payments/${samNoTeam}`, "Tina", { ...good, key: "ktina1234567" });
  check("a team leader records one for their team", r.status === 201 && received.at(-1)?.body.recordedBy?.name === "Tina");
  const before = received.length;
  for (const [label, body] of [
    ["no receipt", { ...good, key: "kbad0000001", receipt: undefined }],
    ["a receipt with no stored file", { ...good, key: "kbad0000002", receipt: { name: "x", url: "", key: "" } }],
    ["no amount", { ...good, key: "kbad0000003", amount: 0 }],
    ["three decimals", { ...good, key: "kbad0000004", amount: 10.555 }],
    ["an unknown method", { ...good, key: "kbad0000005", method: "crypto" }],
    ["a day in the future", { ...good, key: "kbad0000006", paidOn: plus(today, 2) }],
    ["not a day", { ...good, key: "kbad0000007", paidOn: "yesterday" }],
    ["no payment id", { ...good, key: "" }],
  ] as const) {
    r = await call("POST", `/balance-payments/${sallyOverdue}`, "Sally", body);
    check(`refused here: ${label}`, r.status === 400, `${r.status} ${r.body.message}`);
  }
  check("…and none reached finance", received.length === before);
  r = await call("POST", `/balance-payments/${omar}`, "Sally", { ...good, key: "kother123456" });
  check("someone else's close: not found", r.status === 404);
  r = await call("POST", `/balance-payments/${samNotSent}`, "Sam", { ...good, key: "knotsent1234" });
  check("a close not in finance yet: refused", r.status === 409 && /isn't in finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  refuseNext = { status: 409, message: "AED 700.00 is more than the AED 600.00 left on invoice IN-00001" };
  r = await call("POST", `/balance-payments/${sallyOverdue}`, "Sally", { ...good, key: "ktoomuch1234", amount: 700 });
  check("finance's own refusal, word for word", r.status === 409 && r.body.message === "AED 700.00 is more than the AED 600.00 left on invoice IN-00001", `${r.status} ${r.body.message}`);
  financeMode = "down";
  r = await call("POST", `/balance-payments/${sallyOverdue}`, "Sally", { ...good, key: "kdown1234567" });
  check("finance down: 502, try again", r.status === 502, `${r.status} ${r.body.message}`);
  financeMode = "ok";
  r = await call("POST", `/balance-payments/${sallyOverdue}/receipt`, "Sally");
  check("a receipt upload with no file: refused", r.status === 400 || r.status === 503, `${r.status}`);

  section("Case 4 — the sidebar and the module");
  r = await call("GET", "/balance-payments/count", "Sally");
  check("Sally: 2 due (one overdue, one in 2 days)", r.body.data?.due === 2, JSON.stringify(r.body));
  r = await call("GET", "/balance-payments/count", "Omar");
  check("Omar: none due within 3 days", r.body.data?.due === 0, JSON.stringify(r.body));
  r = await call("GET", "/balance-payments/count", "Tina");
  check("Tina: her team's 2", r.body.data?.due === 2, JSON.stringify(r.body));
  r = await list("Shut");
  check("a role with the box unticked: no page", r.status === 403);
  r = await call("GET", "/balance-payments", "Lou");
  check("view only: sees the page…", r.status === 200);
  r = await call("POST", `/balance-payments/${sallyOverdue}`, "Lou", { ...good, key: "klou12345678" });
  check("…but can't record one", r.status === 403);
} finally {
  server.close();
  fin.stop(true);
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
