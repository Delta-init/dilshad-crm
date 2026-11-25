/**
 * Payments accounts recorded straight in finance, brought into the CRM (the user, 2026-11-25: Irshad mullassery,
 * IN-00255 — paid in full in finance on 13 Nov, the CRM kept AED 100 pending and the commission waited for good), on
 * a scratch database, against a stand-in finance:
 *
 *   - Case 1: the one-off script on Irshad's close — read only first; then the close's payment on the lead corrected
 *     (2,250 → 2,150), finance's AED 100 of 13 Nov on the lead as approved (TI-00072), the enrolment paid in full —
 *     and the commission paid in full on 13 Nov (November), the lead's tag "approved"; run again: nothing; undone.
 *   - Case 2: the two-minute pass — part-paid enrolments in finance; nothing when finance has no more; held while
 *     one of the lead's own balance payments is still with finance; a rupee invoice on a dirham enrolment left alone;
 *     a balance payment the CRM sent never taken for the missing money; finance away: nothing; twice: once.
 *   - Case 3: from 1 Nov only (the user: "only from November … October not needed for now") — October money left as
 *     it is; paid in full in finance in November: paid in full here, at finance's fee (a lowered fee, a pending figure
 *     never brought down); paid in full in October: left owing; an earlier day takes October in.
 *
 * Run by finance-only-payments-check.sh. Scratch database only.
 */
import crypto from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
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
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

