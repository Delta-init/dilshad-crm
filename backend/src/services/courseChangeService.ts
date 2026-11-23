import crypto from "node:crypto";
import { Types } from "mongoose";
import { CommissionSale } from "../models/CommissionSale.js";
import { Course } from "../models/Course.js";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { User } from "../models/User.js";
import { ACADEMY_CURRENCY, academyOf, type ICourseChange, type IRole } from "../types/index.js";
import { isSuperAdmin } from "./commissionService.js";
import {
  FinanceRefusal, fetchEnrolmentStatuses, sendCourseChange,
  type EnrolmentStatus, type FinanceCourseChange,
} from "./financeClient.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";
import { financeCourseOf } from "./studentService.js";

/*
 * Change course after finance approved the enrolment (the user, 2026-11-23, as in the Sales CRM). A salesperson
 * reopened a closed, approved lead, put it on a cheaper course and closed it again: finance never heard — the invoice
 * kept the old course and price — while the lead's Payments card measured the money against the new course and said
 * "100% paid".
 *
 * So the course and fee of an enrolment finance has are no longer edited here (the locks: leadService.updateLead,
 * StudentService.updateStudent). A change is asked for instead — the new course, its fee and why — and sent to
 * finance at once, where it waits in Approvals as a "Course change", as a balance payment does. Finance's decision
 * comes back with the enrolment's status (every two minutes, beside the balance payments — leadPaymentDecisions.ts):
 * approved, the student and the lead move to the new course at the new fee and the sale's commission is counted again
 * with finance's fee; rejected, it says why. Applied once, by the request's id.
 *
 * A request finance kept while this CRM never heard back (a timeout) is taken from finance's answer — an id finance
 * has that isn't here — and handled like any other (2026-11-23).
 */

