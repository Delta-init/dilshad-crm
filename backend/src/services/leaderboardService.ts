import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { LeadCall } from "../models/LeadCall.js";
import { dubaiDayStart, dubaiToday } from "../utils/dubaiDay.js";
import { CommissionSettings } from "../models/CommissionSettings.js";
import { COUNTED_PAYMENT } from "../utils/countedPayments.js";
import { bangaloreLeadsUnion } from "../utils/bangaloreRevenue.js";
import { addCounts, closingsWithoutEnrolment } from "../utils/closedWithoutEnrolment.js";

/*
 * The month's leaderboard (the owner, 2026-10-07): every active salesperson,
 * ranked by revenue, then closings, then follow-ups, then calls — or, since
 * 2026-10-14, by calls or by talk time (`rankBy`). Months are Dubai months
 * (Asia/Dubai). Super admins and the commission plan's excluded people are left
 * out. Everyone signed in sees the whole board.
 *
 *  • Revenue   — payments dated in the month on the leads each person holds; a Bangalore enrolment's
 *                rupees too, in AED (utils/bangaloreRevenue.ts, 2026-10-28).
 *  • Closings  — enrolments in the month credited to them (not dropped ones), and since 2026-10-31 their Closed leads
 *                with no enrolment, on the day each was marked Closed (utils/closedWithoutEnrolment.ts).
 *  • Follow-ups — follow-ups they logged in the month.
 *  • Calls     — since 2026-10-14, their calls with leads through 3CX in the
 *                month (lead_calls, in and out — the Calls page's count):
 *                calls, connected, and talk time. Theirs by the call's person
 *                (the 3CX extension → the user who has it). The old click-to-
 *                call log (call_logs) no longer counts.
 *  • Today     — the same calls today (the Dubai day), whatever month is
 *                shown, and the leads each person holds now, by status
 *                (2026-10-15, for the open board — a TV board, live — and
 *                this one).
 *
 * The same board is open to anyone at /public/leaderboard (routes/publicRoutes.ts), live over the socket's
 * /public-leaderboard namespace (services/leaderboardLive.ts).
 */

/** Talk-time targets, as on the Bangalore CRM's board: minutes on 3CX a day and a month. */
export const TALK_TARGETS = { dayMinutes: 100, monthMinutes: 1000 } as const;

// 1900-01 … 2099-12: a year like 0099 would be read as 1999 by Date.UTC.
const MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;

export function isLeaderboardMonth(v: unknown): v is string {
  return typeof v === "string" && MONTH.test(v);
}

/** How the board is ordered: revenue (then closings, follow-ups, calls), calls (then talk time), or talk time. */
export const RANK_BY = ["revenue", "calls", "talk"] as const;
export type RankBy = (typeof RANK_BY)[number];
export const isRankBy = (v: unknown): v is RankBy => typeof v === "string" && (RANK_BY as readonly string[]).includes(v);

/** "2026-10" → its start and end on the Dubai calendar; the current month when none is given. */
export function dubaiMonthRange(month?: string): { month: string; from: Date; to: Date } {
  const m = month && MONTH.test(month) ? month : dubaiToday().slice(0, 7);
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  return { month: m, from: dubaiDayStart(`${m}-01`)!, to: dubaiDayStart(`${next}-01`)! };
}

/** Today on the Dubai calendar, as instants. */
function dubaiTodayRange(): { $gte: Date; $lt: Date } {
  const from = dubaiDayStart(dubaiToday())!;
  return { $gte: from, $lt: new Date(from.getTime() + 24 * 3_600_000) };
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  revenue: number;
  closings: number;
  followUps: number;
  calls: number;
  connected: number;
  talkSeconds: number;
  /** Today's (Dubai) 3CX calls, the connected ones and talk time — whatever month the board shows. */
  callsToday: number;
  connectedToday: number;
  talkSecondsToday: number;
  /** The leads they hold now, by status; and how many in all. */
  leadCounts: Record<string, number>;
  totalLeads: number;
}

export interface Leaderboard {
  month: string;
  rankBy: RankBy;
  /** The month shown is the current one (today's figures belong to it). */
  currentMonth: boolean;
  targets: typeof TALK_TARGETS;
  /** When this was counted. */
  updatedAt: string;
  rows: LeaderboardRow[];
}

type CallTotals = { _id: Types.ObjectId; calls: number; connected: number; talkSeconds: number };
type UnrankedRow = Omit<LeaderboardRow, "rank">;

/** Revenue (then closings, follow-ups, calls), calls (then talk time, connected) or talk time (then calls); then name. */
function compareRows(rankBy: RankBy) {
  return (a: UnrankedRow, b: UnrankedRow): number => {
    const byName = a.name.localeCompare(b.name);
    if (rankBy === "calls") return b.calls - a.calls || b.talkSeconds - a.talkSeconds || b.connected - a.connected || byName;
    if (rankBy === "talk") return b.talkSeconds - a.talkSeconds || b.calls - a.calls || b.connected - a.connected || byName;
    return b.revenue - a.revenue || b.closings - a.closings || b.followUps - a.followUps || b.calls - a.calls || byName;
  };
}

