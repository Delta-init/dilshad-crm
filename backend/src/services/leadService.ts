import { Types } from "mongoose";
import { dubaiDayRange } from "../utils/dubaiDay.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { buildPagination } from "../utils/response.js";
import { emitTeamUpdate, emitToUser } from "../socket.js";
import { sendPushToUsers, notifyLeadAssignment } from "./pushService.js";
import type {
  LeadFilters,
  LeadStatus,
  LeadStats,
  ParsedLead,
  AutoAssignResult,
  ActivityAction,
  IRole,
} from "../types/index.js";
import { collectAssignments } from "./leadAlertService.js";
import { phoneMates } from "./whatsapp/sharing.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPopulatedQuery(id: string) {
  return Lead.findById(id)
    .populate("reporter", "name email designation")
    .populate("assignedTo", "name email designation")
    .populate({
      path: "team",
      select: "name status leaders members",
      populate: [
        { path: "leaders", select: "name email designation" },
        { path: "members", select: "name email designation" },
      ],
    })
    // bonusAmount and the Bangalore price: the close starts from them (CreateStudentModal).
    .populate("course", "name amount bonusAmount status bangalore")
    .populate("notes.author", "name email")
    .populate("activityLogs.performedBy", "name email");
}

function addLog(
  lead: Awaited<ReturnType<typeof Lead.findById>> & {
    activityLogs: { push: (v: object) => void };
  },
  action: ActivityAction,
  description: string,
  performedBy: string,
  changes?: Record<string, { from: unknown; to: unknown }>,
) {
  lead.activityLogs.push({
    action,
    description,
    performedBy,
    changes,
    createdAt: new Date(),
  } as never);
}

// ── Emit last activity log to the lead's team room ────────────────────────────
async function emitActivity(lead: {
  _id: unknown;
  name: string;
  team?: unknown;
  activityLogs: unknown[];
}) {
  const teamId = lead.team ? String(lead.team) : null;
  if (!teamId) return;
  const log = lead.activityLogs[lead.activityLogs.length - 1] as Record<
    string,
    unknown
  >;
  if (!log) return;

  // Fetch performer name
  const performer = log.performedBy
    ? await User.findById(log.performedBy).select("name email").lean()
    : null;

  emitTeamUpdate(teamId, {
    _id: String(log._id ?? ""),
    type: "activity",
    action: log.action,
    description: log.description,
    performedBy: performer
      ? {
          _id: String(performer._id),
          name: performer.name,
          email: performer.email,
        }
      : null,
    leadId: String(lead._id),
    leadName: lead.name,
    changes: log.changes ?? undefined,
    createdAt: (log.createdAt as Date).toISOString(),
  });
}

// ── Notify team leaders about a lead event ────────────────────────────────────
async function notifyTeamLeaders(
  lead: { _id: unknown; name: string; team?: unknown },
  skipUserId: string,
  payload: {
    title: string;
    body: string;
    tag?: string;
    url?: string;
    data?: Record<string, unknown>;
  },
) {
  const teamId = lead.team ? String(lead.team) : null;
  if (!teamId) return;

  const teamDoc = await Team.findById(teamId).select("leaders").lean();
  if (!teamDoc) return;

  const leaderIds = (teamDoc.leaders as unknown as { toString(): string }[])
    .map((l) => l.toString())
    .filter((id) => id !== skipUserId);

  for (const lid of leaderIds) {
    emitToUser(lid, "notification", {
      ...payload,
      createdAt: new Date().toISOString(),
    });
  }
  sendPushToUsers(leaderIds, payload).catch(() => null);
}

// ── Return midnight UTC for the current AED calendar day ─────────────────────
function istMidnightUTC(): Date {
  const now = new Date();
  // AED = UTC+4; floor to day in AED then convert back to UTC
  const aedOffset = 4 * 60 * 60 * 1000;
  const aedNow = new Date(now.getTime() + aedOffset);
  const aedMidnight = new Date(
    Date.UTC(aedNow.getUTCFullYear(), aedNow.getUTCMonth(), aedNow.getUTCDate()),
  );
  return new Date(aedMidnight.getTime() - aedOffset);
}

// ── Per-team split queue ──────────────────────────────────────────────────────
// Batch callers (sheet sync, bulk upload) fire autoSplitLead for many leads in
// parallel. Round-robin cursors and count-based selection must each see the
// previous assignment's write, so splits for the SAME team are serialized
// through a promise chain. Different teams still split in parallel. Moving an
// inactive lead on picks its next owner through the same chain.
const teamSplitQueues = new Map<string, Promise<void>>();

/** Runs `task` after every split already queued for this team. */
export function runInTeamQueue<T>(teamId: string, task: () => Promise<T>): Promise<T> {
  const prev = teamSplitQueues.get(teamId) ?? Promise.resolve();
  const run = prev.then(task);
  // Guard the chain so one failure can never wedge the queue.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  teamSplitQueues.set(teamId, tail);
  void tail.finally(() => {
    if (teamSplitQueues.get(teamId) === tail) teamSplitQueues.delete(teamId);
  });
  return run;
}

function autoSplitLead(
  teamId: string,
  leadId: string,
  performedById: string,
  overrideMemberIds?: string[],
  bypassSplitTime = false,
): Promise<void> {
  // Inner catches its own errors.
  return runInTeamQueue(teamId, () =>
    autoSplitLeadInner(teamId, leadId, performedById, overrideMemberIds, bypassSplitTime),
  );
}

