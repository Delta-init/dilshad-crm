/**
 * Checks correcting an enrolment finance sent back (the user, 2026-10-05: "if
 * send it back we can edit the course and amount also, all details"), on a
 * scratch database, through the API, against a stand-in finance:
 *
 *   - Case 1: nothing to correct until finance sends it back;
 *   - Case 2: the closer corrects everything — client, course, fee, date,
 *     payments with their receipts, language, bonus, notes — and it goes to
 *     finance again in the same step, as the same enrolment; the lead's
 *     payments follow, its own left alone;
 *   - Case 3: what can't be right is refused, with nothing changed and nothing sent;
 *   - Case 4: who may correct, and who may move a sale to another counsellor or team;
 *   - Case 5: sent back a moment ago — finance says so before the outbox has heard;
 *   - Case 6: an enrolment from before payments were listed, "Send again" as it
 *     was, and the receipt upload a correction uses;
 *   - Case 7: what the form starts from, and "sent again" shown once it was
 *     (the user, 2026-10-05: "if send again show that also");
 *   - Case 8: a payment in another currency, corrected — what was handed over,
 *     its rate, and the AED it came to, as at the close;
 *   - Case 9: the Bangalore academy (2026-10-10) — billed in Bangalore's
 *     finance organization, and every later call about it (delivery, the
 *     decision poll, My Enrolments, its page, the send-back check, "Send
 *     again", the correction) made there too; the academy can't be corrected;
 *     refused without the Bangalore organization; the course mapping's
 *     Bangalore section and its catalogue;
 *   - Case 10: a close that went without the client's email (2026-10-10) —
 *     refused by finance's intake, it can't be corrected; adding the email
 *     (POST /students/:id/enrolment/email) sends it again at once as the same
 *     enrolment, to the organization on its row; refused for one finance has,
 *     an invalid email (finance's own check: `a@b.c` too), one failed for
 *     another reason, and by who may not; "Send again" refused for it until the
 *     email is added; the field filled in with an email finance would take
 *     that the CRM has (the enrolment's, else the lead's) — never sent by itself;
 *   - Case 11: one email, one client (2026-10-10), Halif's case — a client
 *     closed before the rule with another client's address, sent back: the
 *     correction keeping it, "Send again" as it stands, and one with an address
 *     another lead holds are refused (409, naming the holder), nothing changed
 *     or sent; corrected with his own address it goes again as the same
 *     enrolment; another enrolment of the same client's is no other client;
 *     the add-email refuses a taken address, and its field never starts from one.
 *
 * The Remote CRM's copy of the Sales CRM's check.
 *
 * Run by enrolment-correction-check.sh. Scratch database only.
 */
import http from "node:http";
import { Types } from "mongoose";
import { z } from "zod";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ok: () => Promise<boolean> | boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok()) return true;
    await sleep(50);
  }
  return false;
}

// ── A stand-in finance: takes enrolments, and says what became of them ──────
// Like finance, it keeps each enrolment in the organization it was sent to,
// and answers a status call only for that organization's own (x-delta-org).
const DUBAI_ORG = "org-correction-check", BLR_ORG = "org-bangalore-check";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delivered: any[] = [];
const approvalOf = new Map<string, string>();
const orgOfId = new Map<string, string>();
const statusCalls: { org: string; ids: string[] }[] = [];
const itemsAsked: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refusedSends: any[] = [];
const finance = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const org = String(req.headers["x-delta-org"] ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/integrations/enrolments") {
      // As finance's intake does — its zod 3 `z.string().email()`, the same pattern as zod 4's
      // `z.email()` here: no valid client email, no enrolment (422, "Request validation failed").
      if (!z.email().safeParse(body?.customer?.email).success) {
        refusedSends.push({ ...body, _org: org });
        res.statusCode = 422;
        res.end(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: { customer: ["Invalid email address"] } } }));
        return;
      }
      delivered.push({ ...body, _org: org });
      orgOfId.set(String(body.externalId), org);
      res.end(JSON.stringify({ data: { invoiceId: `inv-${body.externalId}`, invoiceNumber: `INV-${String(body.externalId).slice(-4)}`, customerId: "cust", duplicate: false, flags: [] } }));
      return;
    }
    if (req.url === "/api/v1/integrations/items") {
      itemsAsked.push(org);
      res.end(JSON.stringify({ data: [{ id: org === BLR_ORG ? "b".repeat(24) : "a".repeat(24), name: org === BLR_ORG ? "MBT Bangalore" : "MBT Dubai", sku: "MBT", unitPriceMinor: 100, type: "service" }] }));
      return;
    }
    if (req.url === "/api/v1/integrations/enrolments/status") {
      statusCalls.push({ org, ids: body.externalIds ?? [] });
      const ids = ((body.externalIds ?? []) as string[]).filter((id) => approvalOf.has(id) && (orgOfId.get(id) ?? DUBAI_ORG) === org);
      res.end(JSON.stringify({
        data: ids.map((id) => ({
          externalId: id, invoiceId: `inv-${id}`, invoiceNumber: `INV-${id.slice(-4)}`, status: "sent",
          approval: approvalOf.get(id), returnedReason: approvalOf.get(id) === "returned" ? "Wrong course" : "",
          issueDate: "2026-10-05", currency: "AED", totalMinor: 0, amountPaidMinor: 0, balanceMinor: 0,
        })),
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => finance.listen(0, "127.0.0.1", () => r()));
const financePort = (finance.address() as { port: number }).port;
const sendsFor = (id: string) => delivered.filter((d) => d.externalId === id);

// The routes load the push service, which wants VAPID keys the moment it loads.
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "enrolment-correction-check-jwt",
  JWT_REFRESH_SECRET: "enrolment-correction-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${financePort}`,
  FINANCE_CLIENT_ID: "crm-correction-check",
  FINANCE_INTEGRATION_SECRET: "correction-check-secret-correction-check-secret",
  FINANCE_ORG_ID: DUBAI_ORG,
  FINANCE_ORG_ID_BANGALORE: BLR_ORG,
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { Course } = await import("../src/models/Course.js");
const { Student } = await import("../src/models/Student.js");
const { Lead } = await import("../src/models/Lead.js");
const { FinanceHandover } = await import("../src/models/FinanceHandover.js");
const { signAccessToken } = await import("../src/utils/jwt.js");

// ── People, teams, courses ──────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), managerRole = new Types.ObjectId(), viewerRole = new Types.ObjectId();
const all = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // Closes leads and corrects their own sales; may not edit students at large.
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { students: { ...all, edit: false }, leads: all, enrolments: all } },
  // Edits any student, adds none.
  { _id: managerRole, roleName: "Manager", isSystemRole: false, permissions: { students: { ...all, create: false }, enrolments: all } },
  { _id: viewerRole, roleName: "Viewer", isSystemRole: false, permissions: { students: { ...all, create: false, edit: false } } },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Abrar", superRole], ["Theertha", bdeRole], ["Nikhil", bdeRole], ["Maya", managerRole], ["Vera", viewerRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const teamA = new Types.ObjectId(), teamB = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: teamA, name: "Team A", status: "active", leaders: [], members: [people.Theertha!.id, people.Nikhil!.id] },
  { _id: teamB, name: "Team B", status: "active", leaders: [], members: [] },
]);
const course500 = await Course.create({ name: "COURSE 500", amount: 500 });
const course1000 = await Course.create({ name: "COURSE 1000", amount: 1000 });

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
const token = (name: string) => signAccessToken({ userId: String(people[name]!.id), email: `${name.toLowerCase()}@test.local`, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: Record<string, unknown>; message?: string } };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}

const receipt = (name: string) => ({ name: `${name}.jpg`, url: `https://files.test.local/receipts/${name}.jpg`, key: `receipts/${name}.jpg`, size: 1000, mimeType: "image/jpeg" });
const pay = (method: string, amount: number, name = `${method}-${amount}`, extra: Record<string, unknown> = {}) =>
  ({ method, amount, receipt: receipt(name), paidAt: "2026-10-05T00:00:00.000Z", ...extra });

let n = 0;
/**
 * A lead closed by Theertha the way the dialog does it: 200 already on the
 * lead of its own, 300 in cash at the close — recorded on the lead by the
 * dialog — and delivered to finance.
 */
async function closedSale() {
  n++;
  const leadId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`, status: "closed",
    assignedTo: people.Theertha!.id,
    payments: [
      { _id: new Types.ObjectId(), amount: 200, note: "Booking", paidAt: new Date("2026-10-01"), addedBy: people.Theertha!.id },
      { _id: new Types.ObjectId(), amount: 300, note: "Collected at enrolment — COURSE 500 · Cash", paidAt: new Date("2026-10-05"), addedBy: people.Theertha!.id },
    ],
  });
  const r = await call("POST", "/students", "Theertha", {
    leadId: String(leadId), name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`,
    course: String(course500._id), team: String(teamA), assignedTo: String(people.Theertha!.id),
    enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 500, paidAmount: 500, language: "English", hasBonus: false,
    payments: [pay("bank_transfer", 200, `own-${n}`, { collectedBefore: true }), pay("cash", 300, `cash-${n}`)],
  });
  const id = String(r.body.data?._id ?? "");
  const out = await waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "sent");
  if (r.status !== 201 || !out) throw new Error(`could not set up a sale: ${r.status} ${r.body.message}`);
  approvalOf.set(id, "pending");
  return { id, leadId: String(leadId) };
}
/** Finance sends it back — and the outbox has heard, as its poll would. */
async function sendBack(id: string) {
  approvalOf.set(id, "returned");
  await FinanceHandover.updateOne({ studentId: id }, { $set: { approvalState: "returned", returnedReason: "Wrong course", returnedAt: new Date() } });
}
/** Everything, corrected. */
const correction = (over: Record<string, unknown> = {}) => ({
  name: "Abdul Hakeem", phone: "+971501112233", email: "Hakeem@Example.com",
  course: String(course1000._id), enrollmentDate: "2026-10-04T00:00:00.000Z",
  totalFee: 1000, paidAmount: 800, language: "Malayalam", hasBonus: true, bonusAmount: 150, notes: "Corrected after finance sent it back",
  payments: [pay("cash", 200, "own-cash", { collectedBefore: true }), pay("card", 500, "card-new"), pay("tabby", 100, "tabby-new")],
  ...over,
});
// Leaving out what the outbox writes on the student once finance answers an
// earlier send, which can land in the middle of a refused request.
const snapshot = async (id: string) =>
  JSON.stringify(await Student.findById(id).select("-__v -updatedAt -financeInvoiceId -financeInvoiceNumber -financeSyncedAt").lean());