type Viewer = { userId: string; role?: IRole | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 200;
/** How long after a request is sent its enrolment is still looked at for one finance kept unheard — well past a timeout. */
const ASKED_OPEN_MS = 10 * 60_000;
/** The reason on a request taken from finance, whose own record here was lost. */
export const ADOPTED_REASON = "Asked from the CRM; its record here was lost — taken from finance";
/** Finance refusing because one is already waiting for it. */
const ALREADY_WAITING = /already waiting|still pending/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const round2 = (n: number) => Math.round(n * 100) / 100;
const minor = (n: number) => Math.round(n * 100);
/** The enrolment's own currency: AED for Dubai, INR for Bangalore — its fee, what is paid, and the change. */
const currencyOf = (academy: string | null | undefined) => ACADEMY_CURRENCY[academyOf({ academy })];
const money = (n: number, currency: string) =>
  `${currency} ${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feeStatusOf = (fee: number, paid: number) => (fee <= 0 || paid <= 0 ? "pending" : paid >= fee ? "paid" : "partial");

type StudentLite = {
  _id: Types.ObjectId;
  course?: unknown;
  totalFee?: number;
  paidAmount?: number;
  assignedTo?: unknown;
  academy?: string;
  leadId?: unknown;
  courseChanges?: ICourseChange[];
};

/**
 * The enrolment, if this viewer may change its course — as Correct it: the closer their own (with enrolments:edit,
 * which the route asks for), anyone who may edit students — or a Super Admin — any.
 */
async function changeable(viewer: Viewer, studentId: string): Promise<StudentLite> {
  if (!Types.ObjectId.isValid(studentId)) throw fail(404, "Enrolment not found");
  const student = await Student.findById(studentId)
    .select("course totalFee paidAmount assignedTo academy leadId courseChanges")
    .lean<StudentLite>();
  if (!student) throw fail(404, "Enrolment not found");
  const any = isSuperAdmin(viewer.role) || viewer.role?.permissions?.students?.edit === true;
  const own = viewer.role?.permissions?.enrolments?.edit === true && String(student.assignedTo ?? "") === viewer.userId;
  if (!any && !own) throw fail(403, "This enrolment isn't yours to change");
  return student;
}

/**
 * Where finance stands on the enrolment, asked live (finance may have decided a minute ago): a course can be changed
 * only once finance has it and has approved it. Sent back, the correction is the way; not sent yet, the close is.
 * Asked of the organization it was billed in, as the balance payments are (financeOrgs.orgOfHandover).
 */
async function financeState(student: StudentLite): Promise<{ whyNot: string; status?: EnrolmentStatus; orgId: string; unreachable?: boolean }> {
  const h = await FinanceHandover.findOne({ studentId: student._id }).select("status academy financeOrgId").lean();
  if (!h || h.status !== "sent") {
    return { orgId: "", whyNot: "This enrolment isn't in finance yet — change its course by editing the enrolment instead." };
  }
  const orgId = orgOfHandover(h, student.academy);
  const [st] = await fetchEnrolmentStatuses([String(student._id)], orgId);
  if (!st) return { orgId, unreachable: true, whyNot: "Finance didn't answer about this enrolment — try again in a minute." };
  if (st.status === "void") return { orgId, status: st, whyNot: `Its invoice${st.invoiceNumber ? ` ${st.invoiceNumber}` : ""} is void in finance.` };
  if (st.approval === "returned") {
    return { orgId, status: st, whyNot: "Finance sent this enrolment back — correct its course and fee with Correct it instead." };
  }
  // "not_required": an invoice finance raised without needing an approval — as good as approved.
  if (st.approval !== "approved" && st.approval !== "not_required") {
    return { orgId, status: st, whyNot: "Finance hasn't approved this enrolment yet — wait for its decision (sent back, correct it there)." };
  }
  return { orgId, status: st, whyNot: "" };
}

export class CourseChangeService {
  /**
   * What the Change course dialog starts from: whether a change can be asked now (and if not, why), the course and fee
   * as they are, what is paid, the invoice as finance has it, and every change asked for so far.
   */
  async info(viewer: Viewer, studentId: string) {
    const student = await changeable(viewer, studentId);
    const course = student.course ? await Course.findById(student.course).select("name").lean() : null;
    const pending = (student.courseChanges ?? []).find((c) => c.status === "pending");
    const state = pending ? null : await financeState(student);
    const st = state?.status;
    return {
      canRequest: !pending && !state?.whyNot,
      whyNot: pending ? `A change to ${pending.courseName} is already waiting for finance.` : state?.whyNot ?? "",
      academy: academyOf(student),
      currency: currencyOf(student.academy),
      course: course ? { id: String(course._id), name: course.name } : null,
      fee: student.totalFee ?? 0,
      paid: student.paidAmount ?? 0,
      invoice: st
        ? { number: st.invoiceNumber, currency: st.currency, totalMinor: st.totalMinor, paidMinor: st.amountPaidMinor, balanceMinor: st.balanceMinor }
        : null,
      changes: student.courseChanges ?? [],
    };
  }

  /**
   * Ask finance to change the course: checked here, then sent to finance synchronously — refused there, refused here
   * with finance's reason. `key` is the dialog's own id for the request (a UUID), so pressing it twice, or again after
   * a timeout, is the same request.
   */
  async request(viewer: Viewer, studentId: string, body: Record<string, unknown>): Promise<ICourseChange> {
    const student = await changeable(viewer, studentId);
    const courseId = String(body.courseId ?? "");
    const fee = Number(body.fee);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const key = typeof body.key === "string" && UUID.test(body.key) ? body.key.toLowerCase() : "";

    const missing: string[] = [];
    if (!Types.ObjectId.isValid(courseId)) missing.push("the new course");
    if (!Number.isFinite(fee) || fee <= 0) missing.push("the new fee");
    if (reason.length < 3) missing.push("why it changes");
    if (missing.length) throw fail(422, `A course change needs ${missing.join(", ")}.`);
    if (Math.abs(fee * 100 - Math.round(fee * 100)) > 1e-6) throw fail(422, "The fee can have at most 2 decimals.");
    if (reason.length > 500) throw fail(422, "Keep the reason under 500 characters.");

    // Asked already (a retry of the same dialog): the same request back, nothing sent twice.
    const asked = key ? (student.courseChanges ?? []).find((c) => c.externalId === key) : undefined;
    if (asked) return asked;
    const pending = (student.courseChanges ?? []).find((c) => c.status === "pending");
    if (pending) throw fail(409, `A change to ${pending.courseName} is already waiting for finance — one at a time.`);

    const course = await Course.findById(courseId).lean();
    if (!course) throw fail(422, "That course no longer exists — choose another.");
    if (course.status === "inactive") throw fail(422, `${course.name} isn't sold any more — choose another course.`);

    // In the enrolment's own currency: a Bangalore close's fee and payments are rupees (its close took them so).
    const currency = currencyOf(student.academy);
    const paid = round2(student.paidAmount ?? 0);
    if (minor(fee) < minor(paid)) throw fail(422, `${money(paid, currency)} is already paid — the new fee can't be less.`);
    if (String(student.course ?? "") === String(course._id) && minor(fee) === minor(student.totalFee ?? 0)) {
      throw fail(422, `It is on ${course.name} at ${money(fee, currency)} already — nothing to change.`);
    }

    const state = await financeState(student);
    if (state.whyNot) throw fail(state.unreachable ? 502 : 409, state.whyNot);

    const me = await User.findById(viewer.userId).select("name email").lean<{ name?: string; email?: string }>();
    const externalId = key || crypto.randomUUID();
    // Marked before it goes: if finance keeps it and the answer never comes back, the read-back still finds it there.
    await Student.updateOne({ _id: student._id }, { $set: { courseChangeAskedAt: new Date() } });
    try {
      await sendCourseChange({
        enrolmentExternalId: String(student._id),
        externalId,
        // Exactly as the close names it — the same item (Bangalore's in a Bangalore enrolment) and LMS courses.
        course: financeCourseOf(course, academyOf(student)),
        priceMinor: minor(fee),
        reason,
        requestedBy: { name: me?.name ?? "", email: me?.email ?? "" },
      }, state.orgId);
    } catch (err) {
      if (err instanceof FinanceRefusal) {
        // Finance's reason is for the person: already paid more, one waiting already, nothing changes. One waiting
        // that isn't here is one this CRM sent and never heard back about: the read-back takes it from finance.
        const message = ALREADY_WAITING.test(err.message)
          ? `${err.message.replace(/[.\s]+$/, "")}. It will show here within a few minutes.`
          : err.message;
        throw fail(err.status === 0 || err.status >= 500 || err.status === 401 || err.status === 403 ? 502 : 409, message);
      }
      throw err;
    }

    const entry: ICourseChange = {
      externalId,
      courseId: course._id as Types.ObjectId,
      courseName: course.name,
      fee: round2(fee),
      reason,
      status: "pending",
      requestedBy: { id: Types.ObjectId.isValid(viewer.userId) ? new Types.ObjectId(viewer.userId) : null, name: me?.name ?? "" },
      requestedAt: new Date(),
    };
    // Once, by its id: a second press that got here too adds nothing.
    await Student.updateOne({ _id: student._id, "courseChanges.externalId": { $ne: externalId } }, { $push: { courseChanges: entry } });
    return entry;
  }
}

