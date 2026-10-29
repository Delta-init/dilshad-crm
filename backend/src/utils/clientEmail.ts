import { z } from "zod";

/*
 * One email, one client (the user, 2026-10-10).
 *
 * Finance knows a customer by the email alone: within an organization the
 * first close with an address makes the customer, and every later close with
 * it is filed under them, whatever name and phone it carries. Four different
 * students were closed here with one address — and 23 leads carry it — so
 * finance filed all four invoices under the first. An email is therefore
 * "taken" for a client when another record in this CRM holds it — a student,
 * or a lead — and that record is a different person.
 *
 * Pure, with no models: the read-only report script shares the rule.
 */

/*
 * The client's email, checked as finance checks it.
 *
 * Finance's intake refuses an enrolment whose `customer.email` fails its
 * `z.string().email()` (zod 3 there). Zod 4's `z.email()` here is the same
 * pattern (`z.regexes.email`) — so an address that only looks like one, such
 * as `a@b.c`, is refused at the close and at a correction rather than saved
 * here and then refused by finance, out of sight. Checked as given: finance
 * trims nothing.
 */
const financeEmail = z.email();
export const isFinanceEmail = (v: unknown): boolean => typeof v === "string" && financeEmail.safeParse(v).success;
/** The same pattern, for a database filter. */
export const FINANCE_EMAIL_RE = z.regexes.email;

/** An email as compared: trimmed and lower-cased — exact otherwise. */
export const emailKey = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Fewer digits than this is no phone number — "0", "N/A", "-" — and counts as no phone. */
const MIN_PHONE_DIGITS = 7;

/**
 * A phone as compared: its last nine digits, so "+971 50 123 4567",
 * "0501234567" and "971501234567" are one number. "" when it has too few
 * digits to be one.
 */
export function phoneKey(v: unknown): string {
  const digits = typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
  return digits.length >= MIN_PHONE_DIGITS ? digits.slice(-9) : "";
}

/** A name as compared: case and spaces aside. "" when there is none. */
export const nameKey = (v: unknown): string => (typeof v === "string" ? v.toLowerCase().replace(/\s+/g, "") : "");

/** Whoever a record is: as much as there is of a name and a phone. */
export interface Person {
  name?: unknown;
  phone?: unknown;
}

/**
 * Whether two records are different people: both phones known and their last
 * nine digits differ — and, when either phone is missing, their names differ
 * (case and spaces aside). The same phone is the same person: a second course
 * is ordinary. With nothing to go on — no phone on one side, no name on one —
 * they are not known to differ, and are not called different.
 */
export function differentPeople(a: Person, b: Person): boolean {
  const pa = phoneKey(a.phone);
  const pb = phoneKey(b.phone);
  if (pa && pb) return pa !== pb;
  const na = nameKey(a.name);
  const nb = nameKey(b.name);
  return Boolean(na && nb) && na !== nb;
}

/** A filter value matching a stored email as compared: exactly, case and surrounding spaces aside. */
export function emailMatch(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
}

/** "na***@gmail.com": the first two characters and the domain — for a report that must not print whole addresses. */
export function maskEmail(key: string): string {
  const at = key.lastIndexOf("@");
  if (at < 0) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, Math.min(2, at))}***${key.slice(at)}`;
}

/*
 * A made-up email (the user, 2026-10-29): noemail@gmail.com and the like, typed
 * when the client gave none. Finance and the CS Portal tell clients apart by
 * their email, so two closes with one such address became one client — Najad
 * Ahmed's invoice and his $500 bonus went to Mohammed Lebbie. Refused wherever
 * a taken email is: it stands for nobody, so it is everybody's.
 */
const MADE_UP_NAME =
  /^(no[-_.]?e?[-_.]?mails?([-_.]?id)?|no[-_.]?mail[-_.]?address|none|nil|null|na|n[-_.]a|not[-_.]?available|not[-_.]?given|unknown|dummy|test(ing)?|example|sample|fake|abc|xyz|asdf|no[-_.]?reply|nothing)[-_.]?\d*$/;
const MADE_UP_DOMAIN = /^(noemail|nomail|no-email)\.com$/;

/** Whether an email is a made-up one: its name before the @ (noemail, none, na, test…) or its domain (noemail.com). */
export function madeUpEmail(v: unknown): boolean {
  const key = emailKey(v);
  const at = key.lastIndexOf("@");
  if (at <= 0) return false;
  return MADE_UP_NAME.test(key.slice(0, at)) || MADE_UP_DOMAIN.test(key.slice(at + 1));
}

/** Another client holding an email: a student (with its code) or a lead — or, for a made-up one, nobody (`name` is the email). */
export interface EmailHolder {
  kind: "student" | "lead" | "made_up";
  id: string;
  name: string;
  /** The student's code, STU-…; absent for a lead. */
  code?: string;
}

/**
 * The refusal, naming who holds the email — never their phone:
 * "This email is already used by mohammed lebbie (STU-0021), a different
 * client — enter Halif's own email." A lead is named as one: "… by Rahul K
 * (a lead), …".
 */
export function takenMessage(holder: EmailHolder, clientName?: unknown): string {
  if (holder.kind === "made_up") {
    const client = typeof clientName === "string" ? clientName.trim() : "";
    return `${holder.name} is a made-up email — enter ${client ? `${client}'s` : "the client's"} own email. Finance and the CS Portal tell clients apart by their email, so a made-up one makes different clients one.`;
  }
  const name = typeof holder.name === "string" ? holder.name.trim() : "";
  const who = holder.kind === "student"
    ? `${name || "another student"}${holder.code ? ` (${holder.code})` : ""}`
    : name ? `${name} (a lead)` : "another lead";
  const client = typeof clientName === "string" ? clientName.trim() : "";
  return `This email is already used by ${who}, a different client — enter ${client ? `${client}'s` : "the client's"} own email.`;
}
