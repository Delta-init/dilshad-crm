import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { ReportService } from "../services/reportService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const svc = new ReportService();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDateParams(query: Record<string, string>) {
  const dateFrom = query.dateFrom?.trim() || undefined;
  const dateTo   = query.dateTo?.trim()   || undefined;
  return { dateFrom, dateTo };
}

// ── Controllers ───────────────────────────────────────────────────────────────

/** GET /api/reports/overview?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD */
export const getOverview = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getOverview(dateFrom, dateTo);
    sendSuccess(res, "Overview fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/timeline
 * ?period=daily|weekly|monthly&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 */
export const getTimeline = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const period = (q.period || "daily") as "daily" | "weekly" | "monthly";

    if (!["daily", "weekly", "monthly"].includes(period)) {
      sendError(res, "period must be daily, weekly, or monthly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getTimeline(period, dateFrom, dateTo);
    sendSuccess(res, "Timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/users?dateFrom=...&dateTo=...&limit=20 */
export const getUserRankings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q     = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q.limit || "20", 10), 50);
    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getUserRankings(dateFrom, dateTo, limit);
    sendSuccess(res, "User rankings fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/team-split
 * ?period=daily|weekly|monthly|yearly&dateFrom=...&dateTo=...
 */
export const getTeamSplit = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getTeamSplit(period, dateFrom, dateTo);
    sendSuccess(res, "Team split fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** Team rankings by period, kept a minute: the dashboard asks for them on every open (2026-10-30). */
const teamRankingsKept = new Map<string, { at: number; value: Promise<unknown> }>();
function keptTeamRankings(dateFrom?: string, dateTo?: string) {
  const key = `${dateFrom ?? ""}|${dateTo ?? ""}`;
  const hit = teamRankingsKept.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  for (const [k, v] of teamRankingsKept) if (Date.now() - v.at >= 60_000) teamRankingsKept.delete(k);
  const value = svc.getTeamRankings(dateFrom, dateTo);
  teamRankingsKept.set(key, { at: Date.now(), value });
  value.catch(() => teamRankingsKept.delete(key)); // a failed count is not kept
  return value;
}

/** GET /api/reports/teams?dateFrom=...&dateTo=... */
export const getTeamRankings = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await keptTeamRankings(dateFrom, dateTo);
    sendSuccess(res, "Team rankings fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

// ── Revenue controllers ───────────────────────────────────────────────────────

/** GET /api/reports/revenue/overview?dateFrom=&dateTo= */
export const getRevenueOverview = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getRevenueOverview(dateFrom, dateTo);
    sendSuccess(res, "Revenue overview fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/reports/revenue/timeline
 * ?period=daily|weekly|monthly|yearly&dateFrom=&dateTo=
 */
export const getRevenueTimeline = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const period = (q.period || "monthly") as "daily" | "weekly" | "monthly" | "yearly";

    if (!["daily","weekly","monthly","yearly"].includes(period)) {
      sendError(res, "period must be daily, weekly, monthly, or yearly", 400);
      return;
    }

    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getRevenueTimeline(period, dateFrom, dateTo);
    sendSuccess(res, "Revenue timeline fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/sources?dateFrom=&dateTo=&team= */
export const getSourceAnalytics = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.team?.trim() || undefined;
    const data = await svc.getSourceAnalytics(dateFrom, dateTo, teamId);
    sendSuccess(res, "Source analytics fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/sources/:source/campaigns?dateFrom=&dateTo= */
export const getSourceCampaigns = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q      = req.query as Record<string, string>;
    const source = req.params.source?.trim();
    if (!source) {
      sendError(res, "source param is required", 400);
      return;
    }
    const { dateFrom, dateTo } = getDateParams(q);
    const data = await svc.getSourceCampaigns(source, dateFrom, dateTo);
    sendSuccess(res, "Campaign breakdown fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/revenue/teams?dateFrom=&dateTo= */
export const getRevenueTeams = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = getDateParams(req.query as Record<string, string>);
    const data = await svc.getRevenueTeams(dateFrom, dateTo);
    sendSuccess(res, "Revenue teams fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/response-time?teamId=&dateFrom=&dateTo=&slaMinutes= */
export const getResponseTimeReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const slaMinutes = q.slaMinutes ? parseInt(q.slaMinutes, 10) : undefined;
    const teamId = q.teamId?.trim() || undefined;

    if (slaMinutes !== undefined && (isNaN(slaMinutes) || slaMinutes < 1)) {
      sendError(res, "slaMinutes must be a positive integer", 400);
      return;
    }

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getResponseTimeReport({ teamId, dateFrom, dateTo, slaMinutes });
    sendSuccess(res, "Response time report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};


/** GET /api/reports/lead-timing?teamId=&dateFrom=&dateTo=&page=&limit= */
export const getLeadTimingReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;
    const page  = q.page  ? Math.max(1, parseInt(q.page, 10)  || 1)  : 1;
    const limit = q.limit ? Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25)) : 25;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getLeadTimingReport({ teamId, dateFrom, dateTo, page, limit });
    sendSuccess(res, "Lead timing report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};


/** GET /api/reports/followups?teamId=&dateFrom=&dateTo= */
export const getFollowUpReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getFollowUpReport({ teamId, dateFrom, dateTo });
    sendSuccess(res, "Follow-up report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/pipeline?teamId=&dateFrom=&dateTo= */
export const getPipelineBreakdown = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getPipelineBreakdown({ teamId, dateFrom, dateTo });
    sendSuccess(res, "Pipeline breakdown fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

export const getLeadQualityReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getLeadQualityReport({ teamId, dateFrom, dateTo });
    sendSuccess(res, "Lead quality report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

export const getSalesFunnelReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getSalesFunnelReport({ teamId, dateFrom, dateTo });
    sendSuccess(res, "Sales funnel report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

export const getManagementAlerts = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const teamId            = q.teamId?.trim() || undefined;
    const uncontactedHours  = q.uncontactedHours ? parseInt(q.uncontactedHours, 10) : 2;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getManagementAlerts({ teamId, uncontactedHours });
    sendSuccess(res, "Management alerts fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

export const getAuditReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;
    const action = q.action?.trim()  || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getAuditReport({ teamId, dateFrom, dateTo, action });
    sendSuccess(res, "Audit report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};

/** GET /api/reports/member-split?teamId=&dateFrom=&dateTo= */
export const getMemberSplitReport = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string>;
    const { dateFrom, dateTo } = getDateParams(q);
    const teamId = q.teamId?.trim() || undefined;

    if (teamId && !/^[a-f0-9]{24}$/i.test(teamId)) {
      sendError(res, "Invalid teamId format", 400);
      return;
    }

    const data = await svc.getMemberSplitReport({ teamId, dateFrom, dateTo });
    sendSuccess(res, "Member split report fetched successfully", data);
  } catch (err) {
    next(err);
  }
};
