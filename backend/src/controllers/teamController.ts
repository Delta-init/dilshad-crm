import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { TeamService } from "../services/teamService.js";
import { ReportService } from "../services/reportService.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { emitTeamUpdate, emitToUser } from "../socket.js";
import { sendPushToUsers } from "../services/pushService.js";
import { Team } from "../models/Team.js";
import { Lead } from "../models/Lead.js";
import { collectAssignments } from "../services/leadAlertService.js";

const teamService   = new TeamService();
const reportService = new ReportService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createTeamSchema = z.object({
  name: z.string().min(1, "Team name is required").max(100),
  description: z.string().max(300).optional(),
  leaders: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(300).optional().nullable(),
  leaders: z.array(z.string()).optional(),
  members: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const autoAssignTeamSchema = z.object({
  leadIds: z.array(z.string()).optional(),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export async function createTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = createTeamSchema.parse(req.body);
    const team = await teamService.createTeam(data);
    sendSuccess(res, "Team created successfully", team, 201);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/teams/mine
 * Returns the team(s) the authenticated user belongs to
 * (either as a leader or as a member).
 * Returns null if the user isn't in any team.
 */
export async function getMyTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = req.user!.userId;
    const team = await teamService.getTeamByMember(userId);
    sendSuccess(res, "My team fetched successfully", team ?? null);
  } catch (err) {
    next(err);
  }
}

export async function getTeams(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      status: req.query.status as string | undefined,
      page: req.query.page as string | undefined,
      limit: req.query.limit as string | undefined,
    };
    const isSuperAdmin =
      req.user?.role?.roleName === "Super Admin" ||
      req.user?.role?.roleName === "Reporter" || 
      req.user?.role?.roleName === "Team Leader";
    if (!isSuperAdmin) {
      sendError(res, "You are not authorized to get teams", 403);
      return;
    }
    const result = await teamService.getTeams(filters);
    sendSuccess(
      res,
      "Teams fetched successfully",
      result.teams,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const team = await teamService.getTeamById(req.params.id);
    sendSuccess(res, "Team fetched successfully", team);
  } catch (err) {
    next(err);
  }
}

export async function updateTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = updateTeamSchema.parse(req.body);
    const team = await teamService.updateTeam(
      req.params.id,
      data as Parameters<typeof teamService.updateTeam>[1],
    );
    sendSuccess(res, "Team updated successfully", team);
  } catch (err) {
    next(err);
  }
}

export async function deleteTeam(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await teamService.deleteTeam(req.params.id);
    sendSuccess(res, result.message);
  } catch (err) {
    next(err);
  }
}

export async function getTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      assignedTo: req.query.assignedTo as string | undefined,
      reporter: req.query.reporter as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page as string | undefined,
      limit: req.query.limit as string | undefined,
      unassignedOnly: req.query.unassignedOnly as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      splitFrom: req.query.splitFrom as string | undefined,
      splitTo: req.query.splitTo as string | undefined,
      course: req.query.course as string | undefined,
    };
    const result = await teamService.getTeamLeads(req.params.id, filters);
    sendSuccess(
      res,
      "Team leads fetched successfully",
      result.leads,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamMemberStats(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const stats = await teamService.getTeamMemberStats(req.params.id);
    sendSuccess(res, "Team member stats fetched successfully", stats);
  } catch (err) {
    next(err);
  }
}

export async function getTeamMemberSplit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
    const data = await teamService.getTeamMemberSplit(req.params.id, dateFrom, dateTo);
    sendSuccess(res, "Team member split fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

export async function getTeamDailySourceSplit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendError(res, "Query param 'date' (YYYY-MM-DD) is required", 400);
      return;
    }
    const data = await teamService.getTeamDailySourceSplit(req.params.id, date);
    sendSuccess(res, "Daily source split fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

export async function autoAssignTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { leadIds } = autoAssignTeamSchema.parse(req.body);
    const result = await teamService.autoAssignTeamLeadsToMembers(
      req.params.id,
      leadIds,
    );
    sendSuccess(
      res,
      `${result.assigned} lead(s) auto-assigned to team members`,
      result,
    );
  } catch (err) {
    next(err);
  }
}

