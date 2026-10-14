import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Lead } from "../models/Lead.js";
import { Student } from "../models/Student.js";
import { LeadCall } from "../models/LeadCall.js";
import { dubaiDayStart, dubaiToday } from "../utils/dubaiDay.js";
import { CommissionSettings } from "../models/CommissionSettings.js";

/*
 * The month's leaderboard (the owner, 2026-10-07): every active salesperson,
 * ranked by revenue, then closings, then follow-ups, then calls — or, since
 * 2026-10-14, by calls or by talk time (`rankBy`). Months are Dubai months
 * (Asia/Dubai). Super admins and the commission plan's excluded people are left
 * out. Everyone signed in sees the whole board.
 *
 *  • Revenue   — payments dated in the month on the leads each person holds.
 *  • Closings  — enrolments in the month credited to them (not dropped ones).
 *  • Follow-ups — follow-ups they logged in the month.
 *  • Calls     — since 2026-10-14, their calls with leads through 3CX in the
 *                month (lead_calls, in and out — the Calls page's count):
 *                calls, connected, and talk time. Theirs by the call's person
 *                (the 3CX extension → the user who has it). The old click-to-
 *                call log (call_logs) no longer counts.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

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
}

type Counted = { _id: Types.ObjectId | null; n: number };
const byId = (rows: Counted[]) => new Map(rows.filter((r) => r._id).map((r) => [String(r._id), r.n]));

export class LeaderboardService {
  async getLeaderboard(month?: string, rankBy: RankBy = "revenue"): Promise<{ month: string; rankBy: RankBy; rows: LeaderboardRow[] }> {
    const range = dubaiMonthRange(month);
    const inMonth = { $gte: range.from, $lt: range.to };

    const [people, settings, revenue, closings, followUps, calls] = await Promise.all([
      User.find({ status: "active" })
        .select("name extension role")
        .populate("role", "roleName isSystemRole")
        .lean<{ _id: Types.ObjectId; name: string; extension?: string | null; role?: { roleName?: string; isSystemRole?: boolean } | null }[]>(),
      CommissionSettings.findOne().select("excludedUsers").lean<{ excludedUsers?: Types.ObjectId[] } | null>(),
      Lead.aggregate<Counted>([
        { $match: { "payments.paidAt": inMonth } },
        { $unwind: "$payments" },
        { $match: { "payments.paidAt": inMonth } },
        { $group: { _id: "$assignedTo", n: { $sum: "$payments.amount" } } },
      ]),
      Student.aggregate<Counted>([
        { $match: { enrollmentDate: inMonth, status: { $ne: "dropped" } } },
        { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
      ]),
      this.followUpsBy(inMonth),
      LeadCall.aggregate<{ _id: Types.ObjectId; calls: number; connected: number; talkSeconds: number }>([
        { $match: { startedAt: inMonth, user: { $ne: null } } },
        {
          $group: {
            _id: "$user",
            calls: { $sum: 1 },
            connected: { $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] } },
            talkSeconds: { $sum: { $ifNull: ["$talkSeconds", 0] } },
          },
        },
      ]),
    ]);

    const excluded = new Set((settings?.excludedUsers ?? []).map(String));
    const staff = people.filter((p) => !(p.role?.isSystemRole && p.role.roleName === "Super Admin") && !excluded.has(String(p._id)));

    // A call is theirs when it was taken or made on their 3CX extension (the sync links it to them).
    const callsOf = new Map(calls.map((c) => [String(c._id), c]));

    const rev = byId(revenue), clo = byId(closings), fol = byId(followUps);
    const rows = staff
      .map((p) => {
        const id = String(p._id);
        return {
          userId: id,
          name: p.name,
          revenue: Math.round((rev.get(id) ?? 0) * 100) / 100,
          closings: clo.get(id) ?? 0,
          followUps: fol.get(id) ?? 0,
          calls: callsOf.get(id)?.calls ?? 0,
          connected: callsOf.get(id)?.connected ?? 0,
          talkSeconds: callsOf.get(id)?.talkSeconds ?? 0,
        };
      })
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        if (rankBy === "calls") return b.calls - a.calls || b.talkSeconds - a.talkSeconds || b.connected - a.connected || byName;
        if (rankBy === "talk") return b.talkSeconds - a.talkSeconds || b.calls - a.calls || b.connected - a.connected || byName;
        return b.revenue - a.revenue || b.closings - a.closings || b.followUps - a.followUps || b.calls - a.calls || byName;
      })
      .map((r, i) => ({ rank: i + 1, ...r }));

    return { month: range.month, rankBy, rows };
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
