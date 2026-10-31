import { Types } from "mongoose";
import { CommissionSale } from "../models/CommissionSale.js";
import { CommissionSettings } from "../models/CommissionSettings.js";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Student } from "../models/Student.js";
import { Course } from "../models/Course.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";
import { stepsOf, allDone, waitingOn } from "./enrolmentSteps.js";
import { slabsFor } from "./salarySlabs.js";
import { env } from "../config/env.js";
import { collectionsOf } from "../utils/enrolmentCollections.js";
import type {
  CommissionRole,
  CommissionSaleState,
  ICommissionLine,
  IRole,
} from "../types/index.js";

/*
 * Sales commission: a plan per course (Sales Staff / TL / SM, in AED), and
 * what each approved sale earns under it.
 *
 * The rules, as the business set them (2026-10-04):
 *   - every sale finance approves pays three people: whoever closed it (Sales
 *     Staff), the leader of its team (TL) and the Sales Manager (SM);
 *   - one Sales Manager for the whole CRM. A team he leads himself gets no TL
 *     amount — he is paid as SM, not twice;
 *   - a TL or SM who closes a sale is paid the Sales Staff amount as well;
 *   - one leader per team: a sale in a team with none, or two, waits until the
 *     team is fixed, and is listed so somebody fixes it;
 *   - sales closed under a shared login (root user, superadmin, developer)
 *     earn nobody anything.
 *
 * Counted once finance approves the sale (the user, 2026-10-26: "they will get
 * commission when they get approval from the finance — no need to wait for the
 * MT5 bonus"). It used to wait for all five steps (2026-10-04) — LMS account,
 * CS, onboarded and the MT5 bonus too; those are still shown on the enrolment,
 * never waited on. With the amounts of that day, in the month the sale was made
 * (UAE time), for sales closed from 1 October 2026 on. Until then the sale is
 * "progress", saying it waits for finance (or was sent back). A sale whose
 * invoice finance voids is reversed.
 */

/**
 * How this CRM pays a team's leader — the one line that differs between the
 * three sales CRMs, which otherwise run this same code:
 *   "zero_if_sm"  the leader is paid the TL amount, except on a team the Sales
 *                 Manager leads himself, where it is 0 (Sales CRM)
 *   "always"      the leader is paid the TL amount — the Sales Manager too when
 *                 he leads the team, so one person earns both (Remote CRM)
 *   "never"       no TL amount at all, so a sale needs no team leader (Draw)
 */
export type TlRule = "zero_if_sm" | "always" | "never";
export const TL_RULE: TlRule = "always";

/** UAE has no daylight saving: a month there starts at 20:00 UTC the day before. */
const UAE_OFFSET_MS = 4 * 60 * 60 * 1000;

export function uaeMonthOf(d: Date): string {
  return new Date(d.getTime() + UAE_OFFSET_MS).toISOString().slice(0, 7);
}

export function isSuperAdmin(role?: IRole | null): boolean {
  return Boolean(role?.isSystemRole && role.roleName === "Super Admin");
}

export type Plan = { sales: number; tl: number; sm: number; creditUsd: number };

const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A course's plan row; zeros for a course nobody has set one on. */
export function planOf(course?: { commission?: Partial<Plan> | null } | null): Plan {
  const c = course?.commission;
  return { sales: amount(c?.sales), tl: amount(c?.tl), sm: amount(c?.sm), creditUsd: amount(c?.creditUsd) };
}

export const idOf = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Types.ObjectId) return v.toHexString();
  if (typeof v === "object" && "_id" in (v as object)) return String((v as { _id: unknown })._id);
  return String(v);
};

/**
 * A sale's course fee in AED: finance's invoice total — the fee as approved,
 * its tax inside — or, while finance has no total in AED for it, the
 * student's own fee. What a sale adds to a salary-slab target.
 */
