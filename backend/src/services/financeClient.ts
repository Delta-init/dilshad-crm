import crypto from "node:crypto";
import { env } from "../config/env.js";
import { signRequest } from "../utils/signing.js";

/**
 * Calling Delta Finance.
 *
 * The same signed protocol finance uses to call HRMS, pointed at finance: a
 * canonical string over method, path, timestamp, nonce and a body digest. The
 * body is signed as the exact bytes that go on the wire, so it is serialised
 * once here and never re-serialised.
 */

const TIMEOUT_MS = 15_000;

export function financeConfigured(): boolean {
  return Boolean(
    env.FINANCE_API_URL &&
      env.FINANCE_CLIENT_ID &&
      env.FINANCE_INTEGRATION_SECRET &&
      env.FINANCE_ORG_ID,
  );
}

/**
 * The finance organization a close for this academy is billed in (2026-10-10):
 * Dubai's (FINANCE_ORG_ID) — as every close was before there was a choice —
 * or Bangalore's (FINANCE_ORG_ID_BANGALORE). "" when that one isn't set.
 */
export function financeOrgOf(academy?: string | null): string {
  return academy === "bangalore" ? env.FINANCE_ORG_ID_BANGALORE : env.FINANCE_ORG_ID;
}

/**
 * The academies a close can be made for on this server, as the close dialog is
 * told (GET /students/close-options): Bangalore only once its finance
 * organization is set. The dialog shows its Academy choice only when Bangalore
 * is listed — so a new screen on a server that can't bill Bangalore (or an
 * older API that lists nothing) never offers it, and closes as Dubai.
 */
export function academiesOffered(): ("dubai" | "bangalore")[] {
  return env.FINANCE_ORG_ID_BANGALORE ? ["dubai", "bangalore"] : ["dubai"];
}

