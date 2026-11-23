/**
 * Checks Change course after finance approved the enrolment in the Remote CRM (the user, 2026-11-23, as in the Sales
 * CRM: a closed, approved lead was reopened, put on a cheaper course and closed again — finance never heard), on a
 * scratch database, through the API, against a stand-in finance:
 *
 *   - Case 1: asking — refused until finance has the enrolment and approved it (not sent yet, waiting, sent back,
 *     finance away), for a course that isn't sold, a fee below what is paid, nothing changing, a missing reason;
 *     who may (the closer their own, whoever edits students any); finance's own refusal passed on; nothing stored.
 *   - Case 2: asked — sent to finance with the course exactly as the close names it (item, code, LMS courses), the
 *     fee in fils, the reason and who asked; stored pending; the same dialog again is the same request; a second one
 *     while it waits refused; what the dialog starts from.
 *   - Case 3: the locks — the lead's course, the enrolment's course and fee once finance has it (re-closing too);
 *     before finance has it, and once it sends it back, as before.
 *   - Case 4: approved in finance — the student (course, fee, left to pay, fee status), the request (approved, who,
 *     when, note, applied), the lead (course, selling amount, its activity), the sale's commission to be counted
 *     again; applied once, however often it is read back.
 *   - Case 5: rejected in finance — with its reason, the enrolment unchanged; once.
 *   - Case 6: a Bangalore enrolment — its own finance org, its Bangalore item and LMS courses, paise.
 *   - Case 7: the read-only mismatch report (src/scripts/financeMismatch.ts).
 *   - Case 8: a request finance kept while this CRM never heard back — asking again says it will show here; the
 *     read-back takes it from finance (once), then applies finance's approval once; one whose course isn't a course
 *     here changes the fee only, and says so.
 *   - Case 9: this CRM's own — a close paid partly in dollars (its rate to AED) is measured by the dirhams it came to,
 *     and keeps its dollar payment as it was; a team leader asks only for their own closes, as Correct it.
 *
 * The stand-in finance takes enrolments, says where each stands (with its course changes), and takes course changes
 * the way finance's intake does: refused for an enrolment it doesn't have or hasn't approved, while another waits,
 * below what is paid, or when nothing changes; the same id again is the same request.
 *
 * Run by course-change-check.sh. Scratch database only.
 */
import http from "node:http";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ok: () => Promise<boolean> | boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok()) return true;
    await sleep(50);
  }
  return false;
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 600) ?? "";