export function feeOf(st: { totalMinor?: number; currency?: string } | null | undefined, studentFee?: number): number {
  const inAed = (st?.currency || "AED").toUpperCase() === "AED";
  if (st && inAed && typeof st.totalMinor === "number" && st.totalMinor > 0) return st.totalMinor / 100;
  return typeof studentFee === "number" && Number.isFinite(studentFee) && studentFee > 0 ? studentFee : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/*
 * Commission on what is collected, in the month it is collected (the user, 2026-10-31: "that month collected payment
 * only count for the commission — if it was another month it will never count"). Each payment received on a sale
 * from COUNT_FROM on earns its share of the fee (`collections`) in the month it came in: an October sale whose
 * balance is paid in November earns that part in November. Money received before COUNT_FROM never earns. What the
 * client still owes is the balance (`owedShare`). A line's `amount` stays the full plan amount.
 */
type ShareSale = {
  saleDate?: Date;
  paidShare?: number | null;
  owedShare?: number | null;
  collections?: { paidAt: Date; share: number }[] | null;
};

/** A UAE month as two instants, inclusive. */
export function monthRange(month: string): { from: Date; to: Date } {
  const from = new Date(`${month}-01T00:00:00+04:00`);
  const [y, m] = month.split("-").map(Number);
  const next = new Date(`${m === 12 ? y! + 1 : y}-${String(m === 12 ? 1 : m! + 1).padStart(2, "0")}-01T00:00:00+04:00`);
  return { from, to: new Date(next.getTime() - 1) };
}

/** The share of the fee received between two instants. A sale not followed yet earns all of it on its sale day. */
export function shareBetween(sale: ShareSale, from: Date, to: Date): number {
  if (!Array.isArray(sale.collections)) {
    return sale.saleDate && sale.saleDate >= from && sale.saleDate <= to ? 1 : 0;
  }
  return round4(sale.collections.filter((c) => c.paidAt >= from && c.paidAt <= to).reduce((s, c) => s + c.share, 0));
}

/** The share collected from COUNT_FROM until now; a sale not followed yet counts in full. */
export const shareOf = (sale: ShareSale): number =>
  typeof sale.paidShare === "number" && sale.paidShare >= 0 ? Math.min(1, sale.paidShare) : 1;

/** The share the client still owes — what the balance payments can still earn. */
export const owedShareOf = (sale: ShareSale): number =>
  typeof sale.owedShare === "number" && sale.owedShare > 0 ? Math.min(1, sale.owedShare) : 0;

/** A line's amount at a share. */
export const partOf = (amount: number, share: number): number => round2(amount * share);


// ─── Settings ─────────────────────────────────────────────────────────────────

export interface CommissionConfig {
  salesManager: Types.ObjectId | null;
  excluded: Set<string>;
}

export async function loadConfig(): Promise<CommissionConfig> {
  const s = await CommissionSettings.findOne({ key: "default" }).lean();
  return {
    salesManager: s?.salesManager ?? null,
    excluded: new Set((s?.excludedUsers ?? []).map(idOf)),
  };
}

/**
 * What a viewer may see of commission (the user, 2026-10-23: "only his own; the team leader his and his team members';
 * the sales manager everyone" — as the Sales CRM has it since 2026-10-15): Super Admins and the Sales Manager see
 * everything; a team leader sees their own active teams; everyone else only themselves.
 */
export interface CommissionScope {
  all: boolean;
  /** Active teams the viewer leads (empty when `all`). */
  ledTeamIds: string[];
  /** Members and leaders of those teams, the viewer included. */
  teamPeople: Set<string>;
}

export async function commissionScope(viewer: { userId: string; role?: IRole }): Promise<CommissionScope> {
  const me = viewer.userId;
  const s = await CommissionSettings.findOne({ key: "default" }).select("salesManager").lean();
  if (isSuperAdmin(viewer.role) || idOf(s?.salesManager) === me) return { all: true, ledTeamIds: [], teamPeople: new Set() };
  const led = Types.ObjectId.isValid(me)
    ? await Team.find({ leaders: new Types.ObjectId(me), status: { $ne: "inactive" } }).select("_id members leaders").lean()
    : [];
  const teamPeople = new Set<string>([me]);
  for (const t of led) for (const u of [...(t.members ?? []), ...(t.leaders ?? [])]) teamPeople.add(idOf(u));
  return { all: false, ledTeamIds: led.map((t) => String(t._id)), teamPeople };
}

/** May the viewer see this commission line (an SM line only when `all`)? */
export function canSeeLine(scope: CommissionScope, viewerId: string, line: { user?: unknown; role?: string }, saleCloser = ""): boolean {
  if (scope.all) return true;
  if (idOf(line.user) === viewerId) return true;
  if (!scope.ledTeamIds.length || line.role === "sm") return false;
  return scope.teamPeople.has(idOf(line.user)) || (!!saleCloser && scope.teamPeople.has(saleCloser));
}

/** The rates a viewer may see: a team leader no SM rate, everyone else only the sales rate. */
export function planFor(plan: Plan, scope: CommissionScope): Partial<Plan> {
  if (scope.all) return plan;
  if (scope.ledTeamIds.length) return { sales: plan.sales, tl: plan.tl, creditUsd: plan.creditUsd };
  return { sales: plan.sales, creditUsd: plan.creditUsd };
}

/** The salary slabs a viewer may see, by the same rule. */
export function slabsForScope<T extends Record<string, unknown>>(slabs: T, scope: CommissionScope): Partial<T> {
  if (scope.all) return slabs;
  const keep = scope.ledTeamIds.length ? ["sales", "tl"] : ["sales"];
  return Object.fromEntries(Object.entries(slabs).filter(([k]) => keep.includes(k))) as Partial<T>;
}

/** Names looked up once per pass, not once per line. */
class Names {
  private cache = new Map<string, string>();
  async of(id: unknown): Promise<string> {
    const key = idOf(id);
    if (!key) return "";
    if (!this.cache.has(key)) {
      const u = Types.ObjectId.isValid(key) ? await User.findById(key).select("name").lean() : null;
      this.cache.set(key, u?.name ?? "Unknown user");
    }
    return this.cache.get(key)!;
  }
}

// ─── Who earns it ─────────────────────────────────────────────────────────────

type TeamLite = { _id: Types.ObjectId; name: string; leaders: unknown[] };

export interface Resolved {
  state: CommissionSaleState;
  reason: string;
  team: Types.ObjectId | null;
  teamName: string;
  lines: ICommissionLine[];
}

/**
 * The team a sale counts under: its own, or — for a sale made with none — the
 * one team its closer is in.
 */
async function teamFor(
  saleTeam: unknown,
  closer: unknown,
  closerName: string,
): Promise<{ team?: TeamLite; reason?: string }> {
  const own = idOf(saleTeam);
  if (own && Types.ObjectId.isValid(own)) {
    const t = await Team.findById(own).select("name leaders").lean();
    if (t) return { team: t as unknown as TeamLite };
  }
  const theirs = await Team.find({ status: "active", $or: [{ members: closer }, { leaders: closer }] })
    .select("name leaders")
    .lean();
  if (theirs.length === 1) return { team: theirs[0] as unknown as TeamLite };
  return {
    reason: theirs.length
      ? `${closerName} is in ${theirs.length} teams — the sale has none, so it can't tell whose leader to pay`
      : `${closerName} isn't in a team`,
  };
}

/**
 * Who earns what on a sale, under the rules above. Nothing is written: the
 * caller stores it, or — for the closing dialog — only shows it.
 */
export async function resolveSale(
  input: { closer: unknown; saleTeam: unknown; plan: Plan },
  config: CommissionConfig,
  names: Names = new Names(),
): Promise<Resolved> {
  const none = { team: null, teamName: "", lines: [] as ICommissionLine[] };
  const closer = idOf(input.closer);
  if (!closer || !Types.ObjectId.isValid(closer)) {
    return { ...none, state: "waiting", reason: "Nobody is set as the closer" };
  }
  const closerName = await names.of(closer);
  if (config.excluded.has(closer)) {
    return { ...none, state: "excluded", reason: `Closed under ${closerName}, a login that earns no commission` };
  }

  const { team, reason } = await teamFor(input.saleTeam, closer, closerName);
  const line = async (role: CommissionRole, user: string, amt: number, note?: string): Promise<ICommissionLine> => ({
    role,
    user: new Types.ObjectId(user),
    userName: await names.of(user),
    amount: amt,
    ...(note ? { note } : {}),
  });

  // No TL paid here: the team is only shown, and a sale without one still counts.
  if (TL_RULE === "never") {
    const shown = { team: team?._id ?? null, teamName: team?.name ?? "", lines: [] as ICommissionLine[] };
    if (!config.salesManager) {
      return { ...shown, state: "waiting", reason: "No Sales Manager is set on the commission plan" };
    }
    return {
      ...shown,
      state: "counted",
      reason: "",
      lines: [
        await line("sales", closer, input.plan.sales),
        await line("sm", idOf(config.salesManager), input.plan.sm),
      ],
    };
  }

  if (!team) return { ...none, state: "waiting", reason: reason ?? "No team" };

  const onTeam = { team: team._id, teamName: team.name, lines: [] as ICommissionLine[] };
  const leaders = [...new Set((team.leaders ?? []).map(idOf).filter(Boolean))];
  if (leaders.length !== 1) {
    return {
      ...onTeam,
      state: "waiting",
      reason: leaders.length
        ? `${team.name} has ${leaders.length} leaders — a team needs exactly one`
        : `${team.name} has no leader`,
    };
  }
  if (!config.salesManager) {
    return { ...onTeam, state: "waiting", reason: "No Sales Manager is set on the commission plan" };
  }

  const tl = leaders[0]!;
  const sm = idOf(config.salesManager);
  const tlIsSm = tl === sm && TL_RULE === "zero_if_sm";

  return {
    ...onTeam,
    state: "counted",
    reason: "",
    lines: [
      await line("sales", closer, input.plan.sales),
      await line("tl", tl, tlIsSm ? 0 : input.plan.tl, tlIsSm ? "Leads this team as Sales Manager — paid as SM" : undefined),
      await line("sm", sm, input.plan.sm),
    ],
  };
}

// ─── The sweep ────────────────────────────────────────────────────────────────

/**
 * Commission counts sales closed from here on (the user, 2026-10-04: "this
 * month onwards") — 1 October 2026, 00:00 UAE.
 */
export const COUNT_FROM = new Date("2026-10-01T00:00:00+04:00");
const TRACK_MS = 2 * 60_000;
const VOID_CHECK_MS = 10 * 60_000;
/** How far back a voided invoice still takes a sale's commission back. */
const VOID_WINDOW_MS = 120 * 24 * 60 * 60_000;

type StudentLite = {
  _id: Types.ObjectId;
  name?: string;
  enrollmentNumber?: string;
  course?: unknown;
  team?: unknown;
  assignedTo?: unknown;
  enrollmentDate?: Date;
  createdAt?: Date;
  financeInvoiceNumber?: string | null;
  totalFee?: number;
};

/**
 * Every sale closed since COUNT_FROM, followed until finance approves it (its
 * first step, enrolmentSteps.ts — since 2026-10-26 the only one commission waits
 * for). Until then it is "progress", saying it waits for finance; once approved,
 * who earns what is decided with the plan of that day — counted, held (waiting)
 * or excluded — and never redone by this (`stepsDoneAt`: when that was). A sale
 * counted before `stepsDoneAt` existed is looked at once more and keeps counting.
 */
export async function trackSales(config: CommissionConfig, names: Names): Promise<number> {
  const handed = await FinanceHandover.find({ status: "sent" }).select("studentId invoiceNumber approvedAt academy financeOrgId").lean();
  if (!handed.length) return 0;
  const handoverOf = new Map(handed.map((h) => [String(h.studentId), h]));
  const students = (await Student.find({ _id: { $in: handed.map((h) => h.studentId) }, enrollmentDate: { $gte: COUNT_FROM } })
    .select("name enrollmentNumber course team assignedTo enrollmentDate createdAt financeInvoiceNumber totalFee")
    .lean()) as StudentLite[];
  const sales = await CommissionSale.find({ student: { $in: students.map((s) => s._id) } }).lean();
  const saleOf = new Map(sales.map((x) => [String(x.student), x]));
  const open = students.filter((s) => {
    const sale = saleOf.get(String(s._id));
    return !sale || sale.state === "progress" || (sale.state === "counted" && !sale.stepsDoneAt);
  }).slice(0, 200);
  if (!open.length) return 0;

  // Each asked of the finance organization it was billed in — Dubai's or Bangalore's.
  const statuses = await fetchStatusesByOrg(
    open.map((s) => String(s._id)),
    new Map(open.map((s) => [String(s._id), orgOfHandover(handoverOf.get(String(s._id)))])),
  );
  if (!statuses.length) return 0;                       // finance unreachable: ask again next time
  const statusOf = new Map(statuses.map((st) => [st.externalId, st]));
  let changed = 0;

  for (const student of open) {
    try {
      const st = statusOf.get(String(student._id));
      if (!st) continue;                                 // finance has no invoice for it (yet)
      const sale = saleOf.get(String(student._id));
      const h = handoverOf.get(String(student._id));
      const closer = idOf(student.assignedTo);
      const saleDate = student.enrollmentDate ?? student.createdAt ?? new Date();
      const courseId = idOf(student.course);
      const course = courseId ? await Course.findById(courseId).select("name commission").lean() : null;
      const base = {
        student: student._id,
        studentName: student.name ?? "",
        enrollmentNumber: student.enrollmentNumber,
        invoiceNumber: st.invoiceNumber || (h?.invoiceNumber as string | undefined) || student.financeInvoiceNumber || "",
        course: course?._id ?? null,
        courseName: course?.name ?? "",
        closer: closer && Types.ObjectId.isValid(closer) ? new Types.ObjectId(closer) : null,
        closerName: closer ? await names.of(closer) : "",
        saleDate,
        month: uaeMonthOf(saleDate),
        fee: feeOf(st, student.totalFee),
        ...(h?.approvedAt ? { approvedAt: h.approvedAt } : {}),
      };

      if (st.status === "void") {
        if (sale) {
          await CommissionSale.updateOne({ _id: sale._id }, {
            $set: {
              state: "reversed",
              reversedAt: new Date(),
              reason: st.invoiceNumber ? `Invoice ${st.invoiceNumber} was voided in finance` : "Its invoice was voided in finance",
            },
          });
          changed++;
        }
        continue;
      }

      // Closed under a shared login: nobody earns it, whatever its steps.
      if (closer && config.excluded.has(closer)) {
        const resolved = await resolveSale({ closer, saleTeam: student.team, plan: planOf(course) }, config, names);
        await CommissionSale.updateOne({ student: student._id }, { $set: { ...base, ...resolved, plan: planOf(course) } }, { upsert: true });
        changed++;
        continue;
      }

      // Only finance's approval is waited for (2026-10-26); LMS, CS, onboarding and the MT5 bonus are not.
      const steps = stepsOf(st, h ? { status: "sent", approvedAt: h.approvedAt as Date | undefined } : null).filter((x) => x.key === "finance");
      if (!allDone(steps)) {
        const reason = waitingOn(steps);
        if (sale?.state === "progress" && sale.reason === reason && sale.fee === base.fee) continue;
        await CommissionSale.updateOne(
          { student: student._id },
          { $set: { ...base, state: "progress", reason, lines: [], plan: planOf(course) }, $unset: { countedAt: "", team: "", teamName: "" } },
          { upsert: true },
        );
        changed++;
        continue;
      }

      // Finance approved: who earns what, at the plan of today.
      const plan = planOf(course);
      const resolved = await resolveSale({ closer: student.assignedTo, saleTeam: student.team, plan }, config, names);
      await CommissionSale.updateOne(
        { student: student._id },
        {
          $set: {
            ...base, ...resolved, plan, stepsDoneAt: new Date(),
            ...(resolved.state === "counted" ? { countedAt: new Date() } : {}),
            ...(base.approvedAt ? {} : { approvedAt: new Date() }),
          },
        },
        { upsert: true },
      );
      changed++;
    } catch (err) {
      console.error(`[commission] could not follow the sale of student ${String(student._id)}`, err);
    }
  }
  return changed;
}

/**
 * Sales on hold, looked at again: a team given one leader, a closer put in a
 * team, a student given to their real closer, a Sales Manager set. The plan
 * amounts stay the ones they were held at; only who earns them is redone.
 */
export async function settlePendingSales(config: CommissionConfig, names: Names): Promise<number> {
  const pending = await CommissionSale.find({ state: { $in: ["waiting", "excluded"] } })
    .sort({ saleDate: 1 })
    .limit(200);
  let changed = 0;

  for (const sale of pending) {
    try {
      const student = (await Student.findById(sale.student).select("team assignedTo").lean()) as StudentLite | null;
      // A student deleted since is decided on what the sale recorded.
      const closer = student ? student.assignedTo : sale.closer;
      const saleTeam = student ? student.team : sale.team;
      const plan = planOf({ commission: sale.plan as Partial<Plan> });
      const resolved = await resolveSale({ closer, saleTeam, plan }, config, names);

      const closerId = idOf(closer);
      const sameCloser = closerId === idOf(sale.closer);
      if (resolved.state === sale.state && resolved.reason === sale.reason && sameCloser) continue;
      // No longer excluded, but its steps were never followed: back to following them.
      if (sale.state === "excluded" && resolved.state !== "excluded" && !sale.stepsDoneAt) {
        sale.set({ state: "progress", reason: "Next step: its steps are being checked", lines: [] });
        await sale.save();
        changed++;
        continue;
      }

      sale.set({
        ...resolved,
        closer: closerId && Types.ObjectId.isValid(closerId) ? new Types.ObjectId(closerId) : null,
        closerName: closerId ? await names.of(closerId) : "",
        ...(resolved.state === "counted" ? { countedAt: new Date() } : {}),
      });
      await sale.save();
      changed++;
    } catch (err) {
      console.error(`[commission] could not settle the sale ${String(sale._id)}`, err);
    }
  }
  return changed;
}

/**
 * Counted and held sales whose invoice finance has voided since, taken back.
 * Asked of finance for the last few months' sales only — a void long after is
 * somebody's correction to make by hand, not a reason to ask about every sale
 * forever. (Sales still in progress are watched for this by trackSales.)
 *
 * The same answer keeps each sale's fee as finance has it — the invoice total a
 * salary-slab target counts — for sales trackSales no longer follows.
 */
export async function reverseVoidedSales(): Promise<number> {
  const live = await CommissionSale.find({
    state: { $in: ["counted", "waiting", "excluded"] },
    saleDate: { $gte: new Date(Date.now() - VOID_WINDOW_MS) },
  })
    .select("student fee")
    .lean();
  const feeNow = new Map(live.map((s) => [String(s.student), s.fee]));
  let reversed = 0;

  for (let i = 0; i < live.length; i += 200) {
    const ids = live.slice(i, i + 200).map((s) => String(s.student));
    const statuses = await fetchStatusesByOrg(ids);
    for (const st of statuses) {
      if (!Types.ObjectId.isValid(st.externalId)) continue;
      if (st.status !== "void") {
        const fee = feeOf(st);
        if (fee > 0 && fee !== feeNow.get(st.externalId)) {
          await CommissionSale.updateOne(
            { student: new Types.ObjectId(st.externalId), state: { $ne: "reversed" } },
            { $set: { fee } },
          );
        }
        continue;
      }
      const r = await CommissionSale.updateOne(
        { student: new Types.ObjectId(st.externalId), state: { $ne: "reversed" } },
        {
          $set: {
            state: "reversed",
            reversedAt: new Date(),
            reason: st.invoiceNumber
              ? `Invoice ${st.invoiceNumber} was voided in finance`
              : "Its invoice was voided in finance",
          },
        },
      );
      reversed += r.modifiedCount;
    }
  }
  return reversed;
}

/**
 * Every sale's payments received, as shares of its fee by the day they came in, and what is still owed — a balance
 * payment approved, or the fee corrected, moves them. Only payments from COUNT_FROM on (earlier money never earns),
 * and never past the whole fee. A sale with no fee earns all of it on its sale day. Local only (no finance call), so
 * every pass; sales from COUNT_FROM on, voided ones left as they are.
 */
export async function refreshPaidShares(): Promise<number> {
  // Paid in full first (2026-10-30) is gone: a sale it moved to the month it was paid in full goes back to its own
  // month, its markers off — it earns as its money comes in, like every sale. Once; nothing matches after.
  await CommissionSale.collection.updateMany(
    { $or: [{ paidInFullAt: { $exists: true } }, { owed: { $exists: true } }] },
    [
      { $set: { month: { $dateToString: { format: "%Y-%m", date: "$saleDate", timezone: "Asia/Dubai" } } } },
      { $unset: ["paidInFullAt", "owed"] },
    ],
  );
  const sales = await CommissionSale.find({ saleDate: { $gte: COUNT_FROM }, state: { $ne: "reversed" } })
    .select("student saleDate paidShare owedShare collections").lean();
  if (!sales.length) return 0;
  const students = await Student.find({ _id: { $in: sales.map((s) => s.student) } })
    .select("leadId academy enrollmentDate payments totalFee pendingAmount")
    .lean<{ _id: unknown; leadId?: unknown; academy?: string; enrollmentDate?: Date; payments?: { amount?: number; paidAt?: Date; collectedBefore?: boolean }[]; totalFee?: number; pendingAmount?: number }[]>();
  const studentOf = new Map(students.map((s) => [String(s._id), s]));
  const received = await collectionsOf(students);
  let changed = 0;
  for (const sale of sales) {
    const st = studentOf.get(String(sale.student));
    if (!st) continue;                                    // a deleted enrolment keeps what it had
    const fee = st.totalFee ?? 0;
    let collections: { paidAt: Date; share: number }[] = [];
    let owedShare = 0;
    if (!(fee > 0)) {
      collections = [{ paidAt: new Date(st.enrollmentDate ?? sale.saleDate), share: 1 }];
    } else {
      let left = 1;
      for (const c of received.get(String(st._id)) ?? []) {
        if (c.paidAt < COUNT_FROM || left <= 0) continue;
        const share = round4(Math.min(left, c.amount / fee));
        if (share > 0) collections.push({ paidAt: c.paidAt, share });
        left = round4(left - share);
      }
      owedShare = round4(Math.min(1, Math.max(0, (st.pendingAmount ?? 0) / fee)));
    }
    const paidShare = round4(Math.min(1, collections.reduce((s, c) => s + c.share, 0)));
    const same =
      sale.paidShare === paidShare &&
      sale.owedShare === owedShare &&
      JSON.stringify((sale.collections ?? []).map((c) => [new Date(c.paidAt).getTime(), c.share])) ===
        JSON.stringify(collections.map((c) => [c.paidAt.getTime(), c.share]));
    if (same && Array.isArray(sale.collections)) continue;
    await CommissionSale.updateOne({ _id: sale._id }, { $set: { paidShare, owedShare, collections } });
    changed++;
  }
  return changed;
}

let sweeping = false;
let lastTrack = 0;
let lastVoidCheck = 0;

/**
 * One pass: follow open sales' steps (every two minutes), settle what is held,
 * and — every ten minutes — take back voided sales. Run by the finance worker
 * every minute. Never throws: it runs in a timer, where an unhandled rejection
 * kills the process.
 */
export async function sweepCommission(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const config = await loadConfig();
    const names = new Names();
    if (Date.now() - lastTrack >= TRACK_MS) {
      lastTrack = Date.now();
      await trackSales(config, names);
    }
    await settlePendingSales(config, names);
    await refreshPaidShares();
    if (Date.now() - lastVoidCheck >= VOID_CHECK_MS) {
      lastVoidCheck = Date.now();
      await reverseVoidedSales();
    }
  } catch (err) {
    console.error("[commission] sweep failed", err);
  } finally {
    sweeping = false;
  }
}