/* ── A stand-in finance: each enrolment's status, per organization ── */
const SECRET = "finance-only-payments-check-secret-long";
const finance = new Map<string, any>();
let away = false;
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
    if (away) return Response.json({ error: { message: "down" } }, { status: 503 });
    const org = req.headers.get("x-delta-org") ?? "";
    const body = JSON.parse(raw || "{}");
    if (url.pathname === "/api/v1/integrations/enrolments/status") {
      return Response.json({ data: (body.externalIds as string[]).map((id) => finance.get(`${org}:${id}`)).filter(Boolean) });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "finance-only-payments-check-jwt", JWT_REFRESH_SECRET: "finance-only-payments-check-refresh",
  NODE_ENV: "test", RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${fin.port}`, FINANCE_CLIENT_ID: "sales-crm-check", FINANCE_INTEGRATION_SECRET: SECRET,
  FINANCE_ORG_ID: "org-dubai", FINANCE_ORG_ID_BANGALORE: "org-bangalore",
  R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { syncFinanceOnlyPayments } = await import("../src/services/financeOnlyPayments.js");
const { applyApprovedBalances } = await import("../src/services/leadPaymentDecisions.js");
const { matchFinance, undoMatch } = await import("../src/scripts/financeOnlyPayment.js");
const { refreshPaidShares, paidInFullAt } = await import("../src/services/commissionService.js");
const { paymentStatesOf } = await import("../src/services/leadFinancePaymentService.js");
const { isCountedPayment } = await import("../src/utils/countedPayments.js");

const sally = new Types.ObjectId();
await db.collection("users").insertOne({ _id: sally, name: "Sally", email: "sally@test.local", password: "x", status: "active" });
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/* ── A close: its lead, enrolment, hand-over, the sale's commission waiting, and what finance says ── */
let n = 0;
async function close(o: {
  leadPays: { amount: number; note: string; day: string; finance?: any }[];
  closeRows: { amount: number; method: string }[];
  fee: number; paid: number;
  fin: { paidMinor: number; payments: { id?: string; amountMinor: number; paidOn: string; method: string; receiptNumber?: string; taxInvoiceNumber?: string }[]; balancePayments?: any[]; currency?: string; fee?: number } | null;
  saleState?: string; academy?: string; owed?: number; pending?: number; sent?: boolean;
}) {
  n++;
  const leadId = new Types.ObjectId(), studentId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Client ${n}`, phone: `+97150100${n}`, assignedTo: sally, status: "closed", createdAt: day("2026-10-01"), updatedAt: new Date(),
    payments: o.leadPays.map((p) => ({ _id: new Types.ObjectId(), amount: p.amount, note: p.note, paidAt: day(p.day), addedBy: sally, createdAt: day(p.day), updatedAt: day(p.day), ...(p.finance ? { finance: p.finance } : {}) })),
  });
  await db.collection("students").insertOne({
    _id: studentId, leadId, name: `Client ${n}`, enrollmentNumber: `STU-${String(100 + n)}`, assignedTo: sally, academy: o.academy ?? "dubai",
    totalFee: o.fee, paidAmount: o.paid, pendingAmount: o.pending ?? Math.max(0, o.fee - o.paid), feeStatus: o.paid >= o.fee ? "paid" : "partial",
    enrollmentDate: day("2026-10-29"), status: "active",
    payments: o.closeRows.map((r) => ({ method: r.method, amount: r.amount, paidAt: day("2026-10-29"), receipt: { name: "r", url: "https://x/r", key: "k" } })),
  });
  const invoice = `IN-${String(250 + n).padStart(5, "0")}`;
  const org = (o.academy ?? "dubai") === "bangalore" ? "org-bangalore" : "org-dubai";
  await db.collection("financehandovers").insertOne({ studentId, status: o.sent === false ? "pending" : "sent", invoiceNumber: invoice, academy: o.academy ?? "dubai", financeOrgId: org, payload: {}, sentAt: day("2026-10-29") });
  await db.collection("commissionsales").insertOne({
    student: studentId, studentName: `Client ${n}`, invoiceNumber: invoice, saleDate: day("2026-10-29"), month: "2026-10", fee: o.fee,
    state: o.saleState ?? "counted", owedShare: o.owed ?? Math.max(0, o.fee - o.paid) / o.fee, paidShare: 1, lines: [], plan: { sales: 230, tl: 85, sm: 100 },
    createdAt: new Date(), updatedAt: new Date(),
  });
  if (o.fin) {
    const fee = (o.fin.fee ?? o.fee) * 100;
    finance.set(`${org}:${studentId}`, {
      externalId: String(studentId), invoiceId: `inv-${n}`, invoiceNumber: invoice, status: o.fin.paidMinor >= fee ? "paid" : "partial", approval: "approved",
      returnedReason: "", issueDate: "2026-10-29", currency: o.fin.currency ?? (org === "org-bangalore" ? "INR" : "AED"),
      totalMinor: fee, amountPaidMinor: o.fin.paidMinor, balanceMinor: Math.max(0, fee - o.fin.paidMinor),
      // As finance answers since 2026-11-25: each payment with its own id.
      payments: o.fin.payments.map((p, i) => ({ id: p.id ?? `pay-${n}-${i}`, ...p })), balancePayments: o.fin.balancePayments ?? [],
    });
  }
  return { leadId, studentId, invoice };
}
const leadOf = async (c: { leadId: Types.ObjectId }) => (await db.collection("leads").findOne({ _id: c.leadId }))!;
const studentOf = async (c: { studentId: Types.ObjectId }) => (await db.collection("students").findOne({ _id: c.studentId }))!;
const saleOf = async (c: { studentId: Types.ObjectId }) => (await db.collection("commissionsales").findOne({ student: c.studentId }))!;
const CLOSE = "Collected at enrolment — COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT) · BillExPro";

