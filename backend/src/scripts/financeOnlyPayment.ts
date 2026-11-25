/**
 * One enrolment made to match finance's payments (the user, 2026-11-25, as in the Sales CRM: a client paid in full in
 * finance while this CRM kept the rest pending, and the commission waited for full payment for good).
 *
 *   1. The close's own payment on the lead ("Collected at enrolment — …") at what the enrolment says the close took —
 *      when the lead has one such payment and it says otherwise (e.g. AED 2,250 on the lead, 2,150 taken).
 *   2. The money finance has that the enrolment doesn't — recorded straight in finance — put on the lead as payments
 *      approved by finance, on finance's dates, and added to the enrolment; paid in full in finance, paid in full here
 *      (services/financeOnlyPayments.ts, which the server also does for every part-paid enrolment, every two minutes —
 *      from FINANCE_ONLY_PAYMENTS_FROM on, 1 Nov 2026 unless set).
 *
 * The commission sweep then sees it paid in full, on the day of the last payment, within two minutes.
 *
 * Reads and prints only, unless --write; --write first saves the lead's payments and the enrolment's figures to an
 * undo file. Run it from the API folder on the server:
 *
 *   bun src/scripts/financeOnlyPayment.ts --invoice IN-00255 [--write]
 *   bun src/scripts/financeOnlyPayment.ts --undo <file>
 */
import "dotenv/config";
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { syncFinanceOnlyPayments } from "../services/financeOnlyPayments.js";
import { applyApprovedBalances } from "../services/leadPaymentDecisions.js";

const { EJSON } = mongoose.mongo.BSON;
const fromTheClose = (note?: string | null) => /^Collected at enrolment\b/.test(note ?? "");
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function matchFinance(o: { invoice: string; write: boolean; undoFile?: string }): Promise<{ lines: string[]; undoFile?: string }> {
  const db = mongoose.connection.db!;
  const invoice = o.invoice.trim().toUpperCase();
  if (!/^IN-\d+$/.test(invoice)) throw new Error("Give --invoice IN-00001");
  const h: any = await db.collection("financehandovers").findOne({ invoiceNumber: invoice, status: "sent" });
  if (!h) throw new Error(`No enrolment in finance has ${invoice}`);
  const student: any = await db.collection("students").findOne({ _id: h.studentId });
  if (!student) throw new Error(`${invoice}'s enrolment is gone`);
  const lead: any = student.leadId ? await db.collection("leads").findOne({ _id: student.leadId }) : null;
  if (!lead) throw new Error(`${invoice}'s lead is gone`);

  const lines = [
    `${invoice} · ${student.name} · ${student.enrollmentNumber ?? ""}`,
    `enrolment now: fee ${money(student.totalFee)} · paid ${money(student.paidAmount)} · pending ${money(student.pendingAmount)} · ${student.feeStatus}`,
    `lead's payments now:`,
    ...(lead.payments ?? []).map((p: any) => `   ${money(p.amount)} on ${new Date(p.paidAt).toISOString().slice(0, 10)} · ${(p.note ?? "").slice(0, 60)}${p.finance?.externalId ? ` · ${p.finance.externalId} ${p.finance.state ?? ""}` : ""}`),
  ];

  // 1. The close's own payment on the lead, at what the enrolment says the close took.
  const closeOnLead = (lead.payments ?? []).filter((p: any) => fromTheClose(p.note));
  const closeTaken = round2((student.payments ?? []).filter((p: any) => !p.collectedBefore).reduce((s: number, p: any) => s + (p.amount || 0), 0));
  const closeSaid = round2(closeOnLead.reduce((s: number, p: any) => s + (p.amount || 0), 0));
  let fixClose: { id: unknown; from: number; to: number } | null = null;
  if (closeOnLead.length && closeTaken > 0 && Math.round(closeSaid * 100) !== Math.round(closeTaken * 100)) {
    if (closeOnLead.length === 1) {
      fixClose = { id: closeOnLead[0]._id, from: closeSaid, to: closeTaken };
      lines.push("", `1. the close's payment on the lead: ${money(closeSaid)} → ${money(closeTaken)} (what the enrolment says the close took)`);
    } else {
      lines.push("", `1. the close's ${closeOnLead.length} payments on the lead come to ${money(closeSaid)}, the enrolment says ${money(closeTaken)} — not changed: fix them on the lead by hand`);
    }
  } else lines.push("", "1. the close's payment on the lead matches the enrolment — nothing to change");

  // 2. What finance has that the enrolment doesn't (asked of finance; nothing written yet).
  const look = await syncFinanceOnlyPayments({ studentIds: [String(student._id)], write: false });
  const found = look.found[0];
  if (!found) lines.push("2. finance has nothing the enrolment doesn't (or finance didn't answer)");
  else if (found.skipped) lines.push(`2. finance has ${money(found.financePaid)}, the enrolment ${money(found.crmPaid)} — not taken: ${found.skipped}`);
  else {
    lines.push(`2. finance has ${money(found.financePaid)} paid of ${money(found.financeFee)}, the enrolment ${money(found.crmPaid)} of ${money(found.crmFee)}`);
    for (const m of found.payments) lines.push(`   to put on the lead as approved by finance: ${money(m.amountMinor / 100)} on ${m.paidOn}${m.receipt ? ` · ${m.receipt}` : ""} · ${m.method}`);
    if (found.paidInFull) lines.push(`   then the enrolment paid in full as finance has it: fee ${money(found.financeFee)}, paid ${money(found.financePaid)}, nothing pending`);
  }
  if (!fixClose && !found?.payments.length && !found?.paidInFull) return { lines: [...lines, "", "Nothing to change."] };
  if (!o.write) return { lines };

  const undoFile = o.undoFile ?? `finance-only-payment-undo-${invoice}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const saved = {
    invoice, leadId: lead._id, studentId: student._id,
    closePayment: fixClose ? { id: fixClose.id, amount: fixClose.from } : null,
    added: (found?.payments ?? []).map((m) => m.id),
    student: { totalFee: student.totalFee ?? 0, paidAmount: student.paidAmount ?? 0, pendingAmount: student.pendingAmount ?? 0, feeStatus: student.feeStatus ?? null, balanceApplied: student.balanceApplied ?? null },
  };
  writeFileSync(undoFile, EJSON.stringify(saved, undefined, 2, { relaxed: false }));
  if ((EJSON.parse(readFileSync(undoFile, "utf8")) as any)?.invoice !== invoice) throw new Error(`The undo file ${undoFile} didn't read back — nothing changed`);

  if (fixClose) {
    await db.collection("leads").updateOne({ _id: lead._id }, { $set: { "payments.$[p].amount": fixClose.to, "payments.$[p].updatedAt": new Date() } }, { arrayFilters: [{ "p._id": fixClose.id }] });
  }
  const put = await syncFinanceOnlyPayments({ studentIds: [String(student._id)], write: true });
  const applied = await applyApprovedBalances();
  const after: any = await db.collection("students").findOne({ _id: student._id });
  return {
    lines: [
      ...lines, "",
      `written: ${fixClose ? "the close's payment corrected; " : ""}${put.added} payment(s) put on the lead; ${applied} added to the enrolment${put.paidInFull ? "; paid in full as finance has it" : ""}`,
      `enrolment now: paid ${money(after.paidAmount)} · pending ${money(after.pendingAmount)} · ${after.feeStatus}`,
      "The commission sweep counts it within two minutes, in the month of the last payment.",
    ],
    undoFile,
  };
}