export async function assignLeadToMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { memberId } = z
      .object({ memberId: z.string().min(1) })
      .parse(req.body);
    const performedById = req.user!.userId;

    // Check performer is a leader of the team or has admin-level permission
    const teamId = req.params.id;
    const leadId = req.params.leadId;

    const result = await teamService.assignLeadToMember(
      teamId,
      leadId,
      memberId,
      performedById,
    );
    sendSuccess(res, "Lead assigned to member successfully", result);
  } catch (err) {
    next(err);
  }
}

// ─── Bulk operations ──────────────────────────────────────────────────────────

const bulkLeadIdsSchema = z.object({
  leadIds: z.array(z.string().min(1)).min(1, "At least one lead ID required"),
});

export async function bulkAssignTeamLeadsToMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ memberId: z.string().min(1, "Member ID is required") })
      .parse(req.body);
    const result = await teamService.bulkAssignLeadsToMember(
      req.params.id,
      parsed.leadIds,
      parsed.memberId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) assigned to member`, result);
  } catch (err) {
    next(err);
  }
}

export async function bulkTransferTeamLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({ newTeamId: z.string().min(1, "Target team ID is required") })
      .parse(req.body);
    const result = await teamService.bulkTransferLeads(
      parsed.leadIds,
      parsed.newTeamId,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) transferred`, result);
  } catch (err) {
    next(err);
  }
}

export async function bulkUpdateTeamLeadsStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = bulkLeadIdsSchema
      .extend({
        status: z.enum([
          "new",
          "assigned",
          "followup",
          "closed",
          "rejected",
          "cnc",
          "booking",
          "interested",
          "rnr",
          "callback",
          "whatsapp",
          "student",
        ]),
      })
      .parse(req.body);
    const result = await teamService.bulkUpdateTeamLeadsStatus(
      req.params.id,
      parsed.leadIds,
      parsed.status,
      req.user!.userId,
    );
    sendSuccess(res, `${result.updated} lead(s) status updated`, result);
  } catch (err) {
    next(err);
  }
}

export async function getTeamDashboard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const q = req.query as Record<string, string>;
    const dashboard = await teamService.getTeamDashboard(
      req.params.id,
      q.dateFrom?.trim() || undefined,
      q.dateTo?.trim()   || undefined,
    );
    sendSuccess(res, "Team dashboard fetched successfully", dashboard);
  } catch (err) {
    next(err);
  }
}

export async function getTeamLogs(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const limit = Math.min(
      50,
      Math.max(1, parseInt((req.query.limit as string) ?? "20", 10)),
    );
    const result = await teamService.getTeamLogs(req.params.id, page, limit);
    sendSuccess(
      res,
      "Team logs fetched successfully",
      result.logs,
      200,
      result.pagination,
    );
  } catch (err) {
    next(err);
  }
}

export async function getTeamUpdates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const page     = Math.max(1, parseInt((req.query.page  as string) ?? "1",  10));
    const limit    = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "30", 10)));
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo   = req.query.dateTo   as string | undefined;
    const memberId = req.query.memberId as string | undefined;
    const search   = req.query.search   as string | undefined;
    const action   = req.query.action   as string | undefined;
    const result = await teamService.getTeamUpdates(req.params.id, {
      page, limit, dateFrom, dateTo, memberId, search, action,
    });
    sendSuccess(res, "Team updates fetched successfully", result.items, 200, result.pagination);
  } catch (err) {
    next(err);
  }
}

