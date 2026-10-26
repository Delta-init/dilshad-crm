import mongoose from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { COUNTED_PAYMENT, COUNTED_TOTAL } from "../utils/countedPayments.js";

const ALL_STATUSES = [
  "new", "assigned", "pending_response", "followup", "meeting_scheduled", "meeting_done", "closed", "lost",
  "not_connected", "wrong_number", "mia", "repeated", "callback", "cnc",
] as const;

type LeadStatus = (typeof ALL_STATUSES)[number];

interface DateFilter {
  createdAt?: { $gte?: Date; $lte?: Date };
}

export class ReportService {
  // ── Date helpers ────────────────────────────────────────────────────────────

  private buildDateFilter(dateFrom?: string, dateTo?: string): DateFilter {
    if (!dateFrom && !dateTo) return {};
    const f: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) f.$gte = new Date(dateFrom + "T00:00:00.000Z");
    if (dateTo)   f.$lte = new Date(dateTo   + "T23:59:59.999Z");
    return { createdAt: f };
  }

  // Build per-status $sum expressions for $group stage
  private statusSumFields() {
    return ALL_STATUSES.reduce<Record<string, unknown>>((acc, s) => {
      acc[s] = { $sum: { $cond: [{ $eq: ["$status", s] }, 1, 0] } };
      return acc;
    }, {});
  }

  // ── 1. Overview KPIs + status & source distributions ────────────────────────

  async getOverview(dateFrom?: string, dateTo?: string) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // Status distribution
    const statusAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const statusMap: Record<string, number> = {};
    ALL_STATUSES.forEach((s) => (statusMap[s] = 0));
    let total = 0;
    for (const item of statusAgg) {
      statusMap[item._id] = item.count;
      total += item.count;
    }

    // Source distribution
    const sourceAgg = await Lead.aggregate([
      { $match: match },
      { $group: { _id: { $ifNull: ["$source", "other"] }, count: { $sum: 1 } } },
    ]);

    const sourceDist = sourceAgg
      .map((i) => ({ source: (i._id as string) || "other", count: i.count as number }))
      .sort((a, b) => b.count - a.count);

    // Team & user counts
    const [activeTeams, totalTeams, activeUsers] = await Promise.all([
      Team.countDocuments({ status: "active" }),
      Team.countDocuments(),
      User.countDocuments({ status: "active" }),
    ]);

    const conversionRate =
      total > 0 ? +((statusMap.closed / total) * 100).toFixed(1) : 0;

    return {
      summary: {
        total,
        closed: statusMap.closed,
        conversionRate,
        activeTeams,
        totalTeams,
        activeUsers,
      },
      statusDistribution: ALL_STATUSES.map((s) => ({
        status: s,
        count:  statusMap[s],
        pct:    total > 0 ? +((statusMap[s] / total) * 100).toFixed(1) : 0,
      })),
      sourceDistribution: sourceDist,
    };
  }

  // ── 2. Lead timeline (daily / weekly / monthly) ──────────────────────────────

  async getTimeline(
    period: "daily" | "weekly" | "monthly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let groupId: any;
    if (period === "daily") {
      groupId = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    } else if (period === "weekly") {
      groupId = {
        year: { $isoWeekYear: "$createdAt" },
        week: { $isoWeek: "$createdAt" },
      };
    } else {
      groupId = {
        year:  { $year:  "$createdAt" },
        month: { $month: "$createdAt" },
      };
    }

    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:   groupId,
          total: { $sum: 1 },
          ...this.statusSumFields(),
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    return agg.map((item) => {
      let label: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = item._id as any;

      if (typeof id === "string") {
        label = id; // YYYY-MM-DD
      } else if (id?.week !== undefined) {
        label = `W${id.week} '${String(id.year).slice(2)}`;
      } else {
        label = `${MONTHS[id.month]} '${String(id.year).slice(2)}`;
      }

      const row: Record<string, number | string> = { label, total: item.total as number };
      ALL_STATUSES.forEach((s) => { row[s] = item[s] as number ?? 0; });
      return row;
    });
  }

  // ── 3. User rankings ─────────────────────────────────────────────────────────

  async getUserRankings(dateFrom?: string, dateTo?: string, limit = 20) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    const agg = await Lead.aggregate([
      { $match: { ...match, assignedTo: { $exists: true, $ne: null } } },
      // Lookup course to get course fee for pending calculation
      {
        $lookup: {
          from:         "courses",
          localField:   "course",
          foreignField: "_id",
          as:           "courseInfo",
        },
      },
      {
        $group: {
          _id:           "$assignedTo",
          total:         { $sum: 1 },
          revenue:       { $sum: COUNTED_TOTAL },
          courseRevenue: {
            $sum: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$courseInfo", []] } }, 0] },
                { $arrayElemAt: ["$courseInfo.amount", 0] },
                0,
              ],
            },
          },
          ...this.statusSumFields(),
        },
      },
      {
        $addFields: {
          pendingAmount: { $max: [0, { $subtract: ["$courseRevenue", "$revenue"] }] },
        },
      },
      { $sort: { closed: -1, total: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from:         "users",
          localField:   "_id",
          foreignField: "_id",
          as:           "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: false } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        $project: {
          userId:        "$_id",
          name:          "$user.name",
          email:         "$user.email",
          designation:   "$user.designation",
          total:         1,
          revenue:       1,
          pendingAmount: 1,
          new: 1, assigned: 1, pending_response: 1, followup: 1,
          lost: 1, not_connected: 1, mia: 1, repeated: 1, callback: 1, cnc: 1, closed: 1,
          meeting_scheduled: 1, meeting_done: 1, wrong_number: 1,
          conversionRate: {
            $cond: [
              { $gt: ["$total", 0] },
              { $round: [{ $multiply: [{ $divide: ["$closed", "$total"] }, 100] }, 1] },
              0,
            ],
          },
        } as Record<string, unknown>,
      },
    ]);

    return agg.map((item, i) => ({ ...item, rank: i + 1 }));
  }

  // ── 4. Team rankings ─────────────────────────────────────────────────────────

  async getTeamRankings(dateFrom?: string, dateTo?: string) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // This-month window for the thisMonth field (always current month, regardless of date filter)
    const rankNow = new Date();
    const rankMonthStart = new Date(Date.UTC(rankNow.getUTCFullYear(), rankNow.getUTCMonth(), 1));

    const agg = await Lead.aggregate([
      { $match: { ...match, team: { $exists: true, $ne: null } } },
      {
        $group: {
          _id:           "$team",
          total:         { $sum: 1 },
          // Sum all payments[].amount across every lead in this team
          totalPayments: { $sum: COUNTED_TOTAL },
          ...this.statusSumFields(),
        },
      },
      // Rank by highest total payments collected
      { $sort: { totalPayments: -1, total: -1 } },
      {
        $lookup: {
          from:         "teams",
          localField:   "_id",
          foreignField: "_id",
          as:           "team",
        },
      },
      { $unwind: { path: "$team", preserveNullAndEmptyArrays: false } },
      {
        $project: {
          teamId:        "$_id",
          name:          "$team.name",
          description:   "$team.description",
          memberCount:   { $size: { $ifNull: ["$team.members", []] } },
          total:         1,
          totalPayments: 1,
          new: 1, assigned: 1, pending_response: 1, followup: 1,
          lost: 1, not_connected: 1, mia: 1, repeated: 1, callback: 1, cnc: 1, closed: 1,
          meeting_scheduled: 1, meeting_done: 1, wrong_number: 1,
          conversionRate: {
            $cond: [
              { $gt: ["$total", 0] },
              { $round: [{ $multiply: [{ $divide: ["$closed", "$total"] }, 100] }, 1] },
              0,
            ],
          },
        } as Record<string, unknown>,
      },
    ]);

    // Enrich each team with this month's lead count
    const enriched = await Promise.all(
      agg.map(async (item, i) => {
        const thisMonth = await Lead.countDocuments({
          team: item.teamId,
          createdAt: { $gte: rankMonthStart },
        });
        return { ...item, rank: i + 1, thisMonth };
      }),
    );
    return enriched;
  }

  // ── 5. Team lead split over time ─────────────────────────────────────────────

  async getTeamSplit(
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = this.buildDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$createdAt" }, week: { $isoWeek: "$createdAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };
    } else {
      bucketId = { year: { $year: "$createdAt" } };
    }

    // Aggregate: per (time-bucket, team) → count + status breakdown
    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:   { bucket: bucketId, team: "$team" },
          count: { $sum: 1 },
          ...this.statusSumFields(),
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from:         "teams",
          localField:   "_id.team",
          foreignField: "_id",
          as:           "teamInfo",
        },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:   "$_id.bucket",
          teamId:   "$_id.team",
          teamName: { $ifNull: ["$teamInfo.name", "Unassigned"] },
          count:    1,
          new: 1, assigned: 1, pending_response: 1, followup: 1,
          lost: 1, not_connected: 1, mia: 1, repeated: 1, callback: 1, cnc: 1, closed: 1,
          meeting_scheduled: 1, meeting_done: 1, wrong_number: 1,
        } as Record<string, unknown>,
      },
    ]);

    // Collect all unique team names (for chart series)
    const teamSet = new Map<string, string>(); // teamId → teamName
    for (const row of agg) {
      const tid = row.teamId ? String(row.teamId) : "unassigned";
      teamSet.set(tid, row.teamName as string);
    }

    // Build per-bucket totals
    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // Determine label from bucket
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week} '${String(b.year).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      if (!bucketMap.has(label)) {
        bucketMap.set(label, { label, total: 0 });
      }

      const bucket = bucketMap.get(label)!;
      const tid    = row.teamId ? String(row.teamId) : "unassigned";
      const tname  = row.teamName as string;

      bucket[tname] = (bucket[tname] ?? 0) + (row.count as number);
      bucket.total  = (bucket.total  ?? 0) + (row.count as number);

      // also accumulate status breakdown per team
      const statusKey = `${tname}__status`;
      if (!bucket[statusKey]) {
        bucket[statusKey] = { new: 0, assigned: 0, pending_response: 0, followup: 0, closed: 0, lost: 0, not_connected: 0, mia: 0, repeated: 0, callback: 0, cnc: 0, meeting_scheduled: 0, meeting_done: 0, wrong_number: 0 };
      }
      ALL_STATUSES.forEach((s) => {
        bucket[statusKey][s] = (bucket[statusKey][s] ?? 0) + ((row[s] as number) ?? 0);
      });
    }

    // Team summary totals (across all periods)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const teamTotals = new Map<string, Record<string, any>>();
    for (const row of agg) {
      const tname = row.teamName as string;
      if (!teamTotals.has(tname)) {
        teamTotals.set(tname, { teamName: tname, total: 0, closed: 0, ...Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) });
      }
      const t = teamTotals.get(tname)!;
      t.total += row.count as number;
      ALL_STATUSES.forEach((s) => { t[s] += (row[s] as number) ?? 0; });
    }

    const teams = Array.from(teamSet.values());
    const timeline = Array.from(bucketMap.values());
    const summary  = Array.from(teamTotals.values()).sort((a, b) => b.total - a.total).map((t, i) => ({
      ...t,
      rank: i + 1,
      conversionRate: t.total > 0 ? +((t.closed / t.total) * 100).toFixed(1) : 0,
    }));

    return { teams, timeline, summary };
  }

  // ── Revenue helpers ──────────────────────────────────────────────────────────

  /** Build a match filter on payments.paidAt (used after $unwind: "$payments") */
  private buildPaymentDateFilter(dateFrom?: string, dateTo?: string): Record<string, unknown> {
    if (!dateFrom && !dateTo) return {};
    const f: { $gte?: Date; $lte?: Date } = {};
    if (dateFrom) f.$gte = new Date(dateFrom + "T00:00:00.000Z");
    if (dateTo)   f.$lte = new Date(dateTo   + "T23:59:59.999Z");
    return { "payments.paidAt": f };
  }

  // ── 6. Revenue overview ───────────────────────────────────────────────────────

  async getRevenueOverview(dateFrom?: string, dateTo?: string) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);
    const leadMatch    = this.buildDateFilter(dateFrom, dateTo);

    const [summaryAgg, teamAgg, agentAgg, pendingAgg, overpaidAgg] = await Promise.all([
      // ── total revenue / payment count / paying leads
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          null,
            totalRevenue: { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
      ]),

      // ── top teams by revenue
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$team",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "teams", localField: "_id", foreignField: "_id", as: "teamInfo",
          },
        },
        { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            teamId:       "$_id",
            name:         { $ifNull: ["$teamInfo.name", "Unassigned"] },
            revenue:      1,
            paymentCount: 1,
          },
        },
      ]),

      // ── top agents by revenue (attributed to lead's assignedTo)
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$assignedTo",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 15 },
        {
          $lookup: {
            from: "users", localField: "_id", foreignField: "_id", as: "userInfo",
          },
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: false } },
        {
          $project: {
            userId:       "$_id",
            name:         "$userInfo.name",
            email:        "$userInfo.email",
            designation:  "$userInfo.designation",
            revenue:      1,
            paymentCount: 1,
          },
        },
      ]),

      // ── total pending (sellingAmount ?? course.amount − payments received)
      Lead.aggregate([
        { $match: leadMatch },
        { $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" } },
        {
          $addFields: {
            effectiveAmount: {
              $ifNull: ["$sellingAmount", { $arrayElemAt: ["$courseInfo.amount", 0] }],
            },
          },
        },
        { $match: { effectiveAmount: { $ne: null } } },
        {
          $group: {
            _id:                  null,
            totalEffectiveAmount: { $sum: "$effectiveAmount" },
            totalPaid:            { $sum: COUNTED_TOTAL },
          },
        },
        {
          $project: {
            totalPending: { $max: [0, { $subtract: ["$totalEffectiveAmount", "$totalPaid"] }] },
          },
        },
      ]),

      // ── overpaid leads (sellingAmount set AND totalPaid > sellingAmount)
      Lead.aggregate([
        { $match: { ...leadMatch, sellingAmount: { $exists: true, $ne: null } } },
        { $addFields: { totalPaidCalc: COUNTED_TOTAL } },
        { $match: { $expr: { $gt: ["$totalPaidCalc", "$sellingAmount"] } } },
        {
          $group: {
            _id:           null,
            overpaidCount: { $sum: 1 },
            overpaidTotal: { $sum: { $subtract: ["$totalPaidCalc", "$sellingAmount"] } },
          },
        },
      ]),
    ]);

    const summary        = summaryAgg[0] ?? { totalRevenue: 0, paymentCount: 0, leadIds: [] };
    const totalRevenue   = summary.totalRevenue   as number ?? 0;
    const paymentCount   = summary.paymentCount   as number ?? 0;
    const payingLeadCount = (summary.leadIds as unknown[])?.length ?? 0;
    const avgRevenuePerLead = payingLeadCount > 0
      ? +((totalRevenue / payingLeadCount).toFixed(2))
      : 0;
    const totalPending   = (pendingAgg[0]?.totalPending as number) ?? 0;
    const overpaidCount  = (overpaidAgg[0]?.overpaidCount as number) ?? 0;
    const overpaidTotal  = (overpaidAgg[0]?.overpaidTotal as number) ?? 0;

    const topTeam  = teamAgg[0]  ? { name: teamAgg[0].name  as string, revenue: teamAgg[0].revenue  as number } : null;
    const topAgent = agentAgg[0] ? { name: agentAgg[0].name as string, revenue: agentAgg[0].revenue as number, designation: agentAgg[0].designation as string | undefined } : null;

    return {
      totalRevenue,
      totalPending,
      overpaidCount,
      overpaidTotal,
      payingLeadCount,
      paymentCount,
      avgRevenuePerLead,
      topTeam,
      topAgent,
      teamBreakdown:  teamAgg.map((t, i)  => ({ ...t, rank: i + 1 })),
      agentBreakdown: agentAgg.map((a, i) => ({ ...a, rank: i + 1 })),
    };
  }

  // ── 7. Revenue timeline (per team, per time bucket) ───────────────────────────

  async getRevenueTimeline(
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$payments.paidAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$payments.paidAt" }, week: { $isoWeek: "$payments.paidAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$payments.paidAt" }, month: { $month: "$payments.paidAt" } };
    } else {
      bucketId = { year: { $year: "$payments.paidAt" } };
    }

    const agg = await Lead.aggregate([
      { $unwind: "$payments" },
      { $match: COUNTED_PAYMENT },
      { $match: paymentMatch },
      {
        $group: {
          _id:     { bucket: bucketId, team: "$team" },
          revenue: { $sum: "$payments.amount" },
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from: "teams", localField: "_id.team", foreignField: "_id", as: "teamInfo",
        },
      },
      { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:   "$_id.bucket",
          teamName: { $ifNull: ["$teamInfo.name", "Unassigned"] },
          revenue:  1,
        },
      },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const teamSet   = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week as number} '${String(b.year as number).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year as number).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      const teamName = row.teamName as string;
      teamSet.add(teamName);

      if (!bucketMap.has(label)) bucketMap.set(label, { label, total: 0 });
      const bucket = bucketMap.get(label)!;
      bucket[teamName] = ((bucket[teamName] as number) ?? 0) + (row.revenue as number);
      bucket.total     = ((bucket.total    as number) ?? 0) + (row.revenue as number);
    }

    return {
      teams:    Array.from(teamSet),
      timeline: Array.from(bucketMap.values()),
    };
  }

  // ── 8. Revenue teams with member breakdown ───────────────────────────────────

  async getRevenueTeams(dateFrom?: string, dateTo?: string) {
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    const [agg, pendingTeamAgg, pendingMemberAgg] = await Promise.all([
      // ── existing: revenue by team × member (payment-filtered)
      Lead.aggregate([
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          { team: "$team", member: "$assignedTo" },
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
        {
          $lookup: {
            from: "users", localField: "_id.member", foreignField: "_id", as: "userInfo",
          },
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id:              "$_id.team",
            teamRevenue:      { $sum: "$revenue" },
            teamPaymentCount: { $sum: "$paymentCount" },
            teamLeadCount:    { $sum: { $size: "$leadIds" } },
            members: {
              $push: {
                userId:       "$_id.member",
                name:         { $ifNull: ["$userInfo.name", "Unassigned"] },
                designation:  "$userInfo.designation",
                revenue:      "$revenue",
                paymentCount: "$paymentCount",
                leadCount:    { $size: "$leadIds" },
              },
            },
          },
        },
        { $sort: { teamRevenue: -1 } },
        {
          $lookup: {
            from: "teams", localField: "_id", foreignField: "_id", as: "teamInfo",
          },
        },
        { $unwind: { path: "$teamInfo", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            teamId:       "$_id",
            name:         { $ifNull: ["$teamInfo.name", "Unassigned"] },
            revenue:      "$teamRevenue",
            paymentCount: "$teamPaymentCount",
            leadCount:    "$teamLeadCount",
            members:      1,
          },
        },
      ]),

      // ── pending per team (sellingAmount ?? course.amount − payments)
      Lead.aggregate([
        { $match: { team: { $exists: true, $ne: null } } },
        { $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" } },
        {
          $addFields: {
            effectiveAmount: {
              $ifNull: ["$sellingAmount", { $arrayElemAt: ["$courseInfo.amount", 0] }],
            },
          },
        },
        { $match: { effectiveAmount: { $ne: null } } },
        {
          $group: {
            _id:                  "$team",
            totalEffectiveAmount: { $sum: "$effectiveAmount" },
            totalPaid:            { $sum: COUNTED_TOTAL },
          },
        },
        {
          $project: {
            pendingAmount: { $max: [0, { $subtract: ["$totalEffectiveAmount", "$totalPaid"] }] },
          },
        },
      ]),

      // ── pending per (team × member)
      Lead.aggregate([
        { $match: { team: { $exists: true, $ne: null }, assignedTo: { $exists: true, $ne: null } } },
        { $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" } },
        {
          $addFields: {
            effectiveAmount: {
              $ifNull: ["$sellingAmount", { $arrayElemAt: ["$courseInfo.amount", 0] }],
            },
          },
        },
        { $match: { effectiveAmount: { $ne: null } } },
        {
          $group: {
            _id:                  { team: "$team", member: "$assignedTo" },
            totalEffectiveAmount: { $sum: "$effectiveAmount" },
            totalPaid:            { $sum: COUNTED_TOTAL },
          },
        },
        {
          $project: {
            pendingAmount: { $max: [0, { $subtract: ["$totalEffectiveAmount", "$totalPaid"] }] },
          },
        },
      ]),
    ]);

    // Build lookup maps
    const pendingByTeam   = new Map(pendingTeamAgg.map((r) => [String(r._id), r.pendingAmount as number]));
    const pendingByMember = new Map(
      pendingMemberAgg.map((r) => [
        `${String((r._id as { team: unknown; member: unknown }).team)}__${String((r._id as { team: unknown; member: unknown }).member)}`,
        r.pendingAmount as number,
      ]),
    );

    // Sort members desc + add pct + pending
    return agg.map((team, i) => {
      const teamPending = pendingByTeam.get(String(team.teamId)) ?? 0;
      return {
        ...team,
        rank:          i + 1,
        pendingAmount: teamPending,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        members: (team.members as any[])
          .sort((a, b) => (b.revenue as number) - (a.revenue as number))
          .map((m) => ({
            ...m,
            pendingAmount: pendingByMember.get(`${String(team.teamId)}__${String(m.userId)}`) ?? 0,
            pct: (team.revenue as number) > 0
              ? +(((m.revenue as number) / (team.revenue as number)) * 100).toFixed(1)
              : 0,
          })),
      };
    });
  }

  // ── 9. Team-scoped revenue overview (KPIs + member breakdown) ────────────────

  async getTeamRevenue(teamId: string, dateFrom?: string, dateTo?: string) {
    const teamOid      = new mongoose.Types.ObjectId(teamId);
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);
    const teamFilter   = { team: teamOid };

    const [summaryAgg, memberAgg, pendingAgg, pendingMemberAgg] = await Promise.all([
      Lead.aggregate([
        { $match: teamFilter },
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          null,
            totalRevenue: { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
      ]),

      Lead.aggregate([
        { $match: teamFilter },
        { $unwind: "$payments" },
        { $match: COUNTED_PAYMENT },
        { $match: paymentMatch },
        {
          $group: {
            _id:          "$assignedTo",
            revenue:      { $sum: "$payments.amount" },
            paymentCount: { $sum: 1 },
            leadIds:      { $addToSet: "$_id" },
          },
        },
        { $sort: { revenue: -1 } },
        {
          $lookup: {
            from: "users", localField: "_id", foreignField: "_id", as: "userInfo",
          },
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            userId:       "$_id",
            name:         { $ifNull: ["$userInfo.name", "Unassigned"] },
            designation:  "$userInfo.designation",
            revenue:      1,
            paymentCount: 1,
            leadCount:    { $size: "$leadIds" },
          },
        },
      ]),

      // ── team-level pending (sellingAmount ?? course.amount − payments)
      Lead.aggregate([
        { $match: teamFilter },
        { $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" } },
        {
          $addFields: {
            effectiveAmount: {
              $ifNull: ["$sellingAmount", { $arrayElemAt: ["$courseInfo.amount", 0] }],
            },
          },
        },
        { $match: { effectiveAmount: { $ne: null } } },
        {
          $group: {
            _id:                  null,
            totalEffectiveAmount: { $sum: "$effectiveAmount" },
            totalPaid:            { $sum: COUNTED_TOTAL },
          },
        },
        {
          $project: {
            totalPending: { $max: [0, { $subtract: ["$totalEffectiveAmount", "$totalPaid"] }] },
          },
        },
      ]),

      // ── per-member pending
      Lead.aggregate([
        { $match: { ...teamFilter, assignedTo: { $exists: true, $ne: null } } },
        { $lookup: { from: "courses", localField: "course", foreignField: "_id", as: "courseInfo" } },
        {
          $addFields: {
            effectiveAmount: {
              $ifNull: ["$sellingAmount", { $arrayElemAt: ["$courseInfo.amount", 0] }],
            },
          },
        },
        { $match: { effectiveAmount: { $ne: null } } },
        {
          $group: {
            _id:                  "$assignedTo",
            totalEffectiveAmount: { $sum: "$effectiveAmount" },
            totalPaid:            { $sum: COUNTED_TOTAL },
          },
        },
        {
          $project: {
            pendingAmount: { $max: [0, { $subtract: ["$totalEffectiveAmount", "$totalPaid"] }] },
          },
        },
      ]),
    ]);

    const summary         = summaryAgg[0] ?? { totalRevenue: 0, paymentCount: 0, leadIds: [] };
    const totalRevenue    = summary.totalRevenue   as number ?? 0;
    const paymentCount    = summary.paymentCount   as number ?? 0;
    const payingLeadCount = (summary.leadIds as unknown[])?.length ?? 0;
    const avgRevenuePerLead = payingLeadCount > 0
      ? +((totalRevenue / payingLeadCount).toFixed(2))
      : 0;
    const totalPending = (pendingAgg[0]?.totalPending as number) ?? 0;

    const pendingByMember = new Map(
      pendingMemberAgg.map((r) => [String(r._id), r.pendingAmount as number]),
    );

    const topMember = memberAgg[0]
      ? { name: memberAgg[0].name as string, revenue: memberAgg[0].revenue as number, designation: memberAgg[0].designation as string | undefined }
      : null;

    return {
      totalRevenue,
      totalPending,
      payingLeadCount,
      paymentCount,
      avgRevenuePerLead,
      topMember,
      memberBreakdown: memberAgg.map((m, i) => ({
        ...m,
        rank:          i + 1,
        pendingAmount: pendingByMember.get(String(m.userId)) ?? 0,
        pct: totalRevenue > 0
          ? +(((m.revenue as number) / totalRevenue) * 100).toFixed(1)
          : 0,
      })),
    };
  }

  // ── 10. Team-scoped revenue timeline (by member, per time bucket) ─────────────

  async getTeamRevenueTimeline(
    teamId: string,
    period: "daily" | "weekly" | "monthly" | "yearly",
    dateFrom?: string,
    dateTo?: string,
  ) {
    const teamOid      = new mongoose.Types.ObjectId(teamId);
    const paymentMatch = this.buildPaymentDateFilter(dateFrom, dateTo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bucketId: any;
    if (period === "daily") {
      bucketId = { $dateToString: { format: "%Y-%m-%d", date: "$payments.paidAt" } };
    } else if (period === "weekly") {
      bucketId = { year: { $isoWeekYear: "$payments.paidAt" }, week: { $isoWeek: "$payments.paidAt" } };
    } else if (period === "monthly") {
      bucketId = { year: { $year: "$payments.paidAt" }, month: { $month: "$payments.paidAt" } };
    } else {
      bucketId = { year: { $year: "$payments.paidAt" } };
    }

    const agg = await Lead.aggregate([
      { $match: { team: teamOid } },
      { $unwind: "$payments" },
      { $match: COUNTED_PAYMENT },
      { $match: paymentMatch },
      {
        $group: {
          _id:     { bucket: bucketId, member: "$assignedTo" },
          revenue: { $sum: "$payments.amount" },
        },
      },
      { $sort: { "_id.bucket": 1 } },
      {
        $lookup: {
          from: "users", localField: "_id.member", foreignField: "_id", as: "userInfo",
        },
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          bucket:     "$_id.bucket",
          memberName: { $ifNull: ["$userInfo.name", "Unassigned"] },
          revenue:    1,
        },
      },
    ]);

    const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const memberSet = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bucketMap = new Map<string, Record<string, any>>();

    for (const row of agg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = row.bucket as any;
      let label: string;
      if (typeof b === "string") {
        label = b;
      } else if (b?.week !== undefined) {
        label = `W${b.week as number} '${String(b.year as number).slice(2)}`;
      } else if (b?.month !== undefined) {
        label = `${MONTHS[b.month as number]} '${String(b.year as number).slice(2)}`;
      } else {
        label = String(b?.year ?? "—");
      }

      const memberName = row.memberName as string;
      memberSet.add(memberName);

      if (!bucketMap.has(label)) bucketMap.set(label, { label, total: 0 });
      const bucket = bucketMap.get(label)!;
      bucket[memberName] = ((bucket[memberName] as number) ?? 0) + (row.revenue as number);
      bucket.total       = ((bucket.total       as number) ?? 0) + (row.revenue as number);
    }

    return {
      members:  Array.from(memberSet),
      timeline: Array.from(bucketMap.values()),
    };
  }

  // ── 11. Source analytics (per source: status breakdown + revenue) ─────────────

  async getSourceAnalytics(dateFrom?: string, dateTo?: string, teamId?: string) {
    const match: Record<string, unknown> = {
      ...this.buildDateFilter(dateFrom, dateTo),
    };
    if (teamId) {
      match.team = new mongoose.Types.ObjectId(teamId);
    }

    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:            { $ifNull: ["$source", "other"] },
          total:          { $sum: 1 },
          revenue:        { $sum: COUNTED_TOTAL },
          ...this.statusSumFields(),
        },
      },
      { $sort: { total: -1 } },
    ]);

    return agg.map((item) => {
      const total   = item.total as number;
      const closed  = (item.closed as number) ?? 0;
      const lost    = (item.lost   as number) ?? 0;
      return {
        source:         (item._id as string) || "other",
        total,
        closed,
        lost,
        revenue:        (item.revenue as number) ?? 0,
        conversionRate: total > 0 ? +((closed / total) * 100).toFixed(1) : 0,
        lostRate:       total > 0 ? +((lost / total) * 100).toFixed(1) : 0,
      };
    });
  }

  // ── 12. Campaign breakdown for a given source ─────────────────────────────────

  async getSourceCampaigns(source: string, dateFrom?: string, dateTo?: string) {
    const match: Record<string, unknown> = {
      ...this.buildDateFilter(dateFrom, dateTo),
      source,
    };

    const agg = await Lead.aggregate([
      { $match: match },
      {
        $group: {
          _id:            { $ifNull: ["$campaign", "(no campaign)"] },
          total:          { $sum: 1 },
          revenue:        { $sum: COUNTED_TOTAL },
          ...this.statusSumFields(),
        },
      },
      { $sort: { total: -1 } },
    ]);

    return agg.map((item) => {
      const total   = item.total as number;
      const closed = (item.closed as number) ?? 0;
      const lost   = (item.lost   as number) ?? 0;
      return {
        campaignId:     (item._id as string) || "(no campaign)",
        total,
        closed,
        lost,
        revenue:        (item.revenue as number) ?? 0,
        conversionRate: total > 0 ? +((closed / total) * 100).toFixed(1) : 0,
        lostRate:       total > 0 ? +((lost / total) * 100).toFixed(1) : 0,
      };
    });
  }

  // ── 13. Status breakdown by period (for comparing periods) ────────────────────

  async getStatusByPeriod(
    period: "daily" | "weekly" | "monthly",
    status: LeadStatus,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const match = {
      ...this.buildDateFilter(dateFrom, dateTo),
      status,
    };

    const groupId =
      period === "daily"
        ? { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }
        : period === "weekly"
        ? { year: { $isoWeekYear: "$createdAt" }, week: { $isoWeek: "$createdAt" } }
        : { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };

    return Lead.aggregate([
      { $match: match },
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
  }

  // ── 14. Response Time SLA ──────────────────────────────────────────────────────

  async getResponseTimeReport(params: {
    teamId?: string;
    dateFrom?: string;
    dateTo?: string;
    slaMinutes?: number;
  }) {
    const { teamId, dateFrom, dateTo, slaMinutes = 60 } = params;

    const match: Record<string, unknown> = {
      assignedAt: { $ne: null },
      ...this.buildDateFilter(dateFrom, dateTo),
    };
    if (teamId) match.team = new mongoose.Types.ObjectId(teamId);

    // Aggregate per-agent response time metrics
    const agentAgg = await Lead.aggregate([
      { $match: match },
      {
        $addFields: {
          responseMinutes: {
            $cond: [
              { $and: ["$firstContactTime", "$assignedAt"] },
              {
                $divide: [
                  { $subtract: ["$firstContactTime", "$assignedAt"] },
                  60000,
                ],
              },
              null,
            ],
          },
        },
      },
      {
        $group: {
          _id: "$assignedTo",
          totalAssigned: { $sum: 1 },
          totalContacted: {
            $sum: { $cond: [{ $ifNull: ["$firstContactTime", false] }, 1, 0] },
          },
          totalWithinSla: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ifNull: ["$responseMinutes", false] },
                    { $lte: ["$responseMinutes", slaMinutes] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          avgResponseMinutes: { $avg: "$responseMinutes" },
          minResponseMinutes: { $min: "$responseMinutes" },
          maxResponseMinutes: { $max: "$responseMinutes" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "agent",
        },
      },
      { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          agentId: "$_id",
          agentName: { $ifNull: ["$agent.name", "Unassigned"] },
          agentEmail: "$agent.email",
          totalAssigned: 1,
          totalContacted: 1,
          totalWithinSla: 1,
          slaComplianceRate: {
            $cond: [
              { $gt: ["$totalContacted", 0] },
              {
                $round: [
                  { $multiply: [{ $divide: ["$totalWithinSla", "$totalContacted"] }, 100] },
                  1,
                ],
              },
              0,
            ],
          },
          avgResponseMinutes: { $round: ["$avgResponseMinutes", 1] },
          minResponseMinutes: { $round: ["$minResponseMinutes", 1] },
          maxResponseMinutes: { $round: ["$maxResponseMinutes", 1] },
          notContactedCount: { $subtract: ["$totalAssigned", "$totalContacted"] },
        },
      },
      { $sort: { avgResponseMinutes: 1 } },
    ]);

    // Summary stats
    const totalAssigned   = agentAgg.reduce((s, a) => s + (a.totalAssigned   ?? 0), 0);
    const totalContacted  = agentAgg.reduce((s, a) => s + (a.totalContacted  ?? 0), 0);
    const totalWithinSla  = agentAgg.reduce((s, a) => s + (a.totalWithinSla  ?? 0), 0);
    const notContacted    = totalAssigned - totalContacted;
    const overallAvgMins  = agentAgg.length > 0
      ? +(agentAgg.reduce((s, a) => s + (a.avgResponseMinutes ?? 0), 0) / agentAgg.filter((a) => a.avgResponseMinutes != null).length || 0).toFixed(1)
      : 0;

    // Leads not contacted within SLA (oldest first)
    const breachedLeads = await Lead.find({
      ...match,
      firstContactTime: null,
    })
      .populate("assignedTo", "name email")
      .populate("course", "name")
      .sort({ assignedAt: 1 })
      .limit(50)
      .lean();

    return {
      summary: {
        slaMinutes,
        totalAssigned,
        totalContacted,
        notContacted,
        totalWithinSla,
        overallSlaRate: totalContacted > 0 ? +((totalWithinSla / totalContacted) * 100).toFixed(1) : 0,
        overallAvgResponseMinutes: overallAvgMins,
      },
      agentRanking: agentAgg,
      breachedLeads: breachedLeads.map((l) => ({
        _id: l._id,
        name: l.name,
        phone: l.phone,
        source: l.source,
        status: l.status,
        assignedAt: l.assignedAt,
        assignedTo: l.assignedTo,
        course: l.course,
        minutesSinceAssign: l.assignedAt
          ? +((Date.now() - new Date(l.assignedAt).getTime()) / 60000).toFixed(0)
          : null,
      })),
    };
  }

  // ── Lead Timing Report — per-lead assigned / responded / follow-up times ──────

  async getLeadTimingReport(params: {
    teamId?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
  }) {
    const { teamId, dateFrom, dateTo, page = 1, limit = 25 } = params;

    const match: Record<string, unknown> = {
      assignedAt: { $ne: null },
      ...this.buildDateFilter(dateFrom, dateTo),
    };
    if (teamId) match.team = new mongoose.Types.ObjectId(teamId);

    const total = await Lead.countDocuments(match);
    const leads = await Lead.find(match)
      .select("name phone source status assignedAt firstContactTime lastFollowupDate nextFollowUpAt assignedTo team")
      .populate("assignedTo", "name")
      .populate("team", "name")
      .sort({ assignedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const mins = (from?: Date | null, to?: Date | null): number | null =>
      from && to ? +(((new Date(to).getTime() - new Date(from).getTime()) / 60000).toFixed(0)) : null;

    return {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      leads: leads.map((l) => ({
        _id: l._id,
        name: l.name,
        phone: l.phone,
        source: l.source ?? null,
        status: l.status,
        agent: (l.assignedTo as unknown as { name?: string } | null)?.name ?? null,
        team: (l.team as unknown as { name?: string } | null)?.name ?? null,
        assignedAt: l.assignedAt ?? null,
        respondedAt: l.firstContactTime ?? null,          // first contact (3CX call)
        followUpAt: l.lastFollowupDate ?? null,           // latest follow-up
        nextFollowUpAt: l.nextFollowUpAt ?? null,
        responseMinutes: mins(l.assignedAt, l.firstContactTime),   // assigned → responded
        followUpMinutes: mins(l.firstContactTime, l.lastFollowupDate), // responded → follow-up
      })),
    };
  }

  // ── 15. Follow-Up Report ───────────────────────────────────────────────────────

  async getFollowUpReport(params: {
    teamId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const { teamId, dateFrom, dateTo } = params;

    const now = new Date();

    // Match window: leads that have at least one follow-up in the date range OR are overdue
    const followUpMatch: Record<string, unknown> = {};
    if (teamId) followUpMatch.team = new mongoose.Types.ObjectId(teamId);

    // ── Agent-wise follow-up counts ────────────────────────────────────────────
    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) dateFilter.$gte = new Date(dateFrom);
    if (dateTo)   dateFilter.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));

    const agentAgg = await Lead.aggregate([
      { $match: followUpMatch },
      { $unwind: "$followUps" },
      ...(Object.keys(dateFilter).length > 0 ? [{ $match: { "followUps.followedUpAt": dateFilter } }] : []),
      {
        $group: {
          _id: "$followUps.followedUpBy",
          totalFollowUps: { $sum: 1 },
          uniqueLeads:    { $addToSet: "$_id" },
          lastFollowUp:   { $max: "$followUps.followedUpAt" },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "agent",
        },
      },
      { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          agentId:        "$_id",
          agentName:      { $ifNull: ["$agent.name", "Unknown"] },
          agentEmail:     "$agent.email",
          totalFollowUps: 1,
          uniqueLeads:    { $size: "$uniqueLeads" },
          lastFollowUp:   1,
        },
      },
      { $sort: { totalFollowUps: -1 } },
    ]);

    // ── Per-lead follow-up count in range ──────────────────────────────────────
    const leadAgg = await Lead.aggregate([
      { $match: followUpMatch },
      {
        $project: {
          name:           1,
          phone:          1,
          status:         1,
          source:         1,
          assignedTo:     1,
          nextFollowUpAt: 1,
          followUps: {
            $filter: {
              input: { $ifNull: ["$followUps", []] },
              as:    "f",
              cond:  Object.keys(dateFilter).length > 0
                ? {
                    $and: [
                      ...(dateFilter.$gte ? [{ $gte: ["$$f.followedUpAt", dateFilter.$gte] }] : []),
                      ...(dateFilter.$lte ? [{ $lte: ["$$f.followedUpAt", dateFilter.$lte] }] : []),
                    ],
                  }
                : { $eq: [1, 1] },
            },
          },
          totalFollowUpsAllTime: { $size: { $ifNull: ["$followUps", []] } },
        },
      },
      { $addFields: { followUpCount: { $size: { $ifNull: ["$followUps", []] } } } },
      { $match: { followUpCount: { $gt: 0 } } },
      {
        $lookup: {
          from: "users",
          localField: "assignedTo",
          foreignField: "_id",
          as: "agent",
        },
      },
      { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          phone: 1,
          status: 1,
          source: 1,
          nextFollowUpAt: 1,
          followUpCount: 1,
          totalFollowUpsAllTime: 1,
          lastFollowUpAt: { $max: "$followUps.followedUpAt" },
          agentName:  { $ifNull: ["$agent.name", "Unassigned"] },
          agentEmail: "$agent.email",
        },
      },
      { $sort: { followUpCount: -1 } },
      { $limit: 100 },
    ]);

    // ── Overdue leads (nextFollowUpAt < now, lead not closed/lost) ─────────────
    const overdueMatch: Record<string, unknown> = {
      nextFollowUpAt: { $lt: now, $ne: null },
      status: { $nin: ["closed", "lost"] },
    };
    if (teamId) overdueMatch.team = new mongoose.Types.ObjectId(teamId);

    const overdueLeads = await Lead.find(overdueMatch)
      .populate("assignedTo", "name email")
      .populate("course", "name")
      .sort({ nextFollowUpAt: 1 })
      .limit(50)
      .lean();

    const totalFollowUps = agentAgg.reduce((s, a) => s + a.totalFollowUps, 0);

    return {
      summary: {
        totalFollowUps,
        totalAgentsTracked: agentAgg.length,
        overdueCount: overdueLeads.length,
        leadsWithFollowUps: leadAgg.length,
      },
      agentRanking: agentAgg,
      leadBreakdown: leadAgg,
      overdueLeads: overdueLeads.map((l) => ({
        _id:            l._id,
        name:           l.name,
        phone:          l.phone,
        source:         l.source,
        status:         l.status,
        nextFollowUpAt: (l as unknown as Record<string, unknown>).nextFollowUpAt,
        assignedTo:     l.assignedTo,
        course:         l.course,
        overdueByMinutes: (l as unknown as Record<string, unknown>).nextFollowUpAt
          ? +((now.getTime() - new Date((l as unknown as Record<string, unknown>).nextFollowUpAt as Date).getTime()) / 60000).toFixed(0)
          : null,
        totalFollowUps: ((l as unknown as Record<string, unknown>).followUps as unknown[])?.length ?? 0,
      })),
    };
  }

  // ── 16. Pipeline Breakdown ────────────────────────────────────────────────────

  async getPipelineBreakdown(params: {
    teamId?:  string;
    dateFrom?: string;
    dateTo?:  string;
  }) {
    const { teamId, dateFrom, dateTo } = params;

    const baseMatch: Record<string, unknown> = {
      ...this.buildDateFilter(dateFrom, dateTo),
    };
    if (teamId) baseMatch.team = new mongoose.Types.ObjectId(teamId);

    // ── Single aggregation — one pass over the collection ─────────────────────
    const [result] = await Lead.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          total:          { $sum: 1 },
          contacted:      { $sum: { $cond: [{ $and: [{ $ifNull: ["$firstContactTime", false] }] }, 1, 0] } },
          followUp:       { $sum: { $cond: [{ $in: ["$status", ["followup", "callback", "meeting_scheduled", "meeting_done"]] }, 1, 0] } },
          interested:     { $sum: { $cond: [{ $eq: ["$initialLeadResponse", "very_interested"] }, 1, 0] } },
          notInterested:  { $sum: { $cond: [{ $eq: ["$initialLeadResponse", "not_interested"] }, 1, 0] } },
          lost:           { $sum: { $cond: [{ $in: ["$status", ["lost", "mia", "wrong_number"]] }, 1, 0] } },
          converted:      { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
        },
      },
    ]);

    const total        = result?.total         ?? 0;
    const contacted    = result?.contacted      ?? 0;
    const followUp     = result?.followUp       ?? 0;
    const interested   = result?.interested     ?? 0;
    const notInterested = result?.notInterested ?? 0;
    const lost         = result?.lost           ?? 0;
    const converted    = result?.converted      ?? 0;

    const pct = (n: number) => total > 0 ? +((n / total) * 100).toFixed(1) : 0;

    const stages = [
      { key: "contacted",    label: "Contacted",       count: contacted,     pct: pct(contacted),     color: "#3b82f6" },
      { key: "followUp",     label: "Follow-Up",       count: followUp,      pct: pct(followUp),      color: "#f59e0b" },
      { key: "interested",   label: "Interested",      count: interested,    pct: pct(interested),    color: "#8b5cf6" },
      { key: "notInterested",label: "Not Interested",  count: notInterested, pct: pct(notInterested), color: "#ef4444" },
      { key: "lost",         label: "Lost",            count: lost,          pct: pct(lost),          color: "#6b7280" },
      { key: "converted",    label: "Converted",       count: converted,     pct: pct(converted),     color: "#10b981" },
    ];

    // ── Trend: same 6 counts bucketed by month (last 6 months) ────────────────
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const trendMatch = { ...baseMatch, createdAt: { $gte: sixMonthsAgo } };

    const trendAgg = await Lead.aggregate([
      { $match: trendMatch },
      {
        $group: {
          _id:          { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          total:        { $sum: 1 },
          contacted:    { $sum: { $cond: [{ $ifNull: ["$firstContactTime", false] }, 1, 0] } },
          followUp:     { $sum: { $cond: [{ $in: ["$status", ["followup", "callback", "meeting_scheduled", "meeting_done"]] }, 1, 0] } },
          interested:   { $sum: { $cond: [{ $eq: ["$initialLeadResponse", "very_interested"] }, 1, 0] } },
          notInterested:{ $sum: { $cond: [{ $eq: ["$initialLeadResponse", "not_interested"] }, 1, 0] } },
          lost:         { $sum: { $cond: [{ $in: ["$status", ["lost", "mia", "wrong_number"]] }, 1, 0] } },
          converted:    { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const trend = trendAgg.map((r) => ({
      month:        `${MONTHS[(r._id.month as number) - 1]} ${r._id.year}`,
      total:        r.total        as number,
      contacted:    r.contacted    as number,
      followUp:     r.followUp     as number,
      interested:   r.interested   as number,
      notInterested:r.notInterested as number,
      lost:         r.lost         as number,
      converted:    r.converted    as number,
    }));

    return { total, stages, trend };
  }

  // ── Lead Quality Report ────────────────────────────────────────────────────
  async getLeadQualityReport(params: {
    teamId?:  string;
    dateFrom?: string;
    dateTo?:  string;
  }) {
    const { teamId, dateFrom, dateTo } = params;

    const baseMatch: Record<string, unknown> = {
      ...this.buildDateFilter(dateFrom, dateTo),
    };
    if (teamId) baseMatch.team = new mongoose.Types.ObjectId(teamId);

    const raw = await Lead.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: {
            source:   { $ifNull: ["$source",   "unknown"] },
            campaign: { $ifNull: ["$campaign", ""] },
          },
          total:          { $sum: 1 },
          converted:      { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
          contacted:      { $sum: { $cond: [{ $ifNull: ["$firstContactTime", false] }, 1, 0] } },
          withFollowUp:   { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$followUps", []] } }, 0] }, 1, 0] } },
          lost:           { $sum: { $cond: [{ $in: ["$status", ["lost", "mia", "wrong_number"]] }, 1, 0] } },
          totalRespMs: {
            $sum: {
              $cond: [
                { $and: [
                  { $gt: [{ $ifNull: ["$firstContactTime", null] }, null] },
                  { $gt: [{ $ifNull: ["$assignedAt",       null] }, null] },
                ]},
                { $subtract: ["$firstContactTime", "$assignedAt"] },
                0,
              ],
            },
          },
          respondedCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $gt: [{ $ifNull: ["$firstContactTime", null] }, null] },
                  { $gt: [{ $ifNull: ["$assignedAt",       null] }, null] },
                ]},
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          conversionRate: { $cond: ["$total", { $multiply: [{ $divide: ["$converted",    "$total"] }, 100] }, 0] },
          contactRate:    { $cond: ["$total", { $multiply: [{ $divide: ["$contacted",    "$total"] }, 100] }, 0] },
          followUpRate:   { $cond: ["$total", { $multiply: [{ $divide: ["$withFollowUp", "$total"] }, 100] }, 0] },
          lostRate:       { $cond: ["$total", { $multiply: [{ $divide: ["$lost",         "$total"] }, 100] }, 0] },
          avgResponseMinutes: {
            $cond: [
              "$respondedCount",
              { $divide: ["$totalRespMs", { $multiply: ["$respondedCount", 60000] }] },
              null,
            ],
          },
        },
      },
      {
        $addFields: {
          qualityScore: {
            $round: [{
              $add: [
                { $multiply: ["$conversionRate",                    0.40] },
                { $multiply: ["$contactRate",                       0.25] },
                { $multiply: ["$followUpRate",                      0.20] },
                { $multiply: [{ $subtract: [100, "$lostRate"] },    0.15] },
              ],
            }, 1],
          },
        },
      },
      { $sort: { qualityScore: -1 } },
      {
        $project: {
          _id:                0,
          source:             "$_id.source",
          campaign:           "$_id.campaign",
          total:              1,
          converted:          1,
          contacted:          1,
          withFollowUp:       1,
          lost:               1,
          conversionRate:     { $round: ["$conversionRate", 1] },
          contactRate:        { $round: ["$contactRate",    1] },
          followUpRate:       { $round: ["$followUpRate",   1] },
          lostRate:           { $round: ["$lostRate",       1] },
          avgResponseMinutes: { $round: ["$avgResponseMinutes", 0] },
          qualityScore:       1,
        },
      },
    ]);

    // ── Derived slices ─────────────────────────────────────────────────────────

    // top campaigns: min 5 leads, sorted by conversion rate
    const topCampaigns = [...raw]
      .filter((r) => r.total >= 5)
      .sort((a, b) => b.conversionRate - a.conversionRate)
      .slice(0, 5);

    // low-quality sources: score < 40, min 5 leads, grouped by source
    const sourceMap = new Map<string, { total: number; scoreSum: number; converted: number; lost: number }>();
    for (const r of raw) {
      const existing = sourceMap.get(r.source) ?? { total: 0, scoreSum: 0, converted: 0, lost: 0 };
      existing.total     += r.total;
      existing.scoreSum  += r.qualityScore * r.total;
      existing.converted += r.converted;
      existing.lost      += r.lost;
      sourceMap.set(r.source, existing);
    }

    const sourceSummary = [...sourceMap.entries()]
      .map(([source, v]) => ({
        source,
        total:          v.total,
        avgQualityScore: v.total > 0 ? +((v.scoreSum / v.total).toFixed(1)) : 0,
        converted:      v.converted,
        lost:           v.lost,
        conversionRate: v.total > 0 ? +((v.converted / v.total * 100).toFixed(1)) : 0,
        lostRate:       v.total > 0 ? +((v.lost / v.total * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.avgQualityScore - a.avgQualityScore);

    const lowQualitySources = sourceSummary.filter((s) => s.avgQualityScore < 40 && s.total >= 5);

    // overall summary
    const totalLeads    = raw.reduce((s: number, r) => s + r.total, 0);
    const totalConverted = raw.reduce((s: number, r) => s + r.converted, 0);
    const avgQuality    = raw.length > 0
      ? +(raw.reduce((s: number, r) => s + r.qualityScore * r.total, 0) / Math.max(totalLeads, 1)).toFixed(1)
      : 0;

    return {
      summary: {
        totalCampaigns:   raw.length,
        totalLeads,
        totalConverted,
        overallConversionRate: totalLeads > 0 ? +((totalConverted / totalLeads * 100).toFixed(1)) : 0,
        avgQualityScore: avgQuality,
        lowQualityCount: lowQualitySources.length,
      },
      campaigns:        raw,
      topCampaigns,
      sourceSummary,
      lowQualitySources,
    };
  }

  // ── Sales Funnel ──────────────────────────────────────────────────────────────
  async getSalesFunnelReport(params: { teamId?: string; dateFrom?: string; dateTo?: string }) {
    const { teamId, dateFrom, dateTo } = params;
    const baseMatch: Record<string, unknown> = { ...this.buildDateFilter(dateFrom, dateTo) };
    if (teamId) baseMatch.team = new mongoose.Types.ObjectId(teamId);

    // ── Single-pass funnel counts ─────────────────────────────────────────────
    const [counts] = await Lead.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id:        null,
          total:      { $sum: 1 },
          contacted:  { $sum: { $cond: [{ $gt: [{ $ifNull: ["$firstContactTime", null] }, null] }, 1, 0] } },
          qualified:  { $sum: { $cond: [{ $or: [
            { $eq: ["$initialLeadResponse", "very_interested"] },
            { $in: ["$status", ["booking", "partialbooking"]] },
          ]}, 1, 0] } },
          inFollowUp: { $sum: { $cond: [{ $or: [
            { $in: ["$status", ["followup", "callback", "meeting_scheduled", "meeting_done"]] },
            { $gt: [{ $size: { $ifNull: ["$followUps", []] } }, 0] },
          ]}, 1, 0] } },
          converted:  { $sum: { $cond: [{ $eq:  ["$status", "closed"] }, 1, 0] } },
          lost:       { $sum: { $cond: [{ $in:  ["$status", ["lost", "mia", "cnc", "wrong_number"]] }, 1, 0] } },
        },
      },
    ]);

    const s = counts ?? { total: 0, contacted: 0, qualified: 0, inFollowUp: 0, converted: 0, lost: 0 };
    const pct = (num: number, den: number) => den > 0 ? +((num / den) * 100).toFixed(1) : 0;

    const stages = [
      { key: "total",      label: "Total Received",  count: s.total,      pct: s.total > 0 ? 100 : 0,                dropPct: null as number | null },
      { key: "contacted",  label: "Contacted",        count: s.contacted,  pct: pct(s.contacted,  s.total),           dropPct: s.total > 0     ? pct(s.total - s.contacted,        s.total)     : null },
      { key: "qualified",  label: "Qualified",        count: s.qualified,  pct: pct(s.qualified,  s.total),           dropPct: s.contacted > 0 ? pct(s.contacted - s.qualified,     s.contacted) : null },
      { key: "inFollowUp", label: "In Follow-Up",     count: s.inFollowUp, pct: pct(s.inFollowUp, s.total),           dropPct: null },
      { key: "converted",  label: "Converted",        count: s.converted,  pct: pct(s.converted,  s.total),           dropPct: s.inFollowUp > 0 ? pct(s.inFollowUp - s.converted,  s.inFollowUp) : null },
      { key: "lost",       label: "Lost",             count: s.lost,       pct: pct(s.lost,       s.total),           dropPct: null },
    ];

    // ── Team breakdown ────────────────────────────────────────────────────────
    const teamRows = await Lead.aggregate([
      { $match: baseMatch },
      { $lookup: { from: "teams", localField: "team", foreignField: "_id", as: "t" } },
      { $unwind: { path: "$t", preserveNullAndEmptyArrays: true } },
      { $group: {
        _id:       { id: "$team", name: { $ifNull: ["$t.name", "Unassigned"] } },
        total:     { $sum: 1 },
        contacted: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$firstContactTime", null] }, null] }, 1, 0] } },
        converted: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
        lost:      { $sum: { $cond: [{ $in: ["$status", ["lost", "mia", "cnc", "wrong_number"]] }, 1, 0] } },
      }},
      { $sort: { total: -1 } }, { $limit: 10 },
    ]);

    // ── Top agents ────────────────────────────────────────────────────────────
    const agentRows = await Lead.aggregate([
      { $match: { ...baseMatch, assignedTo: { $ne: null } } },
      { $lookup: { from: "users", localField: "assignedTo", foreignField: "_id", as: "u" } },
      { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
      { $group: {
        _id:        { id: "$assignedTo", name: { $ifNull: ["$u.name", "Unknown"] } },
        total:      { $sum: 1 },
        contacted:  { $sum: { $cond: [{ $gt: [{ $ifNull: ["$firstContactTime", null] }, null] }, 1, 0] } },
        converted:  { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
        inFollowUp: { $sum: { $cond: [{ $in: ["$status", ["followup", "callback", "meeting_scheduled", "meeting_done"]] }, 1, 0] } },
      }},
      { $sort: { converted: -1 } }, { $limit: 10 },
    ]);

    return {
      summary: {
        total:              s.total,
        contactRate:        pct(s.contacted,  s.total),
        qualificationRate:  pct(s.qualified,  s.total),
        followUpRate:       pct(s.inFollowUp, s.total),
        conversionRate:     pct(s.converted,  s.total),
        lostRate:           pct(s.lost,       s.total),
      },
      stages,
      teamBreakdown: teamRows.map((r) => ({
        teamId:         r._id.id,
        teamName:       r._id.name,
        total:          r.total,
        contacted:      r.contacted,
        converted:      r.converted,
        lost:           r.lost,
        conversionRate: pct(r.converted, r.total),
        contactRate:    pct(r.contacted, r.total),
      })),
      topAgents: agentRows.map((r) => ({
        agentId:        r._id.id,
        agentName:      r._id.name,
        total:          r.total,
        contacted:      r.contacted,
        converted:      r.converted,
        inFollowUp:     r.inFollowUp,
        conversionRate: pct(r.converted, r.total),
      })),
    };
  }

  // ── Management Alerts ─────────────────────────────────────────────────────────
  async getManagementAlerts(params: { teamId?: string; uncontactedHours?: number }) {
    const { teamId, uncontactedHours = 2 } = params;
    const now       = new Date();
    const threshold = new Date(now.getTime() - uncontactedHours * 3_600_000);
    const last7     = new Date(now.getTime() - 7  * 86_400_000);
    const prev7     = new Date(now.getTime() - 14 * 86_400_000);

    const teamFilter: Record<string, unknown> = teamId
      ? { team: new mongoose.Types.ObjectId(teamId) }
      : {};

    const [uncontacted, overdueFollowUps, lostRecent, lostPrev] = await Promise.all([
      // Leads assigned but never contacted beyond the threshold
      Lead.find({
        ...teamFilter,
        assignedTo:       { $ne: null },
        firstContactTime: null,
        assignedAt:       { $lt: threshold },
        status:           { $nin: ["lost", "mia", "cnc", "wrong_number", "closed"] },
      })
        .populate("assignedTo", "name email")
        .populate("team",       "name")
        .select("name phone source assignedAt assignedTo team status")
        .sort({ assignedAt: 1 })
        .limit(50)
        .lean(),

      // Follow-ups past their due time
      Lead.find({
        ...teamFilter,
        nextFollowUpAt: { $lt: now, $ne: null },
        status:         { $nin: ["closed", "lost", "mia", "cnc", "wrong_number"] },
      })
        .populate("assignedTo", "name email")
        .populate("team",       "name")
        .select("name phone source nextFollowUpAt assignedTo team status")
        .sort({ nextFollowUpAt: 1 })
        .limit(50)
        .lean(),

      // Lost count — last 7 days
      Lead.countDocuments({ ...teamFilter, status: { $in: ["lost", "mia", "wrong_number"] }, updatedAt: { $gte: last7 } }),

      // Lost count — previous 7 days
      Lead.countDocuments({ ...teamFilter, status: { $in: ["lost", "mia", "wrong_number"] }, updatedAt: { $gte: prev7, $lt: last7 } }),
    ]);

    const spikePct = lostPrev > 0
      ? +((( lostRecent - lostPrev) / lostPrev) * 100).toFixed(1)
      : (lostRecent > 0 ? 100 : 0);

    return {
      summary: {
        uncontactedCount:    uncontacted.length,
        overdueFollowUps:    overdueFollowUps.length,
        lostRecent,
        lostPrev,
        lostSpikePct:        spikePct,
        hasSpikeAlert:       spikePct > 30 && lostRecent >= 5,
      },
      uncontacted: uncontacted.map((l) => ({
        _id:               l._id,
        name:              l.name,
        phone:             (l as unknown as Record<string, unknown>).phone,
        source:            (l as unknown as Record<string, unknown>).source,
        status:            l.status,
        assignedAt:        (l as unknown as Record<string, unknown>).assignedAt,
        assignedTo:        l.assignedTo,
        team:              l.team,
        hoursUncontacted:  (l as unknown as Record<string, unknown>).assignedAt
          ? +((now.getTime() - new Date((l as unknown as Record<string, unknown>).assignedAt as string).getTime()) / 3_600_000).toFixed(1)
          : null,
      })),
      overdueFollowUps: overdueFollowUps.map((l) => ({
        _id:              l._id,
        name:             l.name,
        phone:            (l as unknown as Record<string, unknown>).phone,
        source:           (l as unknown as Record<string, unknown>).source,
        status:           l.status,
        nextFollowUpAt:   (l as unknown as Record<string, unknown>).nextFollowUpAt,
        assignedTo:       l.assignedTo,
        team:             l.team,
        overdueByMinutes: (l as unknown as Record<string, unknown>).nextFollowUpAt
          ? Math.round((now.getTime() - new Date((l as unknown as Record<string, unknown>).nextFollowUpAt as string).getTime()) / 60_000)
          : null,
      })),
    };
  }

  // ── Audit & Transparency ──────────────────────────────────────────────────────
  async getAuditReport(params: {
    teamId?:  string;
    dateFrom?: string;
    dateTo?:  string;
    action?:  string;
  }) {
    const { teamId, dateFrom, dateTo, action } = params;

    const logDateFilter: Record<string, Date> = {};
    if (dateFrom) logDateFilter.$gte = new Date(dateFrom + "T00:00:00.000Z");
    if (dateTo)   logDateFilter.$lte = new Date(dateTo   + "T23:59:59.999Z");

    const AUDITABLE = ["status_changed", "note_added", "note_updated", "note_deleted", "lead_assigned", "inactive_reassigned"];

    const pipeline: object[] = [
      ...(teamId ? [{ $match: { team: new mongoose.Types.ObjectId(teamId) } }] : []),
      { $unwind: "$activityLogs" },
      {
        $match: {
          ...(Object.keys(logDateFilter).length ? { "activityLogs.createdAt": logDateFilter } : {}),
          "activityLogs.action": action ? action : { $in: AUDITABLE },
        },
      },
      {
        $lookup: {
          from:         "users",
          localField:   "activityLogs.performedBy",
          foreignField: "_id",
          as:           "actor",
        },
      },
      { $unwind: { path: "$actor", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id:         "$activityLogs._id",
          leadId:      "$_id",
          leadName:    "$name",
          leadPhone:   "$phone",
          action:      "$activityLogs.action",
          description: "$activityLogs.description",
          changes:     "$activityLogs.changes",
          createdAt:   "$activityLogs.createdAt",
          performedBy: { _id: "$actor._id", name: "$actor.name", email: "$actor.email" },
        },
      },
      { $sort:  { createdAt: -1 } },
      { $limit: 300 },
    ];

    const events = await Lead.aggregate(pipeline);

    const summary = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.action as string] = (acc[e.action as string] ?? 0) + 1;
      return acc;
    }, {});

    return { total: events.length, summary, events };
  }

  // ── Member Split Report ───────────────────────────────────────────────────────
  async getMemberSplitReport(params: {
    teamId?:   string;
    dateFrom?: string;
    dateTo?:   string;
  }) {
    const { teamId, dateFrom, dateTo } = params;

    // Base match — filter by team and assignedAt range
    const baseMatch: Record<string, unknown> = {
      assignedTo: { $ne: null },
    };
    if (teamId) baseMatch.team = new mongoose.Types.ObjectId(teamId);
    if (dateFrom || dateTo) {
      const range: Record<string, Date> = {};
      if (dateFrom) range.$gte = new Date(dateFrom + "T00:00:00.000Z");
      if (dateTo)   range.$lte = new Date(dateTo   + "T23:59:59.999Z");
      baseMatch.assignedAt = range;
    }

    // ── 1. Member assignment counts ──────────────────────────────────────────
    const memberRows = await Lead.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from: "users", localField: "assignedTo", foreignField: "_id", as: "u",
        },
      },
      { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id:       { id: "$assignedTo", name: { $ifNull: ["$u.name", "Unknown"] } },
          total:     { $sum: 1 },
          closed:    { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } },
          lost:      { $sum: { $cond: [{ $in: ["$status", ["lost", "mia", "cnc", "wrong_number"]] }, 1, 0] } },
          followup:  { $sum: { $cond: [{ $in: ["$status", ["followup", "callback", "meeting_scheduled", "meeting_done"]] }, 1, 0] } },
          new_assigned: { $sum: { $cond: [{ $in: ["$status", ["new", "assigned"]] }, 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 30 },
    ]);

    const members = memberRows.map((r, i) => ({
      rank:           i + 1,
      memberId:       r._id.id?.toString() ?? "",
      memberName:     r._id.name,
      total:          r.total,
      closed:         r.closed,
      lost:           r.lost,
      followup:       r.followup,
      new_assigned:   r.new_assigned,
      conversionRate: r.total > 0 ? +((r.closed / r.total) * 100).toFixed(1) : 0,
    }));

    // ── 2. Daily assignment timeline ─────────────────────────────────────────
    const dailyRows = await Lead.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id:   { $dateToString: { format: "%Y-%m-%d", date: "$assignedAt", timezone: "Asia/Dubai" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const daily = dailyRows.map((r) => ({
      date:  r._id as string,
      count: r.count as number,
    }));

    // ── 3. Source × member cross-tab ─────────────────────────────────────────
    const sourceRows = await Lead.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from: "users", localField: "assignedTo", foreignField: "_id", as: "u",
        },
      },
      { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            source:     { $ifNull: ["$source", "unknown"] },
            memberName: { $ifNull: ["$u.name", "Unknown"] },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Pivot into { source → { memberName → count } }
    const sourceMap: Record<string, Record<string, number>> = {};
    const memberSet = new Set<string>();

    for (const r of sourceRows) {
      const src  = r._id.source  as string;
      const name = r._id.memberName as string;
      if (!sourceMap[src]) sourceMap[src] = {};
      sourceMap[src][name] = (sourceMap[src][name] ?? 0) + r.count;
      memberSet.add(name);
    }

    const sourceMembers = [...memberSet].sort();
    const sourceTable = Object.entries(sourceMap).map(([source, counts]) => ({
      source,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      ...Object.fromEntries(sourceMembers.map((m) => [m, counts[m] ?? 0])),
    })).sort((a, b) => b.total - a.total);

    return {
      members,
      daily,
      sourceTable,
      sourceMembers,
      totalAssigned: members.reduce((s, m) => s + m.total, 0),
    };
  }
}