section("Case 1 — nothing to correct until finance sends it back");
const sale = await closedSale();
let r = await call("PUT", `/students/${sale.id}/correction`, "Theertha", correction());
check("waiting for approval: 409, and nothing changed", r.status === 409 && /hasn't sent this enrolment back/.test(r.body.message ?? "") && (await Student.findById(sale.id).lean())?.name === `Client ${n}`, `${r.status} ${r.body.message}`);
let form = await call("GET", `/students/${sale.id}/correction`, "Theertha");
check("the form's starting point says it isn't sent back yet", form.status === 200 && form.body.data?.sentBack === false, `${form.status} ${JSON.stringify(form.body.data?.sentBack)}`);
approvalOf.set(sale.id, "approved");
await FinanceHandover.updateOne({ studentId: sale.id }, { $set: { approvalState: "approved" } });
r = await call("PUT", `/students/${sale.id}/correction`, "Theertha", correction());
check("approved: 409 — a change then goes through finance", r.status === 409, `${r.status} ${r.body.message}`);
approvalOf.set(sale.id, "pending");
await FinanceHandover.updateOne({ studentId: sale.id }, { $set: { approvalState: "pending" } });

section("Case 2 — the closer corrects everything, and it goes to finance again in the same step");
await sendBack(sale.id);
form = await call("GET", `/students/${sale.id}/correction`, "Theertha");
check("the form starts from: sent back, why, the invoice, the lead's own 200, no moving it for a BDE",
  form.status === 200 && form.body.data?.sentBack === true && form.body.data?.returnedReason === "Wrong course" && form.body.data?.invoiceNumber === `INV-${sale.id.slice(-4)}`
    && form.body.data?.ownOnLead === 200 && form.body.data?.mayMove === false && form.body.data?.counsellors === undefined
    && (form.body.data?.student as { enrollmentNumber?: string })?.enrollmentNumber !== undefined,
  JSON.stringify({ ...form.body.data, student: undefined }));
form = await call("GET", `/students/${sale.id}/correction`, "Maya");
check("…and for a manager, the counsellors and teams it may move to",
  form.body.data?.mayMove === true && (form.body.data?.counsellors as { name: string }[])?.some((u) => u.name === "Nikhil") && (form.body.data?.teams as { name: string }[])?.length === 2);
form = await call("GET", `/students/${sale.id}/correction`, "Nikhil");
check("…and none of it for another BDE: 403", form.status === 403, `${form.status}`);
const sendsBefore = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Theertha", correction());
check("corrected: 200, \"sent to finance\"", r.status === 200 && /Corrected and sent to finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
let s = await Student.findById(sale.id).lean();
check("the client: name, phone, email (kept lower case)", s?.name === "Abdul Hakeem" && s?.phone === "+971501112233" && s?.email === "hakeem@example.com", `${s?.name} ${s?.phone} ${s?.email}`);
check("the course, and the date", String(s?.course) === String(course1000._id) && s?.enrollmentDate?.toISOString().slice(0, 10) === "2026-10-04");
check("the money: fee 1000, paid 800, 200 to collect, part paid", s?.totalFee === 1000 && s?.paidAmount === 800 && s?.pendingAmount === 200 && s?.feeStatus === "partial", `${s?.totalFee}/${s?.paidAmount}/${s?.pendingAmount}/${s?.feeStatus}`);
check("each payment, with its receipt; the first is the one method and receipt",
  s?.payments?.map((p) => `${p.method}:${p.amount}:${p.receipt?.key}${p.collectedBefore ? ":own" : ""}`).join(",") === "cash:200:receipts/own-cash.jpg:own,card:500:receipts/card-new.jpg,tabby:100:receipts/tabby-new.jpg"
    && s?.paymentMethod === "cash" && s?.paymentReceipt?.key === "receipts/own-cash.jpg", JSON.stringify(s?.payments));
check("language, bonus and notes", s?.language === "Malayalam" && s?.hasBonus === true && s?.bonusAmount === 150 && s?.notes === "Corrected after finance sent it back");
check("…and the closer and team stay as they were", String(s?.assignedTo) === String(people.Theertha!.id) && String(s?.team) === String(teamA));
let lead = await Lead.findById(sale.leadId).lean();
check("the lead: its own 200 left alone, the close's 300 cash replaced by 500 card and 100 Tabby",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Booking:200 | Collected at enrolment — COURSE 1000 · Card:500 | Collected at enrolment — COURSE 1000 · Tabby:100",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));
check("…so the lead holds what the enrolment says was paid", (lead?.payments ?? []).reduce((t, p) => t + p.amount, 0) === 800);
const delivered2 = await waitFor(() => sendsFor(sale.id).length === sendsBefore + 1);
const sent = sendsFor(sale.id).at(-1);
check("finance is sent it again at once, as the same enrolment, from this CRM", delivered2 && sent?.externalId === sale.id && sent?.source === "crm" && sent?.crm === "remote", `${sendsFor(sale.id).length} sends`);
check("…with the client as corrected", sent?.customer?.name === "Abdul Hakeem" && sent?.customer?.email === "hakeem@example.com" && sent?.customer?.phone === "+971501112233", JSON.stringify(sent?.customer));
check("…the course, its fee in fils, the date", sent?.course?.name === "COURSE 1000" && sent?.course?.amountMinor === 100000 && sent?.enrolledOn === "2026-10-04", JSON.stringify(sent?.course));
check("…what was paid, what is left, each payment with its receipt",
  sent?.declaredPaidMinor === 80000 && sent?.balanceMinor === 20000
    && sent?.payments?.map((p: { method: string; amountMinor: number; receipt?: { key: string } }) => `${p.method}:${p.amountMinor}:${p.receipt?.key}`).join(",") === "cash:20000:receipts/own-cash.jpg,card:50000:receipts/card-new.jpg,tabby:10000:receipts/tabby-new.jpg",
  JSON.stringify(sent?.payments));
check("…the language and the bonus", sent?.language === "Malayalam" && sent?.bonus?.given === true && sent?.bonus?.amountMinor === 15000);
let h = await FinanceHandover.findOne({ studentId: sale.id }).lean();
check("the outbox: delivered, waiting for approval again, the send-back reason cleared", h?.status === "sent" && h?.approvalState === "pending" && !h?.returnedReason && !h?.returnedAt, `${h?.status} ${h?.approvalState} ${h?.returnedReason}`);
check("…and it says it was sent again, once, just now", h?.resends === 1 && Date.now() - new Date(h?.resentAt ?? 0).getTime() < 60_000, `${h?.resends} ${h?.resentAt}`);

section("Case 3 — what can't be right is refused, with nothing changed and nothing sent");
approvalOf.set(sale.id, "pending");
r = await call("PUT", `/students/${sale.id}/correction`, "Theertha", correction());
check("once resent, it can't be corrected again until finance sends it back again: 409", r.status === 409, `${r.status} ${r.body.message}`);
await sendBack(sale.id);
const refused = async (label: string, body: Record<string, unknown>, status: number, pattern: RegExp, who = "Theertha") => {
  const before = await snapshot(sale.id);
  const sends = sendsFor(sale.id).length;
  const leadBefore = JSON.stringify((await Lead.findById(sale.leadId).lean())?.payments);
  const x = await call("PUT", `/students/${sale.id}/correction`, who, body);
  await sleep(100);
  const same = (await snapshot(sale.id)) === before && sendsFor(sale.id).length === sends
    && JSON.stringify((await Lead.findById(sale.leadId).lean())?.payments) === leadBefore;
  check(label, x.status === status && pattern.test(x.body.message ?? "") && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
};
await refused("no email and no language: 422, both named", correction({ email: "", language: "" }), 422, /the client's email, language/);
await refused("an email finance can't take: 422", correction({ email: "hakeem@example" }), 422, /the client's email/);
await refused("…nor one that only looks like one — finance's own check refuses a@b.c: 422", correction({ email: "a@b.c" }), 422, /the client's email/);
await refused("no name, no phone: 422", correction({ name: " ", phone: "" }), 422, /the client's name, the client's phone/);
await refused("no course: 422", correction({ course: null }), 422, /a course/);
await refused("a course that no longer exists: 422", correction({ course: String(new Types.ObjectId()) }), 422, /no longer exists/);
await refused("no fee: 422", correction({ totalFee: "" }), 422, /the fee/);
await refused("payments that don't add up to what was paid: 422", correction({ paidAmount: 900 }), 422, /must match/);
await refused("a payment without its receipt: 422", correction({ payments: [pay("cash", 200, "own", { collectedBefore: true }), { method: "card", amount: 600, paidAt: "2026-10-05" }] }), 422, /Payment 2 needs its receipt/);
await refused("no payments at all: 422", correction({ payments: undefined }), 422, /needs its payments/);
await refused("the lead's own 200 left out: 422", correction({ paidAmount: 600, payments: [pay("card", 500), pay("tabby", 100)] }), 422, /holds 200 of its own/);
await refused("the lead's own money at another figure: 409, open it again", correction({ paidAmount: 750, payments: [pay("cash", 150, "own", { collectedBefore: true }), pay("card", 500), pay("tabby", 100)] }), 409, /changed while this was open/);
// Several rows may be the lead's own now — one per lead payment with its method and receipt (2026-10-23) — but together
// they must be what the lead holds.
await refused("two of the lead's own coming to more than it holds: 409", correction({ paidAmount: 900, payments: [pay("cash", 200, "a", { collectedBefore: true }), pay("cash", 200, "b", { collectedBefore: true }), pay("card", 500)] }), 409, /changed while this was open/);
await refused("a bonus without its amount: 422", correction({ bonusAmount: 0 }), 422, /the bonus amount/);
await refused("not said whether a bonus was given: 422", correction({ hasBonus: undefined }), 422, /whether a bonus was given/);

section("Case 4 — who may correct, and who may move a sale");
await refused("another BDE, not the closer: 403", correction(), 403, /isn't yours/, "Nikhil");
await refused("a role without enrolments: 403", correction(), 403, /Access denied/, "Vera");
await refused("the closer moving it to another counsellor: 403", correction({ assignedTo: String(people.Nikhil!.id) }), 403, /Only someone who may edit students/);
await refused("…or to another team: 403", correction({ team: String(teamB) }), 403, /Only someone who may edit students/);
r = await call("PUT", `/students/${sale.id}/correction`, undefined, correction());
check("not signed in: 401", r.status === 401, `${r.status}`);
let sends = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction({ assignedTo: String(people.Nikhil!.id), team: String(teamB) }));
s = await Student.findById(sale.id).lean();
check("a manager who may edit students corrects it and moves it to Nikhil in Team B: 200", r.status === 200 && String(s?.assignedTo) === String(people.Nikhil!.id) && String(s?.team) === String(teamB), `${r.status} ${r.body.message}`);
await waitFor(() => sendsFor(sale.id).length === sends + 1);
check("…and finance is told who closed it now", sendsFor(sale.id).at(-1)?.salespersonEmail === "nikhil@test.local", sendsFor(sale.id).at(-1)?.salespersonEmail);
await sendBack(sale.id);
await refused("…after which Theertha's sale is no longer hers to correct: 403", correction(), 403, /isn't yours/);
sends = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Abrar", correction({ assignedTo: String(people.Theertha!.id), team: String(teamA) }));
check("a super admin may correct any, and move it back", r.status === 200 && String((await Student.findById(sale.id).lean())?.assignedTo) === String(people.Theertha!.id), `${r.status} ${r.body.message}`);
await waitFor(() => sendsFor(sale.id).length === sends + 1);

section("Case 5 — sent back a moment ago: finance says so before the outbox has heard");
const fresh = await closedSale();
approvalOf.set(fresh.id, "returned"); // the outbox still says "pending"
r = await call("PUT", `/students/${fresh.id}/correction`, "Theertha", correction({ name: "Fresh Client" }));
check("corrected all the same: 200", r.status === 200 && (await Student.findById(fresh.id).lean())?.name === "Fresh Client", `${r.status} ${r.body.message}`);

section("Case 5b — the lead's own money as two payments, each with its method and receipt (2026-10-23)");
const split = await closedSale();
approvalOf.set(split.id, "returned");
r = await call("PUT", `/students/${split.id}/correction`, "Theertha", correction({
  payments: [pay("cash", 120, "own-cash", { collectedBefore: true }), pay("card", 80, "own-card", { collectedBefore: true }), pay("card", 500, "card-new"), pay("tabby", 100, "tabby-new")],
}));
const splitDoc = await Student.findById(split.id).lean();
const ownKept = (splitDoc?.payments ?? []).filter((p) => p.collectedBefore);
check("corrected with the lead's 200 as cash 120 + card 80: 200, both kept as the lead's own", r.status === 200 && ownKept.length === 2
  && ownKept.map((p) => `${p.method}:${p.amount}`).join(",") === "cash:120,card:80", `${r.status} ${r.body.message} ${JSON.stringify(ownKept)}`);

section("Case 6 — an enrolment from before payments were listed; \"Send again\"; the receipt upload");
const oldLead = new Types.ObjectId();
await db.collection("leads").insertOne({ _id: oldLead, name: "Old Client", phone: "+971509999999", status: "closed", assignedTo: people.Theertha!.id, payments: [] });
const old = await Student.create({
  enrollmentNumber: "STU-9000", name: "Old Client", phone: "+971509999999", leadId: oldLead, course: course500._id, team: teamA,
  assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date("2026-09-20"),
  paymentMethod: "cash", paymentReceipt: receipt("old-cash"),
});
await FinanceHandover.create({ studentId: old._id, leadId: oldLead, payload: {}, status: "sent", invoiceNumber: "INV-OLD", approvalState: "returned", returnedReason: "No email" });
approvalOf.set(String(old._id), "returned");
r = await call("PUT", `/students/${String(old._id)}/correction`, "Theertha", correction({
  name: "Old Client", phone: "+971509999999", email: "old.client@test.local", course: String(course500._id), totalFee: 500, paidAmount: 500,
  language: "English", hasBonus: false, bonusAmount: 0, payments: [pay("cash", 500, "old-cash")],
}));
s = await Student.findById(old._id).lean();
lead = await Lead.findById(oldLead).lean();
check("an older enrolment — one method, one receipt, no list — is corrected into a list: 200",
  r.status === 200 && s?.email === "old.client@test.local" && s?.payments?.length === 1 && s?.hasBonus === false, `${r.status} ${r.body.message}`);
check("…and its lead, which held nothing, now holds what was collected at the close",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Collected at enrolment — COURSE 500 · Cash:500", lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));
await waitFor(async () => (await FinanceHandover.findOne({ studentId: old._id }).lean())?.status === "sent");
await sendBack(String(old._id));
r = await call("POST", `/students/${String(old._id)}/invoice`, "Theertha");
check("\"Send again\" still resends a sent-back enrolment as it stands", r.status === 200 && /Correction sent/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
await waitFor(async () => (await FinanceHandover.findOne({ studentId: old._id }).lean())?.status === "sent");
approvalOf.set(String(old._id), "pending");
r = await call("POST", `/students/${String(old._id)}/invoice`, "Theertha");
check("…and refuses one waiting for approval: 409", r.status === 409 && /Already invoiced/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
check("…counting each time it went again: corrected once, sent again once", (await FinanceHandover.findOne({ studentId: old._id }).lean())?.resends === 2);

const upload = async (who: string) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "receipt.jpg");
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/students/receipts/${sale.leadId}`, { method: "POST", headers: { authorization: `Bearer ${token(who)}` }, body: form });
  return res.status;
};
const managerUpload = await upload("Maya");
check("a receipt for a correction can be taken by someone who corrects but adds no students (not 403)", managerUpload !== 403, `${managerUpload}`);
check("…but not by a role with neither: 403", (await upload("Vera")) === 403);

section("Case 7 — \"sent again\" shown once it was");
approvalOf.set(sale.id, "pending");
const mine = await call("GET", "/students/enrolments/mine", "Theertha");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = ((mine.body as any).data as any[])?.find((x) => String(x._id) === sale.id);
check("My Enrolments carries when it was sent again, and how many times (corrected three times)", Boolean(row?.handover?.resentAt) && row?.handover?.resends === 3, JSON.stringify(row?.handover));
check("…and its finance step says \"Sent again …, waiting for accounts\"", row?.steps?.[0]?.state === "waiting" && /^Sent again \d{1,2} \w{3}, .* — waiting for accounts to approve it$/.test(row?.steps?.[0]?.detail ?? ""), row?.steps?.[0]?.detail);
const one = await call("GET", `/students/enrolments/${sale.id}`, "Abrar");
check("…its own page too", (one.body.data as any)?.handover?.resends === 3 && /^Sent again/.test((one.body.data as any)?.steps?.[0]?.detail ?? ""), JSON.stringify((one.body.data as any)?.steps?.[0]));
const { stepsOf } = await import("../src/services/enrolmentSteps.js");
const returned = { externalId: "x", invoiceId: "i", invoiceNumber: "INV-1", status: "sent", approval: "returned", returnedReason: "Wrong course", issueDate: "", currency: "AED", totalMinor: 0, amountPaidMinor: 0, balanceMinor: 0 };
let st = stepsOf(returned, { status: "pending", resentAt: new Date() })[0]!;
check("on its way back — finance still says \"returned\" — it shows as sent again, not sent back", st.state === "waiting" && /^Sent again .* — on its way to finance$/.test(st.detail ?? ""), st.detail);
st = stepsOf(returned, { status: "failed", resentAt: new Date(), lastError: "Invalid email" })[0]!;
check("sent again but refused by finance: says so, with why", st.state === "failed" && /^Sent again .*, but finance didn't take it — Invalid email$/.test(st.detail ?? ""), st.detail);
st = stepsOf(returned, { status: "sent" })[0]!;
check("sent back, never sent again: as before", st.state === "failed" && st.detail === "Sent back: Wrong course — correct it and send it again", st.detail);

section("Case 8 — a payment in another currency, corrected");
const abroad = await closedSale();
await sendBack(abroad.id);
let k = sendsFor(abroad.id).length;
r = await call("PUT", `/students/${abroad.id}/correction`, "Theertha", correction({
  paidAmount: 640,
  payments: [pay("cash", 200, "own-cash", { collectedBefore: true }), pay("bank_transfer", 440, "inr-transfer", { currency: "INR", amountInCurrency: 10000, exchangeRate: 0.044 })],
}));
s = await Student.findById(abroad.id).lean();
const inr = s?.payments?.[1];
check("corrected with 10,000 INR at 0.044 — 440 AED: 200", r.status === 200 && inr?.currency === "INR" && inr?.amountInCurrency === 10000 && inr?.exchangeRate === 0.044 && inr?.amount === 440, `${r.status} ${r.body.message} ${JSON.stringify(inr)}`);
lead = await Lead.findById(abroad.leadId).lean();
check("…the lead's note says what was handed over, as the close's does",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Booking:200 | Collected at enrolment — COURSE 1000 · Bank Transfer · INR 10,000 at 1 INR = 0.044 AED:440",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));
await waitFor(() => sendsFor(abroad.id).length === k + 1);
const sentAbroad = sendsFor(abroad.id).at(-1);
check("…and finance is sent the AED with the original beside it",
  sentAbroad?.payments?.[1]?.amountMinor === 44000 && sentAbroad?.payments?.[1]?.original?.currency === "INR" && sentAbroad?.payments?.[1]?.original?.amountMinor === 1000000 && sentAbroad?.payments?.[1]?.original?.rate === 0.044,
  JSON.stringify(sentAbroad?.payments?.[1]));
await sendBack(abroad.id);
k = sendsFor(abroad.id).length;
r = await call("PUT", `/students/${abroad.id}/correction`, "Theertha", correction({
  paidAmount: 700,
  payments: [pay("cash", 200, "own-cash", { collectedBefore: true }), pay("bank_transfer", 500, "inr-transfer", { currency: "INR", amountInCurrency: 10000, exchangeRate: 0.044 })],
}));
check("a figure that isn't what the rate makes it is refused: 422, nothing sent", r.status === 422 && /comes to 440/.test(r.body.message ?? "") && sendsFor(abroad.id).length === k, `${r.status} ${r.body.message}`);

section("Case 9 — the Bangalore academy: its own finance organization, from the close to the correction");
const BLR_ITEM = "b".repeat(24);
const courseBlr = await Course.create({ name: "COURSE BLR", amount: 2250, lmsCourseSlugs: ["mbt"], lmsCourseSlug: "mbt", bangalore: { price: 45000, financeItemId: BLR_ITEM } });
const courseBlr2 = await Course.create({ name: "COURSE BLR 2", amount: 5500, bangalore: { price: 90000 } });
/** A lead closed for Bangalore the way the dialog does it: AED 200 its own; ₹30,000 card + AED 400 cash at 22.5 at the close (only the AED goes on the lead). */
async function bangaloreSale() {
  n++;
  const leadId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Client ${n}`, phone: `+91900000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`, status: "closed",
    assignedTo: people.Theertha!.id,
    payments: [
      { _id: new Types.ObjectId(), amount: 200, note: "Booking", paidAt: new Date("2026-10-01"), addedBy: people.Theertha!.id },
      { _id: new Types.ObjectId(), amount: 400, note: "Collected at enrolment — COURSE BLR · Cash · Bangalore · AED 400 at 1 AED = 22.5 INR", paidAt: new Date("2026-10-05"), addedBy: people.Theertha!.id },
    ],
  });
  const r = await call("POST", "/students", "Theertha", {
    leadId: String(leadId), name: `Client ${n}`, phone: `+91900000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`,
    academy: "bangalore", course: String(courseBlr._id), team: String(teamA), assignedTo: String(people.Theertha!.id),
    enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 45000, paidAmount: 43500, language: "English", hasBonus: false,
    payments: [
      pay("cash", 4500, `own-${n}`, { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 }),
      pay("card", 30000, `card-${n}`),
      pay("cash", 9000, `aed-${n}`, { currency: "AED", amountInCurrency: 400, exchangeRate: 22.5 }),
    ],
  });
  const id = String(r.body.data?._id ?? "");
  const out = await waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "sent");
  if (r.status !== 201 || !out) throw new Error(`could not set up a Bangalore sale: ${r.status} ${r.body.message}`);
  approvalOf.set(id, "pending");
  return { id, leadId: String(leadId) };
}
const blr = await bangaloreSale();
let first = sendsFor(blr.id)[0];
check("delivered to Bangalore's finance organization (x-delta-org), saying academy bangalore", first?._org === BLR_ORG && first?.academy === "bangalore", `${first?._org} ${first?.academy}`);
check("…in INR: the Bangalore item, fee and payments in paise, the AED cash as original {AED, fils, INR per AED}",
  first?.course?.itemId === BLR_ITEM && first?.course?.amountMinor === 4500000 && first?.declaredPaidMinor === 4350000
    && first?.payments?.map((p: { amountMinor: number }) => p.amountMinor).join(",") === "450000,3000000,900000"
    && first?.payments?.[2]?.original?.currency === "AED" && first?.payments?.[2]?.original?.amountMinor === 40000 && first?.payments?.[2]?.original?.rate === 22.5,
  JSON.stringify({ course: first?.course, payments: first?.payments }));
h = await FinanceHandover.findOne({ studentId: blr.id }).lean();
check("the outbox row keeps the academy and its organization", h?.academy === "bangalore" && h?.financeOrgId === BLR_ORG, `${h?.academy} ${h?.financeOrgId}`);
const dubaiSale = await closedSale();
check("a Dubai close beside it still goes to Dubai's, saying academy dubai", sendsFor(dubaiSale.id)[0]?._org === DUBAI_ORG && sendsFor(dubaiSale.id)[0]?.academy === "dubai"
  && (await FinanceHandover.findOne({ studentId: dubaiSale.id }).lean())?.financeOrgId === DUBAI_ORG);

// The decision poll asks each organization about its own, in one pass.
const { pollFinanceOutcomes } = await import("../src/services/financeHandoverWorker.js");
approvalOf.set(blr.id, "returned");
approvalOf.set(dubaiSale.id, "returned");
statusCalls.length = 0;
await pollFinanceOutcomes();
check("the poll hears both send-backs — the Bangalore one from Bangalore's organization",
  (await FinanceHandover.findOne({ studentId: blr.id }).lean())?.approvalState === "returned" && (await FinanceHandover.findOne({ studentId: dubaiSale.id }).lean())?.approvalState === "returned");
check("…one status call per organization, each with only its own",
  statusCalls.some((c) => c.org === BLR_ORG && c.ids.includes(blr.id) && !c.ids.includes(dubaiSale.id))
    && statusCalls.some((c) => c.org === DUBAI_ORG && c.ids.includes(dubaiSale.id) && !c.ids.includes(blr.id)),
  JSON.stringify(statusCalls));

statusCalls.length = 0;
const mineB = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowB = ((mineB.body as any).data as any[])?.find((x) => String(x._id) === blr.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowD = ((mineB.body as any).data as any[])?.find((x) => String(x._id) === dubaiSale.id);
check("My Enrolments: the Bangalore card says Bangalore, and finance's answer for it came from Bangalore's organization",
  rowB?.academy === "bangalore" && rowB?.invoice?.approval === "returned" && rowD?.invoice?.approval === "returned"
    && statusCalls.some((c) => c.org === BLR_ORG && c.ids.includes(blr.id)) && !statusCalls.some((c) => c.org === DUBAI_ORG && c.ids.includes(blr.id)),
  JSON.stringify({ academy: rowB?.academy, invoice: rowB?.invoice?.approval, calls: statusCalls }));
const pageB = await call("GET", `/students/enrolments/${blr.id}`, "Abrar");
check("…its own page too", pageB.status === 200 && (pageB.body.data as any)?.academy === "bangalore" && (pageB.body.data as any)?.invoice?.approval === "returned", `${pageB.status}`);

form = await call("GET", `/students/${blr.id}/correction`, "Theertha");
check("the correction starts from: Bangalore, sent back, the lead's own AED 200",
  form.status === 200 && form.body.data?.academy === "bangalore" && form.body.data?.sentBack === true && form.body.data?.ownOnLead === 200,
  JSON.stringify({ ...form.body.data, student: undefined }));
const blrCorrection = (over: Record<string, unknown> = {}) => correction({
  course: String(courseBlr._id), totalFee: 45000, paidAmount: 45000, hasBonus: false, bonusAmount: 0,
  payments: [
    pay("cash", 4500, "own-blr", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 }),
    pay("bank_transfer", 29250, "upi-blr"),
    pay("cash", 11250, "aed-blr", { currency: "AED", amountInCurrency: 500, exchangeRate: 22.5 }),
  ],
  ...over,
});
const sendsB = sendsFor(blr.id).length;
const refusedB = async (label: string, body: Record<string, unknown>, status: number, pattern: RegExp) => {
  const before = await snapshot(blr.id);
  const x = await call("PUT", `/students/${blr.id}/correction`, "Theertha", body);
  await sleep(100);
  const same = (await snapshot(blr.id)) === before && sendsFor(blr.id).length === sendsB;
  check(label, x.status === status && pattern.test(x.body.message ?? "") && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
};
await refusedB("moving it to Dubai in a correction: 422, the academy is fixed", blrCorrection({ academy: "dubai" }), 422, /academy is fixed at the close/);
await refusedB("a course with no Bangalore price: 422", blrCorrection({ course: String(course500._id) }), 422, /COURSE 500 has no Bangalore price/);
await refusedB("an AED figure the rate doesn't make: 422", blrCorrection({ paidAmount: 46000, payments: [pay("cash", 4500, "own", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 }), pay("cash", 41500, "aed", { currency: "AED", amountInCurrency: 500, exchangeRate: 22.5 })] }), 422, /comes to 11,250 INR/);
await refusedB("the lead's own money at another AED figure: 409", blrCorrection({ paidAmount: 42250, payments: [pay("cash", 2250, "own", { collectedBefore: true, currency: "AED", amountInCurrency: 100, exchangeRate: 22.5 }), pay("bank_transfer", 40000, "upi")] }), 409, /come to 200 AED now, not 100 AED/);
r = await call("PUT", `/students/${blr.id}/correction`, "Theertha", blrCorrection({ academy: "bangalore" }));
s = await Student.findById(blr.id).lean();
check("corrected in INR (saying its own academy is fine): 200, still Bangalore", r.status === 200 && s?.academy === "bangalore" && s?.paidAmount === 45000 && s?.payments?.[2]?.amountInCurrency === 500, `${r.status} ${r.body.message}`);
await waitFor(() => sendsFor(blr.id).length === sendsB + 1);
const resentB = sendsFor(blr.id).at(-1);
check("…sent again to Bangalore's organization, in paise, the AED cash as original", resentB?._org === BLR_ORG && resentB?.academy === "bangalore" && resentB?.course?.itemId === BLR_ITEM
  && resentB?.payments?.[2]?.amountMinor === 1125000 && resentB?.payments?.[2]?.original?.amountMinor === 50000, JSON.stringify(resentB?.payments));
lead = await Lead.findById(blr.leadId).lean();
check("…the lead keeps its own AED 200, and of the close only the AED cash, in AED",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Booking:200 | Collected at enrolment — COURSE BLR · Cash · Bangalore · AED 500 at 1 AED = 22.5 INR:500",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));

// Sent back again, and seen by finance before the outbox: "Send again" asks Bangalore's organization, and resends there.
const settled = (id: string) => waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "sent");
await settled(blr.id);
approvalOf.set(blr.id, "returned");
statusCalls.length = 0;
const k9 = sendsFor(blr.id).length;
r = await call("POST", `/students/${blr.id}/invoice`, "Theertha");
check("\"Send again\": finance asked in Bangalore's organization whether it is sent back — and it goes there again",
  r.status === 200 && statusCalls.some((c) => c.org === BLR_ORG && c.ids.includes(blr.id)) && !statusCalls.some((c) => c.org === DUBAI_ORG),
  `${r.status} ${r.body.message} ${JSON.stringify(statusCalls)}`);
await waitFor(() => sendsFor(blr.id).length === k9 + 1);
check("…delivered to Bangalore's", sendsFor(blr.id).at(-1)?._org === BLR_ORG);

// The organization is the one fixed at the close: a changed setting later doesn't move it.
const { env } = await import("../src/config/env.js");
await settled(blr.id);
approvalOf.set(blr.id, "returned");
await sendBack(blr.id);
env.FINANCE_ORG_ID_BANGALORE = "org-bangalore-renamed";
const k10 = sendsFor(blr.id).length;
r = await call("PUT", `/students/${blr.id}/correction`, "Theertha", blrCorrection());
await waitFor(() => sendsFor(blr.id).length === k10 + 1);
check("a correction after the setting changed still goes to the organization it was billed in", r.status === 200 && sendsFor(blr.id).at(-1)?._org === BLR_ORG, `${r.status} ${sendsFor(blr.id).at(-1)?._org}`);

// No Bangalore organization set: a Bangalore close is refused, Dubai's still go.
env.FINANCE_ORG_ID_BANGALORE = "";
{
  const leadId = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: leadId, name: "No Org", phone: "+919000000999", status: "closed", assignedTo: people.Theertha!.id, payments: [] });
  const count = await Student.countDocuments();
  const x = await call("POST", "/students", "Theertha", {
    leadId: String(leadId), name: "No Org", phone: "+919000000999", email: "no.org@test.local", academy: "bangalore", course: String(courseBlr2._id),
    enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 90000, paidAmount: 90000, language: "English", hasBonus: false, payments: [pay("card", 90000, "no-org")],
  });
  check("without FINANCE_ORG_ID_BANGALORE a Bangalore close is refused: 422, nothing saved", x.status === 422 && /Bangalore finance organization/.test(x.body.message ?? "") && (await Student.countDocuments()) === count, `${x.status} ${x.body.message}`);
  const y = await call("GET", "/courses/finance-items?academy=bangalore", "Abrar");
  check("…and the Bangalore catalogue is empty rather than Dubai's", y.status === 200 && Array.isArray(y.body.data) && (y.body.data as unknown[]).length === 0, JSON.stringify(y.body));
  const o = await call("GET", "/students/close-options", "Theertha");
  check("…and the close dialog is told Dubai only", (o.body.data?.academies as string[])?.join(",") === "dubai", JSON.stringify(o.body));
}
const dubaiStill = await closedSale();
check("…while a Dubai close still goes, to Dubai's", sendsFor(dubaiStill.id)[0]?._org === DUBAI_ORG);
env.FINANCE_ORG_ID_BANGALORE = BLR_ORG;

// The course mapping's Bangalore section, and its catalogue from the Bangalore organization.
itemsAsked.length = 0;
let items = await call("GET", "/courses/finance-items?academy=bangalore", "Abrar");
check("Bangalore's catalogue comes from Bangalore's organization", items.status === 200 && (items.body.data as any)?.[0]?.name === "MBT Bangalore" && itemsAsked.at(-1) === BLR_ORG, `${JSON.stringify(items.body.data)} ${itemsAsked}`);
items = await call("GET", "/courses/finance-items", "Abrar");
check("…Dubai's, from Dubai's", (items.body.data as any)?.[0]?.name === "MBT Dubai" && itemsAsked.at(-1) === DUBAI_ORG);
r = await call("PUT", `/courses/${courseBlr2._id}`, "Abrar", { bangalore: { price: 95000, financeItemId: BLR_ITEM, lmsCourseSlugs: ["mbt-blr", "dwt-blr"] } });
let cB = await Course.findById(courseBlr2._id).lean();
check("mapping a course's Bangalore price, item and LMS courses", r.status === 200 && cB?.bangalore?.price === 95000 && cB?.bangalore?.financeItemId === BLR_ITEM && cB?.bangalore?.lmsCourseSlugs?.join(",") === "mbt-blr,dwt-blr", `${r.status} ${JSON.stringify(cB?.bangalore)}`);
r = await call("PUT", `/courses/${courseBlr2._id}`, "Abrar", { financeItemId: "", lmsCourseSlugs: ["mbt"] });
cB = await Course.findById(courseBlr2._id).lean();
check("…mapping Dubai's side leaves Bangalore's as it was", r.status === 200 && cB?.bangalore?.price === 95000 && cB?.bangalore?.lmsCourseSlugs?.length === 2);
r = await call("PUT", `/courses/${courseBlr2._id}`, "Abrar", { bangalore: { price: null, financeItemId: "", lmsCourseSlugs: [] } });
cB = await Course.findById(courseBlr2._id).lean();
check("…taking the price off and unmapping (no LMS courses = Dubai's)", r.status === 200 && cB?.bangalore?.price === undefined && cB?.bangalore?.financeItemId === null && cB?.bangalore?.lmsCourseSlugs?.length === 0, JSON.stringify(cB?.bangalore));
r = await call("PUT", `/courses/${courseBlr2._id}`, "Abrar", { bangalore: { price: -5 } });
check("…a negative price: 400", r.status === 400, `${r.status}`);
r = await call("PUT", `/courses/${courseBlr2._id}`, "Vera", { bangalore: { price: 1 } });
check("…a role that can't edit courses: 403", r.status === 403, `${r.status}`);

section("Case 10 — a close that went without the client's email: add it, and it goes again as the same enrolment");
{
  const { StudentService } = await import("../src/services/studentService.js");
  const svc = new StudentService();
  /**
   * A close from before the email was asked: no email on the lead or the
   * enrolment, queued, and refused by finance's intake — as the stuck ones are.
   */
  const stuckClose = async (over: Record<string, unknown> = {}) => {
    n++;
    const leadId = new Types.ObjectId();
    await db.collection("leads").insertOne({
      _id: leadId, name: `No Email ${n}`, phone: `+97155000${String(n).padStart(4, "0")}`, status: "closed", assignedTo: people.Theertha!.id, payments: [], activityLogs: [],
    });
    const st = await Student.create({
      enrollmentNumber: `STU-${8000 + n}`, name: `No Email ${n}`, phone: `+97155000${String(n).padStart(4, "0")}`, leadId, course: course500._id, team: teamA,
      assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date("2026-10-10"),
      language: "English", paymentMethod: "cash", paymentReceipt: receipt(`no-email-${n}`), payments: [{ ...pay("cash", 500, `no-email-${n}`), paidAt: new Date("2026-10-10") }],
      hasBonus: false, bonusAmount: 0, academy: "dubai", status: "active", ...over,
    });
    const id = String(st._id);
    await svc.queueFinanceHandover(id, String(leadId));
    const failed = await waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "failed");
    if (!failed) throw new Error("could not set up a refused close");
    return { id, leadId: String(leadId) };
  };
  const addEmail = (id: string, who: string | undefined, email: unknown) => call("POST", `/students/${id}/enrolment/email`, who, { email });
  const rowOf = (id: string) => FinanceHandover.findOne({ studentId: id }).lean();
  const strip = (p: Record<string, unknown>) => JSON.stringify({ ...p, customer: { ...(p.customer as object), email: undefined }, _org: undefined });

  const stuck = await stuckClose();
  let row = await rowOf(stuck.id);
  check("set up as in production: refused by finance's intake, permanently — failed, \"Request validation failed\", no email in what went",
    row?.status === "failed" && row?.lastError === "Request validation failed" && (row?.payload as any)?.customer?.email === "" && sendsFor(stuck.id).length === 0,
    `${row?.status} ${row?.lastError} ${JSON.stringify((row?.payload as any)?.customer)}`);
  let mineE = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
  let rowE = ((mineE.body as any).data as any[])?.find((x) => String(x._id) === stuck.id);
  check("My Enrolments marks it as needing the client's email — nothing to suggest, the CRM has none — and its finance step says so",
    rowE?.handover?.needsClientEmail === true && rowE?.handover?.suggestedEmail === "" && rowE?.steps?.[0]?.state === "failed" && /client's email is missing/.test(rowE?.steps?.[0]?.detail ?? ""),
    JSON.stringify({ h: rowE?.handover, step: rowE?.steps?.[0] }));
  const pageE = await call("GET", `/students/enrolments/${stuck.id}`, "Theertha");
  check("…its own page too", (pageE.body.data as any)?.handover?.needsClientEmail === true && (pageE.body.data as any)?.handover?.suggestedEmail === "", JSON.stringify((pageE.body.data as any)?.handover));
  form = await call("GET", `/students/${stuck.id}/correction`, "Theertha");
  check("…and the student page's starting point: not delivered, needs the client's email, nothing sent back",
    form.status === 200 && form.body.data?.needsClientEmail === true && form.body.data?.suggestedEmail === "" && form.body.data?.deliveryStatus === "failed" && form.body.data?.sentBack === false,
    JSON.stringify({ ...form.body.data, student: undefined }));
  r = await call("PUT", `/students/${stuck.id}/correction`, "Theertha", correction());
  check("the correction still can't reach it — finance never had it: 409", r.status === 409, `${r.status} ${r.body.message}`);

  // Refused, with nothing changed and nothing sent.
  const untouched = async (label: string, x: Answer, status: number, pattern: RegExp, id = stuck.id, leadId = stuck.leadId) => {
    await sleep(150);
    const rw = await rowOf(id);
    const st = await Student.findById(id).lean();
    const ld = await Lead.findById(leadId).lean();
    const same = rw?.status === "failed" && !(rw?.payload as any)?.customer?.email && !st?.email && !ld?.email && !(ld?.activityLogs ?? []).length && sendsFor(id).length === 0;
    check(label, x.status === status && pattern.test(x.body.message ?? "") && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
  };
  await untouched("\"Send again\" / \"Generate invoice\" on it: 409 — add the client's email first", await call("POST", `/students/${stuck.id}/invoice`, "Theertha"), 409, /add the client's email first/);
  await untouched("an email finance can't take: 422", await addEmail(stuck.id, "Theertha", "client@example"), 422, /isn't an email finance will take/);
  await untouched("…nor one that only looks like one — finance's own check refuses a@b.c: 422", await addEmail(stuck.id, "Theertha", "a@b.c"), 422, /isn't an email finance will take/);
  await untouched("no email at all: 422", await addEmail(stuck.id, "Theertha", "  "), 422, /isn't an email/);
  await untouched("another BDE, not the closer: 403", await addEmail(stuck.id, "Nikhil", "client@example.com"), 403, /isn't yours/);
  await untouched("a role without enrolments: 403", await addEmail(stuck.id, "Vera", "client@example.com"), 403, /Access denied/);
  await untouched("not signed in: 401", await addEmail(stuck.id, undefined, "client@example.com"), 401, /./);
  r = await addEmail(String(new Types.ObjectId()), "Abrar", "client@example.com");
  check("an enrolment that doesn't exist: 404", r.status === 404, `${r.status} ${r.body.message}`);

  const refusedBefore = refusedSends.filter((p) => p.externalId === stuck.id).at(-1);
  r = await addEmail(stuck.id, "Theertha", "  Stuck.Client@Example.COM ");
  check("the closer adds it: 200, \"sending it to finance again\"", r.status === 200 && /sending it to finance again/.test(r.body.message ?? "") && r.body.data?.email === "stuck.client@example.com", `${r.status} ${r.body.message}`);
  const went = await waitFor(() => sendsFor(stuck.id).length === 1);
  const sentE = sendsFor(stuck.id)[0];
  check("finance gets it at once, with the email, as the same enrolment (same externalId), to Dubai's organization",
    went && sentE?.externalId === stuck.id && sentE?.customer?.email === "stuck.client@example.com" && sentE?._org === DUBAI_ORG,
    `${sendsFor(stuck.id).length} sends ${JSON.stringify(sentE?.customer)} ${sentE?._org}`);
  check("…and otherwise exactly what was refused — the sale as it was closed", Boolean(refusedBefore) && strip(sentE) === strip(refusedBefore), `${strip(sentE)}\n${strip(refusedBefore ?? {})}`);
  await waitFor(async () => (await rowOf(stuck.id))?.status === "sent");
  row = await rowOf(stuck.id);
  check("the outbox: delivered, invoiced, the error gone — not counted as a resend after a send-back",
    row?.status === "sent" && row?.invoiceNumber === `INV-${stuck.id.slice(-4)}` && !row?.lastError && (row?.payload as any)?.customer?.email === "stuck.client@example.com" && !row?.resends && !row?.resentAt,
    `${row?.status} ${row?.invoiceNumber} ${row?.lastError} ${row?.resends}`);
  s = await Student.findById(stuck.id).lean();
  check("the enrolment keeps the email (lower case)", s?.email === "stuck.client@example.com", s?.email);
  lead = await Lead.findById(stuck.leadId).lean();
  const logE = lead?.activityLogs?.at(-1);
  check("…and the lead, which had none, with an entry on its activity by who added it",
    lead?.email === "stuck.client@example.com" && logE?.action === "lead_updated" && /Email added for finance: stuck\.client@example\.com/.test(logE?.description ?? "")
      && String(logE?.performedBy) === String(people.Theertha!.id) && (logE?.changes as any)?.email?.to === "stuck.client@example.com",
    JSON.stringify({ email: lead?.email, log: logE }));
  mineE = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
  rowE = ((mineE.body as any).data as any[])?.find((x) => String(x._id) === stuck.id);
  check("My Enrolments no longer asks for it", rowE?.handover?.needsClientEmail === false && rowE?.handover?.status === "sent", JSON.stringify(rowE?.handover));

  r = await addEmail(stuck.id, "Theertha", "another@example.com");
  check("once finance has it, an email isn't changed from here: 409, nothing sent",
    r.status === 409 && /already has this enrolment/.test(r.body.message ?? "") && sendsFor(stuck.id).length === 1 && (await Student.findById(stuck.id).lean())?.email === "stuck.client@example.com",
    `${r.status} ${r.body.message}`);

  // Failed for something else: an email wouldn't fix it.
  const other = await closedSale();
  await FinanceHandover.updateOne({ studentId: other.id }, { $set: { status: "failed", lastError: "Finance returned 400: course not mapped" } });
  const otherEmail = (await Student.findById(other.id).lean())?.email;
  r = await addEmail(other.id, "Theertha", "other@example.com");
  check("a close failed for another reason: 409, saying what finance said, nothing changed",
    r.status === 409 && /wasn't held up by the client's email — finance said: Finance returned 400: course not mapped/.test(r.body.message ?? "")
      && (await rowOf(other.id))?.status === "failed" && (await Student.findById(other.id).lean())?.email === otherEmail,
    `${r.status} ${r.body.message}`);
  mineE = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
  rowE = ((mineE.body as any).data as any[])?.find((x) => String(x._id) === other.id);
  check("…and the screens don't offer it there", rowE?.handover?.needsClientEmail === false, JSON.stringify(rowE?.handover));
  await FinanceHandover.updateOne({ studentId: other.id }, { $set: { lastError: "Request validation failed" } });
  r = await addEmail(other.id, "Theertha", "other@example.com");
  check("…nor one refused by finance's check whose email is fine — something else is wrong: 409", r.status === 409 && /wasn't held up/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/students/${other.id}/invoice`, "Theertha");
  row = await rowOf(other.id);
  // Queued again for the worker's timer, as "Send again" on a failed close always has been.
  check("…while \"Send again\" still works for those: 200, queued again",
    r.status === 200 && /Sending to finance again/.test(r.body.message ?? "") && row?.status === "pending" && !row?.lastError, `${r.status} ${r.body.message} ${row?.status}`);

  // What the field starts from: an email finance would take that the CRM already has — the
  // enrolment's, else the lead's (people add it to the lead by hand). Only ever a suggestion.
  {
    const s2 = await stuckClose({ email: "a@b.c" });
    const views = async () => {
      const mine = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
      const page = await call("GET", `/students/enrolments/${s2.id}`, "Theertha");
      const start = await call("GET", `/students/${s2.id}/correction`, "Theertha");
      return [((mine.body as any).data as any[])?.find((x) => String(x._id) === s2.id)?.handover, (page.body.data as any)?.handover, start.body.data] as any[];
    };
    let v = await views();
    check("an email that only looks like one (a@b.c) went, finance's check refused it — flagged on My Enrolments, the enrolment page and the student page",
      (await rowOf(s2.id))?.status === "failed" && ((await rowOf(s2.id))?.payload as any)?.customer?.email === "a@b.c" && v.every((x) => x?.needsClientEmail === true),
      JSON.stringify(v.map((x) => x?.needsClientEmail)));
    check("…nothing to suggest: the enrolment's isn't one finance takes, and the lead has none", v.every((x) => x?.suggestedEmail === ""), JSON.stringify(v.map((x) => x?.suggestedEmail)));
    // Added to the lead by hand afterwards, as people have been doing — straight in, as typed.
    await db.collection("leads").updateOne({ _id: new Types.ObjectId(s2.leadId) }, { $set: { email: "ByHand@Example.com" } });
    v = await views();
    check("the lead's email added by hand: suggested on all three, lower case", v.every((x) => x?.suggestedEmail === "byhand@example.com"), JSON.stringify(v.map((x) => x?.suggestedEmail)));
    await sleep(150);
    check("…only suggested: nothing sent, still waiting for somebody to press the button", sendsFor(s2.id).length === 0 && (await rowOf(s2.id))?.status === "failed");
    await Student.updateOne({ _id: s2.id }, { $set: { email: "student.fixed@example.com" } });
    v = await views();
    check("the enrolment's own email, once it is one finance takes, comes before the lead's", v.every((x) => x?.suggestedEmail === "student.fixed@example.com"), JSON.stringify(v.map((x) => x?.suggestedEmail)));
    r = await addEmail(s2.id, "Theertha", "byhand@example.com");
    await waitFor(() => sendsFor(s2.id).length === 1);
    check("sent with the one somebody chose: 200, delivered with it", r.status === 200 && sendsFor(s2.id)[0]?.customer?.email === "byhand@example.com", `${r.status} ${r.body.message}`);
    const ld2 = await Lead.findById(s2.leadId).lean();
    check("…the lead keeps the email it was given by hand, with no entry added", ld2?.email === "ByHand@Example.com" && !(ld2?.activityLogs ?? []).length, JSON.stringify({ email: ld2?.email, logs: ld2?.activityLogs?.length }));
  }
  {
    const leadId = new Types.ObjectId();
    await db.collection("leads").insertOne({ _id: leadId, name: "Never Queued", phone: "+971550009999", status: "closed", assignedTo: people.Theertha!.id, payments: [] });
    const st = await Student.create({ enrollmentNumber: "STU-9500", name: "Never Queued", leadId, assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 0, pendingAmount: 500, feeStatus: "pending", enrollmentDate: new Date() });
    r = await addEmail(String(st._id), "Theertha", "never@example.com");
    check("an enrolment with nothing queued for finance: 409", r.status === 409 && /isn't waiting on finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  }

  // Waiting to go, never tried, with no email in it: finance would refuse it — it can take the email too.
  {
    const leadId = new Types.ObjectId();
    await db.collection("leads").insertOne({ _id: leadId, name: "Waiting", phone: "+971550008888", email: "already@lead.example", status: "closed", assignedTo: people.Theertha!.id, payments: [] });
    const st = await Student.create({ enrollmentNumber: "STU-9501", name: "Waiting", leadId, course: course500._id, assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date(), hasBonus: false, language: "English" });
    const payload = await svc.buildHandoverPayload(String(st._id));
    await FinanceHandover.create({ studentId: st._id, leadId, payload, status: "pending", academy: "dubai", financeOrgId: DUBAI_ORG, nextAttemptAt: new Date(Date.now() + 3_600_000), attempts: 2, lastError: "Finance returned 503" });
    const wid = String(st._id);
    r = await addEmail(wid, "Theertha", "waiting@example.com");
    await waitFor(() => sendsFor(wid).length === 1);
    check("a close still waiting to go with no email: taken (200), and out at once with it",
      r.status === 200 && sendsFor(wid)[0]?.customer?.email === "waiting@example.com", `${r.status} ${r.body.message} ${sendsFor(wid).length}`);
    check("…a lead that has an email of its own keeps it", (await Lead.findById(leadId).lean())?.email === "already@lead.example");
  }

  // A Bangalore close: to the organization written on its row at the close, whatever the setting says now — added by a manager.
  const stuckB = await stuckClose({ academy: "bangalore", course: courseBlr._id, totalFee: 45000, paidAmount: 45000, payments: [{ ...pay("card", 45000, "blr-no-email"), paidAt: new Date("2026-10-10") }] });
  row = await rowOf(stuckB.id);
  check("a Bangalore close refused the same way, its row written for Bangalore's organization",
    row?.status === "failed" && row?.financeOrgId === BLR_ORG && refusedSends.some((p) => p.externalId === stuckB.id && p._org === BLR_ORG), `${row?.status} ${row?.financeOrgId}`);
  const { env } = await import("../src/config/env.js");
  env.FINANCE_ORG_ID_BANGALORE = "org-bangalore-renamed";
  r = await addEmail(stuckB.id, "Maya", "blr.client@example.com");
  await waitFor(() => sendsFor(stuckB.id).length === 1);
  check("someone who may edit students adds it: 200 — and it goes to the organization it was closed for, as the same enrolment",
    r.status === 200 && sendsFor(stuckB.id)[0]?._org === BLR_ORG && sendsFor(stuckB.id)[0]?.externalId === stuckB.id && sendsFor(stuckB.id)[0]?.academy === "bangalore"
      && sendsFor(stuckB.id)[0]?.customer?.email === "blr.client@example.com",
    `${r.status} ${r.body.message} ${JSON.stringify(sendsFor(stuckB.id).map((p) => p._org))}`);
  check("…the lead's activity says who", String((await Lead.findById(stuckB.leadId).lean())?.activityLogs?.at(-1)?.performedBy) === String(people.Maya!.id));
  env.FINANCE_ORG_ID_BANGALORE = BLR_ORG;
}

section("Case 11 — one email, one client (2026-10-10): Halif's case — the correction, \"Send again\" and the added email refuse another client's email");
{
  const { StudentService } = await import("../src/services/studentService.js");
  const svc = new StudentService();
  const SHARED = "najad.shared@example.com";
  /** A lead with this name, phone and email, as the CRM holds one. */
  const leadOf = async (name: string, phone: string, email: string | null) => {
    const _id = new Types.ObjectId();
    await db.collection("leads").insertOne({
      _id, name, phone, ...(email === null ? {} : { email }), status: "closed", assignedTo: people.Theertha!.id, payments: [], activityLogs: [],
    });
    return String(_id);
  };
  const ask = (q: Record<string, string>) => call("GET", `/students/email-check?${new URLSearchParams(q)}`, "Theertha");
  const settledAs = (id: string, status: string) => waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === status);

  // najad ahmed closed first with the address — through the API, delivered.
  const najadLead = await leadOf("najad ahmed", "+971509200001", SHARED);
  r = await call("POST", "/students", "Theertha", {
    leadId: najadLead, name: "najad ahmed", phone: "+971509200001", email: SHARED, course: String(course500._id), team: String(teamA),
    assignedTo: String(people.Theertha!.id), enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 500, paidAmount: 500, language: "English",
    hasBonus: false, payments: [pay("cash", 500, "najad-cash")],
  });
  const najadId = String(r.body.data?._id ?? "");
  const najadDelivered = await settledAs(najadId, "sent");
  const najadBefore = await snapshot(najadId);
  const najadCode = (await Student.findById(najadId).lean())?.enrollmentNumber;
  check("najad ahmed closes with the address first: 201, delivered", r.status === 201 && najadDelivered && Boolean(najadCode), `${r.status} ${r.body.message}`);

  // Halif — another client, another phone — closed with the same address before this rule, as in
  // this CRM: written straight in, and delivered (finance filed it under najad ahmed).
  const halifLead = await leadOf("Halif", "+971509200002", SHARED);
  const halif = await Student.create({
    enrollmentNumber: "STU-6001", name: "Halif", phone: "+971509200002", email: SHARED, leadId: halifLead, course: course500._id, team: teamA,
    assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date("2026-10-06"),
    language: "English", paymentMethod: "cash", paymentReceipt: receipt("halif-cash"), payments: [{ ...pay("cash", 500, "halif-cash"), paidAt: new Date("2026-10-06") }],
    hasBonus: false, bonusAmount: 0, academy: "dubai", status: "active",
  });
  const halifId = String(halif._id);
  await svc.queueFinanceHandover(halifId, halifLead);
  const halifDelivered = await settledAs(halifId, "sent");
  approvalOf.set(halifId, "pending");
  await sendBack(halifId);
  check("Halif's close went to finance with najad's address — and finance sends it back",
    halifDelivered && sendsFor(halifId).length === 1 && sendsFor(halifId)[0]?.customer?.email === SHARED, `${halifDelivered} ${sendsFor(halifId).length}`);
  form = await call("GET", `/students/${halifId}/correction`, "Theertha");
  check("…the correction opens for it", form.status === 200 && form.body.data?.sentBack === true, `${form.status} ${JSON.stringify(form.body.data?.sentBack)}`);

  const halifFix = (over: Record<string, unknown> = {}) => correction({
    name: "Halif", phone: "+971509200002", email: SHARED, course: String(course500._id), totalFee: 500, paidAmount: 500,
    payments: [pay("cash", 500, "halif-fixed")], hasBonus: false, bonusAmount: 0, notes: "Halif's own email", ...over,
  });
  const takenByNajad = `This email is already used by najad ahmed (${najadCode}), a different client — enter Halif's own email.`;
  /** Refused, with nothing changed on Halif, nothing sent, and still sent back. */
  const refusedH = async (label: string, send: () => Promise<Answer>, status: number, pattern: RegExp | string) => {
    const before = await snapshot(halifId);
    const sends = sendsFor(halifId).length;
    const x = await send();
    await sleep(100);
    const same = (await snapshot(halifId)) === before && sendsFor(halifId).length === sends
      && (await FinanceHandover.findOne({ studentId: halifId }).lean())?.approvalState === "returned";
    const said = typeof pattern === "string" ? x.body.message === pattern : pattern.test(x.body.message ?? "");
    check(label, x.status === status && said && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
  };

  let c = await ask({ email: SHARED, studentId: halifId });
  check("the correction dialog's check on the email it opens with: taken — najad ahmed, a student, by code — in the refusal's words",
    c.status === 200 && c.body.data?.ok === false && (c.body.data?.takenBy as any)?.name === "najad ahmed" && (c.body.data?.takenBy as any)?.code === najadCode
      && c.body.data?.message === takenByNajad, JSON.stringify(c.body));
  await refusedH("corrected keeping najad's address: 409, naming him — so finance never renames najad ahmed to Halif", () => call("PUT", `/students/${halifId}/correction`, "Theertha", halifFix()), 409, takenByNajad);
  await refusedH("…in any case, with spaces round it: 409", () => call("PUT", `/students/${halifId}/correction`, "Theertha", halifFix({ email: "  NAJAD.Shared@Example.com " })), 409, takenByNajad);
  await refusedH("\"Send again\" as it stands, with that address: 409, the same words and where to change it",
    () => call("POST", `/students/${halifId}/invoice`, "Theertha"), 409, `${takenByNajad} Correct the enrolment to change it, and it goes again.`);
  await leadOf("Rahul K", "+971509200003", "rahul.k@example.com");
  await refusedH("corrected with an address another lead holds (another person): 409, naming the lead as one",
    () => call("PUT", `/students/${halifId}/correction`, "Theertha", halifFix({ email: "rahul.k@example.com" })), 409,
    "This email is already used by Rahul K (a lead), a different client — enter Halif's own email.");

  c = await ask({ email: "halif.own@example.com", studentId: halifId });
  check("the check on Halif's own address: free", c.body.data?.ok === true, JSON.stringify(c.body.data));
  const k = sendsFor(halifId).length;
  r = await call("PUT", `/students/${halifId}/correction`, "Theertha", halifFix({ email: "Halif.Own@Example.com" }));
  await waitFor(() => sendsFor(halifId).length === k + 1);
  const resent = sendsFor(halifId).at(-1);
  check("Halif corrected with his own, untaken address: 200, sent again at once as the same enrolment, with it",
    r.status === 200 && resent?.externalId === halifId && resent?.customer?.email === "halif.own@example.com" && resent?.customer?.name === "Halif",
    `${r.status} ${r.body.message} ${JSON.stringify(resent?.customer)}`);
  check("…the enrolment has it; his lead keeps the address it carried (nothing cleaned); najad ahmed untouched",
    (await Student.findById(halifId).lean())?.email === "halif.own@example.com" && (await Lead.findById(halifLead).lean())?.email === SHARED
      && (await snapshot(najadId)) === najadBefore);

  // The same client's other enrolment's address: the same person (the same phone, written another way).
  const second = await leadOf("Halif", "0509200002", null);
  r = await call("POST", "/students", "Theertha", {
    leadId: second, name: "Halif", phone: "0509200002", email: "halif.second@example.com", course: String(course500._id),
    enrollmentDate: "2026-10-07T00:00:00.000Z", totalFee: 500, paidAmount: 500, language: "English", hasBonus: false, payments: [pay("cash", 500, "halif-2")],
  });
  check("Halif closes a second course with another address of his: 201", r.status === 201, `${r.status} ${r.body.message}`);
  await settledAs(halifId, "sent");
  await sendBack(halifId);
  r = await call("PUT", `/students/${halifId}/correction`, "Theertha", halifFix({ email: "halif.second@example.com" }));
  check("…and his first, sent back again, corrected with that one — his own other enrolment's: 200", r.status === 200, `${r.status} ${r.body.message}`);

  // The added email, for a close finance refused for want of one.
  const stuckOf = async (name: string, phone: string) => {
    n++;
    const leadId = await leadOf(name, phone, null);
    const st = await Student.create({
      enrollmentNumber: `STU-${6100 + n}`, name, phone, leadId, course: course500._id, team: teamA, assignedTo: people.Theertha!.id,
      totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date("2026-10-10"), language: "English",
      paymentMethod: "cash", paymentReceipt: receipt(`stuck-${n}`), payments: [{ ...pay("cash", 500, `stuck-${n}`), paidAt: new Date("2026-10-10") }],
      hasBonus: false, bonusAmount: 0, academy: "dubai", status: "active",
    });
    const id = String(st._id);
    await svc.queueFinanceHandover(id, leadId);
    if (!(await settledAs(id, "failed"))) throw new Error("could not set up a refused close");
    return { id, leadId };
  };
  const stuck = await stuckOf("Stuck Person", "+971509200009");
  const addEmail = (email: string) => call("POST", `/students/${stuck.id}/enrolment/email`, "Theertha", { email });
  /** Refused, with nothing changed and nothing sent. */
  const refusedAdd = async (label: string, email: string, message: string) => {
    const x = await addEmail(email);
    await sleep(150);
    const row = await FinanceHandover.findOne({ studentId: stuck.id }).lean();
    const same = row?.status === "failed" && !(row?.payload as any)?.customer?.email && sendsFor(stuck.id).length === 0
      && !(await Student.findById(stuck.id).lean())?.email && !(await Lead.findById(stuck.leadId).lean())?.email;
    check(label, x.status === 409 && x.body.message === message && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
  };
  await refusedAdd("adding najad's address to another client's refused close: 409, naming him, nothing changed or sent", SHARED,
    `This email is already used by najad ahmed (${najadCode}), a different client — enter Stuck Person's own email.`);
  await refusedAdd("…or one another lead holds: 409, naming the lead", "rahul.k@example.com",
    "This email is already used by Rahul K (a lead), a different client — enter Stuck Person's own email.");
  c = await ask({ email: SHARED, studentId: stuck.id });
  check("…the add-email box's check says so first", c.body.data?.ok === false && (c.body.data?.takenBy as any)?.code === najadCode, JSON.stringify(c.body.data));

  // What its field starts from: never an address another client holds.
  const views = async () => {
    const mine = await call("GET", "/students/enrolments/mine?limit=100", "Theertha");
    const page = await call("GET", `/students/enrolments/${stuck.id}`, "Theertha");
    const start = await call("GET", `/students/${stuck.id}/correction`, "Theertha");
    return [((mine.body as any).data as any[])?.find((x) => String(x._id) === stuck.id)?.handover, (page.body.data as any)?.handover, start.body.data] as any[];
  };
  await db.collection("leads").updateOne({ _id: new Types.ObjectId(stuck.leadId) }, { $set: { email: SHARED } });
  let v = await views();
  check("the lead given najad's address by hand: not suggested — on My Enrolments, the enrolment page or the student page",
    v.every((x) => x?.needsClientEmail === true && x?.suggestedEmail === ""), JSON.stringify(v.map((x) => [x?.needsClientEmail, x?.suggestedEmail])));
  await db.collection("leads").updateOne({ _id: new Types.ObjectId(stuck.leadId) }, { $set: { email: "stuck.lead@example.com" } });
  await Student.updateOne({ _id: stuck.id }, { $set: { email: SHARED } });
  v = await views();
  check("…the enrolment holding najad's and the lead its own: the lead's is suggested", v.every((x) => x?.suggestedEmail === "stuck.lead@example.com"), JSON.stringify(v.map((x) => x?.suggestedEmail)));
  await sleep(150);
  check("…only suggested: nothing sent", sendsFor(stuck.id).length === 0);
  r = await addEmail("stuck.lead@example.com");
  await waitFor(() => sendsFor(stuck.id).length === 1);
  check("the client's own address added: 200, delivered with it as the same enrolment",
    r.status === 200 && sendsFor(stuck.id)[0]?.customer?.email === "stuck.lead@example.com" && sendsFor(stuck.id)[0]?.externalId === stuck.id, `${r.status} ${r.body.message}`);
}

// Collecting more than the fee is taken now (the owner, 2026-10-06) — last, so nothing above depends on it.
await sendBack(sale.id);
const overRes = await call("PUT", `/students/${sale.id}/correction`, "Theertha", correction({ totalFee: 700 }));
const overSaved = await Student.findById(sale.id).lean();
check("collected more than the fee: taken (200), balance 0", overRes.status === 200 && overSaved?.totalFee === 700 && overSaved?.pendingAmount === 0, `${overRes.status} ${overRes.body.message}`);

server.close();
finance.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
