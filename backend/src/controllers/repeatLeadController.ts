import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { listRepeatLeads, waitingRepeatCount, giveRepeatLead } from "../services/repeatLeadService.js";

/* Repeat leads — the same number in again, held by its team leader to verify (services/repeatLeadService.ts). */

const viewerOf = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });

/** GET /leads/repeats?state=waiting|done|all — a team leader's teams', or everyone's for a Super Admin / the Sales Manager */
export const getRepeatLeads = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const state = z.enum(["waiting", "done", "all"]).catch("waiting").parse(req.query.state);
    const out = await listRepeatLeads(viewerOf(req), state);
    if (!out) {
      sendError(res, "Repeat leads are for team leaders", 403);
      return;
    }
    sendSuccess(res, "Repeat leads fetched", out);
  } catch (error) {
    next(error);
  }
};

/** GET /leads/repeats/count — how many wait for the viewer; null when repeats aren't theirs to see (no menu item) */
export const getRepeatLeadCount = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Repeat leads counted", { count: await waitingRepeatCount(viewerOf(req)) });
  } catch (error) {
    next(error);
  }
};

/** POST /leads/:id/repeat/give { userId } — verified: to the same person or another in the team */
export const giveRepeat = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = z.object({ userId: z.string().trim().min(1) }).safeParse(req.body);
    if (!body.success) {
      sendError(res, "Pick who gets it", 400);
      return;
    }
    sendSuccess(res, "Repeat lead given out", await giveRepeatLead(viewerOf(req), String(req.params.id), body.data.userId));
  } catch (error) {
    next(error);
  }
};
