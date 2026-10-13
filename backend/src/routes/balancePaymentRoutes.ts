import { Router, type NextFunction, type Response } from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { BalancePaymentService } from "../services/balancePaymentService.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";

/*
 * Balance payments (the user, 2026-10-13): the part-paid courses this CRM
 * closed — a salesperson's own, a team leader's teams', everyone's for the
 * Sales Manager and a Super Admin — and the next payment recorded against one,
 * with its receipt, for finance to approve. Its own module ("balancePayments"),
 * open to every role until unticked: view sees the page, create records one.
 */
const router = Router();
const svc = new BalancePaymentService();
const viewer = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role ?? null });

/** As the close's receipts: a photograph or a PDF of one. */
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("A receipt must be a JPG, PNG, WebP, HEIC or PDF"));
  },
});

router.get("/", authenticate, checkPermission("balancePayments", "view"), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    sendSuccess(res, "Balance payments fetched", await svc.list(viewer(req), { state: q.state, search: q.search, mine: q.mine }));
  } catch (err) { next(err); }
});

// The sidebar's number: overdue or due within 3 days.
router.get("/count", authenticate, checkPermission("balancePayments", "view"), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, "Balance payments due", { due: await svc.dueCount(viewer(req)) });
  } catch (err) { next(err); }
});

// The receipt first, on its own (as at the close); the payment then names it.
router.post(
  "/:studentId/receipt",
  authenticate,
  checkPermission("balancePayments", "create"),
  receiptUpload.single("file"),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) return sendError(res, "No file was uploaded", 400);
      const studentId = String(req.params.studentId);
      if (!(await svc.inScope(viewer(req), studentId))) return sendError(res, "Enrolment not found", 404);
      const { storageConfigured, uploadFile } = await import("../lib/storage.js");
      if (!storageConfigured()) return sendError(res, "File storage is not configured, so a receipt cannot be taken", 503);
      // Never the uploader's filename as the key: it could reach outside this prefix.
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const uploaded = await uploadFile({
        key: `balance-receipts/${studentId}/${Date.now()}-${safe}`,
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
      });
      sendSuccess(res, "Receipt uploaded", {
        name: file.originalname.slice(0, 200), url: uploaded.url, key: uploaded.key, size: uploaded.size, mimeType: uploaded.mimeType,
      });
    } catch (err) { next(err); }
  },
);

router.post("/:studentId", authenticate, checkPermission("balancePayments", "create"), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sent = await svc.record(viewer(req), String(req.params.studentId), (req.body ?? {}) as Record<string, unknown>);
    sendSuccess(res, "Sent to finance for approval", sent, 201);
  } catch (err) { next(err); }
});

export default router;
