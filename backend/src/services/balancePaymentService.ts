import { Types } from "mongoose";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Student } from "../models/Student.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { ENROLMENT_PAYMENT_METHODS, type IRole } from "../types/index.js";
import { isSuperAdmin, loadConfig } from "./commissionService.js";
/** An id, whether a populated document or a bare ObjectId. */
const idOf = (v: unknown): string =>
  v && typeof v === "object" && "_id" in (v as object) ? String((v as { _id: unknown })._id) : v ? String(v) : "";
import {
  FinanceRefusal, sendBalancePayment,
  type BalanceFields, type EnrolmentStatus, type FinanceBalancePayment,
} from "./financeClient.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";

/*
 * Balance payments (the user, 2026-10-13): every part-paid course this CRM
 * closed is followed up here, by the people who sold it — not in Tetra
 * Commission. A salesperson sees their own closes, a team leader their teams',
 * the Sales Manager and a Super Admin every one.
 *
 * Finance holds the money: what the course comes to, what is paid, what is
 * left and when the next instalment is due (29 days after the latest payment).
 * It is asked live for the closes in view — a few dozen, one call. A payment
 * recorded here goes to finance with its receipt and waits for accounts there;
 * approved, it is on the invoice and the next due date moves. Each one shows
 * pending, approved or rejected (with why), as finance answers.
 *
 * Which closes: those part paid at the close (pendingAmount > 0). The student
 * here keeps what was paid at the close; finance says what is paid now.
 */

type Viewer = { userId: string; role?: IRole | null };

/** How many days ahead counts as "due soon" — the client's own reminders start 3 days before. */
const DUE_SOON_DAYS = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;

/** Today on the Dubai calendar, YYYY-MM-DD. */
export const dubaiToday = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Whose closes the viewer sees: everyone's for a Super Admin or the Sales
 * Manager; a team leader their active teams' (a close with no team counted by
 * its closer's team) and their own; anyone else their own.
 */
async function scopeOf(viewer: Viewer): Promise<Record<string, unknown>> {
  if (isSuperAdmin(viewer.role)) return {};
  const config = await loadConfig();
  if (idOf(config.salesManager) === viewer.userId) return {};
  const me = new Types.ObjectId(viewer.userId);
  const led = await Team.find({ status: "active", leaders: me }).select("_id members leaders").lean();
  if (!led.length) return { assignedTo: me };
  const members = led.flatMap((t) => [...(t.members ?? []), ...(t.leaders ?? [])].map((u) => new Types.ObjectId(idOf(u))));
  return {
    $or: [
      { assignedTo: me },
      { team: { $in: led.map((t) => t._id) } },
      { team: null, assignedTo: { $in: members } },
    ],
  };
}

export type DueState = "overdue" | "due_soon" | "later" | "none";

export interface BalanceRow {
  studentId: string;
  name: string;
  phone: string;
  email: string;
  enrollmentNumber: string;
  course: string;
  academy: string;
  closedBy: { id: string; name: string };
  team: string;
  enrolledOn: string | null;
  /** The invoice in finance; null when finance had no answer for it (not sent, or not reachable). */
  invoice: {
    number: string;
    approval: string;
    status: string;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    nextDueOn: string;
    payments: { amountMinor: number; paidOn: string; method: string; receiptNumber?: string }[];
  } | null;
  dueState: DueState;
  balancePayments: FinanceBalancePayment[];
  /** Balance payments waiting on accounts: they come off the balance once approved. */
  waitingMinor: number;
  /** Whether a payment can be recorded now, and if not, why. */
  canRecord: boolean;
  whyNot: string;
}

function dueStateOf(nextDueOn: string, balanceMinor: number, today: string): DueState {
  if (balanceMinor <= 0 || !DAY.test(nextDueOn)) return "none";
  if (nextDueOn < today) return "overdue";
  if (nextDueOn <= plusDays(today, DUE_SOON_DAYS)) return "due_soon";
  return "later";
}

const SCOPE_CAP = 1000;