/** Puts the lead's payments and the enrolment's figures back as they were saved. */
export async function undoMatch(file: string): Promise<void> {
  const saved: any = EJSON.parse(readFileSync(file, "utf8"));
  const db = mongoose.connection.db!;
  if (saved.closePayment) {
    await db.collection("leads").updateOne({ _id: saved.leadId }, { $set: { "payments.$[p].amount": saved.closePayment.amount } }, { arrayFilters: [{ "p._id": saved.closePayment.id }] });
  }
  if (saved.added?.length) await db.collection("leads").updateOne({ _id: saved.leadId }, { $pull: { payments: { "finance.externalId": { $in: saved.added } } } } as never);
  const s = saved.student;
  await db.collection("students").updateOne(
    { _id: saved.studentId },
    s.balanceApplied === null
      ? { $set: { totalFee: s.totalFee, paidAmount: s.paidAmount, pendingAmount: s.pendingAmount, feeStatus: s.feeStatus }, $unset: { balanceApplied: "" } }
      : { $set: { totalFee: s.totalFee, paidAmount: s.paidAmount, pendingAmount: s.pendingAmount, feeStatus: s.feeStatus, balanceApplied: s.balanceApplied } },
  );
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  await mongoose.connect(process.env.MONGODB_URI!, { authSource: "admin" });
  try {
    if (arg("--undo")) { await undoMatch(arg("--undo")); console.log(`Put back from ${arg("--undo")}.`); }
    else {
      const write = argv.includes("--write");
      const r = await matchFinance({ invoice: arg("--invoice"), write });
      for (const l of r.lines) console.log(l);
      if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}\n  bun src/scripts/financeOnlyPayment.ts --undo ${r.undoFile}`);
      else if (!write && !r.lines.includes("Nothing to change.")) console.log("\nNothing written. To make it so: the same command with --write.");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