export async function postTeamMessage(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { content } = z.object({ content: z.string().min(1).max(1000) }).parse(req.body);
    const msg = await teamService.postTeamMessage(req.params.id, req.user!.userId, content);

    // Emit real-time event to everyone in the team room
    if (msg) {
      emitTeamUpdate(req.params.id, { ...(msg as object), type: "message" });
    }

    // ── Push + socket notification to all team leaders ─────────────────────────
    const senderId = req.user!.userId;
    const senderName = (msg as unknown as { author?: { name?: string } })?.author?.name ?? "A team member";
    const teamDoc = await Team.findById(req.params.id).select("leaders name").lean();
    if (teamDoc) {
      const leaderIds = (teamDoc.leaders as unknown as { toString(): string }[])
        .map((l) => l.toString())
        .filter((id) => id !== senderId);

      const notifPayload = {
        title: `💬 Team Update — ${teamDoc.name}`,
        body: `${senderName}: ${content.length > 80 ? content.slice(0, 80) + "…" : content}`,
        tag: `team-message-${req.params.id}`,
        url: `/teams/${req.params.id}`,
        data: { type: "team_message", teamId: req.params.id },
      };

      for (const lid of leaderIds) {
        emitToUser(lid, "notification", { ...notifPayload, createdAt: new Date().toISOString() });
      }
      sendPushToUsers(leaderIds, notifPayload).catch(() => null);
    }

    sendSuccess(res, "Message posted", msg, 201);
  } catch (err) {
    next(err);
  }
}

// ─── Toggle team-member active status (for auto-assignment) ───────────────────
export async function toggleMemberActive(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: teamId, memberId } = req.params;
    const mongoose = await import("mongoose");

    const team = await Team.findById(teamId);
    if (!team) return sendError(res, "Team not found", 404);

    // Verify the user is actually a member (or leader) of this team
    const allIds = [
      ...(team.members as unknown as { toString(): string }[]).map((m) => m.toString()),
      ...(team.leaders as unknown as { toString(): string }[]).map((l) => l.toString()),
    ];
    if (!allIds.includes(memberId)) {
      return sendError(res, "User is not a member of this team", 400);
    }

    const inactiveArr = (team.inactiveMembers as unknown as { toString(): string }[]).map((m) => m.toString());
    const isCurrentlyInactive = inactiveArr.includes(memberId);
    const memberObjId = new mongoose.default.Types.ObjectId(memberId);

    if (isCurrentlyInactive) {
      // Activate — remove from inactiveMembers
      await Team.findByIdAndUpdate(teamId, { $pull: { inactiveMembers: memberObjId } });
    } else {
      // Deactivate — add to inactiveMembers
      await Team.findByIdAndUpdate(teamId, { $addToSet: { inactiveMembers: memberObjId } });
    }

    sendSuccess(res, `Member marked as ${isCurrentlyInactive ? "active" : "inactive"} for auto-assignment`, {
      memberId,
      isActive: isCurrentlyInactive, // after toggle: was inactive → now active
    });
  } catch (err) {
    next(err);
  }
}

// ─── Get Team Member By ID ────────────────────────────────────────────────────
export async function getTeamMemberById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId        = req.params.teamId ?? req.params.id;
    const memberId      = req.params.memberId;
    const requesterId   = req.user!.userId;
    const requesterRole = req.user!.role as { isSystemRole?: boolean; roleName?: string };

    const data = await teamService.getTeamMemberById(teamId, memberId, requesterId, requesterRole);
    sendSuccess(res, "Member fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

// ─── Get Team Member Leads (paginated, filterable) ────────────────────────────
export async function getTeamMemberLeads(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId        = req.params.teamId;
    const memberId      = req.params.memberId;
    const requesterId   = req.user!.userId;
    const requesterRole = req.user!.role as { isSystemRole?: boolean; roleName?: string };

    const filters = {
      status:    req.query.status    as string | undefined,
      search:    req.query.search    as string | undefined,
      page:      req.query.page      as string | undefined,
      limit:     req.query.limit     as string | undefined,
      dateFrom:  req.query.dateFrom  as string | undefined,
      dateTo:    req.query.dateTo    as string | undefined,
      splitFrom: req.query.splitFrom as string | undefined,
      splitTo:   req.query.splitTo   as string | undefined,
    };

    const result = await teamService.getTeamMemberLeads(
      teamId, memberId, requesterId, requesterRole, filters,
    );
    sendSuccess(res, "Member leads fetched successfully", result.leads, 200, result.pagination);
  } catch (err) {
    next(err);
  }
}

// ─── Team Revenue (scoped to one team) ───────────────────────────────────────