// ── Finance's decisions, read back ───────────────────────────────────────────────────────────────────────────────────

/**
 * An approved change, made here (once — the request is still pending here, or nothing happens): the student's course
 * and fee, what is left to pay and the fee status; the lead's course (and selling amount, where it has one) with an
 * entry in its activity; and the sale's commission counted again — by clearing its `stepsDoneAt`, so the sweep
 * (commissionService.trackSales) decides it again at the new course with finance's fee.
 */
export async function applyApprovedCourseChange(studentId: string, d: FinanceCourseChange): Promise<boolean> {
  if (!Types.ObjectId.isValid(studentId)) return false;
  const pendingHere = { $elemMatch: { externalId: d.externalId, status: "pending" } };
  const student = await Student.findOne({ _id: new Types.ObjectId(studentId), courseChanges: pendingHere })
    .select("course totalFee paidAmount leadId academy courseChanges")
    .lean<StudentLite>();
  if (!student) return false;                              // not asked here, or applied already
  const cc = (student.courseChanges ?? []).find((c) => c.externalId === d.externalId)!;
  // Finance's price is what the invoice says now; the one asked for otherwise (they are the same).
  const fee = d.priceMinor > 0 ? round2(d.priceMinor / 100) : cc.fee;
  const paid = round2(student.paidAmount ?? 0);
  const now = new Date();
  // Taken from finance with a course that isn't one here: the fee changes, the course stays as it is.
  const keepsCourse = !cc.courseId;
  const done = await Student.updateOne(
    // Not while a balance payment is being added: then paid is different, and the next pass does it.
    { _id: student._id, paidAmount: student.paidAmount ?? null, courseChanges: pendingHere },
    {
      $set: {
        ...(keepsCourse ? {} : { course: cc.courseId }),
        totalFee: fee,
        pendingAmount: Math.max(0, round2(fee - paid)),
        feeStatus: feeStatusOf(fee, paid),
        "courseChanges.$.status": "approved",
        "courseChanges.$.appliedAt": now,
        "courseChanges.$.decidedAt": d.decidedAt ? new Date(d.decidedAt) : now,
        "courseChanges.$.decidedBy": d.decidedBy ?? "",
        ...(d.note ? { "courseChanges.$.note": d.note } : {}),
      },
    },
  );
  if (!done.modifiedCount) return false;

  const currency = currencyOf(student.academy);
  const from = student.course ? await Course.findById(student.course).select("name").lean() : null;
  const fromName = from?.name ?? "no course";
  const lead = student.leadId ? await Lead.findById(student.leadId).select("sellingAmount").lean<{ _id: Types.ObjectId; sellingAmount?: number | null }>() : null;
  if (lead) {
    const by = cc.requestedBy?.id ?? null;
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: { ...(keepsCourse ? {} : { course: cc.courseId }), ...(lead.sellingAmount != null ? { sellingAmount: fee } : {}) },
        $push: {
          activityLogs: {
            action: "lead_updated",
            description: (keepsCourse
              ? `Fee changed (finance approved): ${money(student.totalFee ?? 0, currency)} → ${money(fee, currency)} — finance moved it to ${cc.courseName}, which isn't a course here, so the course stays ${fromName}`
              : `Course changed (finance approved): ${fromName} → ${cc.courseName}, fee ${money(student.totalFee ?? 0, currency)} → ${money(fee, currency)}`).slice(0, 500),
            // Who asked for it (nobody known for one taken from finance); finance approved it.
            ...(by ? { performedBy: by } : {}),
            changes: {
              ...(keepsCourse ? {} : { course: { from: fromName, to: cc.courseName } }),
              fee: { from: student.totalFee ?? 0, to: fee },
            },
            createdAt: now,
          },
        },
      },
    );
  }
  await CommissionSale.updateOne({ student: student._id }, { $unset: { stepsDoneAt: "" } });
  return true;
}

