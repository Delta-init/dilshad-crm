import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { LeaderboardService, isLeaderboardMonth, isRankBy } from "../services/leaderboardService.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { hiddenFromViewer, withoutHidden } from "../services/leaderboardViewer.js";
import type { AuthenticatedRequest } from "../types/index.js";

const router = Router();
const service = new LeaderboardService();

// GET /api/v1/leaderboard?month=YYYY-MM&rankBy=revenue|calls|talk — the whole board, for a role with the
// Leaderboard box (every role until someone unticks it); no month means this month on the Dubai calendar, no rankBy
// means revenue.
router.get("/", authenticate, checkPermission("leaderboard", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const month = req.query.month;
    if (month !== undefined && !isLeaderboardMonth(month)) {
      sendError(res, "month must look like 2026-10", 400);
      return;
    }
    const rankBy = req.query.rankBy;
    if (rankBy !== undefined && !isRankBy(rankBy)) {
      sendError(res, "rankBy must be revenue, calls or talk", 400);
      return;
    }
    const board = await service.getLeaderboard(month as string | undefined, rankBy ?? "revenue");
    // A salesperson's board leaves out the team leaders and the Sales Manager (2026-10-28).
    const user = (req as AuthenticatedRequest).user;
    const hidden = await hiddenFromViewer({ userId: user?.userId ?? "", role: user?.role });
    sendSuccess(res, "Leaderboard", withoutHidden(board, hidden));
  } catch (error) {
    next(error);
  }
});

export default router;
