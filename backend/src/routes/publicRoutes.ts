import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { dubaiMonthRange, isLeaderboardMonth, isRankBy } from "../services/leaderboardService.js";
import { LeaderboardBusyError, getPublicLeaderboard } from "../services/leaderboardLive.js";
import { sendSuccess, sendError } from "../utils/response.js";

/**
 * Public routes — no sign-in (the owner, 2026-10-15: "an open link, like the
 * Bangalore CRM's"). The leaderboard only: anyone with the address sees every
 * salesperson's month — revenue, closings, follow-ups, 3CX calls and talk
 * time, today's calls — and their leads by status. No emails, nothing else.
 *
 * This month's comes from the live watcher's count while a screen watches it
 * (leaderboardLive.ts); others are kept 15 s, counted once however many ask at
 * once, two at a time at most (503 when too many wait).
 */
const router = Router();

/** "2026-12" → "2027-01". */
function monthAfter(m: string): string {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

// GET /api/v1/public/leaderboard?month=YYYY-MM&rankBy=revenue|calls|talk — no month means this month on the Dubai calendar.
router.get("/leaderboard", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const month = req.query.month;
    if (month !== undefined && !isLeaderboardMonth(month)) {
      sendError(res, "month must look like 2026-10", 400);
      return;
    }
    // Next month too: a TV whose clock runs a little ahead asks for it just before midnight on the 1st (it's empty).
    if (typeof month === "string" && month > monthAfter(dubaiMonthRange().month)) {
      sendError(res, "That month hasn't started yet", 400);
      return;
    }
    const rankBy = req.query.rankBy;
    if (rankBy !== undefined && !isRankBy(rankBy)) {
      sendError(res, "rankBy must be revenue, calls or talk", 400);
      return;
    }

    sendSuccess(res, "Leaderboard", await getPublicLeaderboard(month as string | undefined, rankBy ?? "revenue"));
  } catch (error) {
    if (error instanceof LeaderboardBusyError) {
      sendError(res, error.message, 503);
      return;
    }
    next(error);
  }
});

export default router;