/** A rejected change: so, with finance's reason and who decided. Once. */
export async function applyRejectedCourseChange(studentId: string, d: FinanceCourseChange): Promise<boolean> {
  if (!Types.ObjectId.isValid(studentId)) return false;
  const done = await Student.updateOne(
    { _id: new Types.ObjectId(studentId), courseChanges: { $elemMatch: { externalId: d.externalId, status: "pending" } } },
    {
      $set: {
        "courseChanges.$.status": "rejected",
        "courseChanges.$.rejectReason": d.reason ?? "",
        "courseChanges.$.decidedAt": d.decidedAt ? new Date(d.decidedAt) : new Date(),
        "courseChanges.$.decidedBy": d.decidedBy ?? "",
      },
    },
  );
  return done.modifiedCount > 0;
}

/**
 * A request finance has that isn't here — sent from here, kept by finance, and the answer lost (a timeout) — taken
 * from finance's answer: its id, the course by name (a course here of that name, case and spaces aside — else none,
 * and only the fee will change), the fee. Taken as pending; finance's decision is then applied like any other. Once.
 */
export async function adoptCourseChange(studentId: string, d: FinanceCourseChange): Promise<boolean> {
  if (!Types.ObjectId.isValid(studentId) || !d.externalId) return false;
  const name = String(d.course ?? "").trim();
  // One name for both academies: finance is sent the course's name whichever it bills.
  const course = name
    ? await Course.findOne({ name: new RegExp(`^\\s*${name.split(/\s+/).map(escapeRe).join("\\s+")}\\s*$`, "i") }).select("_id name").lean()
    : null;
  const entry: ICourseChange = {
    externalId: d.externalId,
    courseId: (course?._id as Types.ObjectId | undefined) ?? null,
    courseName: name || "(no course named)",
    fee: round2((d.priceMinor || 0) / 100),
    reason: ADOPTED_REASON,
    status: "pending",
    requestedBy: { id: null, name: "" },
    requestedAt: new Date(),
  };
  const done = await Student.updateOne(
    { _id: new Types.ObjectId(studentId), "courseChanges.externalId": { $ne: d.externalId } },
    { $push: { courseChanges: entry } },
  );
  return done.modifiedCount > 0;
}

