/**
 * Checks a lead's payments once its close is in finance (the user, 2026-10-23: a second payment added on the lead
 * page never reached finance, so the invoice still owed, the LMS kept half the course shut and CS Portal held
 * the bonus), on a scratch database, through the API, against a stand-in finance:
 *
 *   - Case 1: which payments finance has — the close's own, one on the lead before the enrolment was sent, and one
 *     added after it ("not sent"); nothing flagged once finance has as much as the lead; a lead not closed, or not in
 *     finance yet.
 *   - Case 2: a payment on a closed lead can no longer be added without finance; on a lead not in finance it can.
 *   - Case 3: sending a "not sent" payment — its own amount only, with method and receipt, to the close's org; marked
 *     on the lead; sent once; then finance's say (pending) on it; its amount and date locked, and no deleting it.
 *   - Case 4: a new payment on a closed lead — sent and kept on the lead; saved twice is one; refused by finance, kept
 *     nowhere; out of scope; not in finance yet.
 *   - Case 6 (2026-10-26): a balance payment counts only once finance approves it — pending or rejected it is shown,
 *     never counted; one sent before has its decision filled in; a decision is final.
 *   - Case 7 (2026-10-26): the Balance payments page keeps the payment on the lead too, as a request.
 *
 * Run by lead-payments-finance-check.sh. Scratch database only.
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
const SECRET = "lead-payments-finance-check-secret-long";
type Fin = Record<string, unknown> & { externalId: string; balancePayments: any[] };
const finance = new Map<string, Fin>();
const received: { org: string; body: any }[] = [];
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
    const org = req.headers.get("x-delta-org") ?? "";
    const body = JSON.parse(raw || "{}");
    if (url.pathname === "/api/v1/integrations/enrolments/status") {
      return Response.json({ data: (body.externalIds as string[]).map((id) => finance.get(`${org}:${id}`)).filter(Boolean) });
    }
    if (url.pathname === "/api/v1/integrations/enrolments/balance-payments") {
      received.push({ org, body });
      if (refuseNext) { const r = refuseNext; refuseNext = null; return Response.json({ error: { message: r.message } }, { status: r.status }); }
      const f = finance.get(`${org}:${body.enrolmentExternalId}`);
      const bp = { externalId: body.externalId, amountMinor: body.amountMinor, currency: "AED", method: body.method, paidOn: body.paidOn, status: "pending" };
      if (f && !f.balancePayments.some((b) => b.externalId === body.externalId)) f.balancePayments.push(bp);
      return Response.json({ data: { id: `fin-${body.externalId}`, ...bp } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "lead-payments-finance-check-jwt",
  JWT_REFRESH_SECRET: "lead-payments-finance-check-refresh",
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

/* ── People ── */
const leadsPerms = { leads: { view: true, create: true, edit: true, delete: true, approve: false, export: false } };
const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: leadsPerms },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Root", superRole], ["Sally", salesRole], ["Omar", salesRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const P = (n: string) => people[n]!.id;
const team = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: team, name: "Gladiators", status: "active", leaders: [], members: [P("Sally"), P("Omar")] });
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: null, excludedUsers: [] });

/* ── Days ── */
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hh = "08:00") => new Date(`${d}T${hh}:00.000Z`);

