import { Router, type Response, type NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { logBreak, onBreak } from "../services/breakClock.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { BREAK_KINDS, type AuthenticatedRequest, type BreakKind } from "../types/index.js";

/*
 * A break, as the Sales CRM has it (brought here 2026-10-20): "Take break" —
 * until "End break", or the GST day ends, the inactive-lead clock stops for its
 * owner and none of their leads moves on. Everyone's own, whatever their role:
 * signed in is enough, and nobody sets anyone else's. A break that ends is
 * written down (BreakLog), so the clock leaves it out afterwards too.
 */
const router = Router();
router.use(authenticate);

const view = (since: Date | null | undefined, kind?: BreakKind | null) => {
  const on = onBreak(since);
  return { onBreak: on, since: on ? new Date(since as Date).toISOString() : null, kind: on ? kind ?? null : null };
};

/** GET /break — mine: { onBreak, since, kind } */
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const me = await User.findById(req.user?.userId).select("breakSince breakKind").lean();
    if (!me) return sendError(res, "Not found", 404);
    sendSuccess(res, "Break fetched", view(me.breakSince, me.breakKind));
  } catch (err) { next(err); }
});

/** POST /break { on: boolean, kind?: "meeting" | "lunch" | "tea" | "washroom" } — start or end mine. */
router.post("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ on: z.boolean(), kind: z.enum(BREAK_KINDS).optional() }).safeParse(req.body);
    if (!parsed.success) return sendError(res, "on must be true or false; kind one of meeting, lunch, tea, washroom", 400);
    const me = await User.findById(req.user?.userId).select("breakSince breakKind");
    if (!me) return sendError(res, "Not found", 404);
    const current = view(me.breakSince, me.breakKind);
    const endedKind = (me.breakKind ?? null) as BreakKind | null;
    const now = new Date();
    // The one before is over: ended now, or with its day when it was left on (a new one the next day replaces it).
    const ended = me.breakSince && (!parsed.data.on || !current.onBreak) ? new Date(me.breakSince) : null;
    // Starting one already started keeps when it began.
    if (parsed.data.on && !current.onBreak) {
      me.breakSince = now;
      me.breakKind = parsed.data.kind ?? null;
    }
    if (!parsed.data.on) {
      me.breakSince = null;
      me.breakKind = null;
    }
    await me.save();
    if (ended) await logBreak(me._id, ended, now, endedKind);
    sendSuccess(res, parsed.data.on ? "On a break — your leads won't go inactive until it ends" : "Break ended", view(me.breakSince, me.breakKind));
  } catch (err) { next(err); }
});

export default router;