/** Test hook: the next sweep follows every open sale at once, not on its two-minute beat. */
export function followNow(): void {
  lastTrack = 0;
  lastVoidCheck = 0;
}

// ─── Reading it ───────────────────────────────────────────────────────────────

type Viewer = { userId: string; role?: IRole };

export class CommissionService {
  /**
   * The plan: every course's row, the Sales Manager, the excluded logins, the
   * salary slabs in force this month, and what needs fixing.
   */
  async getPlan(viewer: Viewer) {
    // Read only for everyone (the user, 2026-10-09); a Super Admin still sees the sales on hold.
    const canEdit = false;
    const seesHeld = isSuperAdmin(viewer.role);
    const month = uaeMonthOf(new Date());
    const scope = await commissionScope(viewer);
    const [courses, settings, teams, slabs] = await Promise.all([
      Course.find({}).select("name amount status commission").sort({ status: 1, name: 1 }).lean(),
      CommissionSettings.findOne({ key: "default" })
        .populate("salesManager", "name email")
        .populate("excludedUsers", "name email")
        .lean(),
      Team.find({ status: "active", ...(scope.all ? {} : { _id: { $in: scope.ledTeamIds.map((id) => new Types.ObjectId(id)) } }) })
        .select("name leaders members")
        .populate("leaders", "name")
        .populate("members", "name")
        .sort({ name: 1 })
        .lean(),
      slabsFor(month),
    ]);

    const person = (u: unknown) =>
      u && typeof u === "object" && "_id" in (u as object)
        ? { _id: idOf(u), name: (u as { name?: string }).name ?? "", email: (u as { email?: string }).email ?? "" }
        : null;

    const [waiting, users] = seesHeld
      ? await Promise.all([
          CommissionSale.find({ state: "waiting" })
            .select("studentName enrollmentNumber courseName closerName teamName saleDate approvedAt reason")
            .sort({ approvedAt: -1 })
            .limit(100)
            .lean(),
          User.find({}).select("name email status").sort({ name: 1 }).lean(),
        ])
      : [[], []];

    // "all": the whole plan; "team": a team leader's teams, no SM; "own": the sales rate and slab only (2026-10-23).
    const view: "all" | "team" | "own" = scope.all ? "all" : scope.ledTeamIds.length ? "team" : "own";
    const named = (u: unknown) => ({ _id: idOf(u), name: (u as { name?: string }).name ?? "" });
    return {
      canEdit,
      seesHeld,
      view,
      tlRule: TL_RULE,
      courses: courses.map((c) => ({
        _id: String(c._id),
        name: c.name,
        amount: c.amount,
        status: c.status,
        commission: planFor(planOf(c), scope),
      })),
      salesManager: scope.all ? person(settings?.salesManager) : null,
      excludedUsers: scope.all ? ((settings?.excludedUsers ?? []) as unknown[]).map(person).filter(Boolean) : [],
      teams: view === "own" ? [] : teams.map((t) => {
        const leaders = ((t.leaders ?? []) as unknown[]).map(named);
        return {
          _id: String(t._id),
          name: t.name,
          leaders,
          ...(view === "team" ? { members: ((t.members ?? []) as unknown[]).map(named) } : {}),
          problem: leaders.length === 1 ? null : leaders.length ? `${leaders.length} leaders` : "No leader",
        };
      }),
      waiting,
      users: users.map((u) => ({ _id: String(u._id), name: u.name, email: u.email, status: u.status })),
      // The salary slabs in force this month, and the month they were set in (null: the sheet's).
      slabs: slabsForScope(slabs.slabs as unknown as Record<string, unknown>, scope),
      slabsFrom: slabs.from,
      slabsMonth: month,
    };
  }