// ── A stand-in finance ────────────────────────────────────────────────────────────────────────────────────────────
const DXB_ORG = "org-course-change-check", BLR_ORG = "org-course-change-blr";
type Invoice = { org: string; number: string; course: string; totalMinor: number; paidMinor: number; currency: string; approval: string; void?: boolean };
type Change = { externalId: string; status: "pending" | "approved" | "rejected"; course: string; priceMinor: number; currency: string; reason?: string; decidedAt?: string; decidedBy?: string; note?: string };
const invoiceOf = new Map<string, Invoice>();
const changesOf = new Map<string, Change[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intake: any[] = [];
let financeDown = false;
/** Keep the next course change, but answer 504 — a proxy timing out after finance kept it, as the CRM sees it. */
let keepThenDrop = false;
let inv = 0;
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const aed = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const finance = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const org = String(req.headers["x-delta-org"] ?? "");
    res.setHeader("content-type", "application/json");
    const answer = (status: number, json: unknown) => { res.statusCode = status; res.end(JSON.stringify(json)); };
    if (req.url === "/api/v1/integrations/enrolments") {
      const id = String(body.externalId);
      inv++;
      invoiceOf.set(id, {
        org, number: `IN-${String(inv).padStart(5, "0")}`, course: body.course?.name ?? "", totalMinor: body.course?.amountMinor ?? 0,
        paidMinor: body.declaredPaidMinor ?? 0, currency: body.academy === "bangalore" ? "INR" : "AED", approval: "pending",
      });
      return answer(200, { data: { invoiceId: `inv-${id}`, invoiceNumber: invoiceOf.get(id)!.number, customerId: "cust", duplicate: false, flags: [] } });
    }
    // A changed note on an enrolment finance has goes there too (financeSalesNote.ts) — taken.
    if (req.url === "/api/v1/integrations/enrolments/sales-note") return answer(200, { data: { ok: true } });
    if (req.url === "/api/v1/integrations/enrolments/status") {
      if (financeDown) return answer(503, {});
      const ids = ((body.externalIds ?? []) as string[]).filter((id) => invoiceOf.get(id)?.org === org);
      return answer(200, {
        data: ids.map((id) => {
          const i = invoiceOf.get(id)!;
          return {
            externalId: id, invoiceId: `inv-${id}`, invoiceNumber: i.number, status: i.void ? "void" : "sent", approval: i.approval,
            returnedReason: i.approval === "returned" ? "Wrong receipt" : "", issueDate: "2026-11-01", currency: i.currency,
            totalMinor: i.totalMinor, amountPaidMinor: i.paidMinor, balanceMinor: Math.max(0, i.totalMinor - i.paidMinor), course: i.course,
            balancePayments: [], courseChanges: changesOf.get(id) ?? [],
          };
        }),
      });
    }
    if (req.url === "/api/v1/integrations/enrolments/course-changes") {
      if (financeDown) return answer(503, { error: { message: "Service unavailable" } });
      intake.push({ ...body, __org: org });
      const id = String(body.enrolmentExternalId);
      const i = invoiceOf.get(id);
      if (!i || i.org !== org) return answer(404, { error: { message: "This enrolment isn't in finance" } });
      const list = changesOf.get(id) ?? [];
      const again = list.find((c) => c.externalId === body.externalId);
      if (again) return answer(200, { data: { id: `cc-${again.externalId}`, ...again } });
      if (i.void) return answer(409, { error: { message: `Invoice ${i.number} is void` } });
      if (i.approval !== "approved") return answer(409, { error: { message: `Invoice ${i.number} is not approved yet — correct it in the CRM` } });
      const waiting = list.find((c) => c.status === "pending");
      if (waiting) return answer(409, { error: { message: `A course change for invoice ${i.number} (to ${waiting.course}) is already waiting for finance` } });
      if (body.priceMinor < i.paidMinor) return answer(409, { error: { message: `${aed(i.paidMinor, i.currency)} is already paid — the new fee can't be less` } });
      if (sameName(String(body.course?.name ?? ""), i.course) && body.priceMinor === i.totalMinor) return answer(409, { error: { message: "Nothing changes: the same course at the same price" } });
      const c: Change = { externalId: body.externalId, status: "pending", course: body.course.name, priceMinor: body.priceMinor, currency: i.currency };
      changesOf.set(id, [...list, c]);
      if (keepThenDrop) { keepThenDrop = false; return answer(504, { error: { message: "Gateway timeout" } }); }
      return answer(201, { data: { id: `cc-${c.externalId}`, ...c } });
    }
    answer(404, {});
  });
});
await new Promise<void>((r) => finance.listen(0, "127.0.0.1", () => r()));
const financePort = (finance.address() as { port: number }).port;
/** Finance decides a change: approved moves the invoice to the new course and price. */
function financeDecides(id: string, externalId: string, status: "approved" | "rejected", extra: { reason?: string; note?: string } = {}) {
  const c = (changesOf.get(id) ?? []).find((x) => x.externalId === externalId)!;
  Object.assign(c, { status, decidedAt: "2026-11-23T08:30:00.000Z", decidedBy: "Accounts Approver", ...extra });
  if (status === "approved") Object.assign(invoiceOf.get(id)!, { course: c.course, totalMinor: c.priceMinor });
}

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "course-change-check-jwt",
  JWT_REFRESH_SECRET: "course-change-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${financePort}`,
  FINANCE_CLIENT_ID: "crm-course-change-check",
  FINANCE_INTEGRATION_SECRET: "course-change-check-secret-course-change-check",
  FINANCE_ORG_ID: DXB_ORG,
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
const { syncCourseChanges, ADOPTED_REASON } = await import("../src/services/courseChangeService.js");

// ── People and courses (made up) ──────────────────────────────────────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), managerRole = new Types.ObjectId(), viewerRole = new Types.ObjectId(), tlRole = new Types.ObjectId();
const all = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // Closes leads and changes their own sales; may not edit students at large.
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { students: { ...all, edit: false }, leads: all, enrolments: all } },
  // Edits any student; no enrolments module.
  { _id: managerRole, roleName: "Manager", isSystemRole: false, permissions: { students: all, leads: all } },
  { _id: viewerRole, roleName: "Viewer", isSystemRole: false, permissions: { students: { ...all, create: false, edit: false }, leads: { ...all, edit: false } } },
  // This CRM's Team Leader: corrects their own closes, not their members' (no students edit).
  { _id: tlRole, roleName: "Team Leader", isSystemRole: false, permissions: { students: { ...all, edit: false }, leads: all, enrolments: all } },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Sam", superRole], ["Rania", bdeRole], ["Omar", bdeRole], ["Maya", managerRole], ["Vera", viewerRole], ["Tara", tlRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const team = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: team, name: "Team A", status: "active", leaders: [], members: [people.Rania!.id, people.Omar!.id] });
const courseA = await Course.create({ name: "COURSE A", amount: 2250, financeItemId: "item-a", lmsCourseSlugs: ["course-a"] });
const courseB = await Course.create({
  name: "COURSE B", amount: 5500, financeItemId: "item-b", hsnSac: "999293", lmsCourseSlugs: ["course-b-1", "course-b-2"],
  bangalore: { price: 150000, financeItemId: "blr-item-b", lmsCourseSlugs: ["course-b-blr"] },
});
const courseC = await Course.create({ name: "COURSE C", amount: 1500, bangalore: { price: 40000 } });
const retired = await Course.create({ name: "OLD COURSE", amount: 999, status: "inactive" });

// ── The API ───────────────────────────────────────────────────────────────────────────────────────────────────────
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
type Answer = { status: number; body: { data?: Record<string, unknown> & { _id?: string }; message?: string } };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}

