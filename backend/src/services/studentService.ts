import { Types } from "mongoose";
import {
  ACADEMY_CURRENCY,
  ACADEMY_LABELS,
  BASE_CURRENCY,
  CLOSE_CURRENCIES,
  ENROLMENT_LANGUAGES,
  academyOf,
  isAcademy,
  type Academy,
  ENROLMENT_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type CloseCurrency,
  type EnrolmentLanguage,
  type EnrolmentPaymentMethod,
} from "../types/index.js";
import { Student } from "../models/Student.js";
import { Lead } from "../models/Lead.js";
import type { IRole, IStudent, IStudentPayment } from "../types/index.js";
import { FINANCE_EMAIL_RE, emailKey, isFinanceEmail, takenMessage, type EmailHolder } from "../utils/clientEmail.js";
import { findEmailHolder } from "./emailHolder.js";
import { announceSaleClosed } from "./saleAnnouncement.js";
import { syncSalesNote } from "./financeSalesNote.js";

function createError(msg: string, status: number) {
  return Object.assign(new Error(msg), { statusCode: status });
}

/** Whole fils, so 300.10 + 199.90 is 500 and never 499.9999. */
const minor = (n: number) => Math.round(n * 100);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

type ReceiptInput = { name?: string; url?: string; key?: string; size?: number; mimeType?: string } | null | undefined;
type PaymentInput = {
  method?: string;
  amount?: number | string;
  receipt?: ReceiptInput;
  paidAt?: string;
  collectedBefore?: boolean;
  currency?: string;
  amountInCurrency?: number | string;
  exchangeRate?: number | string;
} | null;

/** What an academy's fees are in: AED for Dubai — this CRM's own, BASE_CURRENCY — INR for Bangalore. */
type AcademyCurrency = (typeof ACADEMY_CURRENCY)[Academy];

/**
 * A payment taken in another currency than the academy's (the owner,
 * 2026-10-05; generalised for the Bangalore academy, 2026-10-10): the
 * currency, the amount in it and the rate — 1 of it = `exchangeRate` of the
 * academy's currency — checked against the amount the close converted it to.
 * Within half a percent, for rounding; a figure typed in the wrong currency is
 * refused rather than billed.
 *
 *   Dubai (AED)      any of the CRM's currencies; nothing for an AED payment,
 *                    nor for the money already on the lead, which is in AED.
 *   Bangalore (INR)  rupees, or cash taken in AED with its rate — finance's
 *                    `original` {AED, amount, INR per AED}. The money already
 *                    on the lead is in AED, so on a Bangalore close it is
 *                    always the latter: its AED and the rate it is taken at.
 */
function foreignPart(
  raw: PaymentInput,
  amount: number,
  n: string,
  base: AcademyCurrency = BASE_CURRENCY,
): Pick<IStudentPayment, "currency" | "amountInCurrency" | "exchangeRate"> {
  const currency = typeof raw?.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  if (base === BASE_CURRENCY) {
    if (!currency || currency === BASE_CURRENCY) return {};
    if (!CLOSE_CURRENCIES.includes(currency as CloseCurrency)) throw createError(`${n} is in a currency this CRM does not take (${currency}).`, 422);
    if (raw?.collectedBefore) throw createError(`${n} was already on the lead in ${BASE_CURRENCY}, so it cannot be in ${currency}.`, 422);
  } else if (raw?.collectedBefore) {
    if (currency !== BASE_CURRENCY) {
      throw createError(`${n} was already on the lead in ${BASE_CURRENCY} — give it in ${BASE_CURRENCY} with its rate: 1 ${BASE_CURRENCY} = how many ${base}.`, 422);
    }
  } else {
    if (!currency || currency === base) return {};
    if (currency !== BASE_CURRENCY) {
      throw createError(`${n} is in ${currency}: a Bangalore close takes ${base}, or cash in ${BASE_CURRENCY} with its rate to ${base}.`, 422);
    }
  }
  const inCurrency = Number(raw?.amountInCurrency);
  if (!Number.isFinite(inCurrency) || inCurrency <= 0) throw createError(`${n} needs the amount paid in ${currency}.`, 422);
  const rate = Number(raw?.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) throw createError(`${n} needs its rate: 1 ${currency} = how many ${base}.`, 422);
  const expected = Math.round(inCurrency * rate * 100);
  if (Math.abs(minor(amount) - expected) > Math.max(1, Math.round(expected * 0.005))) {
    throw createError(
      `${n}: ${money(inCurrency)} ${currency} at 1 ${currency} = ${rate} ${base} comes to ${money(expected / 100)} ${base}, not ${money(amount)}.`,
      422,
    );
  }
  return { currency: currency as CloseCurrency, amountInCurrency: minor(inCurrency) / 100, exchangeRate: rate };
}

/**
 * The payments a close sends, checked (the user, 2026-10-05: a client may pay
 * part in cash and part by card, each with its own receipt): every one with a
 * method this CRM takes, an amount above zero and its receipt, and together
 * exactly what was paid. Null when the close sent none — an older screen, with
 * one method, one receipt and the total.
 */
function checkedPayments(list: unknown, paidAmount: number, enrolledOn: Date, base: AcademyCurrency = BASE_CURRENCY): IStudentPayment[] | null {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) throw createError("A closing takes between one and ten payments.", 422);
  const payments = (list as PaymentInput[]).map((raw, i) => {
    const n = list.length > 1 ? `Payment ${i + 1}` : "The payment";
    if (!ENROLMENT_PAYMENT_METHODS.includes(raw?.method as EnrolmentPaymentMethod)) throw createError(`${n} needs a payment method.`, 422);
    const amount = Number(raw?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw createError(`${n} needs an amount above zero.`, 422);
    if (!raw?.receipt?.key || !raw.receipt.url) throw createError(`${n} needs its receipt.`, 422);
    const paidAt = raw.paidAt ? new Date(raw.paidAt) : enrolledOn;
    return {
      method: raw.method as EnrolmentPaymentMethod,
      amount: minor(amount) / 100,
      receipt: {
        name: raw.receipt.name || "Receipt",
        url: raw.receipt.url,
        key: raw.receipt.key,
        ...(raw.receipt.size ? { size: raw.receipt.size } : {}),
        ...(raw.receipt.mimeType ? { mimeType: raw.receipt.mimeType } : {}),
        uploadedAt: new Date(),
      },
      paidAt: Number.isNaN(paidAt.getTime()) ? enrolledOn : paidAt,
      ...(raw.collectedBefore ? { collectedBefore: true } : {}),
      ...foreignPart(raw, amount, n, base),
    };
  });
  const sum = payments.reduce((s, p) => s + minor(p.amount), 0);
  if (sum !== minor(paidAmount)) {
    throw createError(`The payments come to ${money(sum / 100)}, but ${money(paidAmount)} was paid — they must match.`, 422);
  }
  return payments;
}

/*
 * Collecting more than the fee is taken (the owner, 2026-10-06: more is
 * sometimes collected and it must still go through). The close and correction
 * forms say so in amber, the balance stays at zero, never negative, and finance
 * leaves payments above its invoice for accounts to record by hand.
 */

/** A bonus amount that can be recorded: a real number above zero. */
function isBonusAmount(v: unknown): boolean {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n > 0;
}

/*
 * The client's email is checked as finance checks it (2026-10-10) —
 * isFinanceEmail, zod's email pattern, in utils/clientEmail.ts — and, since
 * finance files a close under whoever its email already belongs to, it must
 * not be another client's here (findEmailHolder; one email, one client).
 */

/** What finance answers when its intake refuses the enrolment's shape — an empty client email, say. */
const FINANCE_REFUSED_RE = /request validation failed/i;

type HandoverForEmail = { status?: string | null; lastError?: string | null; payload?: unknown } | null | undefined;

/** The client's email as it went — or is about to go — to finance, exactly: the one in the queued payload. */
function payloadEmail(h: HandoverForEmail): string {
  const customer = (h?.payload as { customer?: { email?: unknown } } | null | undefined)?.customer;
  return typeof customer?.email === "string" ? customer.email : "";
}

/**
 * A close finance refused because the client's email was missing or not one
 * (2026-10-10): not delivered, refused by finance's intake check, and the
 * email it was sent no email. The screens offer "Add the client's email and
 * send again" for exactly these — not for one held up by anything else.
 */
export function refusedForEmail(h: HandoverForEmail): boolean {
  if (!h || h.status === "sent") return false;
  return FINANCE_REFUSED_RE.test(h.lastError ?? "") && !isFinanceEmail(payloadEmail(h));
}

/**
 * Whether the client's email can be added to this queued close and sent
 * again: one finance refused for it (above), or one still waiting to go with
 * no email in it — finance would refuse that the moment it got there. Never
 * one finance already has, nor one failed for some other reason.
 */
function emailCanBeAdded(h: HandoverForEmail): boolean {
  if (!h || h.status === "sent" || isFinanceEmail(payloadEmail(h))) return false;
  return h.status === "pending" || refusedForEmail(h);
}

/**
 * What the "add the client's email" field starts from (2026-10-10): the
 * enrolment's email if finance would take it, else the lead's — people add it
 * to the lead by hand — else nothing. Never one another client here already
 * holds (one email, one client): suggested, it would only be refused. Only
 * ever a suggestion: nothing is sent until somebody presses the button.
 */
