import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { StudentService } from "../services/studentService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const svc = new StudentService();

export const createStudent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Who closed it, for the lead's activity when the close adds the client's email there.
    const student = await svc.createStudent(req.body, req.user?.userId);
    sendSuccess(res, "Student created", student, 201);
  } catch (err) { next(err); }
};

export const getStudents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.getStudents(req.query as Record<string, string>);
    res.json({ success: true, data: result.students, pagination: result.pagination });
  } catch (err) { next(err); }
};

export const getStudentById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.getStudentById(req.params.id);
    sendSuccess(res, "Student fetched", student);
  } catch (err) { next(err); }
};

export const getStudentByLeadId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.getStudentByLeadId(req.params.leadId);
    sendSuccess(res, "Student fetched", student ?? null);
  } catch (err) { next(err); }
};

export const updateStudent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.updateStudent(req.params.id, req.body);
    sendSuccess(res, "Student updated", student);
  } catch (err) { next(err); }
};

export const deleteStudent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.deleteStudent(req.params.id);
    sendSuccess(res, "Student deleted", { deleted: result });
  } catch (err) { next(err); }
};

/**
 * The caller's own enrolments, each carrying what finance made of it.
 *
 * Scoped to the caller unless they ask otherwise: the screen this serves is
 * called "My Enrolments", and a counsellor opening it wants their own sales,
 * not the whole book.
 */
export const getMyEnrolments = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const result = await svc.listEnrolments({
      ...(req.query as Record<string, string>),
      userId,
    });
    res.json({
      success: true,
      data: result.rows,
      counts: result.counts,
      pagination: result.pagination,
    });
  } catch (err) { next(err); }
};

/**
 * One enrolment, for its own page: its five steps with who did each and when,
 * and its commission as the viewer may see it.
 *
 * GET /api/v1/students/enrolments/:id
 */
export const getEnrolment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const enrolment = await svc.getEnrolment(req.params.id, { userId, role: req.user?.role as never });
    sendSuccess(res, "Enrolment fetched", enrolment);
  } catch (err) { next(err); }
};

/**
 * The closing book, a day at a time.
 *
 * GET /api/students/closings/daily?dateFrom=&dateTo=&team=&user=&mine=true
 *
 * `mine=true` narrows it to the caller, which is what a counsellor wants and
 * what a manager does not — so it is asked for rather than assumed, unlike the
 * enrolments list, whose screen is called "My Enrolments" and means it.
 */
export const getDailyClosings = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, string>;
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);

    const data = await svc.listDailyClosings({
      dateFrom: q.dateFrom?.trim() || undefined,
      dateTo: q.dateTo?.trim() || undefined,
      team: q.team?.trim() || undefined,
      user: q.mine === "true" ? userId : q.user?.trim() || undefined,
    }, { userId, role: req.user?.role });
    sendSuccess(res, "Daily closings fetched successfully", data);
  } catch (err) { next(err); }
};

/**
 * Take the payment receipt, before the enrolment that will carry it exists.
 *
 * Uploaded on its own rather than as part of the close, because the close
 * creates a student and hands it to finance in one go, and a multipart body
 * carrying both a file and the enrolment would have to be unpicked before
 * either could be validated. This returns a stored file; the close is then the
 * same JSON it always was, with the receipt named in it.
 *
 * Keyed under the lead, since that is what exists at the time.
 */
export const uploadPaymentReceipt = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const file = req.file;
    if (!file) return sendError(res, "No file was uploaded", 400);

    const { storageConfigured, uploadFile } = await import("../lib/storage.js");
    if (!storageConfigured()) {
      return sendError(res, "File storage is not configured, so a receipt cannot be taken", 503);
    }

    // The uploader's filename never becomes the key. It is theirs to choose,
    // and a key built from it could otherwise reach outside this prefix.
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const leadId = String(req.params.leadId ?? "unfiled");
    const uploaded = await uploadFile({
      key: `enrolment-receipts/${leadId}/${Date.now()}-${safe}`,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });

    sendSuccess(res, "Receipt uploaded", {
      name: file.originalname.slice(0, 200),
      url: uploaded.url,
      key: uploaded.key,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
    });
  } catch (err) { next(err); }
};

/**
 * What the close dialog may offer on this server (2026-10-10): the academies
 * a close can be made for — Bangalore only once its finance organization is
 * set. The dialog shows its Academy choice only when Bangalore is listed.
 *
 * GET /api/v1/students/close-options
 */
export const getCloseOptions = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { academiesOffered } = await import("../services/financeClient.js");
    sendSuccess(res, "Close options", { academies: academiesOffered() });
  } catch (err) { next(err); }
};

/** Send an enrolment to finance, or send it again after a failure. */
export const requestInvoice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.requestInvoice(req.params.id);
    if (!result.queued) return sendError(res, result.message, 409);
    sendSuccess(res, result.message, { queued: true });
  } catch (err) { next(err); }
};

/**
 * What the correction form starts from: the enrolment, whether finance has it
 * sent back and why, the money the lead holds of its own, and — for whoever
 * may move a sale — the counsellors and teams.
 *
 * GET /api/v1/students/:id/correction
 */
export const getCorrection = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const data = await svc.getCorrection(req.params.id, { userId, role: req.user?.role });
    sendSuccess(res, "Correction fetched", data);
  } catch (err) { next(err); }
};

/**
 * Correct an enrolment finance sent back — everything the close took — and
 * send it to finance again, in one step.
 *
 * PUT /api/v1/students/:id/correction
 */
export const correctEnrolment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const result = await svc.correctEnrolment(req.params.id, req.body ?? {}, { userId, role: req.user?.role });
    sendSuccess(res, result.message, result.student);
  } catch (err) { next(err); }
};

/**
 * Add the client's email to a close finance refused for want of one, and send
 * it to finance again at once — the same enrolment, to the same organization.
 * Only for one not yet delivered; the closer their own, anyone who may edit
 * students any.
 *
 * POST /api/v1/students/:id/enrolment/email  { email }
 */
export const addEnrolmentEmail = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const result = await svc.addEnrolmentEmail(req.params.id, req.body?.email, { userId, role: req.user?.role });
    sendSuccess(res, result.message, { queued: true, email: result.email });
  } catch (err) { next(err); }
};

/**
 * Whether an email is already another client's here — one email, one client
 * (2026-10-10) — for the close dialog, the correction and the add-email box
 * to say so before saving: `{ ok }`, or `{ ok: false, takenBy: { name, code?,
 * kind }, message }`. The server refuses a taken email at each of those
 * whatever this said.
 *
 * GET /api/v1/students/email-check?email=&leadId=&studentId=
 */
export const checkClientEmail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, unknown>;
    const result = await svc.checkClientEmail(q.email, { leadId: q.leadId, studentId: q.studentId });
    sendSuccess(res, result.ok ? "Email is free" : "Email is another client's", result);
  } catch (err) { next(err); }
};
