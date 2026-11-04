import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { chooseGift, giftPhoto, myRewards } from "../services/rewardsService.js";

/*
 * Gift rewards (2026-11-04): the pop-up's figures and shelf, a gift chosen, and the gifts' photos. See
 * services/rewardsService.ts.
 */

// GET /rewards/me — this month's target, how far along, the shelf, and the gift chosen if there is one
export async function rewardsMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, "Gift rewards", await myRewards(req.user!.userId));
  } catch (err) {
    next(err);
  }
}

// POST /rewards/claim { giftId }
export async function rewardsClaim(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const giftId = String((req.body as { giftId?: unknown } | undefined)?.giftId ?? "");
    sendSuccess(res, "Gift chosen", await chooseGift(req.user!.userId, giftId, Boolean(req.user?.impersonatedBy)), 201);
  } catch (err) {
    next(err);
  }
}

// GET /rewards/photos/:id?v= — open: an <img> sends no sign-in, and a gift's photo is nobody's business to hide
export async function rewardsPhoto(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const photo = await giftPhoto(String(req.params.id), String(req.query.v ?? ""));
    if (!photo) { sendError(res, "No such photo", 404); return; }
    res.setHeader("Content-Type", photo.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    // The CRM's pages are on another site from this API: helmet's same-origin default would refuse the image.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.end(photo.body);
  } catch (err) {
    next(err);
  }
}