/**
 * Every enrolment with a change waiting — or one sent from here lately, which finance may have kept unheard — asked of
 * finance in the organization it was billed in: a request finance has that isn't here is taken (adoptCourseChange),
 * and each decision applied. Run with the balance payment decisions, every two minutes. Finance away: next time.
 */
export async function syncCourseChanges(): Promise<number> {
  const students = await Student.find({ $or: [{ "courseChanges.status": "pending" }, { courseChangeAskedAt: { $exists: true } }] })
    .select("_id academy courseChanges.externalId")
    .lean<{ _id: Types.ObjectId; academy?: string; courseChanges?: { externalId: string }[] }[]>();
  let changed = 0;
  for (let i = 0; i < students.length; i += BATCH) {
    const batch = students.slice(i, i + BATCH);
    const handovers = await FinanceHandover.find({ studentId: { $in: batch.map((s) => s._id) } })
      .select("studentId academy financeOrgId").lean<{ studentId: unknown; academy?: string; financeOrgId?: string }[]>();
    const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
    // Each asked of the organization it was billed in, as the balance payments are.
    const statuses = await fetchStatusesByOrg(
      batch.map((s) => String(s._id)),
      new Map(batch.map((s) => [String(s._id), orgOfHandover(handoverOf.get(String(s._id)), s.academy)])),
    );
    const knownOf = new Map(batch.map((s) => [String(s._id), new Set((s.courseChanges ?? []).map((c) => c.externalId))]));
    for (const st of statuses) {
      const known = knownOf.get(st.externalId);
      if (!known) continue;
      // Oldest first, as finance lists them: a lost one is taken and decided before a later one is.
      for (const d of st.courseChanges ?? []) {
        try {
          if (!known.has(d.externalId) && (await adoptCourseChange(st.externalId, d))) changed++;
          if (d.status === "approved" && (await applyApprovedCourseChange(st.externalId, d))) changed++;
          else if (d.status === "rejected" && (await applyRejectedCourseChange(st.externalId, d))) changed++;
        } catch (err) {
          console.error(`[courseChanges] could not apply ${d.externalId} to enrolment ${st.externalId}`, err);
        }
      }
      // Finance answered, and nothing of its is missing here: once the last send is long past and nothing waits, stop asking.
      await Student.updateOne(
        { _id: new Types.ObjectId(st.externalId), courseChangeAskedAt: { $lt: new Date(Date.now() - ASKED_OPEN_MS) }, "courseChanges.status": { $ne: "pending" } },
        { $unset: { courseChangeAskedAt: "" } },
      );
    }
  }
  return changed;
}