/* ── Leads and their closes ── */
let n = 0;
type Pay = { amount: number; note: string; day: string; created?: Date };
async function lead(opts: { payments: Pay[]; close?: boolean; sent?: boolean; sentOn?: string; fin?: Partial<Fin> | null }) {
  n++;
  const leadId = new Types.ObjectId();
  const payments = opts.payments.map((p) => ({ _id: new Types.ObjectId(), amount: p.amount, note: p.note, paidAt: at(p.day), addedBy: P("Sally"), createdAt: p.created ?? at(p.day), updatedAt: p.created ?? at(p.day) }));
  await db.collection("leads").insertOne({ _id: leadId, name: `Client ${n}`, phone: `+97150000${n}`, assignedTo: P("Sally"), team, reporter: P("Sally"), status: opts.close === false ? "new" : "closed", payments, createdAt: at(plus(today, -30)), updatedAt: new Date() });
  if (opts.close === false) return { leadId: String(leadId), studentId: "", pays: payments.map((p) => String(p._id)) };
  const studentId = new Types.ObjectId();
  await db.collection("students").insertOne({
    _id: studentId, leadId, enrollmentNumber: `ENR-${n}`, name: `Client ${n}`, phone: `+97150000${n}`, email: `client${n}@test.local`,
    assignedTo: P("Sally"), team, totalFee: 2250, paidAmount: 1125, pendingAmount: 1125, feeStatus: "partial",
    enrollmentDate: at(plus(today, -6)), academy: "dubai", status: "active",
  });
  if (opts.sent !== false) {
    await db.collection("financehandovers").insertOne({ studentId, status: "sent", payload: {}, academy: "dubai", financeOrgId: "org-dubai", approvalState: "approved", sentAt: at(opts.sentOn ?? plus(today, -6), "09:00") });
  }
  if (opts.fin !== null) {
    finance.set(`org-dubai:${studentId}`, {
      externalId: String(studentId), invoiceId: `inv-${n}`, invoiceNumber: `IN-${String(150 + n).padStart(5, "0")}`, status: "partial", approval: "approved",
      returnedReason: "", issueDate: plus(today, -6), currency: "AED", totalMinor: 225_000, amountPaidMinor: 112_500, balanceMinor: 112_500,
      course: "Market Breakout", nextDueOn: plus(today, 23), payments: [{ amountMinor: 112_500, paidOn: plus(today, -6), method: "tabby" }], balancePayments: [],
      ...(opts.fin ?? {}),
    });
  }
  return { leadId: String(leadId), studentId: String(studentId), pays: payments.map((p) => String(p._id)) };
}
const CLOSE = "Collected at enrolment — COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT) · Tabby";
// Jasheer's: half at the close, half by POS five days later, added on the lead only.
const jasheer = await lead({ payments: [{ amount: 1125, note: CLOSE, day: plus(today, -6) }, { amount: 1125, note: "Pos done 1125 aed", day: plus(today, -5) }] });
// A payment on the lead before the close went with it (collected before).
const before = await lead({ payments: [{ amount: 500, note: "Deposit", day: plus(today, -8) }, { amount: 625, note: CLOSE, day: plus(today, -6) }] });
// Accounts recorded the second payment on the invoice themselves: finance has as much as the lead.
const covered = await lead({ payments: [{ amount: 1125, note: CLOSE, day: plus(today, -6) }, { amount: 1125, note: "Paid by card", day: plus(today, -4) }], fin: { amountPaidMinor: 225_000, balanceMinor: 0, status: "paid" } });
const open = await lead({ close: false, payments: [{ amount: 300, note: "Advance", day: plus(today, -2) }] });
const notSent = await lead({ sent: false, fin: null, payments: [{ amount: 1125, note: CLOSE, day: plus(today, -6) }] });
const fresh = await lead({ payments: [{ amount: 1125, note: CLOSE, day: plus(today, -6) }] });

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
async function call(method: string, path: string, who: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
const link = (l: { leadId: string }, who = "Sally") => call("GET", `/leads/${l.leadId}/payments/finance`, who);
const stateOf = (a: Answer, id: string) => a.body.data?.payments?.find((p: any) => p.id === id);
const leadDoc = async (l: { leadId: string }) => (await db.collection("leads").findOne({ _id: new Types.ObjectId(l.leadId) }))!;
const receipt = { name: "pos.jpg", url: "https://files.test.local/balance-receipts/pos.jpg", key: "balance-receipts/pos.jpg", size: 1200, mimeType: "image/jpeg" };
/** A receipt as the lead page uploads it, for that lead (enrolment-receipts/<lead>/…). */
const leadReceipt = (l: { leadId: string }, name = "slip.jpg") => ({ name, url: `https://files.test.local/enrolment-receipts/${l.leadId}/${name}`, key: `enrolment-receipts/${l.leadId}/${name}`, mimeType: "image/jpeg" });

try {
  section("Case 1 — which payments finance has");
  let r = await link(jasheer);
  check("Jasheer: in finance, IN-00151, AED 1,125 of 2,250 left, a payment can be sent", r.status === 200 && r.body.data?.inFinance === true && r.body.data?.invoice?.number === "IN-00151"
    && r.body.data?.invoice?.balanceMinor === 112_500 && r.body.data?.canRecord === true && r.body.data?.whyNot === "", JSON.stringify(r.body));
  check("…the close's payment is with the close", stateOf(r, jasheer.pays[0]!)?.state === "with_close");
  check("…the POS payment added on the lead after is NOT sent to finance", stateOf(r, jasheer.pays[1]!)?.state === "not_sent", JSON.stringify(r.body.data?.payments));
  r = await link(before);
  check("a payment on the lead before the close went with it", r.body.data?.payments?.every((p: any) => p.state === "with_close"), JSON.stringify(r.body.data?.payments));
  r = await link(covered);
  check("finance has as much as the lead (accounts recorded it): nothing flagged, nothing more to send", r.body.data?.payments?.every((p: any) => p.state === "with_close") && r.body.data?.canRecord === false && r.body.data?.whyNot === "Paid in full", JSON.stringify(r.body.data));
  r = await link(open);
  check("a lead not closed: not in finance, its payments as they were", r.body.data?.inFinance === false && r.body.data?.studentId === null && stateOf(r, open.pays[0]!)?.state === "with_close", JSON.stringify(r.body.data));
  r = await link(notSent);
  check("closed but not in finance yet: says so", r.body.data?.inFinance === false && r.body.data?.whyNot === "Not in finance yet", JSON.stringify(r.body.data));
  r = await link(jasheer, "Omar");
  check("someone outside the close's scope sees it but can't send", r.body.data?.canRecord === false && /closer/.test(r.body.data?.whyNot ?? ""), JSON.stringify(r.body.data));

  section("Case 2 — no payment on a closed lead without finance");
  r = await call("POST", `/leads/${jasheer.leadId}/payments`, "Sally", { amount: 100, note: "Cash", paidAt: today });
  check("refused on a lead whose close is in finance, saying where to send it", r.status === 409 && /send the payment to finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${open.leadId}/payments`, "Sally", { amount: 100, note: "Cash", paidAt: today, method: "cash", receipt: leadReceipt(open) });
  check("a lead not closed takes one, with its method and receipt", r.status === 201, `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${notSent.leadId}/payments`, "Sally", { amount: 100, note: "Cash", paidAt: today, method: "cash", receipt: leadReceipt(notSent) });
  check("…and one not in finance yet", r.status === 201, `${r.status} ${r.body.message}`);

  section("Case 3 — sending the POS payment that never went");
  const pos = jasheer.pays[1]!;
  const send = { key: "kpos12345678", paymentId: pos, amount: 1125, method: "card", paidOn: plus(today, -5), receipt, note: "Pos done 1125 aed" };
  r = await call("POST", `/leads/${jasheer.leadId}/payments/finance`, "Sally", { ...send, amount: 1000 });
  check("only its own amount", r.status === 400 && /own amount/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${jasheer.leadId}/payments/finance`, "Sally", { ...send, receipt: undefined });
  check("the receipt is required (the Balance payments page's checks)", r.status === 400 && /receipt/i.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${jasheer.leadId}/payments/finance`, "Sally", send);
  const got = received.at(-1);
  check("sent to finance: the close, to its org, AED 1,125.00, by card, with the receipt", r.status === 201 && got?.org === "org-dubai" && got.body.enrolmentExternalId === jasheer.studentId
    && got.body.externalId === "bp-kpos12345678" && got.body.amountMinor === 112_500 && got.body.method === "card" && got.body.receipt?.url === receipt.url, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(got)}`);
  let doc = await leadDoc(jasheer);
  const p = (doc.payments as any[]).find((x) => String(x._id) === pos);
  check("…marked on the lead, not added again", p?.finance?.externalId === "bp-kpos12345678" && p.finance.method === "card" && (doc.payments as any[]).length === 2, JSON.stringify(doc.payments));
  r = await call("POST", `/leads/${jasheer.leadId}/payments/finance`, "Sally", { ...send, key: "kpos99999999" });
  check("sent once: a second time is refused", r.status === 409 && /already/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await link(jasheer);
  check("finance's say on it: sent, pending", stateOf(r, pos)?.state === "sent" && stateOf(r, pos)?.financeStatus === "pending", JSON.stringify(stateOf(r, pos)));
  check("…and nothing more can be sent: the rest is waiting", r.body.data?.canRecord === false && /waiting/.test(r.body.data?.whyNot ?? ""), JSON.stringify(r.body.data));
  r = await call("PUT", `/leads/${jasheer.leadId}/payments/${pos}`, "Sally", { amount: 1000 });
  check("its amount is finance's now", r.status === 409);
  r = await call("PUT", `/leads/${jasheer.leadId}/payments/${pos}`, "Sally", { note: "POS slip 4471" });
  check("…its note can still change", r.status === 200);
  r = await call("DELETE", `/leads/${jasheer.leadId}/payments/${pos}`, "Sally");
  check("…and it can't be deleted here", r.status === 409);
  r = await call("DELETE", `/leads/${open.leadId}/payments/${open.pays[0]}`, "Sally");
  check("a payment never sent deletes as before", r.status === 200);

  section("Case 4 — a new payment on a closed lead");
  const nw = { key: "knew12345678", amount: 500, method: "cash", paidOn: today, receipt };
  r = await call("POST", `/leads/${fresh.leadId}/payments/finance`, "Sally", nw);
  doc = await leadDoc(fresh);
  const added = (doc.payments as any[]).find((x) => x.finance?.externalId === "bp-knew12345678");
  check("sent to finance and kept on the lead, marked", r.status === 201 && added?.amount === 500 && added.note === "Balance payment · Cash" && added.finance.method === "cash", `${r.status} ${JSON.stringify(doc.payments)}`);
  r = await call("POST", `/leads/${fresh.leadId}/payments/finance`, "Sally", nw);
  doc = await leadDoc(fresh);
  check("saved twice: one payment on the lead", (doc.payments as any[]).filter((x) => x.finance?.externalId === "bp-knew12345678").length === 1 && received.at(-1)?.body.externalId === "bp-knew12345678", JSON.stringify(doc.payments));
  refuseNext = { status: 409, message: "More than the AED 125.00 left" };
  r = await call("POST", `/leads/${fresh.leadId}/payments/finance`, "Sally", { ...nw, key: "kbig12345678", amount: 900 });
  doc = await leadDoc(fresh);
  check("refused by finance: its reason, and nothing kept on the lead", r.status === 409 && /left/.test(r.body.message ?? "") && (doc.payments as any[]).length === 2, `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${fresh.leadId}/payments/finance`, "Omar", { ...nw, key: "komar1234567" });
  check("out of scope: refused", r.status === 404, `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${notSent.leadId}/payments/finance`, "Sally", { ...nw, key: "knot12345678" });
  check("not in finance yet: refused", r.status === 409 && /isn't in finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${fresh.leadId}/payments/finance`, "Root", { ...nw, key: "kroot1234567", amount: 100 });
  check("a Super Admin may send one", r.status === 201, `${r.status} ${r.body.message}`);

  section("Case 5 — a payment on the lead asks its method and receipt, as at the close (2026-10-23)");
  const bare = await lead({ close: false, payments: [] });
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 250, paidAt: today });
  check("without how it was paid or the receipt: refused", r.status === 400 && /how it was paid and attach the receipt/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 250, paidAt: today, method: "card" });
  check("…the receipt is needed too", r.status === 400, `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 250, paidAt: today, method: "bitcoin", receipt: leadReceipt(bare) });
  check("…a method the close doesn't take: refused", r.status === 400, `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 250, paidAt: today, method: "card", receipt: leadReceipt(jasheer) });
  check("…a receipt uploaded for another lead: refused", r.status === 400 && /uploaded for this lead/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 250, paidAt: today, note: "Advance", method: "card", receipt: leadReceipt(bare) });
  let bareDoc = await leadDoc(bare);
  const card = (bareDoc.payments as any[])[0];
  check("with both: kept on the lead, method and receipt", r.status === 201 && card?.method === "card" && card.receipt?.key === `enrolment-receipts/${bare.leadId}/slip.jpg` && card.receipt.name === "slip.jpg", `${r.status} ${JSON.stringify(card)}`);
  r = await call("POST", `/leads/${bare.leadId}/payments`, "Sally", { amount: 300, paidAt: today, note: "Collected at enrolment — Market Breakout · Cash" });
  check("the close's own payment is taken without them (the close carries them)", r.status === 201, `${r.status} ${r.body.message}`);
  r = await call("PUT", `/leads/${bare.leadId}/payments/${String(card._id)}`, "Sally", { method: "bank_transfer", receipt: leadReceipt(bare, "transfer.pdf") });
  bareDoc = await leadDoc(bare);
  const changed = (bareDoc.payments as any[]).find((x) => String(x._id) === String(card._id));
  check("its method and receipt can be corrected", r.status === 200 && changed?.method === "bank_transfer" && changed.receipt?.name === "transfer.pdf", `${r.status} ${JSON.stringify(changed)}`);
  r = await call("PUT", `/leads/${bare.leadId}/payments/${String(card._id)}`, "Sally", { receipt: leadReceipt(jasheer, "x.jpg") });
  check("…not to another lead's receipt", r.status === 400, `${r.status} ${r.body.message}`);
  r = await call("PUT", `/leads/${jasheer.leadId}/payments/${jasheer.pays[1]}`, "Sally", { method: "cash" });
  check("a payment sent to finance keeps its method", r.status === 409, `${r.status} ${r.body.message}`);

  section("Case 6 — a balance payment counts only once finance approves it (2026-10-26)");
  const { LeaderboardService } = await import("../src/services/leaderboardService.js");
  const { syncLeadPaymentDecisions } = await import("../src/services/leadPaymentDecisions.js");
  const month = today.slice(0, 7);
  const sallyRevenue = async () => (await new LeaderboardService().getLeaderboard(month)).rows.find((x: any) => x.name === "Sally")?.revenue ?? 0;
  const bpOn = async (l: { leadId: string }, ext: string) => ((await leadDoc(l)).payments as any[]).find((x) => x.finance?.externalId === ext);
  const decide = (studentId: string, ext: string, status: string, reason?: string) => {
    const f = finance.get(`org-dubai:${studentId}`)!;
    const b = f.balancePayments.find((x) => x.externalId === ext);
    Object.assign(b, { status, decidedAt: new Date().toISOString(), ...(reason ? { reason } : {}) });
  };
  check("sent, finance not decided: a request — pending on the lead", (await bpOn(fresh, "bp-knew12345678"))?.finance?.state === "pending", JSON.stringify(await bpOn(fresh, "bp-knew12345678")));
  const revBefore = await sallyRevenue();
  await syncLeadPaymentDecisions();
  check("…still pending at finance: not counted on the leaderboard", (await sallyRevenue()) === revBefore, `${revBefore} → ${await sallyRevenue()}`);
  decide(fresh.studentId, "bp-knew12345678", "approved");
  check("finance approves it: kept on the lead", (await syncLeadPaymentDecisions()) >= 1 && (await bpOn(fresh, "bp-knew12345678"))?.finance?.state === "approved" && !!(await bpOn(fresh, "bp-knew12345678"))?.finance?.decidedAt);
  check("…and it counts: the leaderboard up by its 500", (await sallyRevenue()) === revBefore + 500, `${revBefore} → ${await sallyRevenue()}`);
  // One sent before this (no state kept): read as pending until finance's answer is kept.
  await db.collection("leads").updateOne({ _id: new Types.ObjectId(fresh.leadId) }, { $unset: { "payments.$[p].finance.state": "" } }, { arrayFilters: [{ "p.finance.externalId": "bp-kroot1234567" }] });
  check("a payment sent before this, no decision kept: not counted", (await sallyRevenue()) === revBefore + 500);
  await syncLeadPaymentDecisions();
  check("…its decision filled in from finance (pending)", (await bpOn(fresh, "bp-kroot1234567"))?.finance?.state === "pending", JSON.stringify(await bpOn(fresh, "bp-kroot1234567")));
  decide(fresh.studentId, "bp-kroot1234567", "rejected", "Wrong amount");
  await syncLeadPaymentDecisions();
  const rejected = await bpOn(fresh, "bp-kroot1234567");
  check("finance rejects it: rejected on the lead, with finance's reason — still shown, never counted",
    rejected?.finance?.state === "rejected" && rejected.finance.reason === "Wrong amount" && rejected.amount === 100 && (await sallyRevenue()) === revBefore + 500, JSON.stringify(rejected));
  decide(fresh.studentId, "bp-kroot1234567", "approved");
  await syncLeadPaymentDecisions();
  check("a decision is final: not asked about again", (await bpOn(fresh, "bp-kroot1234567"))?.finance?.state === "rejected");
  const { isCountedPayment } = await import("../src/utils/countedPayments.js");
  check("the rule in code: the close's own counts, a pending or rejected balance payment doesn't, an approved one does",
    isCountedPayment({}) && !isCountedPayment({ finance: { externalId: "x", state: "pending" } }) && !isCountedPayment({ finance: { externalId: "x" } })
    && !isCountedPayment({ finance: { externalId: "x", state: "rejected" } }) && isCountedPayment({ finance: { externalId: "x", state: "approved" } }));

  section("Case 7 — the Balance payments page keeps the payment on the lead too, as a request (2026-10-26)");
  const page = await lead({ payments: [{ amount: 1125, note: CLOSE, day: plus(today, -6) }] });
  r = await call("POST", `/balance-payments/${page.studentId}`, "Root", { key: "kpage1234567", amount: 600, method: "cash", paidOn: today, receipt });
  const onLead = await bpOn(page, "bp-kpage1234567");
  check("sent to finance, and on the lead: pending, its amount, method and date", r.status === 201 && onLead?.amount === 600 && onLead.finance?.state === "pending" && onLead.finance.method === "cash" && onLead.note === "Balance payment · Cash", `${r.status} ${r.body.message} ${JSON.stringify(onLead)}`);
  r = await call("POST", `/balance-payments/${page.studentId}`, "Root", { key: "kpage1234567", amount: 600, method: "cash", paidOn: today, receipt });
  check("sent twice: one payment on the lead", ((await leadDoc(page)).payments as any[]).filter((x) => x.finance?.externalId === "bp-kpage1234567").length === 1);
  const pageBefore = await sallyRevenue();
  decide(page.studentId, "bp-kpage1234567", "approved");
  await syncLeadPaymentDecisions();
  check("…approved: counts", (await sallyRevenue()) === pageBefore + 600, `${pageBefore} → ${await sallyRevenue()}`);
} finally {
  server.close();
  fin.stop(true);
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