const receipt = (name: string) => ({ name: `${name}.jpg`, url: `https://files.test.local/receipts/${name}.jpg`, key: `receipts/${name}.jpg`, size: 1000, mimeType: "image/jpeg" });
let n = 0;
/** Closed by Rania on COURSE A at 2,250 with 1,000 cash, and delivered to finance (waiting for approval there). */
async function closedSale(o: { academy?: "bangalore"; course?: Types.ObjectId; fee?: number; paid?: number; sellingAmount?: number; payments?: Record<string, unknown>[] } = {}) {
  n++;
  const leadId = new Types.ObjectId();
  const fee = o.fee ?? 2250, paid = o.paid ?? 1000;
  await db.collection("leads").insertOne({
    _id: leadId, name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`, status: "closed",
    reporter: people.Rania!.id, assignedTo: people.Rania!.id, course: o.course ?? courseA._id, ...(o.sellingAmount ? { sellingAmount: o.sellingAmount } : {}),
    activityLogs: [], payments: [],
  });
  const r = await call("POST", "/students", "Rania", {
    leadId: String(leadId), name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`,
    course: String(o.course ?? courseA._id), team: String(team), assignedTo: String(people.Rania!.id), ...(o.academy ? { academy: o.academy } : {}),
    enrollmentDate: "2026-11-01T00:00:00.000Z", totalFee: fee, paidAmount: paid, language: "English", hasBonus: false,
    payments: o.payments ?? [{ method: "cash", amount: paid, receipt: receipt(`cash-${n}`), paidAt: "2026-11-01T00:00:00.000Z" }],
  });
  const id = String(r.body.data?._id ?? "");
  const out = await waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "sent");
  if (r.status !== 201 || !out) throw new Error(`could not set up a sale: ${r.status} ${r.body.message}`);
  return { id, leadId: String(leadId) };
}
const approve = (id: string) => { invoiceOf.get(id)!.approval = "approved"; };
const ask = (id: string, who: string, over: Record<string, unknown> = {}) =>
  call("POST", `/students/${id}/course-change`, who, { courseId: String(courseB._id), fee: 5000, reason: "Upgraded to the full programme", ...over });
const snapshot = async (id: string) => JSON.stringify(await Student.findById(id).select("-updatedAt -financeSyncedAt").lean());