try {
  section("Case 1 — the one-off script on Irshad's close");
  const irshad = await close({
    leadPays: [{ amount: 2250, note: CLOSE, day: "2026-10-29" }],
    closeRows: [{ amount: 2150, method: "billexpro" }],
    fee: 2250, paid: 2150,
    fin: { paidMinor: 225_000, payments: [
      { id: "pay-close", amountMinor: 215_000, paidOn: "2026-10-29", method: "billexpro", taxInvoiceNumber: "TI-00017" },
      { id: "pay-100", amountMinor: 10_000, paidOn: "2026-11-13", method: "billexpro", taxInvoiceNumber: "TI-00072" },
    ] },
  });
  await refreshPaidShares();
  check("before: the commission waits for full payment (AED 100 pending)", paidInFullAt((await saleOf(irshad)) as never) === null, j(await saleOf(irshad)));

  const look = await matchFinance({ invoice: irshad.invoice, write: false });
  const said = look.lines.join("\n");
  check("read only: says the close's payment 2,250.00 → 2,150.00 and the 100.00 of 2026-11-13 · TI-00072", /2,250\.00 → 2,150\.00/.test(said) && /100\.00 on 2026-11-13 · TI-00072/.test(said), said);
  check("…and changes nothing", (await leadOf(irshad)).payments.length === 1 && (await leadOf(irshad)).payments[0].amount === 2250 && (await studentOf(irshad)).pendingAmount === 100 && !look.undoFile);

  const done = await matchFinance({ invoice: irshad.invoice, write: true, undoFile: `/tmp/finance-only-check-${process.pid}.json` });
  const lead = await leadOf(irshad);
  const closePay = lead.payments.find((p: any) => /^Collected at enrolment/.test(p.note));
  const added = lead.payments.find((p: any) => p.finance?.externalId);
  check("written: the close's payment on the lead is 2,150", closePay?.amount === 2150, j(lead.payments));
  check("…finance's AED 100 of 13 Nov on the lead, approved by finance, its receipt in the note, its method",
    added?.amount === 100 && added.paidAt.toISOString().slice(0, 10) === "2026-11-13" && added.finance.state === "approved" && added.finance.externalId === "fin-pay-100"
      && /Recorded in finance — TI-00072/.test(added.note) && added.method === "billexpro" && String(added.addedBy) === String(sally), j(added));
  const st = await studentOf(irshad);
  check("…the enrolment paid in full: 2,250 paid, 0 pending, paid", st.paidAmount === 2250 && st.pendingAmount === 0 && st.feeStatus === "paid" && (st.balanceApplied ?? []).includes(added?.finance.externalId), j(st));
  await refreshPaidShares();
  const sale = await saleOf(irshad);
  check("the commission: nothing owed, paid in full on 13 Nov — earned in November", sale.owedShare === 0 && paidInFullAt(sale as never)?.toISOString().slice(0, 10) === "2026-11-13", j({ owed: sale.owedShare, collections: sale.collections }));
  check("…the money by day: 2,150 on 29 Oct, 100 on 13 Nov", (sale.collections ?? []).length === 2 && Math.round(sale.collections[0].share * 2250) === 2150 && Math.round(sale.collections[1].share * 2250) === 100, j(sale.collections));
  const tags = paymentStatesOf(lead.payments, { status: "sent", sentAt: day("2026-10-29") }, undefined);
  check("the lead's tag on it: approved by finance", tags.find((t) => t.id === String(added?._id))?.financeStatus === "approved", j(tags));
  check("…and it counts (revenue, reports)", isCountedPayment(added));

  const again = await matchFinance({ invoice: irshad.invoice, write: false });
  check("run again: nothing to change", again.lines.includes("Nothing to change."), again.lines.join(" | "));
  const pass = await syncFinanceOnlyPayments();
  check("…and the two-minute pass adds nothing either", pass.added === 0 && (await leadOf(irshad)).payments.length === 2);

  await undoMatch(done.undoFile!);
  const undone = await leadOf(irshad), sUndone = await studentOf(irshad);
  check("undo: the lead as it was (one payment of 2,250), the enrolment 2,150 paid · 100 pending",
    undone.payments.length === 1 && undone.payments[0].amount === 2250 && sUndone.paidAmount === 2150 && sUndone.pendingAmount === 100 && sUndone.feeStatus === "partial" && sUndone.balanceApplied === undefined, j({ undone: undone.payments, sUndone }));
  if (done.undoFile && existsSync(done.undoFile)) unlinkSync(done.undoFile);
  await refreshPaidShares();   // the commission run, as every two minutes: Irshad waits for full payment again
  check("…and its commission waits for full payment again", paidInFullAt((await saleOf(irshad)) as never) === null);

  section("Case 2 — the two-minute pass");
  // Irshad is waiting again (undone); the pass alone brings the AED 100 in — the close's payment is left as it is.
  const late = await close({   // paid in finance in two parts after the close
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }], closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1000,
    fin: { paidMinor: 225_000, payments: [
      { amountMinor: 100_000, paidOn: "2026-10-29", method: "card", receiptNumber: "TI-1" },
      { amountMinor: 75_000, paidOn: "2026-11-05", method: "cash", receiptNumber: "TI-2" },
      { amountMinor: 50_000, paidOn: "2026-11-20", method: "Smart Invoice", receiptNumber: "TI-3" },
    ] },
  });
  const same = await close({   // finance has no more than the CRM
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }], closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1000,
    fin: { paidMinor: 100_000, payments: [{ amountMinor: 100_000, paidOn: "2026-10-29", method: "card", receiptNumber: "TI-4" }] },
  });
  const held = await close({   // one of the lead's own balance payments still with finance
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }, { amount: 500, note: "Balance payment · Cash", day: "2026-11-10", finance: { externalId: "bp-held", method: "cash", sentAt: day("2026-11-10"), state: "pending" } }],
    closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1000,
    fin: { paidMinor: 150_000, payments: [{ amountMinor: 100_000, paidOn: "2026-10-29", method: "card" }, { amountMinor: 50_000, paidOn: "2026-11-10", method: "cash", receiptNumber: "TI-5" }] },
  });
  const rupees = await close({   // a rupee invoice on a dirham enrolment
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }], closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1000,
    fin: { currency: "INR", paidMinor: 9_000_000, payments: [{ amountMinor: 9_000_000, paidOn: "2026-11-01", method: "inr_bank_account" }] },
  });
  const crmSent = await close({   // the CRM's own approved balance payment is newer than finance's own entry
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }, { amount: 500, note: "Balance payment · Cash", day: "2026-11-18", finance: { externalId: "bp-mine", method: "cash", sentAt: day("2026-11-18"), state: "approved" } }],
    closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1500,
    fin: { paidMinor: 225_000, payments: [
      { amountMinor: 100_000, paidOn: "2026-10-29", method: "card", receiptNumber: "TI-6" },
      { amountMinor: 75_000, paidOn: "2026-11-08", method: "cash", receiptNumber: "TI-7" },
      { amountMinor: 50_000, paidOn: "2026-11-18", method: "cash", receiptNumber: "TI-8" },
    ], balancePayments: [{ externalId: "bp-mine", amountMinor: 50_000, currency: "AED", method: "cash", paidOn: "2026-11-18", status: "approved", receiptNumber: "TI-8" }] },
  });
  await db.collection("students").updateOne({ _id: crmSent.studentId }, { $set: { balanceApplied: ["bp-mine"] } });
  const notWaiting = await close({   // an enrolment not in finance yet is not looked at
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-29" }], closeRows: [{ amount: 1000, method: "card" }], fee: 2250, paid: 1000, sent: false,
    fin: { paidMinor: 225_000, payments: [{ amountMinor: 225_000, paidOn: "2026-11-02", method: "card" }] },
  });

  away = true;
  check("finance away: nothing", (await syncFinanceOnlyPayments()).added === 0);
  away = false;

  const r = await syncFinanceOnlyPayments();
  await applyApprovedBalances();
  const lateLead = await leadOf(late), lateSt = await studentOf(late);
  const fromFin = lateLead.payments.filter((p: any) => p.finance?.externalId?.startsWith("fin-"));
  check("paid in finance in two parts: both on the lead, on finance's days, approved",
    fromFin.length === 2 && fromFin.map((p: any) => `${p.amount}@${p.paidAt.toISOString().slice(0, 10)}`).sort().join() === "500@2026-11-20,750@2026-11-05", j(fromFin));
  check("…a method the CRM doesn't take is left off the payment (kept on its finance note)", fromFin.find((p: any) => p.amount === 500)?.method === undefined && fromFin.find((p: any) => p.amount === 500)?.finance.method === "Smart Invoice");
  check("…the enrolment paid in full", lateSt.paidAmount === 2250 && lateSt.pendingAmount === 0 && lateSt.feeStatus === "paid", j(lateSt));
  await refreshPaidShares();
  check("…its commission: paid in full on 20 Nov", paidInFullAt((await saleOf(late)) as never)?.toISOString().slice(0, 10) === "2026-11-20");
  check("Irshad (undone) by the pass alone: the AED 100 of 13 Nov on the lead, the enrolment paid in full",
    (await leadOf(irshad)).payments.some((p: any) => p.finance?.externalId === "fin-pay-100" && p.amount === 100) && (await studentOf(irshad)).pendingAmount === 0);
  check("finance has no more than the CRM: nothing", (await leadOf(same)).payments.length === 1 && (await studentOf(same)).paidAmount === 1000);
  check("one of the lead's balance payments still with finance: left alone, said why",
    (await leadOf(held)).payments.length === 2 && r.found.some((f) => f.studentId === String(held.studentId) && /still waiting for finance/.test(f.skipped ?? "")), j(r.found));
  check("a rupee invoice on a dirham enrolment: left alone, said why",
    (await leadOf(rupees)).payments.length === 1 && r.found.some((f) => f.studentId === String(rupees.studentId) && /INR/.test(f.skipped ?? "")));
  const crmLead = await leadOf(crmSent);
  const taken = crmLead.payments.filter((p: any) => p.finance?.externalId?.startsWith("fin-"));
  check("the CRM's own balance payment is never the missing money: finance's own AED 750 of 8 Nov taken, not the 18 Nov one",
    taken.length === 1 && taken[0].amount === 750 && taken[0].paidAt.toISOString().slice(0, 10) === "2026-11-08" && (await studentOf(crmSent)).paidAmount === 2250, j(taken));
  check("an enrolment not in finance yet: not looked at", (await leadOf(notWaiting)).payments.length === 1 && (await studentOf(notWaiting)).paidAmount === 1000);
  const twice = await syncFinanceOnlyPayments();
  check("run twice: nothing more", twice.added === 0 && (await leadOf(late)).payments.length === 3, JSON.stringify(twice.found.filter((f) => f.payments.length)));

  section("Case 3 — from 1 November only");
  const octOnly = await close({   // the missing money was paid in October: left as it is
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-01" }], closeRows: [{ amount: 1000, method: "card" }], fee: 1500, paid: 1000,
    fin: { paidMinor: 150_000, payments: [{ amountMinor: 100_000, paidOn: "2026-10-01", method: "card" }, { amountMinor: 50_000, paidOn: "2026-10-15", method: "cash", taxInvoiceNumber: "TI-44" }] },
  });
  const octFee = await close({   // fee lowered in finance, paid in full in October: left owing
    leadPays: [{ amount: 3500, note: CLOSE, day: "2026-10-31" }], closeRows: [{ amount: 3500, method: "card" }], fee: 5500, paid: 3500,
    fin: { fee: 3500, paidMinor: 350_000, payments: [{ amountMinor: 350_000, paidOn: "2026-10-31", method: "card" }] },
  });
  const stale = await close({   // all paid in the CRM too, but its pending never came down (paid in November)
    leadPays: [{ amount: 500, note: CLOSE, day: "2026-11-13" }], closeRows: [{ amount: 500, method: "card" }], fee: 2250, paid: 2250, pending: 1750,
    fin: { paidMinor: 225_000, payments: [{ amountMinor: 50_000, paidOn: "2026-11-13", method: "card" }, { amountMinor: 150_000, paidOn: "2026-11-14", method: "cash" }, { amountMinor: 25_000, paidOn: "2026-11-17", method: "cash" }] },
  });
  const novFee = await close({   // fee lowered in finance, paid in full in November
    leadPays: [{ amount: 3000, note: CLOSE, day: "2026-11-03" }], closeRows: [{ amount: 3000, method: "card" }], fee: 5500, paid: 3000,
    fin: { fee: 3500, paidMinor: 350_000, payments: [{ amountMinor: 300_000, paidOn: "2026-11-03", method: "card" }, { amountMinor: 50_000, paidOn: "2026-11-09", method: "cash", taxInvoiceNumber: "TI-90" }] },
  });
  const split = await close({   // AED 300 paid in October, 200 in November: only the 200
    leadPays: [{ amount: 1000, note: CLOSE, day: "2026-10-01" }], closeRows: [{ amount: 1000, method: "card" }], fee: 1500, paid: 1000,
    fin: { paidMinor: 150_000, payments: [{ amountMinor: 100_000, paidOn: "2026-10-01", method: "card" }, { amountMinor: 30_000, paidOn: "2026-10-20", method: "cash" }, { amountMinor: 20_000, paidOn: "2026-11-04", method: "cash" }] },
  });
  const r3 = await syncFinanceOnlyPayments();
  await applyApprovedBalances();
  check("October money: nothing taken, still owing, said why",
    (await leadOf(octOnly)).payments.length === 1 && (await studentOf(octOnly)).pendingAmount === 500 && r3.found.some((f) => f.studentId === String(octOnly.studentId) && /before 2026-11-01/.test(f.skipped ?? "")), j(r3.found));
  check("fee lowered, paid in full in October: left owing as it was", (await studentOf(octFee)).totalFee === 5500 && (await studentOf(octFee)).pendingAmount === 2000);
  const sStale = await studentOf(stale);
  check("its pending never came down, paid in full in November: paid in full, nothing added", sStale.pendingAmount === 0 && sStale.feeStatus === "paid" && sStale.paidAmount === 2250 && (await leadOf(stale)).payments.length === 1, j(sStale));
  const sNov = await studentOf(novFee);
  const novAdded = (await leadOf(novFee)).payments.filter((p: any) => p.finance?.externalId?.startsWith("fin-"));
  check("fee lowered, paid in full in November: its AED 500 brought in, the enrolment at finance's fee 3,500, paid in full",
    novAdded.length === 1 && novAdded[0].amount === 500 && /TI-90/.test(novAdded[0].note) && sNov.totalFee === 3500 && sNov.paidAmount === 3500 && sNov.pendingAmount === 0 && sNov.feeStatus === "paid", j({ sNov, novAdded }));
  await refreshPaidShares();
  check("…its commission: paid in full on 9 Nov", paidInFullAt((await saleOf(novFee)) as never)?.toISOString().slice(0, 10) === "2026-11-09", j(await saleOf(novFee)));
  const sSplit = await studentOf(split);
  check("October 300 + November 200: only the 200 of 4 Nov taken — still 300 owing",
    (await leadOf(split)).payments.filter((p: any) => p.finance).map((p: any) => `${p.amount}@${p.paidAt.toISOString().slice(0, 10)}`).join() === "200@2026-11-04" && sSplit.paidAmount === 1200 && sSplit.pendingAmount === 300, j(sSplit));
  const wider = await syncFinanceOnlyPayments({ studentIds: [String(octOnly.studentId)], write: false, from: "2026-10-01" });
  check("an earlier day (FINANCE_ONLY_PAYMENTS_FROM) takes October in: the 500 of 15 Oct", wider.found[0]?.payments.map((m) => `${m.amountMinor / 100}@${m.paidOn}`).join() === "500@2026-10-15" && wider.found[0]?.paidInFull === true, j(wider.found));
} finally {
  fin.stop(true);
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
