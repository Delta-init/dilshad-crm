/**
 * READ ONLY (the user, 2026-11-23, as in the Sales CRM): enrolments whose course or fee here isn't what finance has —
 * like a close put on a cheaper course here after finance approved it, whose invoice kept the old course and price
 * while the lead said "100% paid". Every student with a finance enrolment is asked of finance, in batches of 200, in
 * the organization it was billed in (Dubai's or Bangalore's); printed are those whose course name or fee differs from
 * finance's invoice (a void invoice is left out), and the leads whose course differs from their enrolment's. Writes
 * nothing. Run it from the API folder on the server (it reads MONGODB_URI and the finance settings from the .env):
 *
 *   bun src/scripts/financeMismatch.ts
 *
 * Each one is put right with Change course on the enrolment (finance approves it), or in finance itself.
 */
import "dotenv/config";
import mongoose from "mongoose";
import type { BalanceFields, EnrolmentStatus } from "../services/financeClient.js";

export interface EnrolmentMismatch {
  studentId: string;
  enrollmentNumber: string;
  name: string;
  invoiceNumber: string;
  /** "course", "fee" or both. */
  differs: string[];
  crm: { course: string; fee: number };
  finance: { course: string; fee: number; currency: string };
}

export interface LeadMismatch {
  leadId: string;
  name: string;
  leadCourse: string;
  enrolmentCourse: string;
}

/** Course names compared as finance compares them: case and spaces aside. */
const sameName = (a: unknown, b: unknown) =>
  String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const money = (n: number, currency: string) => `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BATCH = 200;

export async function financeMismatches(): Promise<{ enrolments: EnrolmentMismatch[]; leads: LeadMismatch[]; asked: number; answered: number }> {
  const { FinanceHandover } = await import("../models/FinanceHandover.js");
  const { Student } = await import("../models/Student.js");
  const { Course } = await import("../models/Course.js");
  const { Lead } = await import("../models/Lead.js");
  const { fetchStatusesByOrg, orgOfHandover } = await import("../services/financeOrgs.js");

  const handovers = await FinanceHandover.find({ status: "sent" }).select("studentId academy financeOrgId invoiceNumber").lean();
  const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
  const students = await Student.find({ _id: { $in: handovers.map((h) => h.studentId) } })
    .select("name enrollmentNumber course totalFee academy leadId financeInvoiceNumber")
    .lean();
  const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId) } }).select("name course").lean();
  const courseIds = [...students.map((s) => s.course), ...leads.map((l) => l.course)].filter(Boolean);
  const courseName = new Map((await Course.find({ _id: { $in: courseIds } }).select("name").lean()).map((c) => [String(c._id), c.name]));
  const nameOf = (id: unknown) => (id ? courseName.get(String(id)) ?? "(a course no longer here)" : "no course");

  // Each asked of the organization it was billed in; fetchEnrolmentStatuses takes at most 200 at a time, so in batches.
  const statuses: (EnrolmentStatus & BalanceFields)[] = [];
  for (let i = 0; i < students.length; i += BATCH) {
    const batch = students.slice(i, i + BATCH);
    statuses.push(...(await fetchStatusesByOrg(
      batch.map((s) => String(s._id)),
      new Map(batch.map((s) => [String(s._id), orgOfHandover(handoverOf.get(String(s._id)), s.academy)])),
    )) as (EnrolmentStatus & BalanceFields)[]);
  }
  const statusOf = new Map(statuses.map((st) => [st.externalId, st]));

  const enrolments: EnrolmentMismatch[] = [];
  for (const s of students) {
    const st = statusOf.get(String(s._id));
    if (!st || st.status === "void") continue;
    const crmCourse = nameOf(s.course);
    const differs: string[] = [];
    // A finance from before it said its course has nothing to compare.
    if (typeof st.course === "string" && !sameName(st.course, crmCourse)) differs.push("course");
    if (Math.round((s.totalFee ?? 0) * 100) !== (st.totalMinor ?? 0)) differs.push("fee");
    if (!differs.length) continue;
    enrolments.push({
      studentId: String(s._id),
      enrollmentNumber: s.enrollmentNumber ?? "",
      name: s.name ?? "",
      invoiceNumber: st.invoiceNumber || handoverOf.get(String(s._id))?.invoiceNumber || s.financeInvoiceNumber || "",
      differs,
      crm: { course: crmCourse, fee: s.totalFee ?? 0 },
      finance: { course: st.course ?? "", fee: (st.totalMinor ?? 0) / 100, currency: st.currency || "AED" },
    });
  }

  const studentOfLead = new Map(students.map((s) => [String(s.leadId), s]));
  const leadMismatches: LeadMismatch[] = leads.flatMap((l) => {
    const s = studentOfLead.get(String(l._id));
    if (!s || String(l.course ?? "") === String(s.course ?? "")) return [];
    return [{ leadId: String(l._id), name: l.name ?? "", leadCourse: nameOf(l.course), enrolmentCourse: nameOf(s.course) }];
  });

  return { enrolments, leads: leadMismatches, asked: students.length, answered: statuses.length };
}

export function printMismatches(r: Awaited<ReturnType<typeof financeMismatches>>): string[] {
  return [
    `Enrolments whose course or fee isn't finance's: ${r.enrolments.length}`,
    ...r.enrolments.map((m) => `  ${m.enrollmentNumber} ${m.name} · ${m.invoiceNumber || "no invoice number"} — `
      + [
        ...(m.differs.includes("course") ? [`course: here "${m.crm.course}", finance "${m.finance.course}"`] : []),
        ...(m.differs.includes("fee") ? [`fee: here ${money(m.crm.fee, m.finance.currency)}, finance ${money(m.finance.fee, m.finance.currency)}`] : []),
      ].join("; ")),
    "",
    `Leads whose course isn't their enrolment's: ${r.leads.length}`,
    ...r.leads.map((m) => `  ${m.name} (${m.leadId}) — lead "${m.leadCourse}", enrolment "${m.enrolmentCourse}"`),
    "",
    `Asked finance about ${r.asked} enrolment(s); it answered for ${r.answered}.${r.asked && !r.answered ? " Is finance reachable with this .env?" : ""}`,
  ];
}

if (import.meta.main) {
  await mongoose.connect(process.env.MONGODB_URI!, { authSource: "admin" });
  try {
    for (const l of printMismatches(await financeMismatches())) console.log(l);
    console.log("\nNothing written.");
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