/** GET /api/teams/:id/revenue?dateFrom=&dateTo= */
export async function getTeamRevenue(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId  = req.params.id;
    const q       = req.query as Record<string, string>;
    const dateFrom = q.dateFrom?.trim() || undefined;
    const dateTo   = q.dateTo?.trim()   || undefined;
    const data = await reportService.getTeamRevenue(teamId, dateFrom, dateTo);
    sendSuccess(res, "Team revenue fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

/** GET /api/teams/:id/revenue/timeline?period=daily|weekly|monthly|yearly&dateFrom=&dateTo= */
export async function getTeamRevenueTimeline(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId = req.params.id;
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const dateFrom = q.dateFrom?.trim() || undefined;
    const dateTo   = q.dateTo?.trim()   || undefined;
    const data = await reportService.getTeamRevenueTimeline(teamId, period, dateFrom, dateTo);
    sendSuccess(res, "Team revenue timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

/** GET /api/teams/:id/reminders?memberId=&isDone=&search=&page=&limit= */
export async function getTeamReminders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const teamId = req.params.id;
    const q = req.query as Record<string, string>;
    const data = await teamService.getTeamReminders(
      teamId,
      req.user!.userId,
      req.user!.role as { isSystemRole?: boolean; roleName?: string },
      {
        memberId: q.memberId?.trim() || undefined,
        isDone:   q.isDone?.trim()   || undefined,
        search:   q.search?.trim()   || undefined,
        page:     q.page,
        limit:    q.limit,
      },
    );
    sendSuccess(res, "Team reminders fetched successfully", data);
  } catch (err) {
    next(err);
  }
}

// ─── Upcoming Batch ───────────────────────────────────────────────────────────

export async function getUpcomingBatch(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const data = await teamService.getUpcomingBatch(req.params.id);
    sendSuccess(res, "Upcoming batch fetched", data);
  } catch (err) {
    next(err);
  }
}

// ─── Team Settings ────────────────────────────────────────────────────────────

const teamSettingsSchema = z.object({
  autoAssign:            z.boolean(),
  splitMode:             z.enum(["round_robin", "equal_load"]),
  includedMembers:       z.array(z.string()).optional(),
  splitTime:             z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be a valid time HH:mm (00:00–23:59)").nullable().optional(),
  splitStrategy:         z.enum(["scheduled", "live"]).optional(),
  roundRobinStartDate:   z.string().nullable().optional(),
  slaMinutes:            z.number().int().min(1).max(10080).nullable().optional(), // max 1 week
  sourceExclusions:      z.record(z.string(), z.array(z.string().min(1).max(100)).max(50)).optional(), // userId → excluded sources
});

export async function getTeamSettings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const team = await Team.findById(req.params.id).select("settings").lean();
    if (!team) return sendError(res, "Team not found", 404);
    // Distinct sources in this team's leads — used by the source-exclusion picker
    const { Lead } = await import("../models/Lead.js");
    const availableSources = (await Lead.distinct("source", { team: req.params.id }))
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .sort((a, b) => a.localeCompare(b));
    sendSuccess(res, "Team settings fetched", { ...(team.settings ?? {}), availableSources });
  } catch (err) {
    next(err);
  }
}