  /** One course's row of the plan. Only for future approvals: a recorded sale keeps its amounts. */
  async updateCoursePlan(courseId: string, plan: Plan, userId: string) {
    const course = await Course.findById(courseId);
    if (!course) throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    course.set("commission", {
      sales: plan.sales,
      tl: plan.tl,
      sm: plan.sm,
      creditUsd: plan.creditUsd,
      updatedAt: new Date(),
      updatedBy: new Types.ObjectId(userId),
    });
    await course.save();
    return { _id: String(course._id), name: course.name, commission: planOf(course) };
  }

  async updateSettings(input: { salesManager?: string | null; excludedUsers?: string[] }, viewer: Viewer) {
    const ids = [
      ...(input.salesManager ? [input.salesManager] : []),
      ...(input.excludedUsers ?? []),
    ];
    const found = await User.countDocuments({ _id: { $in: [...new Set(ids)] } });
    if (found !== new Set(ids).size) throw Object.assign(new Error("Unknown user"), { statusCode: 400 });

    const set: Record<string, unknown> = { updatedBy: new Types.ObjectId(viewer.userId) };
    if (input.salesManager !== undefined) set.salesManager = input.salesManager ? new Types.ObjectId(input.salesManager) : null;
    if (input.excludedUsers !== undefined) set.excludedUsers = [...new Set(input.excludedUsers)].map((id) => new Types.ObjectId(id));
    await CommissionSettings.updateOne({ key: "default" }, { $set: set, $setOnInsert: { key: "default" } }, { upsert: true });
    // What waits on a Sales Manager, or on a login no longer excluded, settles
    // now rather than in a minute — where this process runs the timed jobs.
    if (env.RUN_SCHEDULERS) void sweepCommission();
    return this.getPlan(viewer);
  }