section("Case 1 — asking: refused until it can be, and for what can't be right");
const sale = await closedSale({ sellingAmount: 2250 });
let r = await ask(sale.id, "Rania");
check("waiting for finance's approval: 409, nothing sent", r.status === 409 && /hasn't approved/.test(r.body.message ?? "") && intake.length === 0, `${r.status} ${r.body.message}`);
invoiceOf.get(sale.id)!.approval = "returned";
r = await ask(sale.id, "Rania");
check("sent back: 409, use Correct it instead", r.status === 409 && /Correct it/.test(r.body.message ?? "") && intake.length === 0, `${r.status} ${r.body.message}`);
approve(sale.id);
// Not in finance yet: a close whose hand-over didn't get through.
const early = await closedSale();
await FinanceHandover.updateOne({ studentId: early.id }, { $set: { status: "failed" } });
r = await ask(early.id, "Rania");
check("not in finance yet: 409, edit the enrolment instead", r.status === 409 && /isn't in finance yet/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
financeDown = true;
r = await ask(sale.id, "Rania");
check("finance away: 502, nothing stored", r.status === 502 && !(await Student.findById(sale.id).lean())?.courseChanges?.length, `${r.status} ${r.body.message}`);
financeDown = false;
const before1 = await snapshot(sale.id);
for (const [label, over, status, pattern] of [
  ["no course", { courseId: "" }, 422, /needs the new course/],
  ["no fee", { fee: 0 }, 422, /needs the new fee/],
  ["no reason", { reason: " " }, 422, /needs why it changes/],
  ["three decimals", { fee: 5000.125 }, 422, /at most 2 decimals/],
  ["a course no longer sold", { courseId: String(retired._id) }, 422, /isn't sold any more/],
  ["a course that doesn't exist", { courseId: String(new Types.ObjectId()) }, 422, /no longer exists/],
  ["a fee below the 1,000 paid", { fee: 900 }, 422, /AED 1,000\.00 is already paid — the new fee can't be less/],
  ["the course and fee it has", { courseId: String(courseA._id), fee: 2250 }, 422, /nothing to change/],
] as const) {
  r = await ask(sale.id, "Rania", over);
  check(`${label}: ${status}`, r.status === status && pattern.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
}
check("…none of them sent to finance, nothing changed", intake.length === 0 && (await snapshot(sale.id)) === before1);
r = await ask(sale.id, "Omar");
check("another salesperson's close: 403", r.status === 403 && /isn't yours/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
r = await ask(sale.id, "Vera");
check("no enrolments or students edit: 403 at the door", r.status === 403, `${r.status} ${r.body.message}`);
r = await ask(sale.id);
check("no one signed in: 401", r.status === 401, `${r.status}`);
// Finance's own refusal, passed on: it knows of more paid than this CRM does yet.
invoiceOf.get(sale.id)!.paidMinor = 300000;
r = await ask(sale.id, "Rania", { fee: 2500 });
check("finance refuses (AED 3,000 paid there): 409 with finance's words, nothing stored",
  r.status === 409 && r.body.message === "AED 3,000.00 is already paid — the new fee can't be less" && !(await Student.findById(sale.id).lean())?.courseChanges?.length, `${r.status} ${r.body.message}`);
invoiceOf.get(sale.id)!.paidMinor = 100000;
const intakeBefore = intake.length;

section("Case 2 — asked: sent to finance, stored pending, once");
let info = await call("GET", `/students/${sale.id}/course-change`, "Rania");
check("what the dialog starts from: can ask, the course, fee, paid, the invoice", info.status === 200 && info.body.data?.canRequest === true && (info.body.data?.course as { name?: string })?.name === "COURSE A"
  && info.body.data?.fee === 2250 && info.body.data?.paid === 1000 && info.body.data?.currency === "AED" && (info.body.data?.invoice as { totalMinor?: number })?.totalMinor === 225000, show(info.body.data));
const key = crypto.randomUUID();
r = await ask(sale.id, "Rania", { key });
check("the closer asks: 201, pending", r.status === 201 && r.body.data?.status === "pending" && r.body.data?.externalId === key, `${r.status} ${r.body.message} ${show(r.body.data)}`);
const sent = intake.at(-1);
check("finance is sent: crm, the enrolment, the request's id, to Dubai's org", intake.length === intakeBefore + 1 && sent?.source === "crm" && sent?.enrolmentExternalId === sale.id && sent?.externalId === key && sent?.__org === DXB_ORG, show(sent));
check("…the course as the close names it: item, code, LMS courses — no amount",
  JSON.stringify(sent?.course) === JSON.stringify({ name: "COURSE B", itemId: "item-b", hsnSac: "999293", lmsCourseSlug: "course-b-1", lmsCourseSlugs: ["course-b-1", "course-b-2"] }), show(sent?.course));
check("…the fee in fils, the reason, who asked", sent?.priceMinor === 500000 && sent?.reason === "Upgraded to the full programme" && sent?.requestedBy?.name === "Rania" && sent?.requestedBy?.email === "rania@test.local", show(sent));
let s = await Student.findById(sale.id).lean();
const cc = s?.courseChanges?.[0];
check("stored on the student: pending, the course, the fee, the reason, who and when", s?.courseChanges?.length === 1 && cc?.externalId === key && String(cc?.courseId) === String(courseB._id)
  && cc?.courseName === "COURSE B" && cc?.fee === 5000 && cc?.reason === "Upgraded to the full programme" && cc?.status === "pending"
  && String(cc?.requestedBy?.id) === String(people.Rania!.id) && cc?.requestedBy?.name === "Rania" && cc?.requestedAt instanceof Date, show(s?.courseChanges));
check("…and nothing else about the enrolment changed yet", String(s?.course) === String(courseA._id) && s?.totalFee === 2250 && s?.pendingAmount === 1250);
r = await ask(sale.id, "Rania", { key });
check("the same dialog again (same id): the same request, nothing sent or stored twice", r.status === 201 && r.body.data?.externalId === key && intake.length === intakeBefore + 1
  && (await Student.findById(sale.id).lean())?.courseChanges?.length === 1, `${r.status} ${intake.length}`);
r = await ask(sale.id, "Rania", { courseId: String(courseC._id), fee: 1500 });
check("a second one while it waits: 409, one at a time", r.status === 409 && /already waiting/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
info = await call("GET", `/students/${sale.id}/course-change`, "Rania");
check("the dialog now says it is waiting, and lists it", info.body.data?.canRequest === false && /COURSE B is already waiting/.test(String(info.body.data?.whyNot)) && (info.body.data?.changes as unknown[])?.length === 1, show(info.body.data));
info = await call("GET", `/students/${sale.id}/course-change`, "Omar");
check("…another salesperson can't open it: 403", info.status === 403);
const byLead = await call("GET", `/students/by-lead/${sale.leadId}`, "Rania");
check("the student by its lead carries the request (for the lead page's banner)", ((byLead.body.data as { courseChanges?: { status: string }[] })?.courseChanges ?? [])[0]?.status === "pending", show(byLead.body.data));

section("Case 3 — the locks");
r = await call("PUT", `/leads/${sale.leadId}`, "Rania", { course: String(courseC._id) });
check("the enrolled lead's course: 409", r.status === 409 && r.body.message === "This lead is enrolled — change its course with Change course; finance approves it.", `${r.status} ${r.body.message}`);
check("…unchanged", String((await Lead.findById(sale.leadId).lean())?.course) === String(courseA._id));
r = await call("PUT", `/leads/${sale.leadId}`, "Rania", { course: String(courseA._id), comments: "Same course, other fields" });
check("…the lead saved with the course it has: fine", r.status === 200, `${r.status} ${r.body.message}`);
r = await call("PUT", `/leads/${early.leadId}`, "Rania", { course: String(courseC._id) });
check("…a lead enrolled but not in finance yet: 409 too", r.status === 409, `${r.status} ${r.body.message}`);
const plainLead = new Types.ObjectId();
await db.collection("leads").insertOne({ _id: plainLead, name: "Not enrolled", phone: "+971509990000", status: "followup", reporter: people.Rania!.id, assignedTo: people.Rania!.id, course: courseA._id, activityLogs: [] });
r = await call("PUT", `/leads/${plainLead}`, "Rania", { course: String(courseC._id) });
check("…a lead not enrolled: changes as before", r.status === 200 && String((await Lead.findById(plainLead).lean())?.course) === String(courseC._id), `${r.status} ${r.body.message}`);
const before3 = await snapshot(sale.id);
r = await call("PUT", `/students/${sale.id}`, "Maya", { course: String(courseC._id) });
check("the enrolment's course, once finance has it: 409", r.status === 409 && /Change course/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
r = await call("PUT", `/students/${sale.id}`, "Maya", { totalFee: 1500 });
check("…its fee: 409", r.status === 409, `${r.status} ${r.body.message}`);
// Re-closing the lead sends what the close dialog holds — the same course and fee save, a changed one doesn't.
r = await call("PUT", `/students/${sale.id}`, "Sam", { course: String(courseC._id), totalFee: 1500, paidAmount: 1000, notes: "closed again" });
check("…closed again on another course and fee (even a Super Admin): 409, nothing changed", r.status === 409 && (await snapshot(sale.id)) === before3, `${r.status} ${r.body.message}`);
r = await call("PUT", `/students/${sale.id}`, "Maya", { course: String(courseA._id), totalFee: 2250, notes: "closed again" });
check("…closed again as it is (same course, same fee), with a note: saved", r.status === 200 && (await Student.findById(sale.id).lean())?.notes === "closed again", `${r.status} ${r.body.message}`);
r = await call("PUT", `/students/${early.id}`, "Maya", { course: String(courseC._id), totalFee: 1500 });
check("before finance has it: the course and fee change as before", r.status === 200 && String((await Student.findById(early.id).lean())?.course) === String(courseC._id), `${r.status} ${r.body.message}`);
const returned = await closedSale();
invoiceOf.get(returned.id)!.approval = "returned";
await FinanceHandover.updateOne({ studentId: returned.id }, { $set: { approvalState: "returned", returnedReason: "Wrong receipt" } });
r = await call("PUT", `/students/${returned.id}`, "Maya", { course: String(courseC._id), totalFee: 1500 });
check("sent back by finance: as before (the correction's to send)", r.status === 200, `${r.status} ${r.body.message}`);

section("Case 4 — approved in finance: applied to the student, the lead and the commission, once");
await db.collection("commissionsales").insertOne({
  student: new Types.ObjectId(sale.id), studentName: "Client", saleDate: new Date("2026-11-01"), month: "2026-11", state: "counted",
  fee: 2250, plan: { sales: 100, tl: 50, sm: 25 }, lines: [], stepsDoneAt: new Date("2026-11-02"), countedAt: new Date("2026-11-02"),
});
check("nothing decided yet: the read-back changes nothing", (await syncCourseChanges()) === 0 && (await Student.findById(sale.id).lean())?.courseChanges?.[0]?.status === "pending");
financeDecides(sale.id, key, "approved", { note: "Upgrade agreed with the client" });
const applied = await syncCourseChanges();
check("finance approved it: one applied", applied === 1, `${applied}`);
s = await Student.findById(sale.id).lean();
check("the student: COURSE B at 5,000, 1,000 paid, 4,000 left, part paid", String(s?.course) === String(courseB._id) && s?.totalFee === 5000 && s?.paidAmount === 1000
  && s?.pendingAmount === 4000 && s?.feeStatus === "partial", show({ c: s?.course, f: s?.totalFee, p: s?.paidAmount, l: s?.pendingAmount, st: s?.feeStatus }));
const done = s?.courseChanges?.[0];
check("the request: approved, by whom and when, the note, applied", done?.status === "approved" && done?.decidedBy === "Accounts Approver" && done?.decidedAt?.toISOString() === "2026-11-23T08:30:00.000Z"
  && done?.note === "Upgrade agreed with the client" && done?.appliedAt instanceof Date, show(done));
let lead = await Lead.findById(sale.leadId).lean();
const log = lead?.activityLogs?.at(-1);
check("the lead: COURSE B, its selling amount 5,000", String(lead?.course) === String(courseB._id) && lead?.sellingAmount === 5000, show({ c: lead?.course, s: lead?.sellingAmount }));
check("…its activity: \"Course changed (finance approved): COURSE A → COURSE B, fee AED 2,250.00 → AED 5,000.00\", by who asked",
  log?.description === "Course changed (finance approved): COURSE A → COURSE B, fee AED 2,250.00 → AED 5,000.00" && String(log?.performedBy) === String(people.Rania!.id)
  && JSON.stringify(log?.changes) === JSON.stringify({ course: { from: "COURSE A", to: "COURSE B" }, fee: { from: 2250, to: 5000 } }), show(log));
const saleAfter = await db.collection("commissionsales").findOne({ student: new Types.ObjectId(sale.id) });
check("the sale's commission to be counted again: stepsDoneAt cleared, the rest as it was", saleAfter && !("stepsDoneAt" in saleAfter) && saleAfter.state === "counted" && saleAfter.fee === 2250, show(saleAfter));
const once = await snapshot(sale.id);
const logs = lead?.activityLogs?.length;
check("read back again: nothing applied twice", (await syncCourseChanges()) === 0 && (await snapshot(sale.id)) === once && (await Lead.findById(sale.leadId).lean())?.activityLogs?.length === logs);
info = await call("GET", `/students/${sale.id}/course-change`, "Rania");
check("…and another change can be asked for now", info.body.data?.canRequest === true && (info.body.data?.course as { name?: string })?.name === "COURSE B", show(info.body.data));
r = await call("PUT", `/students/${sale.id}`, "Maya", { course: String(courseB._id), totalFee: 5000, notes: "closed again after the change" });
check("…closing it again as it is now: saved", r.status === 200, `${r.status} ${r.body.message}`);

section("Case 5 — rejected in finance");
const second = await closedSale();
approve(second.id);
const k2 = crypto.randomUUID();
r = await ask(second.id, "Maya", { key: k2, courseId: String(courseC._id), fee: 1500, reason: "Client wants the shorter course" });
check("whoever edits students asks for any close: 201", r.status === 201, `${r.status} ${r.body.message}`);
const before5 = await Student.findById(second.id).lean();
financeDecides(second.id, k2, "rejected", { reason: "The client signed for COURSE A — keep it" });
check("finance rejected it: one applied", (await syncCourseChanges()) === 1);
const after5 = await Student.findById(second.id).lean();
const rej = after5?.courseChanges?.[0];
check("the request: rejected, finance's reason, who and when", rej?.status === "rejected" && rej?.rejectReason === "The client signed for COURSE A — keep it" && rej?.decidedBy === "Accounts Approver" && rej?.decidedAt instanceof Date && !rej?.appliedAt, show(rej));
check("…the enrolment and the lead unchanged", String(after5?.course) === String(courseA._id) && after5?.totalFee === before5?.totalFee && after5?.pendingAmount === before5?.pendingAmount
  && String((await Lead.findById(second.leadId).lean())?.course) === String(courseA._id));
check("…read back again: nothing", (await syncCourseChanges()) === 0);
r = await ask(second.id, "Rania", { courseId: String(courseC._id), fee: 1500 });
check("…and it can be asked again", r.status === 201, `${r.status} ${r.body.message}`);

section("Case 6 — a Bangalore enrolment: its own org, item and LMS courses, paise");
const blr = await closedSale({ academy: "bangalore", course: courseC._id, fee: 40000, paid: 10000 });
approve(blr.id);
r = await ask(blr.id, "Rania", { fee: 5000 });
check("a fee below the ₹10,000 paid: 422, in rupees", r.status === 422 && /^INR 10,000\.00 is already paid/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
r = await ask(blr.id, "Rania", { fee: 150000, reason: "Moved to the full course" });
const blrSent = intake.at(-1);
check("asked: 201", r.status === 201, `${r.status} ${r.body.message}`);
check("…sent to Bangalore's org, with the Bangalore item and LMS course, in paise", blrSent?.__org === BLR_ORG && blrSent?.priceMinor === 15_000_000
  && JSON.stringify(blrSent?.course) === JSON.stringify({ name: "COURSE B", itemId: "blr-item-b", hsnSac: "999293", lmsCourseSlug: "course-b-blr", lmsCourseSlugs: ["course-b-blr"] }), show(blrSent));
financeDecides(blr.id, String(r.body.data?.externalId), "approved");
check("approved and read back from Bangalore's org: applied, in rupees", (await syncCourseChanges()) === 1 && (await Student.findById(blr.id).lean())?.totalFee === 150000
  && /fee INR 40,000\.00 → INR 150,000\.00/.test((await Lead.findById(blr.leadId).lean())?.activityLogs?.at(-1)?.description ?? ""),
  (await Lead.findById(blr.leadId).lean())?.activityLogs?.at(-1)?.description);

section("Case 7 — the read-only mismatch report");
const { financeMismatches, printMismatches } = await import("../src/scripts/financeMismatch.js");
// One changed here behind finance's back (as before the locks), one whose lead names another course.
await db.collection("students").updateOne({ _id: new Types.ObjectId(returned.id) }, { $set: { totalFee: 1500 } });
await db.collection("leads").updateOne({ _id: new Types.ObjectId(second.leadId) }, { $set: { course: courseB._id } });
const dbBefore = JSON.stringify(await db.collection("students").find().toArray()) + JSON.stringify(await db.collection("leads").find().toArray());
const mm = await financeMismatches();
const ret = mm.enrolments.find((m) => m.studentId === returned.id);
check("an enrolment here on another course and fee than its invoice: listed, both", !!ret && ret.differs.join(",") === "course,fee" && ret.crm.course === "COURSE C" && ret.finance.course === "COURSE A"
  && ret.crm.fee === 1500 && ret.finance.fee === 2250, show(mm.enrolments));
check("…the approved change is not (finance and here agree)", !mm.enrolments.some((m) => m.studentId === sale.id || m.studentId === blr.id), show(mm.enrolments));
check("a lead whose course isn't its enrolment's: listed", mm.leads.some((l) => l.leadId === second.leadId && l.leadCourse === "COURSE B" && l.enrolmentCourse === "COURSE A"), show(mm.leads));
check("…every enrolment in finance asked about (not the one that never got there), finance answered", mm.asked === 4 && mm.answered === 4, `${mm.asked}/${mm.answered}`);
check("…printed, and nothing written", printMismatches(mm).some((l) => /fee: here AED 1,500\.00, finance AED 2,250\.00/.test(l))
  && JSON.stringify(await db.collection("students").find().toArray()) + JSON.stringify(await db.collection("leads").find().toArray()) === dbBefore);

section("Case 8 — a request finance kept while this CRM never heard back: taken from finance");
const lost = await closedSale();
approve(lost.id);
keepThenDrop = true;
r = await ask(lost.id, "Rania", { key: crypto.randomUUID(), reason: "Asked once, answer lost" });
const lostExt = (changesOf.get(lost.id) ?? [])[0]?.externalId ?? "";
check("finance kept it but the answer never came: 502, nothing here, the send marked", r.status === 502 && !!lostExt
  && !(await Student.findById(lost.id).lean())?.courseChanges?.length && (await Student.findById(lost.id).lean())?.courseChangeAskedAt instanceof Date, `${r.status} ${r.body.message}`);
r = await ask(lost.id, "Rania", { key: crypto.randomUUID() });
check("asked again from a new dialog: finance's 409, saying it will show here within a few minutes",
  r.status === 409 && r.body.message === `A course change for invoice ${invoiceOf.get(lost.id)!.number} (to COURSE B) is already waiting for finance. It will show here within a few minutes.`,
  `${r.status} ${r.body.message}`);
check("the read-back takes it from finance: one", (await syncCourseChanges()) === 1);
let lostSt = await Student.findById(lost.id).lean();
const adopted = lostSt?.courseChanges?.[0];
check("…with finance's id, pending, COURSE B matched here, the fee, the reason, nobody known as asking",
  lostSt?.courseChanges?.length === 1 && adopted?.externalId === lostExt && adopted?.status === "pending" && String(adopted?.courseId) === String(courseB._id)
  && adopted?.courseName === "COURSE B" && adopted?.fee === 5000 && adopted?.reason === ADOPTED_REASON && !adopted?.requestedBy?.id && adopted?.requestedBy?.name === ""
  && adopted?.requestedAt instanceof Date, show(lostSt?.courseChanges));
check("…read back again: not taken twice", (await syncCourseChanges()) === 0 && (await Student.findById(lost.id).lean())?.courseChanges?.length === 1);
r = await ask(lost.id, "Rania", { courseId: String(courseC._id), fee: 1500 });
check("…and now it waits here: a new one is refused here, one at a time", r.status === 409 && /COURSE B is already waiting/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
financeDecides(lost.id, lostExt, "approved");
check("finance approves it: applied", (await syncCourseChanges()) === 1);
lostSt = await Student.findById(lost.id).lean();
const lostLog = (await Lead.findById(lost.leadId).lean())?.activityLogs?.at(-1);
check("…the student on COURSE B at 5,000, the request approved and applied", String(lostSt?.course) === String(courseB._id) && lostSt?.totalFee === 5000 && lostSt?.pendingAmount === 4000
  && lostSt?.courseChanges?.[0]?.status === "approved" && lostSt?.courseChanges?.[0]?.appliedAt instanceof Date, show(lostSt?.courseChanges));
check("…the lead too, its activity by the system (nobody known asked)", String((await Lead.findById(lost.leadId).lean())?.course) === String(courseB._id)
  && lostLog?.description === "Course changed (finance approved): COURSE A → COURSE B, fee AED 2,250.00 → AED 5,000.00" && !lostLog?.performedBy, show(lostLog));
const lostOnce = await snapshot(lost.id);
check("…read back again: applied once", (await syncCourseChanges()) === 0 && (await snapshot(lost.id)) === lostOnce);
await Student.updateOne({ _id: lost.id }, { $set: { courseChangeAskedAt: new Date(Date.now() - 11 * 60_000) } });
await syncCourseChanges();
check("…the send long past and nothing open: no longer looked for", !(await Student.findById(lost.id).lean())?.courseChangeAskedAt);

// One whose course finance names isn't a course here (renamed or removed since), and one named with other case and spaces.
const odd = await closedSale();
approve(odd.id);
changesOf.set(odd.id, [
  { externalId: "finance-kept-1", status: "pending", course: "  course   c ", priceMinor: 250000, currency: "AED" },
]);
await Student.updateOne({ _id: odd.id }, { $set: { courseChangeAskedAt: new Date() } });
check("a request named \"  course   c \": taken, matched to COURSE C (case and spaces aside)", (await syncCourseChanges()) === 1
  && String((await Student.findById(odd.id).lean())?.courseChanges?.[0]?.courseId) === String(courseC._id), show((await Student.findById(odd.id).lean())?.courseChanges));
financeDecides(odd.id, "finance-kept-1", "rejected", { reason: "Not agreed" });
check("…rejected in finance: so here", (await syncCourseChanges()) === 1 && (await Student.findById(odd.id).lean())?.courseChanges?.[0]?.status === "rejected");
changesOf.get(odd.id)!.push({ externalId: "finance-kept-2", status: "pending", course: "Course Not Sold Here", priceMinor: 300000, currency: "AED" });
check("one for a course that isn't here: taken, with no course", (await syncCourseChanges()) === 1
  && (await Student.findById(odd.id).lean())?.courseChanges?.[1]?.courseId === null && (await Student.findById(odd.id).lean())?.courseChanges?.[1]?.courseName === "Course Not Sold Here",
  show((await Student.findById(odd.id).lean())?.courseChanges));
financeDecides(odd.id, "finance-kept-2", "approved");
check("…approved: applied", (await syncCourseChanges()) === 1);
const oddSt = await Student.findById(odd.id).lean();
const oddLead = await Lead.findById(odd.leadId).lean();
const oddLog = oddLead?.activityLogs?.at(-1);
check("…the fee only: 3,000 with 2,000 left, the course still COURSE A, here and on the lead", oddSt?.totalFee === 3000 && oddSt?.pendingAmount === 2000 && oddSt?.feeStatus === "partial"
  && String(oddSt?.course) === String(courseA._id) && String(oddLead?.course) === String(courseA._id) && oddSt?.courseChanges?.[1]?.status === "approved", show({ f: oddSt?.totalFee, c: oddSt?.course }));
check("…and the activity says so", oddLog?.description === "Fee changed (finance approved): AED 2,250.00 → AED 3,000.00 — finance moved it to Course Not Sold Here, which isn't a course here, so the course stays COURSE A"
  && JSON.stringify(oddLog?.changes) === JSON.stringify({ fee: { from: 2250, to: 3000 } }), show(oddLog));
const oddOnce = await snapshot(odd.id);
check("…read back again: applied once", (await syncCourseChanges()) === 0 && (await snapshot(odd.id)) === oddOnce);

section("Case 9 — this CRM's own: a close paid partly in dollars, a team leader");
// 500 US dollars by card at 3.67 — AED 1,835 — as the close takes another currency, with its rate to AED.
const usd = await closedSale({
  fee: 2250, paid: 1835,
  payments: [{ method: "card", amount: 1835, currency: "USD", amountInCurrency: 500, exchangeRate: 3.67, receipt: receipt("usd-card"), paidAt: "2026-11-01T00:00:00.000Z" }],
});
approve(usd.id);
r = await ask(usd.id, "Rania", { fee: 1800 });
check("a fee below the AED 1,835 the dollars came to: 422, in dirhams", r.status === 422 && /^AED 1,835\.00 is already paid/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
await db.collection("teams").updateOne({ _id: team }, { $set: { leaders: [people.Tara!.id] } });
r = await ask(usd.id, "Tara");
check("the team leader on a member's close: 403, as Correct it", r.status === 403 && /isn't yours/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
r = await ask(usd.id, "Rania", { courseId: String(courseC._id), fee: 2000, reason: "Moved to the shorter course" });
const usdSent = intake.at(-1);
check("the closer asks: 201, to Dubai's org, the fee in fils, the course with nothing mapped as just its name", r.status === 201 && usdSent?.__org === DXB_ORG
  && usdSent?.priceMinor === 200000 && JSON.stringify(usdSent?.course) === JSON.stringify({ name: "COURSE C" }), `${r.status} ${r.body.message} ${show(usdSent)}`);
financeDecides(usd.id, String(r.body.data?.externalId), "approved");
check("approved: applied", (await syncCourseChanges()) === 1);
const usdSt = await Student.findById(usd.id).lean();
check("…COURSE C at 2,000, the 1,835 paid kept, 165 left, part paid", String(usdSt?.course) === String(courseC._id) && usdSt?.totalFee === 2000 && usdSt?.paidAmount === 1835
  && usdSt?.pendingAmount === 165 && usdSt?.feeStatus === "partial", show({ c: usdSt?.course, f: usdSt?.totalFee, p: usdSt?.paidAmount, l: usdSt?.pendingAmount, st: usdSt?.feeStatus }));
check("…its dollar payment as it was: USD 500 at 3.67", usdSt?.payments?.length === 1 && usdSt?.payments?.[0]?.currency === "USD" && usdSt?.payments?.[0]?.amountInCurrency === 500
  && usdSt?.payments?.[0]?.exchangeRate === 3.67 && usdSt?.payments?.[0]?.amount === 1835, show(usdSt?.payments));

server.close();
finance.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
