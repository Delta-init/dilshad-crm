import { z } from "zod";
import type { User } from "@/types";
import type { Course } from "@/types/course";
import type { Team } from "@/types/team";
import type { InitialLeadResponse, PrimaryConcern, FollowupStrategyType } from "@/types/lead";

export type StudentStatus  = "active" | "inactive" | "graduated" | "dropped";
export type FeeStatus      = "paid" | "partial" | "pending";

export interface Student {
  _id: string;
  enrollmentNumber: string;
  name: string;
  phone?: string;
  email?: string;
  course?: Course | string | null;
  team?:   Team   | string | null;
  assignedTo?: User | string | null;
  leadId?: { _id: string; name: string; phone?: string; status: string } | string | null;

  initialLeadResponse?:  InitialLeadResponse  | null;
  primaryConcern?:       PrimaryConcern        | null;
  followupStrategyType?: FollowupStrategyType  | null;
  demoScheduled: boolean;
  demoAttended:  boolean;
  firstContactTime?: string | null;
  lastFollowupDate?: string | null;

  enrollmentDate: string;
  feeStatus:      FeeStatus;
  /** In the academy's currency — AED for Dubai, INR for Bangalore — as are paidAmount and pendingAmount. */
  totalFee:       number;
  paidAmount:     number;
  pendingAmount:  number;
  /** Which academy it was closed for; absent on enrolments from before, which are Dubai (academyOf). */
  academy?: Academy;
  status:         StudentStatus;
  notes?: string;
  /** Taken at the close, and required there. Absent on older enrolments. */
  language?: string;
  paymentMethod?: string;
  paymentReceipt?: { name: string; url: string; key: string; size?: number; mimeType?: string } | null;
  /** Each payment taken at the close, when the client paid in more than one way. Absent on older enrolments. */
  payments?: StudentPayment[];
  /** Whether a bonus was given at the close. Absent on enrolments from before it was asked. */
  hasBonus?: boolean | null;
  /** The bonus, in the fee's currency; 0 when none. Never part of the balance. */
  bonusAmount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudentFilters {
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
  page?: number;
  limit?: number;
}

export interface CreateStudentInput {
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
  status?: StudentStatus;
  feeStatus?: FeeStatus;
  totalFee?: number;
  paidAmount?: number;
  notes?: string;
  language?: string;
  paymentMethod?: string;
  paymentReceipt?: { name: string; url: string; key: string; size?: number; mimeType?: string } | null;
  /** Each payment taken now (and the money already on the lead, as one). They add up to paidAmount. */
  payments?: StudentPayment[];
  hasBonus?: boolean;
  bonusAmount?: number;
  /** Which academy it is closed for — Dubai unless said. */
  academy?: Academy;
}

/**
 * Whether finance would take this as the client's email — its intake's own
 * check (zod's `z.string().email()`), which refuses an enrolment without one,
 * and the one the server makes at the close, at a correction and when an email
 * is added to a close finance refused for want of one. So `a@b.c`, which only
 * looks like an email, is asked for again here rather than refused there.
 * Trimmed first, as what is sent is.
 */
const financeEmail = z.string().email();
export const isFinanceEmail = (v: string | null | undefined): boolean => financeEmail.safeParse((v ?? "").trim()).success;

/**
 * What a course is taught in, and how the money came in.
 *
 * Fixed lists, not typed boxes. Finance already holds enrolments whose language
 * reads "MALAYALAM", "Malayalam" and "malayalam" — three answers to one
 * question, which nothing can count across. The payment methods are spelled the
 * way finance spells them, because the value is sent straight into its
 * `declaredPaymentMethod` and a mismatch is refused at the far end.
 */
export const ENROLMENT_LANGUAGES = ["English", "Malayalam", "Hindi/Urdu", "Tamil"] as const;
export type EnrolmentLanguage = (typeof ENROLMENT_LANGUAGES)[number];

export const ENROLMENT_PAYMENT_METHODS = [
  "cash", "bank_transfer", "cheque", "card",
  "easebuzz_emi", "tabby", "tamara", "billexpro",
  // Rupees into the INR account (the user, 2026-10-13) — finance's "INR Bank Account".
  "inr_bank_account",
] as const;
export type EnrolmentPaymentMethod = (typeof ENROLMENT_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<EnrolmentPaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
  card: "Card",
  easebuzz_emi: "Easebuzz EMI",
  tabby: "Tabby",
  tamara: "Tamara",
  billexpro: "BillExPro",
  inr_bank_account: "INR Transfer",
};

/** A receipt, once it is in storage. */
export interface StoredReceipt {
  name: string;
  url: string;
  key: string;
  size?: number;
  mimeType?: string;
}

/**
 * One payment taken at the close — a client may pay part in cash and part by
 * card, each with its own receipt. They add up to the enrolment's paidAmount.
 */
export interface StudentPayment {
  method: string;
  /** In the academy's currency (AED for Dubai, INR for Bangalore) — converted, when the client paid in another. */
  amount: number;
  receipt: StoredReceipt;
  paidAt: string;
  /** The money already on the lead before the close, as one payment. */
  collectedBefore?: boolean;
  /** Paid in another currency than the academy's: which, how much of it, and 1 of it = `exchangeRate` of the academy's. */
  currency?: string;
  amountInCurrency?: number;
  exchangeRate?: number;
}

/**
 * The currency the fees are in — Delta HQ's, which finance bills in. A payment
 * taken in another is converted to it at the close (the owner, 2026-10-05).
 * Also the currency of a lead's own payments, whichever academy it closes for.
 */
export const BASE_CURRENCY = "AED";

/**
 * Which academy a close is for (the user, 2026-10-10): Dubai — what every close
 * was until then — or Bangalore, billed in Bangalore's finance organization in
 * INR. Picked in the close dialog and fixed from then on.
 */
export const ACADEMIES = ["dubai", "bangalore"] as const;
export type Academy = (typeof ACADEMIES)[number];
export const ACADEMY_LABELS: Record<Academy, string> = { dubai: "Dubai", bangalore: "Bangalore" };
/** What each academy's fees are in. */
export const ACADEMY_CURRENCY: Record<Academy, "AED" | "INR"> = { dubai: "AED", bangalore: "INR" };
/** An enrolment's academy — Dubai when it says none (one from before there was a choice). */
export const academyOf = (v: { academy?: string | null } | null | undefined): Academy =>
  v?.academy === "bangalore" ? "bangalore" : "dubai";
