import { Types } from "mongoose";
import { env } from "../config/env.js";
import { CommissionSale } from "../models/CommissionSale.js";
import { Course } from "../models/Course.js";
import { OldBooksSale } from "../models/OldBooksSale.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { Names, loadConfig, planOf, resolveSale, uaeMonthOf } from "./commissionService.js";
import { fetchOldBooksPayments, type OldBooksInvoice } from "./financeClient.js";

/*
 * Finance's old books counted for their salesperson (the user, 2026-11-25: "why the old books is not showing in the
 * sales CRM and Manager TV" — then: counted, commission too, "November onwards", in every CRM and Root).
 *
 * The old books are the invoices imported into finance from the previous system: sales from before the CRMs, still
 * paid off in instalments. No lead here points at them, so nothing here ever counted them. Every ten minutes finance
 * is asked for the old-books invoices with money paid on or after OLD_BOOKS_FROM; each whose salesperson's email is
 * one of this CRM's users is kept (OldBooksSale), and then:
 *
 *   - revenue: each payment from OLD_BOOKS_FROM on counts for that user, in their team, on the day it was paid — the
 *     leaderboard, Reports, the Sales TV (and so Root's Manager TV), rewards, daily targets: every figure that adds up
 *     lead payments (utils/bangaloreRevenue.ts bangaloreLeadsUnion takes these in beside the leads);
 *   - commission: only once the invoice is paid in full (the user: "commission when they get full payment, then
 *     only"), with its last payment on or after OLD_BOOKS_FROM — a CommissionSale like a close's, earned whole in that
 *     month, at the plan row of the course it is matched to by name (OLD_BOOKS_COURSES; the user chose the old "Market
 *     Breakout Theory" row for the old MBT, Digital Marketing at 0 for now). The five steps (finance, LMS, CS,
 *     onboarded, MT5) are not waited for — old books have none. Who earns it is decided as for any sale (team leader,
 *     Sales Manager, excluded logins), and a counted one is never redone. An invoice voided in finance takes it back.
 *
 * Not counted: an invoice in another currency than AED (none today), money before OLD_BOOKS_FROM, a salesperson who
 * isn't a user here (kept, with no user, for the script to list — Root shows those apart).
 */

