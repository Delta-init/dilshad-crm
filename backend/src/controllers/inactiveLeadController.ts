import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import {
  listFilterTeams,
  listInactiveLeads,
  listLeadMoves,
  listMovePeople,
  reassignInactiveLeads,
} from "../services/inactiveLeadService.js";
import {
  listInactiveLeadsQuery,
  listLeadMovesQuery,
  movePeopleQuery,
  reassignInactiveLeadsSchema,
} from "../validations/inactiveLeadValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";

// GET /api/v1/inactive-leads
export async function listInactiveLeadsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listInactiveLeadsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const { items, summary, rule, pagination } = await listInactiveLeads(parsed.data);
    sendSuccess(res, "Inactive leads", { items, summary, rule }, 200, pagination);
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/inactive-leads/moves
export async function listLeadMovesHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listLeadMovesQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const { items, pagination } = await listLeadMoves(parsed.data);
    sendSuccess(res, "Lead moves", items, 200, pagination);
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/inactive-leads/teams — the page's team filter
export async function listFilterTeamsHandler(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, "Teams", await listFilterTeams());
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/inactive-leads/people — the Move dialog's people
export async function listMovePeopleHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = movePeopleQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    sendSuccess(res, "People", await listMovePeople(parsed.data));
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/inactive-leads/reassign
export async function reassignInactiveLeadsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = reassignInactiveLeadsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const result = await reassignInactiveLeads(parsed.data, req.user!.userId);
    const message = result.moved.length
      ? `Moved ${result.moved.length} lead${result.moved.length === 1 ? "" : "s"}`
      : "No leads were moved";
    sendSuccess(res, message, result);
  } catch (err) {
    next(err);
  }
}
