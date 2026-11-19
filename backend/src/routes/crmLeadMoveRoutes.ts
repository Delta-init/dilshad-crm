import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { authenticate } from "../middleware/auth.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { listMovedOut, mayMove, movedLead, moveLeads, moveTargets, undoMove } from "../services/crmLeadMoveService.js";

/*
 * Moving leads to another sales CRM (2026-11-19) — Super Admins, the Sales Manager, team leaders for their teams.
 * A person viewing the CRM as someone else can't (view only).
 */
const router = Router();
router.use(authenticate);

type Handler = (req: AuthenticatedRequest) => Promise<unknown>;
const handle = (message: string, fn: Handler, act = false) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (act && req.user?.impersonatedBy) return sendError(res, "Viewing as someone else is view only", 403);
    sendSuccess(res, message, await fn(req));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status) return sendError(res, (error as Error).message, status);
    next(error);
  }
};
const viewer = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });

router.get("/may", handle("May move", async (req) => ({ may: await mayMove(viewer(req)) })));
router.get("/targets", handle("Where leads can go", async (req) => {
  if (!(await mayMove(viewer(req)))) throw Object.assign(new Error("Not yours to move"), { statusCode: 403 });
  return moveTargets();
}));
router.get("/", handle("Moved out", (req) => listMovedOut(viewer(req), Number(req.query.limit) || 100)));
router.get("/:id", handle("Moved lead", async (req) => {
  if (!(await mayMove(viewer(req)))) throw Object.assign(new Error("Not yours to see"), { statusCode: 403 });
  return movedLead(req.params.id!);
}));
router.post("/", handle("Leads moved", (req) => {
  const b = req.body ?? {};
  return moveLeads(viewer(req), {
    leadIds: Array.isArray(b.leadIds) ? b.leadIds.map(String) : [],
    fromUserId: b.fromUserId ? String(b.fromUserId) : null,
    to: String(b.to ?? ""), mode: b.mode, teamId: b.teamId ? String(b.teamId) : null, userId: b.userId ? String(b.userId) : null,
  });
}, true));
router.post("/:id/undo", handle("Move undone", (req) => undoMove(viewer(req), req.params.id!), true));

export default router;