// ── Auto-split a lead to a team member based on team settings ────────────────
async function autoSplitLeadInner(
  teamId: string,
  leadId: string,
  performedById: string,
  overrideMemberIds?: string[],
  bypassSplitTime = false,
) {
  try {
    const team = await Team.findById(teamId)
      .populate("members", "_id")
      .populate("leaders", "_id")
      .lean();
    if (!team || !team.settings?.autoAssign) return;

    // ── splitTime gate — when a scheduled split time is configured, ALL leads
    //    are held (assignedTo = null) and queued in the Upcoming Batch regardless
    //    of what time they arrive. The scheduler fires once at splitTime each day
    //    and assigns everything accumulated since the last run.
    //    bypassSplitTime=true skips this gate (used by manual redistribute).
    const splitStrategy: string = (team.settings as any)?.splitStrategy ?? "scheduled";
    if (!bypassSplitTime && splitStrategy !== "live") {
      const splitTime: string | null = (team.settings as any)?.splitTime ?? null;
      if (splitTime) return; // always hold — scheduler handles assignment at splitTime
    }

    const assigneeId = await pickSplitAssignee(team as unknown as SplitTeam, leadId, { overrideMemberIds });
    if (!assigneeId) return;

    const user = await User.findById(assigneeId).select("_id name").lean();
    if (!user) return;

    await Lead.updateOne(
      { _id: leadId },
      {
        $set: {
          assignedTo: user._id,
          status: "assigned",
          assignedAt: new Date(),
        },
      },
    );

    await Lead.updateOne(
      { _id: leadId },
      {
        $push: {
          activityLogs: {
            action: "lead_assigned",
            description: `Auto-assigned to "${user.name}" via ${splitStrategy === "live" ? "live split (source + total fair)" : team.settings.splitMode === "equal_load" ? "equal load" : "round robin"}`,
            // The scheduler passes "system": not a person, and an ObjectId field can't hold it — the log failed, and the
            // notice after it never went (2026-10-19). Left out, the screens show it as "System".
            ...(Types.ObjectId.isValid(performedById) ? { performedBy: performedById } : {}),
            createdAt: new Date(),
          },
        },
      },
    );

    const splitLead = await Lead.findById(leadId).select("name").lean();
    void notifyLeadAssignment(
      assigneeId,
      leadId,
      splitLead?.name ?? "",
      emitToUser,
    );
  } catch (err) {
    console.error("[autoSplitLead] error:", err);
  }
}

// ── Pick the member the team's split rule gives a lead to ────────────────────
/** A team as the split reads it: leaders and members populated with at least `_id`. */
export interface SplitTeam {
  _id: { toString(): string };
  leaders: Array<{ _id: { toString(): string } }>;
  members: Array<{ _id: { toString(): string } }>;
  inactiveMembers?: Array<{ toString(): string }>;
  absentToday?: Array<{ userId: { toString(): string }; date: Date }>;
  settings?: {
    splitMode?: "round_robin" | "equal_load";
    splitStrategy?: string;
    roundRobinIndex?: number;
    includedMembers?: Array<{ toString(): string }>;
    roundRobinStartDate?: Date | string | null;
    sourceRoundRobinIndices?: Record<string, number>;
    sourceExclusions?: Record<string, string[]>;
  };
}

/** The next member in a rotation from `cursor` who is not excluded, and where the cursor goes after them. */
function nextInRotation(pool: string[], cursor: number, excluded: Set<string>): { pick: string; next: number } | null {
  for (let k = 0; k < pool.length; k++) {
    const i = (cursor + k) % pool.length;
    if (!excluded.has(pool[i])) return { pick: pool[i], next: (i + 1) % pool.length };
  }
  return null;
}

/**
 * The member the team's split rule gives this lead to, or null when nobody in
 * the pool can take it. Round-robin advances the team's cursor, so call it
 * inside runInTeamQueue.
 *
 * `exclude` takes people out of the running without changing whose turn it
 * is: moving an inactive lead on never picks its current owner, nor anyone
 * who lost it before — their turn passes to the next person in line.
 */
export async function pickSplitAssignee(
  team: SplitTeam,
  leadId: string,
  opts: { overrideMemberIds?: string[]; exclude?: string[] } = {},
): Promise<string | null> {
  const teamId = team._id.toString();
  const settings = team.settings ?? {};
  const splitStrategy: string = settings.splitStrategy ?? "scheduled";
  const excluded = new Set(opts.exclude ?? []);

  const allMemberIds = [
    ...team.leaders.map((u) => u._id.toString()),
    ...team.members.map((u) => u._id.toString()),
  ].filter((id, i, arr) => arr.indexOf(id) === i);

  const inactiveSet = new Set((team.inactiveMembers ?? []).map((id) => id.toString()));

  // Build absent-today set — entries matching today's AED date
  const todayMidnight = istMidnightUTC();
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 86400000);
  const absentSet = new Set(
    (team.absentToday ?? [])
      .filter((a) => a.date >= todayMidnight && a.date < tomorrowMidnight)
      .map((a) => a.userId.toString()),
  );

  // Lead source — needed for per-member source exclusions and source-wise RR
  const leadDoc = await Lead.findById(leadId).select("source").lean();
  const source = (leadDoc?.source as string | undefined)?.trim() || "";
  const srcNorm = source.toLowerCase();

  // Per-member source exclusions — these members never receive this source
  const exclusions = settings.sourceExclusions;
  const isExcludedForSource = (id: string): boolean => {
    if (!srcNorm) return false;
    const list = exclusions?.[id];
    return !!list?.some((s) => s.trim().toLowerCase() === srcNorm);
  };

  // Priority: per-call override → team.settings.includedMembers → all members
  let includedSet: string[];
  if (opts.overrideMemberIds && opts.overrideMemberIds.length > 0) {
    includedSet = opts.overrideMemberIds.filter((id) => allMemberIds.includes(id));
  } else {
    includedSet = (settings.includedMembers ?? [])
      .map((id) => id.toString())
      .filter((id) => allMemberIds.includes(id));
  }
  const pool = (includedSet.length > 0 ? includedSet : allMemberIds).filter(
    (id) => !inactiveSet.has(id) && !absentSet.has(id) && !isExcludedForSource(id),
  );
  const candidates = pool.filter((id) => !excluded.has(id));

  if (candidates.length === 0) return null;

  if (splitStrategy === "live") {
    // Live mode — SOURCE + TOTAL fair, per GST day: the lead goes to the
    // pool member with the fewest leads of THIS source today, tie-broken by
    // fewest total leads today, then stable pool order. Sources stay evenly
    // spread AND daily totals never drift more than 1 apart (a small
    // source's single lead flows to whoever is lowest overall, instead of
    // whoever a blind rotation points at). Runs inside the per-team queue,
    // so each pick sees the previous assignment.
    const liveDayStart = istMidnightUTC();
    const stats = await Promise.all(
      candidates.map(async (id) => ({
        id,
        srcCount: source
          ? await Lead.countDocuments({ assignedTo: id, assignedAt: { $gte: liveDayStart }, source })
          : 0,
        totalCount: await Lead.countDocuments({ assignedTo: id, assignedAt: { $gte: liveDayStart } }),
      })),
    );
    let best = stats[0];
    for (const st of stats) {
      if (st.srcCount < best.srcCount || (st.srcCount === best.srcCount && st.totalCount < best.totalCount)) {
        best = st;
      }
    }
    return best.id;
  }

  if (settings.splitMode === "equal_load") {
    const counts = await Promise.all(
      candidates.map((id) =>
        Lead.countDocuments({
          team: teamId,   // scope to THIS team so cross-team load doesn't skew the count
          assignedTo: id,
          status: {
            $in: ["new", "assigned", "followup", "interested", "cnc", "callback", "rnr", "whatsapp"],
          },
        }),
      ),
    );
    const minIndex = counts.indexOf(Math.min(...counts));
    return candidates[minIndex];
  }

  // round_robin — if roundRobinStartDate is set, pick the member with fewest
  // leads assigned since that date (fair start-date-bounded distribution).
  // Otherwise fall back to stored index.
  const startDate = settings.roundRobinStartDate ? new Date(settings.roundRobinStartDate) : null;

  if (startDate) {
    const counts = await Promise.all(
      candidates.map((id) =>
        Lead.countDocuments({
          assignedTo: id,
          assignedAt: { $gte: startDate },
        }),
      ),
    );
    const minCount = Math.min(...counts);
    // Among tied members, prefer the one earliest in pool order (deterministic)
    const minIndex = counts.indexOf(minCount);
    return candidates[minIndex];
  }

  // Source-wise round robin: each unique lead source has its own cursor so
  // sources don't steal turns from each other when volumes differ.
  if (source) {
    const srcIdx = settings.sourceRoundRobinIndices?.[source] ?? 0;
    const turn = nextInRotation(pool, srcIdx, excluded);
    if (!turn) return null;
    await Team.updateOne(
      { _id: teamId },
      { $set: { [`settings.sourceRoundRobinIndices.${source}`]: turn.next } },
    );
    return turn.pick;
  }

  const turn = nextInRotation(pool, settings.roundRobinIndex ?? 0, excluded);
  if (!turn) return null;
  await Team.updateOne(
    { _id: teamId },
    { $set: { "settings.roundRobinIndex": turn.next } },
  );
  return turn.pick;
}

