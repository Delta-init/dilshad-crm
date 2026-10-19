import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { listTeamReminders, teamReminderOptions } from "../services/teamReminderService.js";

/* Other people's reminders — see teamReminderService.ts. */

const viewerOf = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });

/** GET /leads/reminders/team/options — which button the viewer gets, and its filters' people and teams */
export const getTeamReminderOptions = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Options fetched", await teamReminderOptions(viewerOf(req)));
  } catch (error) {
    next(error);
  }
};

const query = z.object({
  person: z.string().trim().optional(),
  team: z.string().trim().optional(),
  state: z.enum(["active", "done", "all"]).optional(),
});

/** GET /leads/reminders/team — the reminders of the people the viewer may see (view only) */
export const getTeamReminders = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = query.safeParse(req.query);
    if (!q.success) {
      sendError(res, "Validation failed", 400, q.error.flatten().fieldErrors);
      return;
    }
    const out = await listTeamReminders(viewerOf(req), {
      personId: q.data.person || undefined,
      teamId: q.data.team || undefined,
      state: q.data.state,
    });
    if (!out) {
      sendError(res, "You can only see your own reminders", 403);
      return;
    }
    sendSuccess(res, "Reminders fetched", out);
  } catch (error) {
    next(error);
  }
};