export async function updateTeamSettings(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = teamSettingsSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);

    const team = await Team.findById(req.params.id);
    if (!team) return sendError(res, "Team not found", 404);

    const { autoAssign, splitMode, includedMembers, splitTime, splitStrategy, roundRobinStartDate, slaMinutes, sourceExclusions } = parsed.data;
    const prevStrategy = (team.settings as any)?.splitStrategy ?? "scheduled";
    const newStrategy = splitStrategy ?? "scheduled";

    // Drop empty exclusion lists so the map stays clean
    const cleanedExclusions: Record<string, string[]> = {};
    for (const [uid, sources] of Object.entries((sourceExclusions ?? {}) as Record<string, string[]>)) {
      const list = sources.map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) cleanedExclusions[uid] = Array.from(new Set(list));
    }

    await Team.findByIdAndUpdate(req.params.id, {
      $set: {
        "settings.autoAssign":            autoAssign,
        "settings.splitMode":             splitMode,
        "settings.includedMembers":       includedMembers ?? [],
        "settings.splitTime":             splitTime ?? null,
        "settings.splitStrategy":         newStrategy,
        "settings.roundRobinStartDate":   roundRobinStartDate ? new Date(roundRobinStartDate) : null,
        "settings.roundRobinIndex":       0,
        "settings.slaMinutes":            slaMinutes ?? null,
        "settings.sourceExclusions":      cleanedExclusions,
      },
    });

    // Switching Scheduled → Live: drain any leads already queued for the daily
    // batch right now, using the live source+count-fair assignment.
    let drained = 0;
    if (autoAssign && newStrategy === "live" && prevStrategy !== "live") {
      const { Lead } = await import("../models/Lead.js");
      const { autoSplitLeadPublic } = await import("../services/leadService.js");
      const queued = await Lead.find({ team: req.params.id, assignedTo: null })
        .select("_id")
        .sort({ createdAt: 1 })
        .lean();
      await collectAssignments(async () => {
        for (const lead of queued) {
          await autoSplitLeadPublic(req.params.id, lead._id.toString(), req.user?.userId ?? "system");
          drained += 1;
        }
      });
    }

    sendSuccess(res, "Team settings updated", {
      autoAssign,
      splitMode,
      includedMembers: includedMembers ?? [],
      splitTime: splitTime ?? null,
      splitStrategy: newStrategy,
      roundRobinStartDate: roundRobinStartDate ?? null,
      slaMinutes: slaMinutes ?? null,
      sourceExclusions: cleanedExclusions,
      drainedQueuedLeads: drained,
    });
  } catch (err) {
    next(err);
  }
}

// ── Mark / unmark a member as absent today ────────────────────────────────────
export async function toggleMemberAbsentToday(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: teamId, memberId } = req.params;
    const { absent } = req.body as { absent: boolean };

    const mongoose = await import("mongoose");
    const team = await Team.findById(teamId);
    if (!team) return sendError(res, "Team not found", 404);

    const allIds = [
      ...(team.members as unknown as { toString(): string }[]).map((m) => m.toString()),
      ...(team.leaders as unknown as { toString(): string }[]).map((l) => l.toString()),
    ];
    if (!allIds.includes(memberId)) return sendError(res, "User is not a member of this team", 400);

    // AED midnight for today in UTC (GST, UTC+4)
    const aedOffset = 4 * 60 * 60 * 1000;
    const nowAED = new Date(Date.now() + aedOffset);
    const todayMidnightAED = new Date(
      Date.UTC(nowAED.getUTCFullYear(), nowAED.getUTCMonth(), nowAED.getUTCDate()),
    );
    const todayMidnightUTC = new Date(todayMidnightAED.getTime() - aedOffset);
    const tomorrowMidnightUTC = new Date(todayMidnightUTC.getTime() + 86400000);

    const memberObjId = new mongoose.default.Types.ObjectId(memberId);

    if (absent) {
      // Remove existing entry for today (if any) then add fresh
      await Team.findByIdAndUpdate(teamId, {
        $pull: {
          absentToday: {
            userId: memberObjId,
            date: { $gte: todayMidnightUTC, $lt: tomorrowMidnightUTC },
          },
        },
      });
      await Team.findByIdAndUpdate(teamId, {
        $push: { absentToday: { userId: memberObjId, date: todayMidnightUTC } },
      });
    } else {
      // Remove today's entry
      await Team.findByIdAndUpdate(teamId, {
        $pull: {
          absentToday: {
            userId: memberObjId,
            date: { $gte: todayMidnightUTC, $lt: tomorrowMidnightUTC },
          },
        },
      });
    }

    sendSuccess(res, `Member marked as ${absent ? "absent" : "present"} today`, {
      memberId,
      absent,
    });
  } catch (err) {
    next(err);
  }
}

