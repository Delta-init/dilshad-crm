import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { CommissionService, isSuperAdmin, uaeMonthOf } from "../services/commissionService.js";
import { PAY_FROM_MONTH, SalaryService } from "../services/salaryService.js";
import { saveSlab, slabProblem, SLAB_ROLES } from "../services/salarySlabs.js";
import { sendSuccess, sendError } from "../utils/response.js";

const commissionService = new CommissionService();
const salaryService = new SalaryService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Not an id");
/** AED (or USD for the credit), whole or with fils; never negative. */
const money = z.number().min(0, "Cannot be negative").max(1_000_000);

const coursePlanSchema = z.object({
  sales: money,
  tl: money,
  sm: money,
  creditUsd: money,
});

const settingsSchema = z
  .object({
    salesManager: objectId.or(z.literal("")).nullable().optional(),
    excludedUsers: z.array(objectId).max(200).optional(),
  })
  .refine((v) => v.salesManager !== undefined || v.excludedUsers !== undefined, "Nothing to change");

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");

const previewSchema = z.object({
  course: objectId,
  team: objectId.optional(),
  closer: objectId.optional(),
});

/** One level of a salary slab: AED target and salary, percent of commission. */
const slabRowSchema = z.object({
  name: z.string().trim().min(1, "Name the level").max(20),
  target: z.number().min(0, "Cannot be negative").max(100_000_000),
  salary: money,
  percent: z.number().min(0, "0 to 100").max(100, "0 to 100"),
});
const slabSchema = z.object({ rows: z.array(slabRowSchema).min(1, "A slab needs its base row").max(12) });

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// ─── Middleware ───────────────────────────────────────────────────────────────

/** Only a Super Admin sets what people are paid. */
export const requireSuperAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!isSuperAdmin(req.user?.role)) {
    sendError(res, "Only a Super Admin can change the commission plan", 403);
    return;
  }
  next();
};

const viewerOf = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });

// ─── Controllers ─────────────────────────────────────────────────────────────

export const getPlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const plan = await commissionService.getPlan(viewerOf(req));
    sendSuccess(res, "Commission plan fetched", plan);
  } catch (err) {
    next(err);
  }
};

export const updateCoursePlan = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = objectId.safeParse(req.params.courseId);
    const parsed = coursePlanSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
      sendError(res, "Validation failed", 400, parsed.success ? { courseId: ["Not an id"] } : parsed.error.flatten().fieldErrors);
      return;
    }
    const course = await commissionService.updateCoursePlan(id.data, parsed.data, req.user!.userId);
    sendSuccess(res, "Commission plan updated", course);
  } catch (err) {
    next(err);
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const plan = await commissionService.updateSettings(
      {
        ...(parsed.data.salesManager !== undefined ? { salesManager: parsed.data.salesManager || null } : {}),
        ...(parsed.data.excludedUsers !== undefined ? { excludedUsers: parsed.data.excludedUsers } : {}),
      },
      viewerOf(req),
    );
    sendSuccess(res, "Commission settings updated", plan);
  } catch (err) {
    next(err);
  }
};

export const getEarnings = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const raw = typeof req.query.month === "string" && req.query.month ? req.query.month : uaeMonthOf(new Date());
    const month = monthSchema.safeParse(raw);
    if (!month.success) {
      sendError(res, "Month must be YYYY-MM", 400);
      return;
    }
    const earnings = await commissionService.getEarnings(viewerOf(req), month.data);
    sendSuccess(res, "Commission fetched", earnings);
  } catch (err) {
    next(err);
  }
};

/** A month's salary and commission on the slabs: the viewer's own, and everyone's for a Super Admin. */
export const getPay = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const now = uaeMonthOf(new Date());
    const raw = typeof req.query.month === "string" && req.query.month ? req.query.month : now;
    const month = monthSchema.safeParse(raw);
    if (!month.success) {
      sendError(res, "Month must be YYYY-MM", 400);
      return;
    }
    if (month.data < PAY_FROM_MONTH) {
      sendError(res, `Salary slabs start from ${monthName(PAY_FROM_MONTH)}`, 400);
      return;
    }
    if (month.data > now) {
      sendError(res, `${monthName(month.data)} hasn't started yet`, 400);
      return;
    }
    const pay = await salaryService.getPay(viewerOf(req), month.data);
    sendSuccess(res, "Pay fetched", pay);
  } catch (err) {
    next(err);
  }
};

/** One role's salary slab, in force from this month (UAE) on — earlier months keep theirs. */
export const updateSlab = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const role = SLAB_ROLES.find((r) => r === req.params.role);
    if (!role) {
      sendError(res, "Role must be sales, tl or sm", 400);
      return;
    }
    const parsed = slabSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const problem = slabProblem(parsed.data.rows);
    if (problem) {
      sendError(res, problem, 400);
      return;
    }
    const slabs = await saveSlab(role, parsed.data.rows, req.user!.userId, uaeMonthOf(new Date()));
    sendSuccess(res, "Salary slab saved", slabs);
  } catch (err) {
    next(err);
  }
};

export const getPreview = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const parsed = previewSchema.safeParse({
      course: q.course,
      team: q.team || undefined,
      closer: q.closer || undefined,
    });
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const preview = await commissionService.preview(parsed.data, viewerOf(req));
    sendSuccess(res, "Commission preview", preview);
  } catch (err) {
    next(err);
  }
};