/** The part-paid closes the viewer sees, each with what finance says of it now. */
async function rowsFor(viewer: Viewer, filters: { search?: string; mine?: boolean } = {}): Promise<{ rows: BalanceRow[]; reachable: boolean }> {
  const query: Record<string, unknown> = { pendingAmount: { $gt: 0 }, ...(await scopeOf(viewer)) };
  if (filters.mine) query.assignedTo = new Types.ObjectId(viewer.userId);
  if (filters.search?.trim()) {
    const rx = new RegExp(filters.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$and = [{ $or: [{ name: rx }, { email: rx }, { phone: rx }, { enrollmentNumber: rx }] }];
  }
  const students = await Student.find(query)
    .sort({ enrollmentDate: -1 })
    .limit(SCOPE_CAP)
    .select("name phone email enrollmentNumber course team assignedTo enrollmentDate academy")
    .populate("course", "name")
    .populate("assignedTo", "name")
    .populate("team", "name")
    .lean();
  if (!students.length) return { rows: [], reachable: true };

  const ids = students.map((s) => s._id);
  const handovers = await FinanceHandover.find({ studentId: { $in: ids } })
    .select("studentId status approvalState academy financeOrgId invoiceNumber")
    .lean();
  const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
  const sent = students.filter((s) => handoverOf.get(String(s._id))?.status === "sent");
  // Each asked of the organization it was billed in.
  const statuses = await fetchStatusesByOrg(
    sent.map((s) => String(s._id)),
    new Map(sent.map((s) => [String(s._id), orgOfHandover(handoverOf.get(String(s._id)), s.academy)])),
  );
  const reachable = !sent.length || statuses.length > 0;
  const statusOf = new Map(statuses.map((st) => [st.externalId, st]));
  const today = dubaiToday();

  const rows = students.map((s): BalanceRow => {
    const id = String(s._id);
    const h = handoverOf.get(id);
    const f = statusOf.get(id) as (EnrolmentStatus & BalanceFields) | undefined;
    const balanceMinor = f?.balanceMinor ?? 0;
    const bps = f?.balancePayments ?? [];
    const waitingMinor = bps.filter((b) => b.status === "pending").reduce((sum, b) => sum + (b.amountMinor || 0), 0);
    const course = s.course as { name?: string } | null;
    const closer = s.assignedTo as { _id?: unknown; name?: string } | null;
    const team = s.team as { name?: string } | null;
    const whyNot = !h || h.status !== "sent"
      ? "Not in finance yet"
      : !f
        ? reachable ? "Finance has no invoice for this close" : "Finance could not be reached"
        : f.status === "void"
          ? "The invoice is void"
          : f.approval !== "approved"
            ? "Finance hasn't approved this enrolment yet"
            : balanceMinor <= 0
              ? "Paid in full"
              : waitingMinor >= balanceMinor
                ? "The rest is already waiting for finance"
                : "";
    return {
      studentId: id,
      name: s.name ?? "",
      phone: s.phone ?? "",
      email: s.email ?? "",
      enrollmentNumber: s.enrollmentNumber ?? "",
      course: f?.course || course?.name || "",
      academy: s.academy ?? "dubai",
      closedBy: { id: idOf(closer), name: closer?.name ?? "" },
      team: team?.name ?? "",
      enrolledOn: s.enrollmentDate ? new Date(s.enrollmentDate).toISOString() : null,
      invoice: f
        ? {
            number: f.invoiceNumber,
            approval: f.approval,
            status: f.status,
            currency: f.currency,
            totalMinor: f.totalMinor,
            paidMinor: f.amountPaidMinor,
            balanceMinor,
            nextDueOn: f.nextDueOn ?? "",
            payments: f.payments ?? [],
          }
        : null,
      dueState: f && f.status !== "void" ? dueStateOf(f.nextDueOn ?? "", balanceMinor, today) : "none",
      balancePayments: bps,
      waitingMinor,
      canRecord: !whyNot,
      whyNot,
    };
  });
  return { rows, reachable };
}

const RANK: Record<DueState, number> = { overdue: 0, due_soon: 1, later: 2, none: 3 };
const owing = (r: BalanceRow) => !r.invoice || (r.invoice.balanceMinor > 0 && r.invoice.status !== "void");

export class BalancePaymentService {
  /**
   * The Balance payments page: what is still owed (default), what is paid off,
   * or both — the soonest due first — with the counts across the viewer's
   * whole scope, and what is left to collect per currency.
   */
  async list(viewer: Viewer, filters: { state?: string; search?: string; mine?: string }) {
    const { rows, reachable } = await rowsFor(viewer, { search: filters.search, mine: filters.mine === "true" });
    const state = filters.state === "paid" || filters.state === "all" ? filters.state : "owing";
    const shown = rows
      .filter((r) => (state === "all" ? true : state === "paid" ? !owing(r) : owing(r)))
      .sort((a, b) => RANK[a.dueState] - RANK[b.dueState]
        || (a.invoice?.nextDueOn || "9999").localeCompare(b.invoice?.nextDueOn || "9999")
        || (b.enrolledOn ?? "").localeCompare(a.enrolledOn ?? ""));
    const open = rows.filter(owing);
    const left = new Map<string, number>();
    for (const r of open) if (r.invoice) left.set(r.invoice.currency, (left.get(r.invoice.currency) ?? 0) + r.invoice.balanceMinor);
    return {
      rows: shown,
      reachable,
      counts: {
        owing: open.length,
        overdue: rows.filter((r) => r.dueState === "overdue").length,
        dueSoon: rows.filter((r) => r.dueState === "due_soon").length,
        waiting: rows.reduce((n, r) => n + r.balancePayments.filter((b) => b.status === "pending").length, 0),
        paidOff: rows.length - open.length,
        left: [...left].map(([currency, balanceMinor]) => ({ currency, balanceMinor })),
      },
    };
  }

  /** The sidebar's number: the viewer's closes overdue or due within 3 days. */
  async dueCount(viewer: Viewer): Promise<number> {
    const { rows } = await rowsFor(viewer);
    return rows.filter((r) => r.dueState === "overdue" || r.dueState === "due_soon").length;
  }

  /** Whether the viewer may act on this close: theirs, their team's, or everyone's. */
  async inScope(viewer: Viewer, studentId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(studentId)) return false;
    return (await Student.exists({ _id: new Types.ObjectId(studentId), ...(await scopeOf(viewer)) })) !== null;
  }

  /**
   * Record the next payment: checked here, then handed to finance with its
   * receipt, where it waits for accounts. `key` is the form's own id for this
   * payment, so pressing Save twice, or again after a timeout, is one payment.
   */
  async record(viewer: Viewer, studentId: string, body: Record<string, unknown>) {
    const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
    const key = String(body.key ?? "");
    const amount = Number(body.amount);
    const method = String(body.method ?? "");
    const paidOn = String(body.paidOn ?? "");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
    const r = (body.receipt ?? null) as { name?: unknown; url?: unknown; key?: unknown; size?: unknown; mimeType?: unknown } | null;

    if (!KEY.test(key)) throw fail(400, "This payment has no id — reload the page and try again");
    if (!Number.isFinite(amount) || amount <= 0) throw fail(400, "Enter the amount paid");
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw fail(400, "The amount can have at most 2 decimals");
    if (!(ENROLMENT_PAYMENT_METHODS as readonly string[]).includes(method)) throw fail(400, "Choose how it was paid");
    if (!DAY.test(paidOn) || Number.isNaN(Date.parse(paidOn))) throw fail(400, "Choose the day it was paid");
    if (paidOn > dubaiToday()) throw fail(400, "The day it was paid can't be in the future");
    if (!r || typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || typeof r.key !== "string" || !r.key) {
      throw fail(400, "Attach the receipt");
    }

    if (!(await this.inScope(viewer, studentId))) throw fail(404, "Enrolment not found");
    const [student, h, me] = await Promise.all([
      Student.findById(studentId).select("academy name").lean(),
      FinanceHandover.findOne({ studentId: new Types.ObjectId(studentId) }).select("status academy financeOrgId").lean(),
      User.findById(viewer.userId).select("name email").lean(),
    ]);
    if (!h || h.status !== "sent") throw fail(409, "This enrolment isn't in finance yet");

    try {
      const sent = await sendBalancePayment({
        enrolmentExternalId: studentId,
        externalId: `bp-${key}`,
        amountMinor: Math.round(amount * 100),
        method,
        paidOn,
        receipt: {
          name: String(r.name ?? "Receipt").slice(0, 200) || "Receipt",
          url: r.url,
          key: r.key.slice(0, 500),
          ...(typeof r.size === "number" ? { size: r.size } : {}),
          ...(typeof r.mimeType === "string" ? { mimeType: r.mimeType.slice(0, 100) } : {}),
        },
        ...(note ? { note } : {}),
        recordedBy: { name: me?.name ?? "", email: me?.email ?? "" },
      }, orgOfHandover(h, student?.academy));
      return sent;
    } catch (err) {
      if (err instanceof FinanceRefusal) {
        // Finance's reason is for the person: too much, not approved, paid in full.
        throw fail(err.status === 0 || err.status >= 500 ? 502 : err.status === 401 || err.status === 403 ? 502 : 409, err.message);
      }
      throw err;
    }
  }
}