/** Trailing slashes and a trailing /api/v1 both stripped: the path carries it. */
function baseUrl(): string {
  return env.FINANCE_API_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

export interface FinanceItem {
  id: string;
  name: string;
  sku: string;
  unitPriceMinor: number;
  type: string;
}

export interface EnrolmentResult {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  duplicate: boolean;
  flags: string[];
}

/**
 * Hand an enrolment over.
 *
 * Throws on anything that is not a 2xx, so the caller can decide whether to
 * retry. A 4xx will fail the same way every time — a malformed payload does not
 * become valid by being sent again — so the worker stops retrying those.
 */
export async function sendEnrolment(payload: unknown, orgId: string = env.FINANCE_ORG_ID): Promise<EnrolmentResult> {
  if (!financeConfigured()) {
    throw Object.assign(new Error("Finance integration is not configured"), { permanent: true });
  }
  // Never sent to some other organization instead: a Bangalore close with no
  // Bangalore organization set waits here, saying so, until it is set.
  if (!orgId) {
    throw Object.assign(new Error("The finance organization for this academy is not configured"), { permanent: false });
  }

  const path = "/api/v1/integrations/enrolments";
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(
    env.FINANCE_INTEGRATION_SECRET,
    "POST",
    path,
    timestamp,
    nonce,
    raw,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
        "x-delta-org": orgId,
      },
      body: raw,
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: EnrolmentResult;
      error?: { message?: string };
    };

    if (!res.ok) {
      const err = Object.assign(
        new Error(body.error?.message ?? `Finance returned ${res.status}`),
        // 4xx is our fault and will not fix itself. 401 is the exception: a
        // clock that has drifted, or a secret rotated mid-flight, is worth
        // retrying rather than abandoning the enrolment over.
        { permanent: res.status >= 400 && res.status < 500 && res.status !== 401 },
      );
      throw err;
    }
    if (!body.data) throw new Error("Finance returned no result");
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The finance catalogue, for the course mapping screen.
 *
 * Signed like everything else. Read-only and small, so it is fetched on demand
 * rather than mirrored — a copy of somebody else's catalogue is a copy that
 * goes stale, which is the problem this integration exists to remove.
 */
export async function listFinanceItems(orgId: string = env.FINANCE_ORG_ID): Promise<FinanceItem[]> {
  if (!financeConfigured() || !orgId) return [];

  const path = "/api/v1/integrations/items";
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(env.FINANCE_INTEGRATION_SECRET, "GET", path, timestamp, nonce, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: {
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
        "x-delta-org": orgId,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Finance returned ${res.status}`);
    const body = (await res.json()) as { data?: FinanceItem[] };
    return body.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export interface EnrolmentStatus {
  externalId: string;
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  /** pending | approved | returned | not_required */
  approval: string;
  returnedReason: string;
  issueDate: string;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  /**
   * Once approved, what the Delta LMS made of the student — and who looks after
   * them in CS Portal (code, CS, CS team). Passed on to My Enrolments as
   * finance gives it; absent from a finance before it said.
   */
  lms?: { state: string; detail?: string; courses: string[] } | null;
  commission?: {
    state: string; detail?: string; code?: string; cs?: string; team?: string; live?: boolean;
    /** Their welcome went (CS Portal onboarded them); absent when it couldn't be asked. */
    onboarded?: { done: boolean; at?: string; by?: string };
    /**
     * The MT5 bonus promised at this close and its broker-admin approval: none (no bonus —
     * nothing to approve), not_requested, pending, approved, rejected, or unknown.
     */
    bonus?: { state: string; amount?: number; currency?: string; at?: string; by?: string; reason?: string };
  } | null;
}

/**
 * What became of enrolments already handed over.
 *
 * The outbox remembers that finance took the enrolment and what it called the
 * invoice. It cannot know that somebody in accounts approved it an hour later,
 * so a counsellor asking "was my sale accepted" could only be sent to finance
 * to look. This is that answer, asked for in one call for a whole page rather
 * than one per row.
 *
 * Never throws. A page of enrolments is still worth showing when finance is
 * restarting — the rows simply cannot say what happened to them yet, which is
 * the truth at that moment.
 *
 * One organization per call: finance answers only for its own. Enrolments of
 * both academies are asked about through financeOrgs.fetchStatusesByOrg, which
 * groups them by the organization each was billed in.
 */
export async function fetchEnrolmentStatuses(studentIds: string[], orgId: string = env.FINANCE_ORG_ID): Promise<EnrolmentStatus[]> {
  if (!financeConfigured() || studentIds.length === 0 || !orgId) return [];

  const path = "/api/v1/integrations/enrolments/status";
  const raw = JSON.stringify({ source: "crm", externalIds: studentIds.slice(0, 200) });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(
    env.FINANCE_INTEGRATION_SECRET,
    "POST",
    path,
    timestamp,
    nonce,
    raw,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
        "x-delta-org": orgId,
      },
      body: raw,
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { data?: EnrolmentStatus[] };
    return body.data ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** What finance adds to an enrolment's status for the Balance payments page (2026-10-13). */
export interface BalanceFields {
  course?: string;
  nextDueOn?: string;
  payments?: { amountMinor: number; paidOn: string; method: string; receiptNumber?: string }[];
  balancePayments?: FinanceBalancePayment[];
}

/** A balance payment this CRM sent, as finance answers for it. */
export interface FinanceBalancePayment {
  externalId: string;
  amountMinor: number;
  currency: string;
  method: string;
  paidOn: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  decidedAt?: string;
  decidedBy?: string;
  receiptNumber?: string;
}

/** Finance refused a balance payment, or could not be reached: `status` is its HTTP answer (0 when unreachable). */
export class FinanceRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * Hand finance the next payment of a part-paid enrolment (the user,
 * 2026-10-13), with its receipt: it waits there for accounts to approve it.
 * Idempotent on `externalId`, so a retry after a timeout is the same payment.
 * Throws FinanceRefusal with finance's own reason ("more than the AED 600.00
 * left on invoice IN-00041", "not approved yet") for the screen to show.
 */
export async function sendBalancePayment(payload: {
  enrolmentExternalId: string;
  externalId: string;
  amountMinor: number;
  method: string;
  paidOn: string;
  receipt: { name: string; url: string; key: string; size?: number; mimeType?: string };
  note?: string;
  recordedBy: { name: string; email: string };
}, orgId: string): Promise<FinanceBalancePayment & { id: string }> {
  if (!financeConfigured() || !orgId) throw new FinanceRefusal("The finance connection is not set up", 503);

  const path = "/api/v1/integrations/enrolments/balance-payments";
  const raw = JSON.stringify({ source: "crm", ...payload });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(env.FINANCE_INTEGRATION_SECRET, "POST", path, timestamp, nonce, raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
        "x-delta-org": orgId,
      },
      body: raw,
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { data?: FinanceBalancePayment & { id: string }; error?: { message?: string } };
    if (!res.ok || !body.data) throw new FinanceRefusal(body.error?.message ?? `Finance returned ${res.status}`, res.status);
    return body.data;
  } catch (err) {
    if (err instanceof FinanceRefusal) throw err;
    throw new FinanceRefusal("Finance could not be reached — try again in a minute", 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sales note of an enrolment already with finance, as it is now in this
 * CRM (the owner, 2026-10-17: every save reaches finance). Only the note
 * changes there — not the approval, not the bill. Throws on anything but a
 * 2xx; a 404 means finance does not have this enrolment.
 */
export async function sendSalesNote(externalId: string, salesNote: string, orgId: string): Promise<void> {
  if (!financeConfigured() || !orgId) throw new Error("The finance connection is not set up");

  const path = "/api/v1/integrations/enrolments/sales-note";
  const raw = JSON.stringify({ source: "crm", externalId, salesNote });
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(env.FINANCE_INTEGRATION_SECRET, "POST", path, timestamp, nonce, raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
        "x-delta-org": orgId,
      },
      body: raw,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? `Finance returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Commission payouts (2026-10-21) ─────────────────────────────────────────────────────────────────────────────

/** This CRM as finance knows it — the code its commission is kept under there. */
export const FINANCE_CRM_CODE = "remote";

/** Where finance stands on a person's month of commission: a manager approved it, then accounts paid it. */
export interface CommissionPayout {
  userId: string;
  state: "approved" | "paid";
  /** What was approved — the month's commission payable, frozen then. */
  amount: number;
  currency: string;
  approvedByName: string;
  approvedAt: string;
  paidOn?: string | null;
  paymentMethod?: string | null;
  reference?: string | null;
}

/**
 * This CRM's commission payouts for a month, from finance (signed like everything else) — for My Pay's
 * "Approved / Paid" (the user, 2026-10-21). Throws when finance can't be asked; My Pay shows the month without them.
 */
export async function fetchCommissionPayouts(month: string): Promise<CommissionPayout[]> {
  if (!financeConfigured()) throw new Error("Finance is not configured");
  const path = `/api/v1/integrations/crm-commission/payouts?crm=${FINANCE_CRM_CODE}&month=${encodeURIComponent(month)}`;
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signRequest(env.FINANCE_INTEGRATION_SECRET, "GET", path, timestamp, nonce, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: {
        "x-delta-client": env.FINANCE_CLIENT_ID,
        "x-delta-timestamp": timestamp,
        "x-delta-nonce": nonce,
        "x-delta-signature": signature,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Finance returned ${res.status}`);
    const body = (await res.json()) as { data?: CommissionPayout[] };
    return body.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

