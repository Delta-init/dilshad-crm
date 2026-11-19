import { Router } from "express";
import { authenticateApiKey } from "../middleware/apiKeyAuth.js";
import type { NextFunction, Request, Response } from "express";
import { syncSheetLead, syncSheetLeadsBatch } from "../controllers/sheetsController.js";
import { moveLeads, receiveLeads, takeBack, undoMove } from "../services/crmLeadMoveService.js";
import { sendError, sendSuccess } from "../utils/response.js";

const router = Router();

// All sheet routes require a valid x-api-key header
router.use(authenticateApiKey);

/**
 * POST /api/sheets/sync
 * Single-row sync — called by App Script onEdit / onChange triggers
 * Body: one row object with all 17 sheet columns
 */
router.post("/sync", syncSheetLead);

/**
 * POST /api/sheets/sync/batch
 * Batch sync — called once per execution to push all un-synced rows
 * Body: { rows: [ ...row objects ] }
 */
router.post("/sync/batch", syncSheetLeadsBatch);

/**
 * Leads moved here from another sales CRM, handed over by Root (2026-11-19, services/crmLeadMoveService.ts), and one
 * given back when that CRM undoes the move.
 */
const root = (message: string, fn: (body: never) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, message, await fn((req.body ?? {}) as never));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status) return sendError(res, (error as Error).message, status);
    next(error);
  }
};
router.post("/lead-moves", root("Leads taken in", receiveLeads));
router.post("/lead-moves/take-back", root("Given back", takeBack));
// Root's Lead moves page (a root admin): move leads from here, or undo one moved from here — as if done here, so the
// lead is kept in Moved leads the same way. Named after the root admin.
type RootSend = { leadIds?: unknown[]; to?: string; mode?: "person" | "team" | "split"; teamId?: string; userId?: string; byName?: string; leadId?: string };
const rootViewer = (b: RootSend) => ({ userId: "", system: { name: `${String(b.byName || "Root admin").slice(0, 80)} (Root)` } });
router.post("/lead-moves/send", root("Leads moved", (b: RootSend) => moveLeads(rootViewer(b), {
  leadIds: Array.isArray(b.leadIds) ? b.leadIds.map(String) : [], to: String(b.to ?? ""), mode: b.mode as "person",
  teamId: b.teamId ? String(b.teamId) : null, userId: b.userId ? String(b.userId) : null,
})));
router.post("/lead-moves/undo", root("Move undone", (b: RootSend) => undoMove(rootViewer(b), String(b.leadId ?? ""))));

export default router;
