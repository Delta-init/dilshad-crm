import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { authenticate } from "../middleware/auth.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { idOf, isSuperAdmin, loadConfig } from "../services/commissionService.js";
import { listTransfers, previewTransfer, transferLeads, transferSummary, undoTransfer, type TargetInput } from "../services/leadTransferService.js";

/*
 * Transferring a person's leads (2026-11-10) — to one person or split between several; also before a person is
 * deactivated or deleted. Super Admins, the Sales Manager, and anyone whose role may edit users.
 */
const router = Router();
router.use(authenticate);

async function mayTransfer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const role = req.user?.role;
  if (isSuperAdmin(role) || role?.permissions?.users?.edit) return next();
  try {
    if (idOf((await loadConfig()).salesManager) === req.user?.userId) return next();
  } catch {
    /* no settings yet: not the Sales Manager */
  }
  sendError(res, "Transferring leads is for Super Admins, the Sales Manager and those who may edit users", 403);
}
router.use(mayTransfer);

type Handler = (req: AuthenticatedRequest) => Promise<unknown>;
const handle = (message: string, fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, message, await fn(req));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status) {
      sendError(res, (error as Error).message, status);
      return;
    }
    next(error);
  }
};
const targetsOf = (req: AuthenticatedRequest): TargetInput[] => {
  const raw = (req.body ?? {}).targets;
  return Array.isArray(raw) ? raw.map((t: Record<string, unknown>) => ({ userId: String(t?.userId ?? ""), count: t?.count === undefined || t?.count === null || t?.count === "" ? null : Number(t.count) })) : [];
};

router.get("/", handle("Recent transfers", (req) => listTransfers(Number(req.query.limit) || 30)));
router.get("/users/:userId", handle("Their leads", (req) => transferSummary(req.params.userId!)));
router.post("/users/:userId/preview", handle("Preview", (req) => previewTransfer(req.params.userId!, targetsOf(req))));
router.post("/users/:userId", handle("Leads transferred", (req) =>
  transferLeads(req.params.userId!, targetsOf(req), req.user!.userId, (req.body ?? {}).reason === "remove" ? "remove" : "transfer")));
router.post("/:id/undo", handle("Transfer undone", (req) => undoTransfer(req.params.id!, req.user!.userId)));

export default router;