// Public wrapper so teamController can call autoSplitLead without coupling to LeadService class
export async function autoSplitLeadPublic(
  teamId: string,
  leadId: string,
  performedById: string,
  overrideMemberIds?: string[],
  bypassSplitTime = false,
) {
  return autoSplitLead(teamId, leadId, performedById, overrideMemberIds, bypassSplitTime);
}

// ─── LeadService ──────────────────────────────────────────────────────────────

export class LeadService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createLead(
    data: ParsedLead & {
      status?: LeadStatus;
      assignedTo?: string;
      course?: string | null;
      team?: string | null;
    },
    reporterId: string,
  ) {
    // If no team was selected, auto-detect the creator's team so the lead
    // is visible to the team leader and shows up in team-scoped reports.
    let resolvedTeamId = data.team || null;
    if (!resolvedTeamId) {
      const creatorTeam = await Team.findOne({
        $or: [{ members: reporterId }, { leaders: reporterId }],
        status: "active",
      })
        .select("_id")
        .lean();
      if (creatorTeam) {
        resolvedTeamId = creatorTeam._id.toString();
      }
    }

    const lead = await Lead.create({
      ...data,
      team: resolvedTeamId,
      assignedAt: data.assignedTo ? new Date() : null,
      reporter: reporterId,
      activityLogs: [
        {
          action: "lead_created",
          description: "Lead was created",
          performedBy: reporterId,
          createdAt: new Date(),
        },
      ],
    });

    return buildPopulatedQuery(lead._id.toString());
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  async getLeads(filters: LeadFilters, userId?: string, userRole?: IRole) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(
      300,
      Math.max(1, parseInt(filters.limit ?? "10", 10)),
    );
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    // console.log( (userRole?.roleName === "Super Admin" || userRole?.roleName === "Reporter"),userRole,"NAKANANKA" )
    // ── Role-scoped visibility ────────────────────────────────────────────────
    const isSuperAdmin =
      userRole?.roleName === "Super Admin" || userRole?.roleName === "Reporter";

    if (!isSuperAdmin && userId) {
      // Check if the user is a leader of any team
      const leaderTeam = await Team.findOne({ leaders: userId }).select("_id");

      if (leaderTeam) {
        // Team leader: scoped to their team only
        query.team = leaderTeam._id;
      } else {
        // Regular member / BDE / any non-admin role: only their assigned leads —
        // and those of whoever shares a WhatsApp with them (2026-10-31).
        const mates = await phoneMates(userId);
        query.assignedTo = mates.length > 1 ? { $in: mates.map((m) => new Types.ObjectId(m)) } : userId;
      }
    }

    if (filters.status) query.status = filters.status;
    // A filter narrows what the caller may see — it never replaces the limit on
    // their role. One that points outside it matches nothing.
    let outsideView = false;
    const narrow = (key: "assignedTo" | "team", value: string) => {
      const scoped = query[key];
      const within = scoped && typeof scoped === "object" && "$in" in scoped
        ? (scoped as { $in: unknown[] }).$in.some((x) => String(x) === value)
        : scoped === undefined || String(scoped) === value;
      if (!within) outsideView = true;
      else query[key] = value;
    };
    if (filters.assignedTo) narrow("assignedTo", filters.assignedTo);
    if (filters.team) narrow("team", filters.team);
    if (outsideView) return { leads: [], pagination: buildPagination(0, page, limit) };
    if (filters.reporter) query.reporter = filters.reporter;
    if (filters.course) query.course = filters.course;
    if (filters.source) query.source = new RegExp(filters.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    // These six were declared on LeadFilters and, for demo scheduled/attended,
    // wired to visible dropdowns — but nothing here ever read them, so those
    // controls silently returned unfiltered results.
    if (filters.lostReason) query.lostReason = filters.lostReason;
    if (filters.campaignId) query.campaign = filters.campaignId;

    // "true"/"false" arrive as strings. Anything else means no filter rather
    // than a coerced false, which would hide every lead the moment an
    // unexpected value showed up.
    if (filters.demoScheduled === "true" || filters.demoScheduled === "false") {
      query.demoScheduled = filters.demoScheduled === "true";
    }
    if (filters.demoAttended === "true" || filters.demoAttended === "false") {
      query.demoAttended = filters.demoAttended === "true";
    }

    // Follow-up window, on the same day-boundary rule as the createdAt range.
    if (filters.followupFrom || filters.followupTo) {
      const followupRange = dubaiDayRange(filters.followupFrom, filters.followupTo);
      if (followupRange) query.lastFollowupDate = followupRange;
    }

    // ── Split-date window on assignedAt — shows leads SPLIT in the range even
    //    if they were created earlier (e.g. created yesterday, split today).
    if (filters.splitFrom || filters.splitTo) {
      const splitRange = dubaiDayRange(filters.splitFrom, filters.splitTo);
      if (splitRange) query.assignedAt = splitRange;
    }

    // ── Date range filter on createdAt ──────────────────────────────────────────
    if (filters.dateFrom || filters.dateTo) {
      const dateRange = dubaiDayRange(filters.dateFrom, filters.dateTo);
      if (dateRange) query.createdAt = dateRange;
    }

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    const sortField = filters.sortBy ?? "createdAt";
    const sortOrder = filters.sortOrder === "asc" ? 1 : -1;

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate("reporter", "name email")
        .populate("assignedTo", "name email")
        .populate("team", "name status")
        .populate("course", "name amount bonusAmount status bangalore")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .select("-activityLogs -notes")
        .lean(),
      Lead.countDocuments(query),
    ]);

    return { leads, pagination: buildPagination(total, page, limit) };
  }

  // ── Get by ID (full detail with notes + logs) ────────────────────────────────
  async getLeadById(id: string) {
    const lead = await buildPopulatedQuery(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    return lead;
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  async updateLead(
    id: string,
    data: Partial<
      ParsedLead & {
        status?: LeadStatus;
        assignedTo?: string | null;
        course?: string | null;
        initialLeadResponse?: string;
        primaryConcern?: string;
        followupStrategy?: string;
        lastFollowupDate?: string | null;
        firstContactTime?: string | null;
        demoScheduled?: boolean | null;
        demoAttended?: boolean | null;
        sellingAmount?: number | null;
        followupStrategyType?: string | null;
        leadReceivedTime?: string | null;
        exactConcern?: string | null;
        comments?: string | null;
      }
    >,
    performedById: string,
  ) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    // Track field changes for the log
    const trackedFields: Array<keyof typeof data> = [
      "name",
      "email",
      "phone",
      "source",
      "course",
      "status",
      "initialLeadResponse",
      "primaryConcern",
      "followupStrategyType",
      "firstContactTime",
      "lastFollowupDate",
      "demoScheduled",
      "demoAttended",
      "sellingAmount",
    ];
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    for (const field of trackedFields) {
      if (data[field] !== undefined) {
        const prev = (lead as unknown as Record<string, unknown>)[field];
        const next = data[field];
        if (String(prev ?? "") !== String(next ?? "")) {
          changes[field] = { from: prev, to: next };
        }
      }
    }

    const prevAssignedTo = lead.assignedTo?.toString() ?? null;

    // ── Referral rule: source "referral" requires referredBy ─────────────────
    const finalSource =
      data.source !== undefined ? data.source : (lead as unknown as Record<string, unknown>).source;
    const isReferral =
      typeof finalSource === "string" && finalSource.toLowerCase().includes("referral");
    const finalReferredBy =
      (data as Record<string, unknown>).referredBy !== undefined
        ? (data as Record<string, unknown>).referredBy
        : (lead as unknown as Record<string, unknown>).referredBy;
    if (isReferral && !(typeof finalReferredBy === "string" && finalReferredBy.trim())) {
      throw Object.assign(new Error("Referred By is mandatory for referral leads"), {
        statusCode: 400,
      });
    }
    if (!isReferral && data.source !== undefined) {
      // Moving away from referral — clear the referral fields
      (data as Record<string, unknown>).referredBy = null;
      (data as Record<string, unknown>).referralType = null;
    }

    Object.assign(lead, data);

    // Stamp assignedAt whenever assignedTo is set or changed
    const newAssignee = data.assignedTo ? String(data.assignedTo) : undefined;
    if (newAssignee && newAssignee !== prevAssignedTo) {
      (lead as unknown as Record<string, unknown>).assignedAt = new Date();
      // Reset firstContactTime when re-assigned to a new agent
      (lead as unknown as Record<string, unknown>).firstContactTime = null;
    } else if (data.assignedTo === null) {
      (lead as unknown as Record<string, unknown>).assignedAt = null;
      (lead as unknown as Record<string, unknown>).firstContactTime = null;
    }

    // Auto-stamp firstContactTime when the assigned agent changes status/fields for the first time
    const currentAssignee = (lead as unknown as Record<string, unknown>).assignedTo?.toString();
    const currentAssignedAt = (lead as unknown as Record<string, unknown>).assignedAt as Date | null;
    const currentFirstContact = (lead as unknown as Record<string, unknown>).firstContactTime as Date | null;
    const isStatusChange = data.status !== undefined && data.status !== "new" && data.status !== "assigned";
    if (
      currentAssignee &&
      currentAssignee === performedById &&
      currentAssignedAt &&
      !currentFirstContact &&
      isStatusChange
    ) {
      (lead as unknown as Record<string, unknown>).firstContactTime = new Date();
    }

    const changedFields = Object.keys(changes);
    if (changedFields.length > 0) {
      addLog(
        lead as never,
        "lead_updated",
        `Updated field(s): ${changedFields.join(", ")}`,
        performedById,
        changes,
      );
    }

    await lead.save();

    // If assignedTo changed, notify the new assignee
    const newAssignedTo = data.assignedTo ? String(data.assignedTo) : null;
    if (newAssignedTo && newAssignedTo !== prevAssignedTo) {
      void notifyLeadAssignment(
        newAssignedTo,
        String(lead._id),
        lead.name,
        emitToUser,
      ).catch(() => null);
    }

    return buildPopulatedQuery(id);
  }

  // ── Update Status ────────────────────────────────────────────────────────────
  async updateLeadStatus(
    id: string,
    status: LeadStatus,
    performedById: string,
    lostReason?: string,
    lostNotes?: string,
    followUp?: { note: string; followedUpAt: Date; nextFollowUpAt?: Date | null },
    meeting?: { at: Date; note?: string },
  ) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const prevStatus = lead.status;
    lead.status = status;

    // A status change means the agent just worked the lead — refresh followup date
    if (prevStatus !== status) {
      (lead as unknown as Record<string, unknown>).lastFollowupDate = new Date();
    }

    // ── Followup status: mandatory details recorded into the follow-up history ─
    if (status === "followup" && followUp) {
      (lead.followUps as unknown as Array<Record<string, unknown>>).push({
        note: followUp.note,
        followedUpAt: followUp.followedUpAt,
        followedUpBy: performedById,
        nextFollowUpAt: followUp.nextFollowUpAt ?? null,
      });
      // The actual follow-up time overrides the auto "now" stamp
      (lead as unknown as Record<string, unknown>).lastFollowupDate = followUp.followedUpAt;
      if (followUp.nextFollowUpAt) {
        (lead as unknown as Record<string, unknown>).nextFollowUpAt = followUp.nextFollowUpAt;
        // Next follow-up doubles as a reminder — plugs into the reminder scheduler
        (lead.reminders as unknown as Array<Record<string, unknown>>).push({
          title: "Follow-up due",
          note: followUp.note.slice(0, 200),
          remindAt: followUp.nextFollowUpAt,
          createdBy: performedById,
          isDone: false,
        });
      }
    }

    // ── Meeting scheduled: the meeting time becomes a reminder ────────────────
    // Reminders notify their createdBy, so it is the lead's owner — the person who
    // goes to the meeting — or, for a lead nobody owns, whoever booked it.
    let meetingNote = "";
    if (status === "meeting_scheduled" && meeting) {
      (lead.reminders as unknown as Array<Record<string, unknown>>).push({
        title: "Meeting scheduled",
        note: meeting.note ?? "",
        remindAt: meeting.at,
        createdBy: lead.assignedTo ? String(lead.assignedTo) : performedById,
        isDone: false,
      });
      meetingNote = ` — meeting on ${meeting.at.toLocaleString("en-GB", {
        timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short",
      })} (Dubai)`;
    }

    // ── Meeting done: its meeting reminder is closed, so it doesn't ring for a
    // meeting that has already happened (one fired already is closed too).
    if (status === "meeting_done") {
      for (const r of lead.reminders as unknown as Array<{ title?: string; isDone?: boolean }>) {
        if (r.title === "Meeting scheduled" && !r.isDone) r.isDone = true;
      }
    }

    if (status === "lost") {
      (lead as unknown as Record<string, unknown>).lostReason = lostReason ?? null;
      (lead as unknown as Record<string, unknown>).lostNotes  = lostNotes  ?? null;
    } else if (prevStatus === "lost") {
      // Cleared if moving away from lost
      (lead as unknown as Record<string, unknown>).lostReason = null;
      (lead as unknown as Record<string, unknown>).lostNotes  = null;
    }

    addLog(
      lead as never,
      "status_changed",
      `Status changed from "${prevStatus}" to "${status}"${meetingNote}`,
      performedById,
      {
        status:     { from: prevStatus, to: status },
        ...(status === "lost" && lostReason ? { lostReason: { from: null, to: lostReason } } : {}),
      },
    );

    await lead.save();
    void emitActivity(lead as never);
    // Notify team leaders of status change
    void notifyTeamLeaders(lead as never, performedById, {
      title: "Lead Status Updated",
      body: `${lead.name}: status changed to "${status}"`,
      tag: `status-${String(lead._id)}`,
      url: `/leads/${String(lead._id)}`,
      data: { type: "status_changed", leadId: String(lead._id) },
    });
    return buildPopulatedQuery(id);
  }

  // ── Assign ───────────────────────────────────────────────────────────────────
  async assignLead(id: string, userId: string, performedById: string) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const user = await User.findById(userId);
    if (!user)
      throw Object.assign(new Error("User not found"), { statusCode: 404 });

    const prevAssignee = lead.assignedTo?.toString() ?? null;
    lead.assignedTo = user._id;
    lead.status = "assigned";
    (lead as unknown as Record<string, unknown>).assignedAt = new Date();

    addLog(
      lead as never,
      "lead_assigned",
      `Lead assigned to ${user.name}`,
      performedById,
      {
        assignedTo: { from: prevAssignee, to: user._id.toString() },
        status: { from: lead.status, to: "assigned" },
      },
    );

    await lead.save();
    void emitActivity(lead as never);
    return buildPopulatedQuery(id);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async deleteLead(id: string) {
    const lead = await Lead.findById(id);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    await Lead.findByIdAndDelete(id);
    return { message: "Lead deleted successfully" };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Notes
  // ─────────────────────────────────────────────────────────────────────────────

  async addNote(leadId: string, content: string, authorId: string) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    lead.notes.push({
      content,
      author: authorId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    // Auto-stamp firstContactTime when the assigned agent adds their first note
    const assignedId = (lead as unknown as Record<string, unknown>).assignedTo?.toString();
    const assignedAt = (lead as unknown as Record<string, unknown>).assignedAt as Date | null;
    const firstContact = (lead as unknown as Record<string, unknown>).firstContactTime as Date | null;
    if (assignedId === authorId && assignedAt && !firstContact) {
      (lead as unknown as Record<string, unknown>).firstContactTime = new Date();
    }

    addLog(lead as never, "note_added", "A note was added", authorId, {
      note: { from: null, to: content },
    });

    await lead.save();
    void emitActivity(lead as never);
    // Notify team leaders of new note
    void notifyTeamLeaders(lead as never, authorId, {
      title: "Note Added",
      body: `${lead.name}: ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
      tag: `note-${String(lead._id)}`,
      url: `/leads/${String(lead._id)}`,
      data: { type: "note_added", leadId: String(lead._id) },
    });
    return buildPopulatedQuery(leadId);
  }

  async updateNote(
    leadId: string,
    noteId: string,
    content: string,
    performedById: string,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const note = lead.notes.id(noteId);
    if (!note)
      throw Object.assign(new Error("Note not found"), { statusCode: 404 });

    // Only the note author can edit their note
    if (note.author.toString() !== performedById) {
      throw Object.assign(new Error("Not authorised to edit this note"), {
        statusCode: 403,
      });
    }

    const prevContent = note.content;
    note.content = content;
    (note as unknown as { updatedAt: Date }).updatedAt = new Date();

    addLog(lead as never, "note_updated", "A note was updated", performedById, {
      note: { from: prevContent, to: content },
    });

    await lead.save();
    void emitActivity(lead as never);
    return buildPopulatedQuery(leadId);
  }

  async deleteNote(
    leadId: string,
    noteId: string,
    performedById: string,
    isSuperAdmin = false,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const note = lead.notes.id(noteId);
    if (!note)
      throw Object.assign(new Error("Note not found"), { statusCode: 404 });

    // Only note author or super-admin can delete
    if (!isSuperAdmin && note.author.toString() !== performedById) {
      throw Object.assign(new Error("Not authorised to delete this note"), {
        statusCode: 403,
      });
    }

    const deletedContent = note.content;
    note.deleteOne();

    addLog(lead as never, "note_deleted", "A note was deleted", performedById, {
      note: { from: deletedContent, to: null },
    });

    await lead.save();
    return buildPopulatedQuery(leadId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // User-scoped queries
  // ─────────────────────────────────────────────────────────────────────────────

  async getLeadsByUser(userId: string, filters: LeadFilters) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(
      300,
      Math.max(1, parseInt(filters.limit ?? "10", 10)),
    );
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { assignedTo: userId };
    if (filters.status) query.status = filters.status;

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    // Created-date window (was declared on LeadFilters but never applied here)
    if (filters.dateFrom || filters.dateTo) {
      const dateRange = dubaiDayRange(filters.dateFrom, filters.dateTo);
      if (dateRange) query.createdAt = dateRange;
    }

    // Split-date window on assignedAt — leads SPLIT in the range even if
    // created earlier (created yesterday, split today).
    if (filters.splitFrom || filters.splitTo) {
      const splitRange = dubaiDayRange(filters.splitFrom, filters.splitTo);
      if (splitRange) query.assignedAt = splitRange;
    }

    const sortField = filters.sortBy ?? "createdAt";
    const sortOrder = filters.sortOrder === "asc" ? 1 : -1;

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate("reporter", "name email")
        .populate("assignedTo", "name email")
        .sort({ [sortField]: sortOrder })
        .skip(skip)
        .limit(limit)
        .select("-activityLogs")
        .lean(),
      Lead.countDocuments(query),
    ]);

    return { leads, pagination: buildPagination(total, page, limit) };
  }

  async getUserLeadStats(userId: string): Promise<LeadStats> {
    const statuses: LeadStatus[] = [
      "new",
      "assigned",
      "followup",
      "closed",

      "cnc",
      "callback",
      "lost",
      "mia",
      "repeated",
      "pending_response",
      "not_connected",
      "meeting_scheduled",
      "wrong_number",
      "meeting_done",
    ];
    const [total, ...statusCounts] = await Promise.all([
      Lead.countDocuments({ assignedTo: userId }),
      ...statuses.map((s) =>
        Lead.countDocuments({ assignedTo: userId, status: s }),
      ),
    ]);

    return {
      total,
      new: statusCounts[0],
      assigned: statusCounts[1],
      followup: statusCounts[2],
      closed: statusCounts[3],
    
      cnc: statusCounts[4],
      callback: statusCounts[5],
      lost: statusCounts[6],
      mia: statusCounts[7],
      repeated: statusCounts[8],
      pending_response: statusCounts[9],
      not_connected: statusCounts[10],
      meeting_scheduled: statusCounts[11],
      wrong_number: statusCounts[12],
      meeting_done: statusCounts[13],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk / Auto-assign
  // ─────────────────────────────────────────────────────────────────────────────

  async bulkCreateLeads(leads: ParsedLead[], reporterId: string) {
    const EMAIL_RE = /^\S+@\S+\.\S+$/;

    const leadsWithReporter = leads.map((lead) => {
      // Only keep email if it looks like a real address — "No Email" / blanks
      // would fail the Lead schema regex and cause insertMany to reject the row.
      const email =
        lead.email && EMAIL_RE.test(lead.email.trim())
          ? lead.email.trim().toLowerCase()
          : undefined;

      return {
        ...lead,
        email, // undefined = field omitted from document
        reporter: reporterId,
        // notes must be an ARRAY of sub-documents, not a plain object.
        // Passing an object here caused every row to fail Mongoose validation.
        notes: lead.notes ? [{ content: lead.notes, author: reporterId }] : [],
        activityLogs: [
          {
            action: "lead_created",
            description: "Lead was created via bulk upload",
            performedBy: reporterId,
            createdAt: new Date(),
          },
        ],
      };
    });

    const created = await Lead.insertMany(leadsWithReporter, {
      ordered: false,
    });
    return created;
  }

  async autoAssignLeads(
    leadIds?: string[],
    teamIds?: string[],
    memberOverrides?: Record<string, string[]>,
  ): Promise<AutoAssignResult> {
    // Everyone's new leads in one notice each, not one per lead (2026-10-19).
    return collectAssignments(async () => {
      // Empty array means "no teams selected → skip auto-assign entirely"
      if (Array.isArray(teamIds) && teamIds.length === 0) {
        return { assigned: 0, results: [] };
      }
  
      const query =
        leadIds && leadIds.length > 0
          ? { _id: { $in: leadIds } }
          : { status: "new", team: null };
  
      const leadsToAssign = await Lead.find(query);
      if (leadsToAssign.length === 0) return { assigned: 0, results: [] };
  
      // If specific team IDs supplied, restrict to those teams only
      const teamFilter =
        teamIds && teamIds.length > 0
          ? { status: "active", _id: { $in: teamIds } }
          : { status: "active" };
  
      const activeTeams = await Team.find(teamFilter);
      if (activeTeams.length === 0) {
        // When caller specified specific teams but none matched / inactive, skip silently
        if (teamIds && teamIds.length > 0) return { assigned: 0, results: [] };
        throw Object.assign(new Error("No active teams found for assignment"), {
          statusCode: 404,
        });
      }
  
      // Fair balancing window: the current GST day. The balance is computed from
      // the ACTUAL leads each participating member received today (assignedAt),
      // so direct assignments to non-participating people (KSA quota, Hindi
      // leads) don't count against the team, manual assignments to members do
      // count, and every participating member across all teams converges to the
      // same daily lead count.
      const dayStart = istMidnightUTC();
  
      const teamLeadCounts = (
        await Promise.all(
          activeTeams.map(async (team) => {
            const allIds = [
              ...(team.leaders as unknown as { toString(): string }[]),
              ...(team.members as unknown as { toString(): string }[]),
            ].map((id) => id.toString());
            const uniqueIds = [...new Set(allIds)];
            const inactive = new Set(
              (team.inactiveMembers as unknown as { toString(): string }[]).map((id) => id.toString()),
            );
            // Members marked absent for TODAY receive nothing and are left out of
            // the day's math so their teammates aren't over-fed on their behalf
            const tomorrow = new Date(dayStart.getTime() + 86400000);
            const absent = new Set(
              (team.absentToday as unknown as { userId: { toString(): string }; date: Date }[])
                .filter((a) => a.date >= dayStart && a.date < tomorrow)
                .map((a) => a.userId.toString()),
            );
            const included = ((team.settings?.includedMembers ?? []) as unknown as { toString(): string }[])
              .map((id) => id.toString())
              .filter((id) => uniqueIds.includes(id));
            const candidates = (included.length > 0 ? included : uniqueIds)
              .filter((id) => !inactive.has(id) && !absent.has(id));
            // Only globally ACTIVE user accounts participate
            const activeUsers = await User.find({ _id: { $in: candidates }, status: "active" })
              .select("_id")
              .lean();
            const poolIds = activeUsers.map((u) => u._id);
            if (poolIds.length === 0) return { team, count: 0, memberCount: 0 };
  
            // Leads the pool members actually received today (any path — auto,
            // manual, transfer), summed across the pool
            const count = await Lead.countDocuments({
              assignedTo: { $in: poolIds },
              assignedAt: { $gte: dayStart },
            });
  
            return { team, count, memberCount: poolIds.length };
          }),
        )
      ).filter((t) => t.memberCount > 0); // teams with nobody to receive leads are skipped
  
      if (teamLeadCounts.length === 0) {
        if (teamIds && teamIds.length > 0) return { assigned: 0, results: [] };
        throw Object.assign(new Error("No active teams with participating members"), {
          statusCode: 404,
        });
      }
  
      // Each lead goes to the team with the lowest per-member load; ties break
      // by fewer raw leads, then stable team order — giving a proportional
      // round-robin across teams of different sizes.
      const assignedTeams: (typeof teamLeadCounts)[0][] = [];
      for (let i = 0; i < leadsToAssign.length; i++) {
        let best = teamLeadCounts[0];
        for (const t of teamLeadCounts) {
          const bestLoad = best.count / best.memberCount;
          const load = t.count / t.memberCount;
          if (load < bestLoad || (load === bestLoad && t.count < best.count)) best = t;
        }
        assignedTeams.push(best);
        best.count++;
      }
  
      const results: { leadId: string; assignedTo: string }[] = [];
      const updates: Promise<unknown>[] = [];
  
      for (let i = 0; i < leadsToAssign.length; i++) {
        const { team } = assignedTeams[i];
        const lead = leadsToAssign[i];
  
        updates.push(
          Lead.findByIdAndUpdate(lead._id, {
            $set: { team: team._id, status: "new" },
            $push: {
              activityLogs: {
                action: "team_assigned",
                description: `Auto-assigned to team "${team.name}"`,
                performedBy: lead.reporter,
                createdAt: new Date(),
              },
            },
          }),
        );
  
        results.push({
          leadId: lead._id.toString(),
          assignedTo: team._id.toString(),
        });
      }
  
      await Promise.all(updates);
  
      // ── Trigger intra-team auto-split for every lead that was just assigned a team
      await Promise.all(
        leadsToAssign.map((lead, i) =>
          autoSplitLead(
            assignedTeams[i].team._id.toString(),
            lead._id.toString(),
            lead.reporter?.toString() ?? "",
            memberOverrides?.[assignedTeams[i].team._id.toString()],
          ),
        ),
      );
  
      return { assigned: results.length, results };
    });
  }

  // ── Assign Lead to Team ───────────────────────────────────────────────────────
  async assignLeadToTeam(
    leadId: string,
    teamId: string,
    performedById: string,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const team = await Team.findById(teamId);
    if (!team)
      throw Object.assign(new Error("Team not found"), { statusCode: 404 });

    const prevTeamId = lead.team?.toString() ?? null;

    // Clear member assignment when reassigning to a (possibly different) team
    lead.team = team._id;
    (lead as unknown as Record<string, unknown>).assignedTo = null;
    lead.status = "new";

    addLog(
      lead as never,
      "team_assigned",
      `Lead assigned to team "${team.name}"`,
      performedById,
      {
        team: { from: prevTeamId, to: team._id.toString() },
        assignedTo: { from: lead.assignedTo?.toString() ?? null, to: null },
      },
    );

    await lead.save();
    await autoSplitLead(teamId, leadId, performedById);
    return buildPopulatedQuery(leadId);
  }

  // ── Transfer Lead to Another Team ────────────────────────────────────────────
  async transferLeadToTeam(
    leadId: string,
    newTeamId: string,
    performedById: string,
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead)
      throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const newTeam = await Team.findById(newTeamId);
    if (!newTeam)
      throw Object.assign(new Error("Target team not found"), {
        statusCode: 404,
      });

    const prevTeamId = lead.team?.toString() ?? null;
    const prevAssigneeId = lead.assignedTo?.toString() ?? null;

    if (prevTeamId === newTeamId)
      throw Object.assign(new Error("Lead is already in this team"), {
        statusCode: 400,
      });

    lead.team = newTeam._id;
    (lead as unknown as Record<string, unknown>).assignedTo = null;
    lead.status = "new";

    addLog(
      lead as never,
      "team_assigned",
      `Lead transferred to team "${newTeam.name}"`,
      performedById,
      {
        team: { from: prevTeamId, to: newTeam._id.toString() },
        assignedTo: { from: prevAssigneeId, to: null },
      },
    );

    await lead.save();
    await autoSplitLead(newTeamId, leadId, performedById);
    return buildPopulatedQuery(leadId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk operations
  // ─────────────────────────────────────────────────────────────────────────────

  /** Bulk-update status for multiple leads, adding an activity log to each */
  async bulkUpdateStatus(
    leadIds: string[],
    status: LeadStatus,
    performedById: string,
    lostReason?: string,
    lostNotes?: string,
    followUp?: { note: string; followedUpAt: Date; nextFollowUpAt?: Date | null },
  ) {
    const leads = await Lead.find({ _id: { $in: leadIds } });
    await Promise.all(
      leads.map(async (lead) => {
        const prev = lead.status;
        if (prev === status) return;
        lead.status = status;
        // Status change = the lead was just worked — refresh followup date
        (lead as unknown as Record<string, unknown>).lastFollowupDate = new Date();
        if (status === "followup" && followUp) {
          (lead.followUps as unknown as Array<Record<string, unknown>>).push({
            note: followUp.note,
            followedUpAt: followUp.followedUpAt,
            followedUpBy: performedById,
            nextFollowUpAt: followUp.nextFollowUpAt ?? null,
          });
          (lead as unknown as Record<string, unknown>).lastFollowupDate = followUp.followedUpAt;
          if (followUp.nextFollowUpAt) {
            (lead as unknown as Record<string, unknown>).nextFollowUpAt = followUp.nextFollowUpAt;
            (lead.reminders as unknown as Array<Record<string, unknown>>).push({
              title: "Follow-up due",
              note: followUp.note.slice(0, 200),
              remindAt: followUp.nextFollowUpAt,
              createdBy: performedById,
              isDone: false,
            });
          }
        }
        if (status === "lost") {
          (lead as unknown as Record<string, unknown>).lostReason = lostReason ?? null;
          (lead as unknown as Record<string, unknown>).lostNotes  = lostNotes  ?? null;
        }
        // Meeting done: its meeting reminder is closed, as for a single change
        if (status === "meeting_done") {
          for (const r of lead.reminders as unknown as Array<{ title?: string; isDone?: boolean }>) {
            if (r.title === "Meeting scheduled" && !r.isDone) r.isDone = true;
          }
        }
        addLog(
          lead as never,
          "status_changed",
          `Status bulk-changed from "${prev}" to "${status}"`,
          performedById,
          {
            status: { from: prev, to: status },
            ...(status === "lost" && lostReason ? { lostReason: { from: null, to: lostReason } } : {}),
          },
        );
        return lead.save();
      }),
    );
    return { updated: leads.length };
  }

  /** Bulk-delete multiple leads */
  async bulkDelete(leadIds: string[]) {
    const result = await Lead.deleteMany({ _id: { $in: leadIds } });
    return { deleted: result.deletedCount };
  }

  /** Bulk-assign multiple leads to a team (clears member assignment) */
  async bulkAssignToTeam(
    leadIds: string[],
    teamId: string,
    performedById: string,
  ) {
    // Everyone's new leads in one notice each, not one per lead (2026-10-19).
    return collectAssignments(async () => {
      const team = await Team.findById(teamId);
      if (!team)
        throw Object.assign(new Error("Team not found"), { statusCode: 404 });
  
      const leads = await Lead.find({ _id: { $in: leadIds } });
      await Promise.all(
        leads.map(async (lead) => {
          const prevTeam = lead.team?.toString() ?? null;
          lead.team = team._id;
          (lead as unknown as Record<string, unknown>).assignedTo = null;
          lead.status = "new";
          addLog(
            lead as never,
            "team_assigned",
            `Bulk-assigned to team "${team.name}"`,
            performedById,
            { team: { from: prevTeam, to: team._id.toString() } },
          );
          return lead.save();
        }),
      );
  
      // ── Trigger intra-team auto-split for each lead moved to this team
      await Promise.all(
        leads.map((lead) =>
          autoSplitLead(teamId, lead._id.toString(), performedById),
        ),
      );
  
      return { updated: leads.length };
    });
  }

  // get leads by phonenumber
  async getLeadsByPhoneNumber(phoneNumber: string) {
    if (!phoneNumber)
      throw Object.assign(new Error("Phone number is required"), {
        statusCode: 400,
      });
    const leads = await Lead.findOne({ phone: phoneNumber });
    return leads;
  }

  // ─── Follow-Ups ───────────────────────────────────────────────────────────────

  async addFollowUp(
    leadId: string,
    performedById: string,
    data: { note?: string; followedUpAt?: Date; nextFollowUpAt?: Date | null },
  ) {
    const lead = await Lead.findById(leadId);
    if (!lead) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });

    const followedUpAt = data.followedUpAt ?? new Date();

    lead.followUps.push({
      note:          data.note,
      followedUpAt,
      followedUpBy:  performedById,
      nextFollowUpAt: data.nextFollowUpAt ?? null,
      createdAt:     new Date(),
      updatedAt:     new Date(),
    } as never);

    // Keep nextFollowUpAt on the lead root for fast querying
    (lead as unknown as Record<string, unknown>).nextFollowUpAt =
      data.nextFollowUpAt !== undefined ? data.nextFollowUpAt : lead.nextFollowUpAt;

    // Auto-update lastFollowupDate
    (lead as unknown as Record<string, unknown>).lastFollowupDate = followedUpAt;

    // Log activity
    lead.activityLogs.push({
      action: "lead_updated",
      description: `Follow-up logged by agent`,
      performedBy: performedById,
      createdAt: new Date(),
    } as never);

    await lead.save();

    // The entry just added, with who logged it — populated through the lead: populate() on the array entry itself
    // throws in Mongoose 8, after the save, so the follow-up was kept but the answer was a 500 (fixed 2026-10-14).
    const at = lead.followUps.length - 1;
    await lead.populate({ path: `followUps.${at}.followedUpBy`, select: "name email" });
    return lead.followUps[at];
  }

  async getFollowUps(leadId: string) {
    const lead = await Lead.findById(leadId)
      .select("followUps nextFollowUpAt")
      .populate("followUps.followedUpBy", "name email")
      .lean();
    if (!lead) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    return {
      followUps: lead.followUps ?? [],
      nextFollowUpAt: (lead as unknown as Record<string, unknown>).nextFollowUpAt ?? null,
      total: (lead.followUps ?? []).length,
    };
  }
}