async function suggestedEmailOf(
  student: { _id: unknown; name?: unknown; phone?: unknown; email?: unknown; leadId?: unknown },
  leadEmail: unknown,
): Promise<string> {
  for (const v of [student.email, leadEmail]) {
    const e = emailKey(v);
    if (!isFinanceEmail(e)) continue;
    if (await findEmailHolder(e, { name: student.name, phone: student.phone, studentId: student._id, leadId: student.leadId })) continue;
    return e;
  }
  return "";
}

/** A refusal for an email another client here holds: 409, naming them (takenMessage). */
function emailTaken(holder: EmailHolder, clientName: unknown) {
  return createError(takenMessage(holder, clientName), 409);
}

/** Why the finance step failed, as the steps say it: in words for a missing email, finance's own otherwise. */
function stepError(h: HandoverForEmail): string | null | undefined {
  return refusedForEmail(h) ? "the client's email is missing; add it and send again" : h?.lastError;
}

/**
 * A payment on the lead that the close recorded — "Collected at enrolment —
 * <course> · <method>" — as opposed to one the lead held of its own. Only the
 * close's are replaced when the enrolment is corrected.
 */
const fromTheClose = (note?: string | null) => /^Collected at enrolment\b/.test(note ?? "");

/**
 * " · INR 50,000 at 1 INR = 0.044 AED" for a payment in another currency than
 * the academy's (`base`), as the close writes it on the lead; "" otherwise.
 */
function foreignNote(p: IStudentPayment, base: AcademyCurrency = BASE_CURRENCY): string {
  if (!p.currency || p.currency === base || !p.amountInCurrency || !p.exchangeRate) return "";
  const paid = p.amountInCurrency.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const rate = Number(p.exchangeRate.toPrecision(6)).toLocaleString("en-US", { maximumFractionDigits: 10 });
  return ` · ${p.currency} ${paid} at 1 ${p.currency} = ${rate} ${base}`;
}

/**
 * What of a close goes on the lead's own payment list, as the dialog writes
 * it there — the list is in AED, this CRM's currency, and is what its revenue
 * figures add up. A Dubai close: every payment taken, in AED. A Bangalore
 * close (2026-10-10): only what was handed over in AED, at its AED amount;
 * a payment in rupees stays on the enrolment alone, since adding INR to an
 * AED list would count it some twenty times over.
 */
function leadPaymentOf(p: IStudentPayment, academy: Academy, courseName: string): { amount: number; note: string } | null {
  const method = PAYMENT_METHOD_LABELS[p.method] ?? p.method;
  if (academy === "dubai") {
    // In AED; one paid in another currency says what was handed over, as the close's note does.
    return { amount: p.amount, note: `Collected at enrolment — ${courseName} · ${method}${foreignNote(p)}` };
  }
  if (p.currency !== BASE_CURRENCY || !p.amountInCurrency) return null;
  return {
    amount: p.amountInCurrency,
    note: `Collected at enrolment — ${courseName} · ${method} · ${ACADEMY_LABELS[academy]}${foreignNote(p, ACADEMY_CURRENCY[academy])}`,
  };
}

/** Everything a close took, sent again as a correction once finance has sent the enrolment back. */
export interface EnrolmentCorrection {
  name?: string;
  phone?: string;
  email?: string;
  course?: string | null;
  team?: string | null;
  assignedTo?: string | null;
  enrollmentDate?: string;
  feeStatus?: string;
  totalFee?: number | string;
  paidAmount?: number | string;
  notes?: string;
  language?: string;
  payments?: unknown;
  hasBonus?: boolean;
  bonusAmount?: number | string;
  /** The academy: kept unless changed (2026-10-26) — a change moves it to that academy's finance books. */
  academy?: string;
}

// Auto-generate enrollment number: STU-0001, STU-0002, ...
async function nextEnrollmentNumber(): Promise<string> {
  const last = await Student.findOne().sort({ createdAt: -1 }).select("enrollmentNumber").lean();
  if (!last) return "STU-0001";
  const match = last.enrollmentNumber.match(/\d+$/);
  const num = match ? parseInt(match[0], 10) + 1 : 1;
  return `STU-${String(num).padStart(4, "0")}`;
}

export class StudentService {

  // ── Create ───────────────────────────────────────────────────────────────────

  async createStudent(data: {
    leadId: string;
    name: string;
    phone?: string;
    email?: string;
    course?: string | null;
    team?: string | null;
    assignedTo?: string | null;
    initialLeadResponse?: string | null;
    primaryConcern?: string | null;
    followupStrategyType?: string | null;
    demoScheduled?: boolean;
    demoAttended?: boolean;
    firstContactTime?: string | null;
    lastFollowupDate?: string | null;
    enrollmentDate?: string;
    feeStatus?: string;
    totalFee?: number;
    paidAmount?: number;
    notes?: string;
    language?: string;
    paymentMethod?: string;
    paymentReceipt?: { name: string; url: string; key: string; size?: number; mimeType?: string } | null;
    /** Each payment taken, when the client paid in more than one way. */
    payments?: unknown;
    hasBonus?: boolean;
    bonusAmount?: number;
    /** Which academy it is closed for: "dubai" (the default) or "bangalore". */
    academy?: string | null;
  }, performedBy?: string) {
    const existing = await Student.findOne({ leadId: data.leadId });
    if (existing) throw createError("A student already exists for this lead", 409);

    // Dubai unless the close says Bangalore (an older screen says nothing).
    const academy = data.academy === undefined || data.academy === null || data.academy === "" ? "dubai" : data.academy;
    if (!isAcademy(academy)) throw createError(`"${String(data.academy)}" isn't an academy — choose Dubai or Bangalore.`, 422);
    if (academy === "bangalore") await this.assertBangaloreClose(data.course);

    const totalFee   = data.totalFee   ?? 0;
    const paidAmount = data.paidAmount ?? 0;
    const enrolledOn = data.enrollmentDate ? new Date(data.enrollmentDate) : new Date();
    // One payment or several; the first is also the one method and receipt.
    // In the academy's currency: AED for Dubai, INR for Bangalore.
    const payments = checkedPayments(data.payments, paidAmount, enrolledOn, ACADEMY_CURRENCY[academy]);
    const paymentMethod = payments?.[0]?.method ?? data.paymentMethod;
    const paymentReceipt = payments?.[0]?.receipt ?? data.paymentReceipt;

    /*
     * Required here rather than on the model.
     *
     * Enrolments predating these fields exist and have to keep loading, so the
     * schema leaves them optional; the requirement belongs at the moment of
     * closing, which is the only moment somebody is in a position to answer.
     *
     * All three are asked for at once and refused as one list. Rejecting them
     * one at a time means three round trips to learn three things the form
     * could have said together.
     *
     * And the client's email (2026-10-10), as Draw's close already asks:
     * finance's intake refuses an enrolment without a valid one, so a close
     * without it was saved here and then failed there, permanently, where
     * nobody closing the lead could see it.
     */
    const email = String(data.email ?? "").trim().toLowerCase();
    const missing: string[] = [];
    if (!isFinanceEmail(email)) missing.push("the client's email");
    if (!ENROLMENT_LANGUAGES.includes(data.language as EnrolmentLanguage)) missing.push("language");
    if (!ENROLMENT_PAYMENT_METHODS.includes(paymentMethod as EnrolmentPaymentMethod)) {
      missing.push("payment method");
    }
    if (!paymentReceipt?.key || !paymentReceipt.url) missing.push("payment receipt");
    // Yes or no, every time — and a yes is only an answer with its amount.
    if (typeof data.hasBonus !== "boolean") missing.push("whether a bonus was given");
    else if (data.hasBonus && !isBonusAmount(data.bonusAmount)) missing.push("the bonus amount");
    if (missing.length) {
      throw createError(
        `A closing needs ${missing.join(", ")}. Give the client's email, upload the receipt, choose the language and payment method, and say whether a bonus was given, then close again.`,
        422,
      );
    }

    /*
     * The client's own email (one email, one client — the user, 2026-10-10).
     * Finance files a close under the customer its email already belongs to,
     * so an email another client here holds — a student, or a lead that is a
     * different person — is refused, naming them. The lead's own email counts
     * too: a lead sharing it with other people is closed with the client's own,
     * and keeps its email (keepEmailOnLead only fills one in where there is none).
     * Who the client is: as the close says, else as the lead does.
     */
    const closedLead = Types.ObjectId.isValid(String(data.leadId))
      ? await Lead.findById(data.leadId).select("name phone").lean()
      : null;
    const client = { name: data.name || closedLead?.name, phone: data.phone || closedLead?.phone };
    const holder = await findEmailHolder(email, { ...client, leadId: data.leadId });
    if (holder) throw emailTaken(holder, client.name);

    const enrollmentNumber = await nextEnrollmentNumber();

    const student = await Student.create({
      enrollmentNumber,
      name: data.name,
      phone: data.phone,
      email,
      course: data.course || undefined,
      team:   data.team   || undefined,
      assignedTo: data.assignedTo || undefined,
      leadId: data.leadId,
      initialLeadResponse:  data.initialLeadResponse  ?? null,
      primaryConcern:       data.primaryConcern        ?? null,
      followupStrategyType: data.followupStrategyType  ?? null,
      demoScheduled:    data.demoScheduled  ?? false,
      demoAttended:     data.demoAttended   ?? false,
      firstContactTime: data.firstContactTime ? new Date(data.firstContactTime) : null,
      lastFollowupDate: data.lastFollowupDate ? new Date(data.lastFollowupDate) : null,
      enrollmentDate:   enrolledOn,
      feeStatus:    this.computeFeeStatus(totalFee, paidAmount, data.feeStatus),
      totalFee,
      paidAmount,
      pendingAmount: Math.max(0, totalFee - paidAmount),
      academy,
      notes: data.notes,
      language: data.language,
      paymentMethod,
      paymentReceipt: paymentReceipt
        ? { ...paymentReceipt, uploadedAt: new Date() }
        : undefined,
      ...(payments ? { payments } : {}),
      hasBonus: data.hasBonus,
      bonusAmount: data.hasBonus ? Number(data.bonusAmount) : 0,
      status: "active",
    });

    // The email asked for at the close kept on the lead too, where it had none.
    await this.keepEmailOnLead(data.leadId, email, performedBy, "at the close");

    // Queued, not sent. The sale is recorded the moment this returns; the
    // invoice follows when finance is reachable. See financeHandoverWorker.
    await this.queueFinanceHandover(String(student._id), data.leadId);

    const closed = await this.populateStudent(String(student._id));
    // Every signed-in screen celebrates it (the user, 2026-10-15). Not waited for.
    announceSaleClosed(closed, performedBy);
    return closed;
  }