// ── Redistribute today's leads from absent members to present members ─────────
export async function redistributeToday(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { id: teamId } = req.params;
    const performedById = req.user!.userId;

    const mongoose = await import("mongoose");
    const { autoSplitLeadPublic } = await import("../services/leadService.js");

    const team = await Team.findById(teamId).lean();
    if (!team) return sendError(res, "Team not found", 404);
    if (!team.settings?.autoAssign) return sendError(res, "Auto-assign is not enabled for this team", 400);

    // Today's AED window in UTC (GST, UTC+4)
    const aedOffset = 4 * 60 * 60 * 1000;
    const nowAED = new Date(Date.now() + aedOffset);
    const todayMidnightAED = new Date(
      Date.UTC(nowAED.getUTCFullYear(), nowAED.getUTCMonth(), nowAED.getUTCDate()),
    );
    const todayMidnightUTC = new Date(todayMidnightAED.getTime() - aedOffset);
    const tomorrowMidnightUTC = new Date(todayMidnightUTC.getTime() + 86400000);

    // Find absent member IDs for today
    const absentMemberIds = (team.absentToday as unknown as { userId: { toString(): string }; date: Date }[])
      .filter((a) => {
        const d = new Date(a.date);
        return d >= todayMidnightUTC && d < tomorrowMidnightUTC;
      })
      .map((a) => a.userId.toString());

    if (absentMemberIds.length === 0) {
      return sendSuccess(res, "No members are absent today", { redistributed: 0 });
    }

    // Only leads ASSIGNED TODAY (GST) to absent members are redistributed —
    // their ongoing pipeline (older follow-ups etc.) stays with them for
    // when they return. Every status still being worked moves; closed and
    // lost leads stay. The older statuses at the end are kept for leads
    // that still carry them.
    const absentObjIds = absentMemberIds.map((id) => new mongoose.default.Types.ObjectId(id));
    const leadsToRedistribute = await Lead.find({
      team: team._id,
      assignedTo: { $in: absentObjIds },
      assignedAt: { $gte: todayMidnightUTC, $lt: tomorrowMidnightUTC },
      status: { $in: [
        "new", "assigned", "pending_response", "followup", "not_connected", "mia", "repeated", "callback", "cnc",
        "interested", "rnr", "whatsapp", "student", "booking", "partialbooking",
      ] },
    }).select("_id").lean();

    if (leadsToRedistribute.length === 0) {
      return sendSuccess(res, "No active leads to redistribute", { redistributed: 0 });
    }

    // Build present-member pool (all team members minus absent + inactive + non-participating)
    const allMemberIds = [
      ...(team.leaders as unknown as { toString(): string }[]).map((l) => l.toString()),
      ...(team.members as unknown as { toString(): string }[]).map((m) => m.toString()),
    ].filter((id, i, arr) => arr.indexOf(id) === i);

    const inactiveIds = (team.inactiveMembers as unknown as { toString(): string }[]).map((m) => m.toString());

    // Respect includedMembers (Participating Members) — same logic as autoSplitLead
    const rawIncluded = (team.settings as any)?.includedMembers as unknown[] | undefined;
    const includedSet: Set<string> | null =
      rawIncluded && rawIncluded.length > 0
        ? new Set(rawIncluded.map((id) => (id as any)?._id?.toString() ?? (id as any)!.toString()))
        : null;

    const presentPool = allMemberIds.filter((id) => {
      if (absentMemberIds.includes(id)) return false;
      if (inactiveIds.includes(id)) return false;
      if (includedSet && !includedSet.has(id)) return false;
      return true;
    });

    if (presentPool.length === 0) {
      return sendError(res, "No present members available to redistribute leads", 400);
    }

    // Re-assign each lead using autoSplitLeadPublic with present pool override.
    // bypassSplitTime=true so manual redistribute always works regardless of splitTime.
    await collectAssignments(async () => {
      for (const lead of leadsToRedistribute) {
        await autoSplitLeadPublic(teamId, lead._id.toString(), performedById, presentPool, true);
      }
    });

    sendSuccess(res, `Redistributed ${leadsToRedistribute.length} leads to present members`, {
      redistributed: leadsToRedistribute.length,
      absentMembers: absentMemberIds.length,
      presentMembers: presentPool.length,
    });
  } catch (err) {
    next(err);
  }
}