/** Old books' course lines → this CRM's course, by name. The first that matches; none: commission 0. */
export const OLD_BOOKS_COURSES: { line: RegExp; course: RegExp }[] = [
  { line: /market\s*break[\s-]*out/i, course: /^\s*market\s+breakout\s+theory\s*$/i },
  { line: /delta\s*wave/i, course: /^\s*delta\s+wave\s+theory\s*$/i },
  { line: /digital\s*marketing/i, course: /^\s*digital\s+marketing/i },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const dayStart = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00+04:00`);   // a finance date, as a UAE day

export interface OldBooksResult {
  invoices: number;
  kept: number;
  notHere: { invoice: string; salesperson: string; email: string; paidAed: number }[];
  commission: { invoice: string; person: string; course: string; state: string; reason: string; lines: string }[];
  reversed: number;
}

async function courseFor(line: string, courses: { _id: Types.ObjectId; name: string }[]) {
  const rule = OLD_BOOKS_COURSES.find((r) => r.line.test(line));
  return rule ? courses.find((c) => rule.course.test(c.name)) ?? null : null;
}

/** A user's one active team (the revenue figures' team, and the sale's); none when in no team or several. */
async function teamOf(user: Types.ObjectId): Promise<Types.ObjectId | null> {
  const teams = await Team.find({ status: "active", $or: [{ members: user }, { leaders: user }] }).select("_id").lean();
  return teams.length === 1 ? (teams[0]!._id as Types.ObjectId) : null;
}

/** One pass. `write: false` only reports. `invoices`: finance's answer, for the checks (else asked of finance). */
export async function syncOldBooks(opts: { write?: boolean; from?: string; invoices?: OldBooksInvoice[] } = {}): Promise<OldBooksResult> {
  const write = opts.write !== false;
  const from = opts.from ?? env.OLD_BOOKS_FROM;
  const since = dayStart(from);
  const list = opts.invoices ?? (await fetchOldBooksPayments(from));
  const out: OldBooksResult = { invoices: list.length, kept: 0, notHere: [], commission: [], reversed: 0 };
  if (!list.length) return out;

  const emails = [...new Set(list.map((i) => i.salespersonEmail).filter(Boolean))];
  const users = await User.find({ email: { $in: emails } }).select("name email").lean<{ _id: Types.ObjectId; name: string; email: string }[]>();
  const userOf = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
  const courses = await Course.find({}).select("name commission").lean<{ _id: Types.ObjectId; name: string; commission?: unknown }[]>();
  const config = await loadConfig();
  const names = new Names();

  for (const inv of list) {
   try {
    if (!Types.ObjectId.isValid(inv.invoiceId) || (inv.currency || "AED").toUpperCase() !== "AED") continue;
    const user = userOf.get(inv.salespersonEmail) ?? null;
    const all = inv.payments.map((p) => ({ financeId: p.id, amount: round2(p.amountMinor / 100), paidAt: dayStart(p.paidOn) }));
    const counted = all.filter((p) => p.paidAt >= since);
    const paidAed = round2(counted.reduce((s, p) => s + p.amount, 0));
    if (!user) {
      out.notHere.push({ invoice: inv.invoiceNumber, salesperson: inv.salespersonName, email: inv.salespersonEmail, paidAed });
    } else {
      out.kept++;
    }
    const isVoid = inv.status === "void";
    const fee = round2(inv.totalMinor / 100);
    const paidInFullAt = !isVoid && inv.balanceMinor <= 0 && all.length ? new Date(Math.max(...all.map((p) => p.paidAt.getTime()))) : null;
    const course = await courseFor(inv.course, courses);
    const team = user ? await teamOf(user._id) : null;
    const invoiceId = new Types.ObjectId(inv.invoiceId);

    if (write) {
      await OldBooksSale.updateOne(
        { financeInvoiceId: invoiceId },
        {
          $set: {
            invoiceNumber: inv.invoiceNumber, customerName: inv.customerName, course: inv.course, courseRef: course?._id ?? null,
            salespersonName: inv.salespersonName, salespersonEmail: inv.salespersonEmail,
            assignedTo: user?._id ?? null, team, fee, currency: "AED",
            issueDate: inv.issueDate ? dayStart(inv.issueDate) : null, status: inv.status, balance: round2(inv.balanceMinor / 100),
            // A void invoice counts nowhere.
            payments: isVoid ? [] : counted.map((p) => ({ ...p, method: inv.payments.find((x) => x.id === p.financeId)?.method ?? "", note: `Old books · ${inv.invoiceNumber}`, oldBooks: true })),
            allPayments: all, paidInFullAt, syncedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }

    // Commission: once paid in full, from OLD_BOOKS_FROM on; taken back if finance voids it.
    const sale = await CommissionSale.findOne({ student: invoiceId }).lean();
    if (isVoid) {
      if (sale && sale.state !== "reversed") {
        if (write) await CommissionSale.updateOne({ _id: sale._id }, { $set: { state: "reversed", reversedAt: new Date(), reason: `Old-books invoice ${inv.invoiceNumber} was voided in finance` } });
        out.reversed++;
      }
      continue;
    }
    if (!user || !paidInFullAt || paidInFullAt < since || !(fee > 0)) continue;
    if (sale) continue;                                       // decided once; a held one is settled by the sweep
    let left = 1;
    const collections: { paidAt: Date; share: number }[] = [];
    for (const p of counted) {
      const share = round4(Math.min(left, p.amount / fee));
      if (share > 0) collections.push({ paidAt: p.paidAt, share });
      left = round4(left - share);
    }
    const plan = planOf(course as never);
    const resolved = await resolveSale({ closer: user._id, saleTeam: team, plan, ...(course ? { course: course._id } : {}) }, config, names);
    const saleDate = inv.issueDate ? dayStart(inv.issueDate) : paidInFullAt;
    out.commission.push({
      invoice: inv.invoiceNumber, person: user.name, course: course?.name ?? `${inv.course} (no course here — 0)`, state: resolved.state, reason: resolved.reason,
      lines: resolved.lines.map((l) => `${l.role} ${l.userName} ${l.amount}`).join(", "),
    });
    if (!write) continue;
    await CommissionSale.updateOne(
      { student: invoiceId },
      {
        $setOnInsert: {
          oldBooks: true, studentName: inv.customerName, invoiceNumber: inv.invoiceNumber,
          course: course?._id ?? null, courseName: course?.name ?? inv.course,
          closer: user._id, closerName: user.name, saleDate, month: uaeMonthOf(saleDate),
          approvedAt: paidInFullAt, fee, paidShare: 1, owedShare: 0, collections,
          ...resolved, plan: resolved.plan ?? plan, mentor: null, meeting: null, stepsDoneAt: new Date(),
          ...(resolved.state === "counted" ? { countedAt: new Date() } : {}),
        },
      },
      { upsert: true },
    );
   } catch (err) {
    // Root away (it works the plan out) or one bad row: the rest go on, this one next time.
    console.error(`[oldBooks] ${inv.invoiceNumber} — ${err instanceof Error ? err.message : err}`);
   }
  }
  return out;
}

const EVERY_MS = 10 * 60_000;
let lastRun = 0;
let running = false;

/** For the finance worker's tick: at most every ten minutes. Never throws. */
export async function oldBooksTick(): Promise<void> {
  if (running || Date.now() - lastRun < EVERY_MS) return;
  running = true;
  lastRun = Date.now();
  try {
    const r = await syncOldBooks();
    if (r.commission.length || r.reversed) console.log(`[oldBooks] ${r.kept} old-books invoice(s) kept; ${r.commission.length} sale(s) counted, ${r.reversed} taken back`);
  } catch (err) {
    console.error(`[oldBooks] could not be read from finance — ${err instanceof Error ? err.message : err}`);
  } finally {
    running = false;
  }
}