function rankRows(rows: UnrankedRow[], rankBy: RankBy): LeaderboardRow[] {
  return [...rows].sort(compareRows(rankBy)).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The same count, ranked another way — nothing counted again. */
export function rerankLeaderboard(board: Leaderboard, rankBy: RankBy): Leaderboard {
  if (board.rankBy === rankBy) return board;
  return { ...board, rankBy, rows: rankRows(board.rows.map(({ rank: _rank, ...r }) => r), rankBy) };
}

// A lead with no status (only a raw database write could leave one) counts as "unknown", not "null" or "".
const STATUS_KEY = { $let: { vars: { s: { $ifNull: ["$status", ""] } }, in: { $cond: [{ $eq: ["$$s", ""] }, "unknown", "$$s"] } } };

type Counted = { _id: Types.ObjectId | null; n: number };
const byId = (rows: Counted[]) => new Map(rows.filter((r) => r._id).map((r) => [String(r._id), r.n]));

export class LeaderboardService {
  /**
   * `opts.withSuperAdmins` keeps Super Admins in (the Root Sales TV, 2026-10-20: a Super Admin who leads or sits in
   * a sales team — dilshad in Remote — is shown there with their figures; the CRM's own board still leaves them out).
   */
  async getLeaderboard(month?: string, rankBy: RankBy = "revenue", opts: { withSuperAdmins?: boolean } = {}): Promise<Leaderboard> {
    const range = dubaiMonthRange(month);
    const inMonth = { $gte: range.from, $lt: range.to };
    const bangalore = await bangaloreLeadsUnion();

    const [people, settings, revenue, closings, followUps, calls, callsToday, statuses] = await Promise.all([
      User.find({ status: "active" })
        .select("name extension role")
        .populate("role", "roleName isSystemRole")
        .lean<{ _id: Types.ObjectId; name: string; extension?: string | null; role?: { roleName?: string; isSystemRole?: boolean } | null }[]>(),
      CommissionSettings.findOne().select("excludedUsers").lean<{ excludedUsers?: Types.ObjectId[] } | null>(),
      Lead.aggregate<Counted>([
        ...bangalore,
        { $match: { "payments.paidAt": inMonth } },
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: { "payments.paidAt": inMonth } },
        { $group: { _id: "$assignedTo", n: { $sum: "$payments.amount" } } },
      ]),
      Promise.all([
        Student.aggregate<Counted>([
          { $match: { enrollmentDate: inMonth, status: { $ne: "dropped" } } },
          { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
        ]),
        Lead.aggregate<Counted>(closingsWithoutEnrolment(inMonth)),
      ]).then(([enrolled, closedOnly]) => addCounts(enrolled, closedOnly)),
      this.followUpsBy(inMonth),
      this.callsIn(inMonth),
      this.callsIn(dubaiTodayRange()),
      Lead.aggregate<{ _id: { u: Types.ObjectId; s: string }; n: number }>([
        { $match: { assignedTo: { $ne: null } } },
        { $group: { _id: { u: "$assignedTo", s: STATUS_KEY }, n: { $sum: 1 } } },
      ]),
    ]);

    const excluded = new Set((settings?.excludedUsers ?? []).map(String));
    const staff = people.filter((p) => (opts.withSuperAdmins || !(p.role?.isSystemRole && p.role.roleName === "Super Admin")) && !excluded.has(String(p._id)));

    // A call is theirs when it was taken or made on their 3CX extension (the sync links it to them).
    const callsOf = new Map(calls.map((c) => [String(c._id), c]));
    const todayOf = new Map(callsToday.map((c) => [String(c._id), c]));
    const leadsOf = new Map<string, Record<string, number>>();
    for (const r of statuses) {
      const who = String(r._id.u);
      const counts = leadsOf.get(who) ?? {};
      counts[r._id.s] = (counts[r._id.s] ?? 0) + r.n;
      leadsOf.set(who, counts);
    }

    const rev = byId(revenue), clo = byId(closings), fol = byId(followUps);
    const rows = staff
      .map((p): UnrankedRow => {
        const id = String(p._id);
        const leadCounts = leadsOf.get(id) ?? {};
        return {
          userId: id,
          name: p.name,
          revenue: Math.round((rev.get(id) ?? 0) * 100) / 100,
          closings: clo.get(id) ?? 0,
          followUps: fol.get(id) ?? 0,
          calls: callsOf.get(id)?.calls ?? 0,
          connected: callsOf.get(id)?.connected ?? 0,
          talkSeconds: callsOf.get(id)?.talkSeconds ?? 0,
          callsToday: todayOf.get(id)?.calls ?? 0,
          connectedToday: todayOf.get(id)?.connected ?? 0,
          talkSecondsToday: todayOf.get(id)?.talkSeconds ?? 0,
          leadCounts,
          totalLeads: Object.values(leadCounts).reduce((sum, n) => sum + n, 0),
        };
      });

    return {
      month: range.month,
      rankBy,
      currentMonth: range.month === dubaiMonthRange().month,
      targets: TALK_TARGETS,
      updatedAt: new Date().toISOString(),
      rows: rankRows(rows, rankBy),
    };
  }

  /** 3CX calls with leads in a span, by the call's person (the sync links an extension to its user). */
  private callsIn(span: { $gte: Date; $lt: Date }) {
    return LeadCall.aggregate<CallTotals>([
      { $match: { startedAt: span, user: { $ne: null } } },
      {
        $group: {
          _id: "$user",
          calls: { $sum: 1 },
          connected: { $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] } },
          talkSeconds: { $sum: { $ifNull: ["$talkSeconds", 0] } },
        },
      },
    ]);
  }

  /** Follow-ups each person logged in the month. */
  private followUpsBy(inMonth: { $gte: Date; $lt: Date }) {
    return Lead.aggregate<Counted>([
      { $match: { "followUps.followedUpAt": inMonth } },
      { $unwind: "$followUps" },
      { $match: { "followUps.followedUpAt": inMonth } },
      { $group: { _id: "$followUps.followedUpBy", n: { $sum: 1 } } },
    ]);
  }
}
