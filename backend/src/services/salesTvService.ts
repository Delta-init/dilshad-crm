import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { Student } from "../models/Student.js";
import { LeaderboardService } from "./leaderboardService.js";
import { saleClosedOf } from "./saleAnnouncement.js";
import { gstMidnight } from "./breakClock.js";
import { ACADEMY_CURRENCY } from "../types/index.js";

/*
 * The Root portal's Sales TV (the user, 2026-10-20: "Dubai, Draw and Remote on
 * one screen — closings and calls, only the sales staff, the closing pop-up
 * with the amount and the sound, and who is on a break"). What this CRM tells
 * it, over GET /api/v1/service/sales-tv — the same shape as the Sales CRM's:
 *
 *   people    the sales staff — members and leaders of an active team, active,
 *             no Super Admins, not excluded from commission (the Leaderboard
 *             leaves those out) — with this month's and today's (the Dubai
 *             day) closings, this month's revenue, and today's 3CX calls,
 *             connected and talk time (the Leaderboard's own counts)
 *   onBreak   who pressed "Take break" today and hasn't ended it
 *   closes    closes after `after` (an instant; else the last two hours; never
 *             more than a day back), the newest 20 — what the sale-closed
 *             pop-up says (saleAnnouncement.ts), with the amount in the
 *             academy's currency (Dubai AED, Bangalore INR — a payment taken in
 *             another currency is converted at the close), never the student's
 *             name
 *
 * `parts=live` answers only onBreak and closes — cheap, for every few seconds;
 * the people's counts come every half minute or so. Read-only.
 */

export const SALES_TV_CRM = "remote";
const DAY_MS = 86_400_000;
const CLOSES_DEFAULT_MS = 2 * 3_600_000;
const CLOSES_MAX = 20;

/** Each member or leader of an active team → that team's name (the first one found). */
async function teamPeople(): Promise<Map<string, string>> {
  const teams = await Team.find({ status: "active" }).sort({ name: 1 }).select("name members leaders")
    .lean<Array<{ name: string; members?: Types.ObjectId[]; leaders?: Types.ObjectId[] }>>();
  const teamOf = new Map<string, string>();
  for (const t of teams) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) if (!teamOf.has(String(u))) teamOf.set(String(u), t.name);
  return teamOf;
}

export interface SalesTvPerson {
  id: string; name: string; email: string; team: string;
  closingsMonth: number; closingsToday: number; revenueMonth: number;
  callsToday: number; connectedToday: number; talkSecondsToday: number;
}

export interface SalesTvBreak { id: string; name: string; email: string; team: string; since: string; kind: string | null }

export interface SalesTvClose {
  id: string; closer: string; closerEmail: string; courses: string[]; amount: number;
  academy: "dubai" | "bangalore"; currency: "AED" | "INR"; at: string;
}

export interface SalesTv {
  crm: typeof SALES_TV_CRM;
  generatedAt: string;
  month?: string;
  onBreak: SalesTvBreak[];
  closes: SalesTvClose[];
  people?: SalesTvPerson[];
}

export async function salesTv(q: { after?: string; parts?: string }): Promise<SalesTv> {
  const now = Date.now();
  const teamOf = await teamPeople();
  const after = q.after && Number.isFinite(Date.parse(q.after)) ? Date.parse(q.after) : null;
  const since = new Date(after !== null ? Math.max(after, now - DAY_MS) : now - CLOSES_DEFAULT_MS);
  const midnight = gstMidnight(new Date(now));

  const [breakers, closed] = await Promise.all([
    User.find({ status: "active", breakSince: { $gte: midnight } }).select("name email breakSince breakKind")
      .lean<Array<{ _id: Types.ObjectId; name: string; email: string; breakSince: Date; breakKind?: string | null }>>(),
    Student.find({ createdAt: { $gt: since }, status: { $ne: "dropped" } }).sort({ createdAt: -1, _id: -1 }).limit(CLOSES_MAX)
      .populate("course", "name").populate("assignedTo", "name email")
      .select("course assignedTo totalFee academy createdAt")
      .lean<Array<{ _id: Types.ObjectId; course?: unknown; assignedTo?: { name?: string; email?: string } | null; totalFee?: number; academy?: string; createdAt: Date }>>(),
  ]);
  const onBreak: SalesTvBreak[] = breakers
    .map((u) => ({
      id: String(u._id), name: u.name, email: u.email, team: teamOf.get(String(u._id)) ?? "", since: new Date(u.breakSince).toISOString(), kind: u.breakKind ?? null,
    }))
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const closes: SalesTvClose[] = closed.map((s) => {
    // The pop-up's own words, less the student's name: this is a public screen.
    const { student: _student, ...c } = saleClosedOf(s);
    return {
      ...c,
      at: new Date(s.createdAt).toISOString(),
      closerEmail: String(s.assignedTo?.email ?? ""),
      currency: ACADEMY_CURRENCY[c.academy],
    };
  });

  const base: SalesTv = { crm: SALES_TV_CRM, generatedAt: new Date(now).toISOString(), onBreak, closes };
  if (q.parts === "live") return base;

  const board = await new LeaderboardService().getLeaderboard();
  const todayClosings = await Student.aggregate<{ _id: Types.ObjectId | null; n: number }>([
    { $match: { enrollmentDate: { $gte: midnight, $lt: new Date(midnight.getTime() + DAY_MS) }, status: { $ne: "dropped" } } },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ]);
  const today = new Map(todayClosings.filter((r) => r._id).map((r) => [String(r._id), r.n]));
  const rows = board.rows.filter((r) => teamOf.has(r.userId));
  const emails = new Map(
    (await User.find({ _id: { $in: rows.map((r) => new Types.ObjectId(r.userId)) } }).select("email").lean<Array<{ _id: Types.ObjectId; email: string }>>())
      .map((u) => [String(u._id), u.email]),
  );
  const people: SalesTvPerson[] = rows.map((r) => ({
    id: r.userId, name: r.name, email: emails.get(r.userId) ?? "", team: teamOf.get(r.userId) ?? "",
    closingsMonth: r.closings, closingsToday: today.get(r.userId) ?? 0, revenueMonth: r.revenue,
    callsToday: r.callsToday, connectedToday: r.connectedToday, talkSecondsToday: r.talkSecondsToday,
  })).sort((a, b) => b.closingsMonth - a.closingsMonth || b.closingsToday - a.closingsToday || b.callsToday - a.callsToday
    || b.talkSecondsToday - a.talkSecondsToday || a.name.localeCompare(b.name));
  return { ...base, month: board.month, people };
}