  /**
   * A month's commission as the viewer may see it: Super Admins and the Sales
   * Manager everything; a team leader their teams' sales (without the SM's
   * line) and their own lines anywhere; everyone else their own.
   */
  async getEarnings(viewer: Viewer, month: string) {
    const me = viewer.userId;
    const meId = new Types.ObjectId(me);
    // Own, a team leader's active teams, or everything (commissionScope).
    const who = await commissionScope(viewer);
    const ledTeams = who.ledTeamIds.map((id) => ({ _id: new Types.ObjectId(id) }));
    const myTeams = new Set(who.ledTeamIds);
    const scope: "all" | "team" | "own" = who.all ? "all" : myTeams.size ? "team" : "own";

    // The month's sales, and older ones with money received in it (2026-10-31: commission in the month collected).
    const { from, to } = monthRange(month);
    const and: Record<string, unknown>[] = [{ $or: [{ month }, { collections: { $elemMatch: { paidAt: { $gte: from, $lte: to } } } }] }];
    if (scope === "team") {
      and.push({ $or: [{ team: { $in: ledTeams.map((t) => t._id) } }, { "lines.user": meId }, { closer: meId }] });
    } else if (scope === "own") {
      and.push({ $or: [{ "lines.user": meId }, { closer: meId }] });
    }
    const filter: Record<string, unknown> = { $and: and };
    const sales = await CommissionSale.find(filter).sort({ saleDate: -1, approvedAt: -1 }).lean();

    const visible = (sale: (typeof sales)[number]) =>
      scope === "all"
        ? sale.lines
        : sale.lines.filter(
            (l) =>
              String(l.user) === me ||
              (scope === "team" && myTeams.has(String(sale.team)) && l.role !== "sm"),
          );

    // Earned: each line's share of what came in this month. Balance: its share of what the client still owes.
    type Tally = { count: number; amount: number; balance: number };
    const people = new Map<string, { _id: string; name: string; sales: Tally; tl: Tally; sm: Tally; total: number; balance: number }>();
    for (const sale of sales) {
      if (sale.state !== "counted") continue;
      const share = shareBetween(sale, from, to);
      const owed = owedShareOf(sale);
      for (const l of visible(sale)) {
        const earned = partOf(l.amount, share);
        const balance = partOf(l.amount, owed);
        if (earned <= 0 && balance <= 0) continue;
        const key = String(l.user);
        const p = people.get(key) ?? {
          _id: key,
          name: l.userName,
          sales: { count: 0, amount: 0, balance: 0 },
          tl: { count: 0, amount: 0, balance: 0 },
          sm: { count: 0, amount: 0, balance: 0 },
          total: 0,
          balance: 0,
        };
        if (earned > 0) p[l.role].count++;
        p[l.role].amount = round2(p[l.role].amount + earned);
        p[l.role].balance = round2(p[l.role].balance + balance);
        p.total = round2(p.total + earned);
        p.balance = round2(p.balance + balance);
        people.set(key, p);
      }
    }

    const count = (state: CommissionSaleState) => sales.filter((s) => s.state === state).length;
    const list = sales.map((s) => ({
      _id: String(s._id),
      studentName: s.studentName,
      enrollmentNumber: s.enrollmentNumber ?? "",
      invoiceNumber: s.invoiceNumber ?? "",
      courseName: s.courseName,
      closerName: s.closerName,
      teamName: s.teamName,
      saleDate: s.saleDate,
      approvedAt: s.approvedAt,
      state: s.state,
      reason: s.reason,
      fee: s.fee ?? null,
      paidShare: shareOf(s),
      /** The share of the fee received in this month — what the lines earn here. */
      monthShare: shareBetween(s, from, to),
      lines: visible(s).map((l) => ({
        role: l.role, user: String(l.user), userName: l.userName, amount: l.amount,
        earned: partOf(l.amount, shareBetween(s, from, to)), balance: partOf(l.amount, owedShareOf(s)), note: l.note ?? "",
      })),
    }));

    return {
      month,
      scope,
      tlRule: TL_RULE,
      people: [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      sales: list,
      totals: {
        amount: round2([...people.values()].reduce((s, p) => s + p.total, 0)),
        balance: round2([...people.values()].reduce((s, p) => s + p.balance, 0)),
        counted: count("counted"),
        waiting: count("waiting"),
        excluded: count("excluded"),
        reversed: count("reversed"),
        progress: count("progress"),
      },
    };
  }

  /**
   * What a sale would earn if it were approved now — for the closing dialog,
   * before anything is saved. The same rules as a real sale, written nowhere.
   */
  async preview(input: { course: string; team?: string; closer?: string }, viewer: Viewer) {
    const course = await Course.findById(input.course).select("name commission").lean();
    if (!course) throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    const plan = planOf(course);
    const config = await loadConfig();
    const names = new Names();
    const resolved = await resolveSale({ closer: input.closer, saleTeam: input.team, plan }, config, names);
    const closer = input.closer ?? "";

    // On hold, the closer's own share is still worth showing — it is what they
    // earn once the hold is fixed.
    const closerLines =
      resolved.state === "counted"
        ? resolved.lines.filter((l) => String(l.user) === closer)
        : resolved.state === "waiting" && Types.ObjectId.isValid(closer)
          ? [{ role: "sales" as const, user: new Types.ObjectId(closer), userName: await names.of(closer), amount: plan.sales }]
          : [];

    // Only what the viewer may see (2026-10-23): their own line(s), a team leader's team's lines but the SM's — it used
    // to answer anyone signed in with every line of any closer's sale, names and amounts.
    const scope = await commissionScope(viewer);
    const visible = (l: { user?: unknown; role?: string }) => canSeeLine(scope, viewer.userId, l, closer);
    return {
      courseName: course.name,
      plan: planFor(plan, scope),
      state: resolved.state,
      reason: resolved.reason,
      teamName: resolved.teamName,
      closerName: closer ? await names.of(closer) : "",
      closerTotal: closerLines.filter(visible).reduce((s, l) => s + l.amount, 0),
      lines: (resolved.state === "counted" ? resolved.lines : closerLines).filter(visible).map((l) => ({
        role: l.role,
        user: String(l.user),
        userName: l.userName,
        amount: l.amount,
        note: l.note ?? "",
      })),
    };
  }
}