  /**
   * The client's email, kept on the lead too — when it had none that works
   * (2026-10-10, as Draw's close does).
   *
   * The lead is where this CRM keeps a client's details, so an address learnt
   * at the close — or added afterwards for finance — belongs there rather than
   * only on the enrolment. One the lead already holds that is an email is
   * never replaced from here: correcting it is the lead's own edit, with its
   * own history. Logged on the lead's activity. Never fails what called it,
   * which is already saved.
   *
   * An update rather than a save, so a lead carrying some older value its
   * schema would now refuse still gets the email instead of quietly not.
   */
  private async keepEmailOnLead(leadId: unknown, email: string, performedBy: string | undefined, when: string): Promise<void> {
    try {
      if (!leadId || !Types.ObjectId.isValid(String(leadId))) return;
      const lead = await Lead.findById(leadId).select("email").lean();
      if (!lead) return;
      const had = typeof lead.email === "string" ? lead.email.trim() : "";
      if (isFinanceEmail(had)) return;
      await Lead.updateOne(
        // Still without one: an email somebody saved in the meantime is theirs.
        { _id: lead._id, email: { $not: FINANCE_EMAIL_RE } },
        {
          $set: { email },
          $push: {
            activityLogs: {
              action: "lead_updated",
              description: `Email added ${when}: ${email}`,
              ...(performedBy && Types.ObjectId.isValid(performedBy) ? { performedBy: new Types.ObjectId(performedBy) } : {}),
              changes: { email: { from: had || null, to: email } },
              createdAt: new Date(),
            },
          },
        },
      );
    } catch (err) {
      console.error("[students] could not keep the email on the lead", err);
    }
  }

  /**
   * What a close for the Bangalore academy needs before it can be made
   * (2026-10-10): the course, with its Bangalore price — the fee is in INR and
   * there is no Dubai figure to fall back on — and the Bangalore finance
   * organization to bill it in (FINANCE_ORG_ID_BANGALORE), even while finance
   * is switched off: this server offers Bangalore only once it is set
   * (academiesOffered). Refused otherwise, rather than sent into Dubai's
   * organization or billed at a guess.
   */
  private async assertBangaloreClose(courseId: unknown): Promise<void> {
    const { academiesOffered } = await import("./financeClient.js");
    if (!academiesOffered().includes("bangalore")) {
      throw createError(
        "Bangalore closes can't reach finance yet — the Bangalore finance organization isn't set up on this server. Close it for Dubai, or ask an admin to set FINANCE_ORG_ID_BANGALORE.",
        422,
      );
    }
    if (typeof courseId !== "string" || !Types.ObjectId.isValid(courseId)) {
      throw createError("A Bangalore close needs its course — the fee is the course's Bangalore price.", 422);
    }
    const { Course } = await import("../models/Course.js");
    const course = await Course.findById(courseId).select("name bangalore").lean();
    if (!course) throw createError("That course no longer exists — choose another.", 422);
    if (!this.hasBangalorePrice(course)) {
      throw createError(`${course.name} has no Bangalore price yet — set it on Courses → Map, then close it for Bangalore.`, 422);
    }
  }

  /** Whether a course can be closed for Bangalore: it has a price there, in INR, above zero. */
  private hasBangalorePrice(course: { bangalore?: { price?: number | null } | null } | null): boolean {
    const price = course?.bangalore?.price;
    return typeof price === "number" && Number.isFinite(price) && price > 0;
  }

  /**
   * Put this enrolment in the queue for Delta Finance.
   *
   * Deliberately swallows its own failures. The student exists by the time this
   * runs, and a salesperson should not see an error — still less lose the
   * enrolment — because a queue row could not be written or because the
   * integration is switched off. A missing row is visible on the student, which
   * shows no invoice number.
   */
  /**
   * The enrolment as finance needs to read it.
   *
   * Built from the student as it stands right now. Whether that is a snapshot
   * or the current truth depends on when it is called: at the close it is the
   * snapshot, because the queue row keeps the first one it is given; for a
   * correction after finance sent the enrolment back it is deliberately the
   * current record, because the correction is the whole point.
   *
   * Null when the student has gone.
   */
  async buildHandoverPayload(studentId: string): Promise<Record<string, unknown> | null> {
    const { Student } = await import("../models/Student.js");
    const { Course } = await import("../models/Course.js");
    const { User } = await import("../models/User.js");

    const student = await Student.findById(studentId).lean();
    if (!student) return null;

    const course = student.course ? await Course.findById(student.course).lean() : null;
    const rep = student.assignedTo ? await User.findById(student.assignedTo).select("name email").lean() : null;
    // Every LMS course it opens — the list where it was mapped as one (two for a
    // bundle), the single slug from before otherwise.
    const listed = (course?.lmsCourseSlugs ?? []).map((s) => s.trim()).filter(Boolean);
    const dubaiLms = listed.length ? listed : course?.lmsCourseSlug?.trim() ? [course.lmsCourseSlug.trim()] : [];

    /*
     * The academy it was closed for (2026-10-10). Bangalore bills in its own
     * finance organization, in INR: the course's Bangalore item — the Dubai
     * one is in another catalogue — and its Bangalore LMS courses, Dubai's
     * where none were set (the Forex courses are shared). The fee and the
     * payments are already in INR on the student; ×100 makes them paise.
     */
    const academy = academyOf(student);
    const base = ACADEMY_CURRENCY[academy];
    const bangalore = academy === "bangalore" ? course?.bangalore ?? null : null;
    const bangaloreLms = (bangalore?.lmsCourseSlugs ?? []).map((s) => s.trim()).filter(Boolean);
    const lms = academy === "bangalore" && bangaloreLms.length ? bangaloreLms : dubaiLms;
    const itemId = academy === "bangalore" ? bangalore?.financeItemId : course?.financeItemId;

    return {
      externalId: String(student._id),
      source: "crm",
      // Which sales CRM sold it, shown as a tag in finance, the LMS and
      // Tetra Commission. Not the source: this CRM began as a copy of Delta's
      // and sends the same "crm", which is part of finance's idempotency key,
      // so it cannot change for enrolments already sent. Keep "remote" here
      // when code is copied across from Delta's CRM.
      crm: "remote",
      // Dubai or Bangalore — always said, so finance, the LMS and Tetra
      // Commission never have to guess it from which organization this came in.
      academy,
      customer: {
        name: student.name,
        email: student.email ?? "",
        phone: student.phone ?? "",
      },
      course: {
        name: course?.name ?? "Course",
        ...(itemId ? { itemId } : {}),
        // The code this course is billed under, where somebody has set one.
        ...(course?.hsnSac?.trim() ? { hsnSac: course.hsnSac.trim() } : {}),
        // Which course(s) this is in the LMS, for finance to fall back on when
        // the item it bills against has no LMS courses of its own — a bundle
        // with no product opens all of them.
        ...(lms.length ? { lmsCourseSlug: lms[0], lmsCourseSlugs: lms } : {}),
        // Minor units: finance counts in fils and paise, the CRM in whole
        // currency. Getting this wrong bills a client a hundredfold.
        amountMinor: Math.round((student.totalFee ?? 0) * 100),
      },
      ...(rep?.email ? { salespersonEmail: rep.email } : {}),
      ...(rep?.name ? { salespersonName: rep.name } : {}),
      enrolledOn: (student.enrollmentDate ?? new Date()).toISOString().slice(0, 10),
      declaredPaidMinor: Math.round((student.paidAmount ?? 0) * 100),
      // The fee less what was paid, in the same minor units as the two figures
      // it comes from, so finance sees exactly the difference of what it was
      // sent. The bonus is never in it.
      balanceMinor: Math.max(0, Math.round((student.totalFee ?? 0) * 100) - Math.round((student.paidAmount ?? 0) * 100)),
      // Whether a bonus was given at the close, for information. Not sent for
      // an enrolment from before it was asked: unknown is not "no".
      ...(typeof student.hasBonus === "boolean"
        ? {
            bonus: {
              given: student.hasBonus,
              amountMinor: student.hasBonus ? Math.round((student.bonusAmount ?? 0) * 100) : 0,
              // The course bonus is an MT5 bonus, in US dollars in every sales CRM (2026-10-09) —
              // whatever the fee's currency. Cents.
              currency: "USD",
            },
          }
        : {}),
      modeOfStudy: "online" as const,
      // Taken at the close now, rather than sent empty for finance to record
      // as "Not specified" — which is what every enrolment from here used to
      // say, because this field had nothing behind it.
      language: student.language ?? "",
      // The note written at the close, for finance only — kept apart from the
      // invoice's own notes, which are printed for the client. Kept up to date
      // afterwards by financeSalesNote.ts.
      salesNote: (student.notes ?? "").trim(),
      ...(student.paymentMethod ? { declaredPaymentMethod: student.paymentMethod } : {}),
      // The key, not a copy. Both applications address the same bucket, so
      // finance attaches the file this already wrote rather than being sent
      // a second one that can drift from it.
      ...(student.paymentReceipt?.key
        ? {
            receipt: {
              name: student.paymentReceipt.name,
              url: student.paymentReceipt.url,
              key: student.paymentReceipt.key,
              ...(student.paymentReceipt.size ? { size: student.paymentReceipt.size } : {}),
              ...(student.paymentReceipt.mimeType ? { mimeType: student.paymentReceipt.mimeType } : {}),
            },
          }
        : {}),
      // Each payment on its own, with its own method, date and receipt — they
      // add up to declaredPaidMinor, and finance records them on approval. The
      // fields above stay for whatever reads only the total.
      ...(student.payments?.length
        ? {
            payments: student.payments.map((p) => ({
              method: p.method,
              amountMinor: Math.round(p.amount * 100),
              paidOn: new Date(p.paidAt).toISOString().slice(0, 10),
              ...(p.receipt?.key && p.receipt.url
                ? {
                    receipt: {
                      name: p.receipt.name,
                      url: p.receipt.url,
                      key: p.receipt.key,
                      ...(p.receipt.size ? { size: p.receipt.size } : {}),
                      ...(p.receipt.mimeType ? { mimeType: p.receipt.mimeType } : {}),
                    },
                  }
                : {}),
              // Paid in another currency: amountMinor above is what it was
              // converted to in the academy's currency (what finance records);
              // this is what was handed over, and the rate — finance's
              // `original`, 1 of it = rate AED (Dubai) or INR (Bangalore: cash
              // taken in AED, rate INR per AED).
              ...(p.currency && p.currency !== base && p.amountInCurrency && p.exchangeRate
                ? { original: { currency: p.currency, amountMinor: Math.round(p.amountInCurrency * 100), rate: p.exchangeRate } }
                : {}),
            })),
          }
        : {}),
    };
  }

  async queueFinanceHandover(studentId: string, leadId: string): Promise<void> {
    try {
      const { financeConfigured } = await import("./financeClient.js");
      if (!financeConfigured()) return;

      const { FinanceHandover } = await import("../models/FinanceHandover.js");
      const { Student } = await import("../models/Student.js");

      const student = await Student.findById(studentId).select("_id academy").lean();
      if (!student) return;
      // The academy, and so the finance organization, fixed with the row — every
      // later call about this enrolment goes there (financeOrgs.orgOfHandover).
      const { financeOrgOf } = await import("./financeClient.js");
      const academy = academyOf(student);
      const financeOrgId = financeOrgOf(academy);

      /*
       * A snapshot, not a reference.
       *
       * What is delivered is what was true when the sale happened. If somebody
       * renames the course or reprices it tomorrow, the invoice that goes out
       * should still say what the client actually agreed to. $setOnInsert below
       * is what holds that: a row that exists keeps the payload it was made with.
       */
      const payload = await this.buildHandoverPayload(studentId);
      if (!payload) return;

      await FinanceHandover.updateOne(
        { studentId: student._id },
        {
          $setOnInsert: {
            studentId: student._id,
            leadId,
            payload,
            academy,
            ...(financeOrgId ? { financeOrgId } : {}),
            status: "pending",
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );

      // Out now, in the background; the worker's timer retries whatever this cannot send.
      const { kickFinanceHandover } = await import("./financeHandoverWorker.js");
      kickFinanceHandover();
    } catch (err) {
      console.error("[finance] could not queue the handover", err);
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  async getStudents(filters: {
    search?: string;
    status?: string;
    feeStatus?: string;
    course?: string;
    team?: string;
    assignedTo?: string;
    initialLeadResponse?: string;
    primaryConcern?: string;
    followupStrategyType?: string;
    demoScheduled?: string;
    demoAttended?: string;
    enrollmentFrom?: string;
    enrollmentTo?: string;
    page?: string;
    limit?: string;
  }) {
    const page  = Math.max(1, parseInt(filters.page  ?? "1",  10));
    const limit = Math.min(100, parseInt(filters.limit ?? "20", 10));
    const skip  = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = {};

    if (filters.search) {
      const re = new RegExp(filters.search, "i");
      query.$or = [{ name: re }, { phone: re }, { email: re }, { enrollmentNumber: re }];
    }
    if (filters.status)               query.status     = filters.status;
    if (filters.feeStatus)            query.feeStatus  = filters.feeStatus;
    if (filters.course)               query.course     = filters.course;
    if (filters.team)                 query.team       = filters.team;
    if (filters.assignedTo)           query.assignedTo = filters.assignedTo;
    if (filters.initialLeadResponse)  query.initialLeadResponse  = filters.initialLeadResponse;
    if (filters.primaryConcern)       query.primaryConcern       = filters.primaryConcern;
    if (filters.followupStrategyType) query.followupStrategyType = filters.followupStrategyType;
    if (filters.demoScheduled !== undefined) query.demoScheduled = filters.demoScheduled === "true";
    if (filters.demoAttended  !== undefined) query.demoAttended  = filters.demoAttended  === "true";
    if (filters.enrollmentFrom || filters.enrollmentTo) {
      query.enrollmentDate = {};
      if (filters.enrollmentFrom) query.enrollmentDate.$gte = new Date(filters.enrollmentFrom + "T00:00:00.000Z");
      if (filters.enrollmentTo)   query.enrollmentDate.$lte = new Date(filters.enrollmentTo   + "T23:59:59.999Z");
    }

    const [students, total] = await Promise.all([
      Student.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("course",     "name amount bangalore")
        .populate("team",       "name")
        .populate("assignedTo", "name email designation")
        .populate("leadId",     "name phone status")
        .lean(),
      Student.countDocuments(query),
    ]);

    return {
      students,
      pagination: {
        total, page, limit,
        totalPages:  Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  async getStudentById(id: string) {
    const student = await this.populateStudent(id);
    if (!student) throw createError("Student not found", 404);
    return student;
  }

  async getStudentByLeadId(leadId: string) {
    return Student.findOne({ leadId })
      .populate("course",     "name amount bangalore")
      .populate("team",       "name")
      .populate("assignedTo", "name email designation")
      .lean();
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  async updateStudent(id: string, data: Partial<IStudent & { course?: string; team?: string; assignedTo?: string }>) {
    const student = await Student.findById(id);
    if (!student) throw createError("Student not found", 404);

    const allowed: Array<keyof typeof data> = [
      "name", "phone", "email", "course", "team", "assignedTo",
      "initialLeadResponse", "primaryConcern", "followupStrategyType",
      "demoScheduled", "demoAttended", "firstContactTime", "lastFollowupDate",
      "enrollmentDate", "feeStatus", "totalFee", "paidAmount", "notes", "status",
    ];
    const noteBefore = (student.notes ?? "").trim();
    for (const field of allowed) {
      if (data[field] !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (student as any)[field] = data[field];
      }
    }

    /*
     * The bonus, corrected after the close. Kept here: an enrolment already
     * with finance is not re-sent for an edit — the bonus reaches finance with
     * a correction only after finance sends the enrolment back.
     */
    if (typeof data.hasBonus === "boolean") student.hasBonus = data.hasBonus;
    if (data.bonusAmount !== undefined) student.bonusAmount = Number(data.bonusAmount);
    if (student.hasBonus === true && !isBonusAmount(student.bonusAmount)) {
      throw createError("A bonus needs an amount above zero — or choose no bonus.", 422);
    }
    if (student.hasBonus !== true) student.bonusAmount = 0;

    // Recompute pendingAmount and feeStatus if fee fields changed
    const total   = (student as unknown as Record<string, number>).totalFee   as number ?? 0;
    const paid    = (student as unknown as Record<string, number>).paidAmount  as number ?? 0;
    student.pendingAmount = Math.max(0, total - paid);
    // An explicitly sent status is honoured, as it is on create. The figures
    // decide when nobody says otherwise — but a counsellor who marks an
    // enrolment paid against a part payment has a reason, and discarding it
    // made the dropdown on the enrolment dialog do nothing at all.
    student.feeStatus     = this.computeFeeStatus(total, paid, data.feeStatus);

    await student.save();
    // A changed note reaches finance straight away (financeSalesNote.ts).
    if ((student.notes ?? "").trim() !== noteBefore) await syncSalesNote(id);
    return this.populateStudent(id);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async deleteStudent(id: string) {
    const student = await Student.findByIdAndDelete(id);
    if (!student) throw createError("Student not found", 404);
    return { deleted: String(student._id) };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private computeFeeStatus(total: number, paid: number, override?: string): "paid" | "partial" | "pending" {
    if (override && ["paid", "partial", "pending"].includes(override)) return override as "paid" | "partial" | "pending";
    if (total <= 0 || paid <= 0) return "pending";
    if (paid >= total) return "paid";
    return "partial";
  }

  private populateStudent(id: string) {
    return Student.findById(id)
      .populate("course",     "name amount bangalore")
      .populate("team",       "name")
      .populate("assignedTo", "name email designation")
      .populate("leadId",     "name phone status")
      .lean();
  }

  // ── The closing book ─────────────────────────────────────────────────────────

  /**
   * Enrolments grouped by the day they were closed.
   *
   * A closing is the moment a lead becomes a student, and the question people
   * actually ask about it is "how did today go" — a number, a value, and the
   * names behind both. That was answerable only by opening the enrolment list
   * and counting, which nobody does twice.
   *
   * Bucketed in Asia/Dubai rather than UTC, which is the whole difficulty.
   * `enrollmentDate` is an instant, and the business day it belongs to is a
   * local question: a sale closed at 2am Dubai is 10pm UTC the day before, and
   * grouping on UTC would file it under yesterday and quietly take a closing
   * off the day somebody is being measured on. Mongo can bucket by timezone, so
   * it does.
   *
   * The enrolments come back inside their day rather than on request. A month
   * of closings is a few hundred rows, and the alternative is a request per day
   * for something whose whole purpose is being glanced at.
   */
  async listDailyClosings(filters: {
    dateFrom?: string;
    dateTo?: string;
    team?: string;
    user?: string;
  }) {
    const TZ = "Asia/Dubai";
    const match: Record<string, unknown> = {};

    // Inclusive at both ends, and read as local days: "to 18 Sept" means up to
    // the end of the 18th in Dubai, not up to midnight at the start of it.
    if (filters.dateFrom || filters.dateTo) {
      const range: Record<string, Date> = {};
      if (filters.dateFrom) range.$gte = new Date(`${filters.dateFrom}T00:00:00+04:00`);
      if (filters.dateTo) range.$lte = new Date(`${filters.dateTo}T23:59:59.999+04:00`);
      match.enrollmentDate = range;
    }
    if (filters.team) match.team = new Types.ObjectId(filters.team);
    if (filters.user) match.assignedTo = new Types.ObjectId(filters.user);

    const days = await Student.aggregate([
      { $match: match },
      { $sort: { enrollmentDate: -1 } },
      {
        $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" },
      },
      { $unwind: { path: "$courseInfo", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "users", localField: "assignedTo", foreignField: "_id", as: "userInfo" },
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      {
        $lookup: { from: "teams", localField: "team", foreignField: "_id", as: "teamInfo" },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$enrollmentDate", timezone: TZ } },
          count: { $sum: 1 },
          totalFee: { $sum: { $ifNull: ["$totalFee", 0] } },
          paidAmount: { $sum: { $ifNull: ["$paidAmount", 0] } },
          pendingAmount: { $sum: { $ifNull: ["$pendingAmount", 0] } },
          enrolments: {
            $push: {
              id: "$_id",
              name: "$name",
              phone: "$phone",
              email: "$email",
              enrollmentNumber: "$enrollmentNumber",
              enrollmentDate: "$enrollmentDate",
              courseName: { $ifNull: ["$courseInfo.name", ""] },
              closedByName: { $ifNull: ["$userInfo.name", "Unassigned"] },
              teamName: { $ifNull: ["$teamInfo.name", "Unassigned"] },
              totalFee: { $ifNull: ["$totalFee", 0] },
              paidAmount: { $ifNull: ["$paidAmount", 0] },
              pendingAmount: { $ifNull: ["$pendingAmount", 0] },
              feeStatus: "$feeStatus",
              status: "$status",
            },
          },
        },
      },
      { $sort: { _id: -1 } },
      { $project: { _id: 0, date: "$_id", count: 1, totalFee: 1, paidAmount: 1, pendingAmount: 1, enrolments: 1 } },
    ]);

    type Day = {
      date: string;
      count: number;
      totalFee: number;
      paidAmount: number;
      pendingAmount: number;
      enrolments: unknown[];
    };
    const rows = days as Day[];

    // Who closed what over the whole period, which is the second question the
    // page gets asked and is cheaper to answer here than to recompute on screen.
    const byCloser = new Map<string, { name: string; count: number; totalFee: number }>();
    for (const d of rows) {
      for (const e of d.enrolments as { closedByName: string; totalFee: number }[]) {
        const cur = byCloser.get(e.closedByName) ?? { name: e.closedByName, count: 0, totalFee: 0 };
        cur.count += 1;
        cur.totalFee += e.totalFee ?? 0;
        byCloser.set(e.closedByName, cur);
      }
    }

    const todayKey = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
    const today = rows.find((d) => d.date === todayKey);

    return {
      days: rows,
      totals: {
        days: rows.length,
        count: rows.reduce((s, d) => s + d.count, 0),
        totalFee: rows.reduce((s, d) => s + d.totalFee, 0),
        paidAmount: rows.reduce((s, d) => s + d.paidAmount, 0),
        pendingAmount: rows.reduce((s, d) => s + d.pendingAmount, 0),
      },
      // Always present, so the header can say "nothing yet today" rather than
      // disappearing on a quiet morning.
      today: {
        date: todayKey,
        count: today?.count ?? 0,
        totalFee: today?.totalFee ?? 0,
      },
      leaderboard: [...byCloser.values()].sort((a, b) => b.count - a.count || b.totalFee - a.totalFee),
    };
  }

  // ── Enrolments, and what finance made of them ────────────────────────────────

  /**
   * A counsellor's own enrolments, each with the state of its invoice.
   *
   * Three things live in three places: the enrolment here, the delivery in the
   * outbox, and the approval in finance. Somebody who wants to know whether
   * their sale went through had to be given a finance login and told to go and
   * look. This joins them so the question is answered where it is asked.
   *
   * Finance is asked once for the whole page. When it cannot be reached the
   * rows still come back — without an approval state, which is the honest
   * answer rather than a wrong one.
   */
  async listEnrolments(filters: {
    mine?: string;
    userId: string;
    search?: string;
    state?: string;
    page?: string;
    limit?: string;
  }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { fetchStatusesByOrg, orgOfHandover } = await import("./financeOrgs.js");

    const page  = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(100, parseInt(filters.limit ?? "20", 10));

    // "Your enrolments" by default. Somebody looking at the whole book asks for
    // it explicitly, and still only sees what students:view already allows.
    const query: Record<string, unknown> = {};
    if (filters.mine !== "false") query.assignedTo = filters.userId;

    /*
     * Narrowed to what finance sent back, when that is what was asked for.
     *
     * Answerable here only because the outcome is now written down as the
     * outbox learns it. Filtering on what finance says live would mean asking
     * finance about every enrolment ever closed in order to show one page of
     * the few it sent back — the query would grow with the book and the answer
     * would not.
     */
    if (filters.state === "returned") {
      const sentBack = await FinanceHandover.find({ approvalState: "returned" })
        .select("studentId")
        .lean();
      query._id = { $in: sentBack.map((h) => h.studentId) };
    }

    if (filters.search?.trim()) {
      const rx = new RegExp(filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ name: rx }, { email: rx }, { phone: rx }, { enrollmentNumber: rx }];
    }

    const [students, total] = await Promise.all([
      Student.find(query)
        .sort({ enrollmentDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("course", "name amount bangalore")
        .populate("assignedTo", "name email")
        // The lead's email too: where an email for a close refused without one may come from.
        .populate("leadId", "name phone status email")
        .lean(),
      Student.countDocuments(query),
    ]);

    const ids = students.map((s) => String(s._id));
    const handovers = await FinanceHandover.find({ studentId: { $in: ids } })
      .select("studentId status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt resentAt resends academy financeOrgId payload.customer.email")
      .lean();
    const byStudent = new Map(handovers.map((h) => [String(h.studentId), h]));

    const { stepsOf } = await import("./enrolmentSteps.js");
    // Each asked of the finance organization of its academy — Dubai's or Bangalore's.
    const statuses = await fetchStatusesByOrg(
      ids,
      new Map(students.map((s) => [String(s._id), orgOfHandover(byStudent.get(String(s._id)), s.academy)])),
    );
    const byExternal = new Map(statuses.map((s) => [s.externalId, s]));

    // For each close refused for want of the client's email, the email its field
    // starts from — one finance would take that no other client here holds.
    const suggested = new Map(
      await Promise.all(
        students
          .filter((s) => refusedForEmail(byStudent.get(String(s._id))))
          .map(async (s) => [String(s._id), await suggestedEmailOf(s, (s.leadId as unknown as { email?: unknown } | null)?.email)] as const),
      ),
    );

    const rows = students.map((s) => {
      const h = byStudent.get(String(s._id));
      const f = byExternal.get(String(s._id));
      return {
        ...s,
        handover: h
          ? {
              status: h.status,
              attempts: h.attempts,
              lastError: h.lastError ?? "",
              invoiceId: h.invoiceId ?? "",
              invoiceNumber: h.invoiceNumber ?? "",
              flags: h.flags ?? [],
              sentAt: h.sentAt ?? null,
              // What the outbox last heard, as opposed to `invoice` below,
              // which is finance answering right now and may be absent.
              approvalState: h.approvalState ?? "unknown",
              returnedReason: h.returnedReason ?? "",
              returnedAt: h.returnedAt ?? null,
              // Sent again after a send-back: when last, and how many times.
              resentAt: h.resentAt ?? null,
              resends: h.resends ?? 0,
              // Refused by finance for want of the client's email: the card asks for it,
              // its field filled in with an email finance would take, where one is known
              // that no other client here holds.
              needsClientEmail: refusedForEmail(h),
              suggestedEmail: suggested.get(String(s._id)) ?? "",
            }
          : null,
        // Absent rather than guessed when finance could not be reached.
        invoice: f ?? null,
        // Its five steps — finance, LMS, CS, onboarded, MT5 bonus — green / yellow / red on the card.
        steps: stepsOf(f ?? null, h ? { status: h.status, lastError: stepError(h), approvedAt: h.approvedAt, resentAt: h.resentAt } : null),
      };
    });

    /*
     * The counts are of this page's rows, not of the whole book.
     *
     * Counting every enrolment would mean asking finance about every one of
     * them on every request. The bar says what it is counting.
     */
    const counts = {
      total,
      onThisPage: rows.length,
      approved: rows.filter((r) => r.invoice?.approval === "approved").length,
      pending: rows.filter((r) => r.invoice?.approval === "pending").length,
      // Not one already on its way back: finance still says "returned" until it arrives.
      returned: rows.filter((r) => (r.invoice?.approval ?? r.handover?.approvalState) === "returned"
        && !(r.handover?.status === "pending" && r.handover.resentAt)).length,
      notInvoiced: rows.filter((r) => !r.invoice).length,
      failed: rows.filter((r) => r.handover?.status === "failed").length,
      flagged: rows.filter((r) => (r.handover?.flags?.length ?? 0) > 0).length,
    };

    return { rows, counts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * One enrolment, for its own page: the student, what finance and the outbox
   * know of it, its five steps with who did each and when, and its commission
   * as the viewer may see it — their own lines; everyone's for a Super Admin
   * or the Sales Manager.
   *
   * The closer sees their own; anyone who may view students sees any.
   */
  async getEnrolment(id: string, viewer: { userId: string; role?: { isSystemRole?: boolean; roleName?: string; permissions?: Record<string, { view?: boolean } | undefined> } }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { CommissionSale } = await import("../models/CommissionSale.js");
    const { fetchEnrolmentStatuses } = await import("./financeClient.js");
    const { orgOfHandover } = await import("./financeOrgs.js");
    const { stepsOf } = await import("./enrolmentSteps.js");
    const { isSuperAdmin, commissionScope, canSeeLine } = await import("./commissionService.js");

    if (!Types.ObjectId.isValid(id)) throw createError("Enrolment not found", 404);
    const student = await Student.findById(id)
      .populate("course", "name amount bangalore")
      .populate("assignedTo", "name email")
      .populate("team", "name")
      .lean();
    if (!student) throw createError("Enrolment not found", 404);
    const closer = student.assignedTo && typeof student.assignedTo === "object" && "_id" in student.assignedTo
      ? String((student.assignedTo as { _id: unknown })._id)
      : String(student.assignedTo ?? "");
    const all = isSuperAdmin(viewer.role as never) || viewer.role?.permissions?.students?.view === true;
    if (closer !== viewer.userId && !all) throw createError("This enrolment isn't yours", 403);

    const h = await FinanceHandover.findOne({ studentId: student._id })
      .select("status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt resentAt resends academy financeOrgId payload.customer.email")
      .lean();
    // Asked of the organization of the academy it was closed for.
    const [st] = await fetchEnrolmentStatuses([id], orgOfHandover(h, student.academy));
    const sale = await CommissionSale.findOne({ student: student._id }).lean();
    // Whose lines this viewer sees, as on the Commission page (2026-10-23): everyone's for a Super Admin or the Sales
    // Manager; a team leader their team's but the SM's; anyone else their own.
    const scope = sale ? await commissionScope({ userId: viewer.userId, role: viewer.role as never }) : null;
    const suggestedEmail = await this.suggestedEmailFor(h, student);

    return {
      ...student,
      handover: h
        ? {
            status: h.status, attempts: h.attempts, lastError: h.lastError ?? "", invoiceId: h.invoiceId ?? "",
            invoiceNumber: h.invoiceNumber ?? "", flags: h.flags ?? [], sentAt: h.sentAt ?? null,
            approvalState: h.approvalState ?? "unknown", returnedReason: h.returnedReason ?? "", returnedAt: h.returnedAt ?? null,
            approvedAt: h.approvedAt ?? null, resentAt: h.resentAt ?? null, resends: h.resends ?? 0,
            needsClientEmail: refusedForEmail(h), suggestedEmail,
          }
        : null,
      invoice: st ?? null,
      steps: stepsOf(st ?? null, h ? { status: h.status, lastError: stepError(h), approvedAt: h.approvedAt, resentAt: h.resentAt } : null),
      commission: sale
        ? {
            state: sale.state,
            reason: sale.reason,
            month: sale.month,
            countedAt: sale.countedAt ?? null,
            lines: (sale.lines ?? [])
              .filter((l) => !!scope && canSeeLine(scope, viewer.userId, l, closer))
              .map((l) => ({ role: l.role, userName: l.userName, amount: l.amount, note: l.note ?? "" })),
          }
        : null,
    };
  }

  /**
   * Send this enrolment to finance, or send it again.
   *
   * The queue row is upserted with $setOnInsert, so a row that already exists
   * keeps the payload it was created with — the snapshot of the sale. This
   * resets the schedule instead, which is what "try again now" means for one
   * that failed or is waiting on a backoff.
   */
  async requestInvoice(studentId: string): Promise<{ queued: boolean; message: string }> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { financeConfigured } = await import("./financeClient.js");

    if (!financeConfigured()) {
      return { queued: false, message: "The finance integration is not configured" };
    }

    const student = await Student.findById(studentId).lean();
    if (!student) return { queued: false, message: "Enrolment not found" };

    const existing = await FinanceHandover.findOne({ studentId }).lean();

    /*
     * Delivered once is usually the end of it — except when finance sent it
     * back.
     *
     * Then the counsellor has corrected something and this is the correction on
     * its way. It goes with a *fresh* payload, which is the whole point: the
     * queue row holds a snapshot of the sale as it was, and resending that
     * would deliver the very figures somebody has just been asked to fix. The
     * snapshot is right for a retry after a timeout and wrong for a
     * resubmission, and the two arrive at this function looking identical.
     *
     * Finance recognises the same externalId on a returned invoice and updates
     * it rather than raising a second one, so this corrects the invoice the
     * approver already has, keeping its number.
     */
    if (existing?.status === "sent") {
      if (!(await this.sendBackOf(studentId, existing)).sentBack) {
        return { queued: false, message: `Already invoiced as ${existing.invoiceNumber ?? "an invoice"}` };
      }
      /*
       * It goes as a correction, with the client's email as the enrolment has
       * it now. One another client here holds (one email, one client —
       * 2026-10-10) is refused, as the correction refuses it: finance would
       * take it as that client's. The correction is where it is changed.
       */
      const holder = isFinanceEmail(emailKey(student.email))
        ? await findEmailHolder(student.email, { name: student.name, phone: student.phone, studentId: student._id, leadId: student.leadId })
        : null;
      if (holder) {
        return { queued: false, message: `${takenMessage(holder, student.name)} Correct the enrolment to change it, and it goes again.` };
      }
      if (!(await this.resendCorrected(studentId))) return { queued: false, message: "Enrolment not found" };
      return { queued: true, message: "Correction sent to finance" };
    }

    /*
     * Refused by finance for want of the client's email: sent again as it is,
     * it would be refused again the same way. The email is added first
     * (addEnrolmentEmail), which sends it.
     */
    if (refusedForEmail(existing)) {
      return {
        queued: false,
        message: "Finance refused this enrolment because it went without the client's email — add the client's email first, and it goes to finance again at once.",
      };
    }

    if (existing) {
      await FinanceHandover.updateOne(
        { studentId },
        { $set: { status: "pending", nextAttemptAt: new Date(), lastError: "" } },
      );
      return { queued: true, message: "Sending to finance again" };
    }

    await this.queueFinanceHandover(String(student._id), String(student.leadId ?? ""));
    return { queued: true, message: "Queued for finance" };
  }

  /**
   * Whether finance has this delivered enrolment sent back, and why — by what
   * the outbox last heard, or else by asking finance now: it may have been
   * sent back in the minute before the outbox next asks, and the screens, which
   * ask finance live, already offer the correction.
   */
  private async sendBackOf(
    studentId: string,
    h: { status?: string; approvalState?: string; returnedReason?: string; academy?: string | null; financeOrgId?: string | null } | null,
  ): Promise<{ sentBack: boolean; reason: string }> {
    if (h?.status !== "sent") return { sentBack: false, reason: "" };
    if (h.approvalState === "returned") return { sentBack: true, reason: h.returnedReason ?? "" };
    // Decided already: an approved enrolment is not sent back, so finance isn't asked.
    if (h.approvalState === "approved" || h.approvalState === "not_required") return { sentBack: false, reason: "" };
    const { fetchEnrolmentStatuses } = await import("./financeClient.js");
    const { orgOfHandover } = await import("./financeOrgs.js");
    // Of the organization it went to — Bangalore's for a Bangalore close.
    const [st] = await fetchEnrolmentStatuses([studentId], orgOfHandover(h));
    return st?.approval === "returned" ? { sentBack: true, reason: st.returnedReason ?? "" } : { sentBack: false, reason: "" };
  }

  /**
   * Send a sent-back enrolment to finance again, as it stands now.
   *
   * With a *fresh* payload, which is the whole point: the queue row holds a
   * snapshot of the sale as it was, and resending that would deliver the very
   * figures somebody has just been asked to fix. The snapshot is right for a
   * retry after a timeout and wrong for a resubmission.
   *
   * Finance recognises the same externalId on a returned invoice and updates
   * it rather than raising a second one, so this corrects the invoice the
   * approver already has, keeping its number. False when the student has gone.
   */
  private async resendCorrected(studentId: string): Promise<boolean> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const payload = await this.buildHandoverPayload(studentId);
    if (!payload) return false;
    await FinanceHandover.updateOne(
      { studentId },
      {
        $set: {
          payload,
          status: "pending",
          nextAttemptAt: new Date(),
          attempts: 0,
          lastError: "",
          // Pending again the moment it leaves, so the screen stops offering
          // "send again" for something already on its way back.
          approvalState: "pending",
          returnedReason: "",
          // So the screens can say it was sent again, and when.
          resentAt: new Date(),
        },
        $inc: { resends: 1 },
        // Cleared, so a second send-back is told about a second time.
        $unset: { returnedNotifiedAt: "", returnedAt: "" },
      },
    );
    // Out now, in the background; the worker's timer retries whatever this cannot send.
    const { kickFinanceHandover } = await import("./financeHandoverWorker.js");
    kickFinanceHandover();
    return true;
  }

  // ── Correcting what finance sent back ────────────────────────────────────────

  /**
   * The enrolment, if this viewer may correct it: the closer their own; anyone
   * who may edit students — or a super admin — any, and only they may move a
   * sale to another counsellor or team (`mayMove`).
   */
  private async correctable(id: string, viewer: { userId: string; role?: IRole | null }) {
    const { isSuperAdmin } = await import("./commissionService.js");
    if (!Types.ObjectId.isValid(id)) throw createError("Enrolment not found", 404);
    const student = await Student.findById(id);
    if (!student) throw createError("Enrolment not found", 404);
    const mayMove = isSuperAdmin(viewer.role) || viewer.role?.permissions?.students?.edit === true;
    if (String(student.assignedTo ?? "") !== viewer.userId && !mayMove) {
      throw createError("This enrolment isn't yours to correct", 403);
    }
    return { student, mayMove };
  }

  /** What the lead holds of its own, in fils: every payment on it but the ones the close recorded. */
  private async ownOnLead(leadId: unknown): Promise<number> {
    const lead = await Lead.findById(leadId).select("payments").lean();
    return (lead?.payments ?? []).filter((p) => !fromTheClose(p.note)).reduce((s, p) => s + minor(p.amount), 0);
  }

  /**
   * What the correction form starts from: the enrolment as it stands, whether
   * finance has it sent back and why, the money the lead holds of its own — a
   * payment of its own on the form, at that figure, as at the close — and, for
   * whoever may move a sale, the counsellors and teams it may move to.
   */
  async getCorrection(id: string, viewer: { userId: string; role?: IRole | null }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { student, mayMove } = await this.correctable(id, viewer);
    const h = await FinanceHandover.findOne({ studentId: student._id }).lean();
    const { sentBack, reason } = await this.sendBackOf(id, h);
    let options = {};
    if (mayMove) {
      const { Team } = await import("../models/Team.js");
      const { User } = await import("../models/User.js");
      const [counsellors, teams] = await Promise.all([
        User.find({ status: "active" }).select("name").sort({ name: 1 }).lean(),
        Team.find({ status: "active" }).select("name").sort({ name: 1 }).lean(),
      ]);
      options = { counsellors, teams };
    }
    return {
      sentBack,
      returnedReason: reason,
      invoiceNumber: h?.invoiceNumber ?? "",
      // What became of it otherwise: sent again, and when; approved or waiting.
      approvalState: h?.approvalState ?? "unknown",
      resentAt: h?.resentAt ?? null,
      resends: h?.resends ?? 0,
      // Never reached finance because it went without the client's email — the
      // student page asks for it (addEnrolmentEmail) rather than a correction.
      deliveryStatus: h?.status ?? null,
      needsClientEmail: refusedForEmail(h),
      suggestedEmail: await this.suggestedEmailFor(h, student),
      mayMove,
      // The academy it is for — changeable while sent back (2026-10-26), to those this server offers.
      academy: academyOf(student),
      academies: (await import("./financeClient.js")).academiesOffered(),
      // In AED, the lead's own currency — on a Bangalore correction, given with its rate to INR.
      ownOnLead: (await this.ownOnLead(student.leadId)) / 100,
      ...options,
      student: await this.populateStudent(id),
    };
  }

  /**
   * Correct an enrolment finance sent back, and send it again — one step (the
   * user, 2026-10-05: "if send it back we can edit the course and amount, all
   * details"). Everything the close took can change: the client's name, phone
   * and email, the course, the date, the fee, each payment with its receipt,
   * the language, the bonus and the notes — and, for whoever may edit
   * students, who closed it and for which team. It is checked as a close is,
   * and then goes to finance as the correction of the invoice it sent back:
   * the same invoice, the same number.
   *
   * Only while finance has it sent back. An enrolment waiting for approval, or
   * approved, is not rewritten from here.
   *
   * The closer corrects their own; anyone who may edit students, any.
   */
  async correctEnrolment(
    id: string,
    data: EnrolmentCorrection,
    viewer: { userId: string; role?: IRole | null },
  ): Promise<{ student: unknown; message: string }> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { Course } = await import("../models/Course.js");
    const { Team } = await import("../models/Team.js");
    const { User } = await import("../models/User.js");

    const { student, mayMove } = await this.correctable(id, viewer);

    const h = await FinanceHandover.findOne({ studentId: student._id }).lean();
    if (!(await this.sendBackOf(id, h)).sentBack) {
      throw createError(
        "Finance hasn't sent this enrolment back, so there is nothing to correct. A change once it is approved goes through finance.",
        409,
      );
    }

    // Asked for all at once and refused as one list, as the close does.
    const name = String(data.name ?? "").trim();
    const phone = String(data.phone ?? "").trim();
    const email = String(data.email ?? "").trim().toLowerCase();
    const enrolledOn = data.enrollmentDate ? new Date(data.enrollmentDate) : null;
    const totalFee = data.totalFee === "" || data.totalFee === null ? NaN : Number(data.totalFee);
    const paidAmount = Number(data.paidAmount ?? NaN);
    const missing: string[] = [];
    if (!name) missing.push("the client's name");
    if (!phone) missing.push("the client's phone");
    if (!isFinanceEmail(email)) missing.push("the client's email");
    if (typeof data.course !== "string" || !Types.ObjectId.isValid(data.course)) missing.push("a course");
    if (!enrolledOn || Number.isNaN(enrolledOn.getTime())) missing.push("the enrolment date");
    if (!Number.isFinite(totalFee) || totalFee < 0) missing.push("the fee");
    if (!Number.isFinite(paidAmount) || paidAmount < 0) missing.push("what was paid");
    if (!ENROLMENT_LANGUAGES.includes(data.language as EnrolmentLanguage)) missing.push("language");
    if (typeof data.hasBonus !== "boolean") missing.push("whether a bonus was given");
    else if (data.hasBonus && !isBonusAmount(data.bonusAmount)) missing.push("the bonus amount");
    if (missing.length) throw createError(`A correction needs ${missing.join(", ")}.`, 422);

    /*
     * The client's own email (one email, one client — 2026-10-10). Finance
     * keeps the customer by email: corrected with an address another client
     * here holds, this enrolment would be filed under them — or, kept with one
     * it shared, rename them. Refused, naming them; the client as corrected
     * is who is compared.
     */
    const holder = await findEmailHolder(email, { name, phone, studentId: student._id, leadId: student.leadId });
    if (holder) throw emailTaken(holder, name);

    /*
     * The academy (the user, 2026-10-26: "when it is sent back we can change the location when correcting it"):
     * kept unless changed. Changed, the money below is in the new academy's currency and the correction goes to
     * that academy's finance organization — finance makes it there and voids the one it sent back here.
     */
    const was = academyOf(student);
    const academy = data.academy === undefined || data.academy === null || data.academy === "" ? was : data.academy;
    if (!isAcademy(academy)) throw createError(`"${String(data.academy)}" isn't an academy — choose Dubai or Bangalore.`, 422);
    const moving = academy !== was;
    if (moving && academy === "bangalore") await this.assertBangaloreClose(data.course);
    const base = ACADEMY_CURRENCY[academy];

    const course = await Course.findById(data.course).select("name bangalore").lean();
    if (!course) throw createError("That course no longer exists — choose another.", 422);
    if (academy === "bangalore" && !this.hasBangalorePrice(course)) {
      throw createError(`${course.name} has no Bangalore price — choose a course sold in Bangalore, or set its price on Courses → Map.`, 422);
    }

    // Who closed it, and for which team: kept unless somebody who may edit
    // students moves it.
    const idOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);
    const team = data.team === undefined ? String(student.team ?? "") || null : idOrNull(data.team);
    const closer = data.assignedTo === undefined ? String(student.assignedTo ?? "") || null : idOrNull(data.assignedTo);
    if ((team ?? "") !== String(student.team ?? "") || (closer ?? "") !== String(student.assignedTo ?? "")) {
      if (!mayMove) throw createError("Only someone who may edit students can move a sale to another counsellor or team.", 403);
      if (team && (!Types.ObjectId.isValid(team) || !(await Team.exists({ _id: team })))) {
        throw createError("That team no longer exists — choose another.", 422);
      }
      if (closer && (!Types.ObjectId.isValid(closer) || !(await User.exists({ _id: closer })))) {
        throw createError("That counsellor no longer exists — choose another.", 422);
      }
    }

    const payments = checkedPayments(data.payments, paidAmount, enrolledOn!, base);
    if (!payments) throw createError("A correction needs its payments, each with its method, amount and receipt.", 422);

    /*
     * The money the lead held of its own — every payment on it but the ones the
     * close recorded — is a payment of its own here, as at the close, and at
     * what it comes to now: the close's own payments on the lead are about to
     * be replaced by these, and the two must not count the same money twice
     * or lose any.
     */
    const own = await this.ownOnLead(student.leadId);
    const ownRows = payments.filter((p) => p.collectedBefore);
    // The lead's own money is in AED; on a Bangalore correction its row is in
    // INR, with the AED it came from beside it — that is what is compared.
    const ownAed = (p: IStudentPayment) => (academy === "bangalore" ? p.amountInCurrency ?? 0 : p.amount);
    const inAed = academy === "bangalore" ? ` ${BASE_CURRENCY}` : "";
    // One row per lead payment with its method and receipt (2026-10-23), so there may be several — together, what the
    // lead holds.
    const ownGiven = ownRows.reduce((sum, p) => sum + ownAed(p), 0);
    if (own > 0 && !ownRows.length) {
      throw createError(
        `This lead already holds ${money(own / 100)}${inAed} of its own — it stays as a payment of its own, with its method and receipt.`,
        422,
      );
    }
    if (ownRows.length && minor(ownGiven) !== own) {
      throw createError(
        `The lead's own payments come to ${money(own / 100)}${inAed} now, not ${money(ownGiven)}${inAed} — they changed while this was open. Close the correction and open it again.`,
        409,
      );
    }

    student.set({
      name,
      phone,
      email,
      course: course._id,
      team,
      assignedTo: closer,
      enrollmentDate: enrolledOn,
      totalFee,
      paidAmount,
      pendingAmount: Math.max(0, totalFee - paidAmount),
      feeStatus: this.computeFeeStatus(totalFee, paidAmount, data.feeStatus),
      ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
      language: data.language,
      // The first payment's, for whatever reads only one; every one below.
      paymentMethod: payments[0]!.method,
      paymentReceipt: payments[0]!.receipt,
      payments,
      hasBonus: data.hasBonus,
      bonusAmount: data.hasBonus ? Number(data.bonusAmount) : 0,
      ...(moving ? { academy } : {}),
    });
    await student.save();

    // Moved academy: the row is sent to that academy's finance organization from now on.
    if (moving) {
      const { financeOrgOf } = await import("./financeClient.js");
      const financeOrgId = financeOrgOf(academy);
      await FinanceHandover.updateOne({ studentId: student._id }, { $set: { academy, ...(financeOrgId ? { financeOrgId } : {}) } });
    }

    /*
     * The lead's payment list follows: what the close recorded there is
     * replaced by the payments as corrected, so the lead and the enrolment
     * keep counting the same money — the lead's own payments are left as they
     * are. Not worth failing the correction over; it says so instead.
     */
    let leadNote = "";
    try {
      const lead = await Lead.findById(student.leadId).select("payments").lean();
      if (lead) {
        const kept = (lead.payments ?? []).filter((p) => !fromTheClose(p.note));
        // As the close writes them: every payment for Dubai, in AED; for
        // Bangalore only what was handed over in AED (leadPaymentOf).
        const taken = payments.filter((p) => !p.collectedBefore).flatMap((p) => {
          const onLead = leadPaymentOf(p, academy, course.name);
          return onLead ? [{ ...onLead, paidAt: p.paidAt, addedBy: new Types.ObjectId(viewer.userId) }] : [];
        });
        await Lead.updateOne({ _id: lead._id }, { $set: { payments: [...kept, ...taken] } });
      }
    } catch (err) {
      console.error(`[enrolments] could not bring the lead's payments in line with corrected enrolment ${id}`, err);
      leadNote = " The lead's own payment list could not be updated — check it on the lead.";
    }

    await this.resendCorrected(id);
    const movedNote = moving ? ` It moves to the ${ACADEMY_LABELS[academy]} academy's books.` : "";
    return { student: await this.populateStudent(id), message: `Corrected and sent to finance.${movedNote}${leadNote}` };
  }

  // ── A close that went without the client's email ─────────────────────────────

  /**
   * The email to start the "add the client's email" field from, for a close
   * finance refused for want of one (suggestedEmailOf): the enrolment's, else
   * the lead's — never one another client here holds. "" for any other.
   */
  private async suggestedEmailFor(
    h: HandoverForEmail,
    student: { _id: unknown; name?: unknown; phone?: unknown; email?: unknown; leadId?: unknown },
  ): Promise<string> {
    if (!refusedForEmail(h)) return "";
    const leadId = student.leadId;
    const lead = leadId && Types.ObjectId.isValid(String(leadId)) ? await Lead.findById(leadId).select("email").lean() : null;
    return suggestedEmailOf(student, lead?.email);
  }

  /**
   * Add the client's email to a close finance refused for want of it, and
   * send it again (2026-10-10).
   *
   * Closes used to be taken without an email; finance's intake refuses those,
   * permanently, and the correction can't reach them — it is for an
   * enrolment finance has and sent back, and these it never had. So: the
   * email is checked as the close checks it, written on the enrolment, on the
   * lead (where it had none, with an activity entry) and into the queued
   * payload — only the email: the rest is the snapshot of the sale as it was —
   * and the row goes back in the queue at once, its tries reset. It is the
   * same enrolment (the same externalId) going to the same finance
   * organization written on its row at the close, so finance raises its
   * invoice as if it had been right the first time.
   *
   * Only for a close not yet delivered whose email is missing or not one:
   * refused by finance for it, or still waiting to go. Never one finance
   * already has — that is changed through a correction, once finance sends it
   * back — nor one held up by something else, which an email would not fix.
   *
   * Who may: as for a correction — the closer their own; anyone who may edit
   * students, any.
   */
  async addEnrolmentEmail(
    id: string,
    rawEmail: unknown,
    viewer: { userId: string; role?: IRole | null },
  ): Promise<{ email: string; message: string }> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");

    const { student } = await this.correctable(id, viewer);

    const email = String(rawEmail ?? "").trim().toLowerCase();
    if (!isFinanceEmail(email)) {
      throw createError("That isn't an email finance will take — give the client's whole address, like name@example.com.", 422);
    }

    const h = await FinanceHandover.findOne({ studentId: student._id }).lean();
    if (!h) {
      throw createError("This enrolment isn't waiting on finance — there is nothing to send again with an email.", 409);
    }
    if (h.status === "sent") {
      throw createError(
        `Finance already has this enrolment${h.invoiceNumber ? ` as ${h.invoiceNumber}` : ""}, so its email isn't changed from here. If finance sends it back, correct it then.`,
        409,
      );
    }
    if (!emailCanBeAdded(h)) {
      throw createError(
        `This enrolment wasn't held up by the client's email${h.lastError ? ` — finance said: ${h.lastError}` : ""}. An email won't fix it: send it again, or ask an admin to look.`,
        409,
      );
    }
    // The client's own (one email, one client — 2026-10-10): not one another client here holds.
    const holder = await findEmailHolder(email, { name: student.name, phone: student.phone, studentId: student._id, leadId: student.leadId });
    if (holder) throw emailTaken(holder, student.name);

    // Conditional, so a row that reached finance a moment ago is left as it is.
    const reset = await FinanceHandover.updateOne(
      { _id: h._id, status: { $ne: "sent" } },
      {
        $set: {
          "payload.customer.email": email,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: "",
        },
      },
    );
    if (!reset.matchedCount) throw createError("Finance took this enrolment a moment ago — refresh to see it.", 409);

    await Student.updateOne({ _id: student._id }, { $set: { email } });
    await this.keepEmailOnLead(student.leadId, email, viewer.userId, "for finance");

    // Out now, in the background — to the organization written on the row at the close.
    const { kickFinanceHandover } = await import("./financeHandoverWorker.js");
    kickFinanceHandover();

    return { email, message: "Email added — sending it to finance again." };
  }

  // ── One email, one client ────────────────────────────────────────────────────

  /**
   * Whether an email is already another client's here (2026-10-10), for the
   * close dialog, the correction and the add-email box to say so before
   * anything is saved: `{ ok: true }`, or `{ ok: false, takenBy, message }` —
   * the refusal the server would give, naming the holder (never their phone).
   *
   * Asked for a client: the lead being closed (`leadId`) or the enrolment
   * (`studentId`) — who is compared, and whose own records don't count. Only a
   * help: the close, the correction and the add-email refuse a taken email
   * whatever this said.
   */
  async checkClientEmail(
    rawEmail: unknown,
    who: { leadId?: unknown; studentId?: unknown },
  ): Promise<{ ok: boolean; takenBy?: { name: string; code?: string; kind: EmailHolder["kind"] }; message?: string }> {
    const email = emailKey(rawEmail);
    if (!isFinanceEmail(email)) throw createError("That isn't an email finance will take.", 422);
    const given = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    const studentId = given(who.studentId);
    const leadId = given(who.leadId);
    if (!studentId && !leadId) throw createError("Say whose email it is: the lead being closed (leadId) or the enrolment (studentId).", 422);

    let client: { name?: unknown; phone?: unknown; studentId?: unknown; leadId?: unknown };
    if (studentId) {
      const s = Types.ObjectId.isValid(studentId) ? await Student.findById(studentId).select("name phone leadId").lean() : null;
      if (!s) throw createError("Enrolment not found", 404);
      client = { name: s.name, phone: s.phone, studentId: s._id, leadId: s.leadId };
    } else {
      const l = Types.ObjectId.isValid(leadId) ? await Lead.findById(leadId).select("name phone").lean() : null;
      if (!l) throw createError("Lead not found", 404);
      client = { name: l.name, phone: l.phone, leadId: l._id };
    }

    const holder = await findEmailHolder(email, client);
    if (!holder) return { ok: true };
    return {
      ok: false,
      takenBy: { name: holder.name, ...(holder.code ? { code: holder.code } : {}), kind: holder.kind },
      message: takenMessage(holder, client.name),
    };
  }

}
