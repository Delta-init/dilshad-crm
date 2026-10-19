import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { sendSuccess, sendError } from "../utils/response.js";
import {
  listRolesForPortal,
  describeUserForPortal,
  describeManyForPortal,
  setUserRoleFromPortal,
  provisionFromPortal,
} from "../services/portalService.js";
import { enrolmentFlowForPortal } from "../services/portalEnrolmentFlow.js";
import { listInactiveLeads } from "../services/inactiveLeadService.js";
import { leadWorkflow, leadWorkflowLeads } from "../services/leadWorkflowService.js";
import { leadWorkflowLeadsQuery, leadWorkflowQuery } from "../validations/inactiveLeadValidation.js";
import { CallFilterError, callsForPortal, recordingLinkForPortal } from "../services/portalCalls.js";

const router = Router();

/**
 * Server-to-server, from the Root portal only.
 *
 * Not reachable by a browser and carrying no session: the caller proves
 * itself with a shared secret, compared in constant time so the comparison
 * says nothing about how close a wrong guess was.
 *
 * Unconfigured means off, not open. A deployment that has not been told
 * about the portal must not expose its roles and its people by default.
 */
function portalOnly(req: Request, res: Response, next: NextFunction): void {
  if (!env.ROOT_ERP_SECRET) {
    sendError(res, "The Root portal integration is not configured — set ROOT_ERP_SECRET", 503);
    return;
  }
  const presented = req.headers["x-portal-secret"];
  if (typeof presented !== "string") {
    sendError(res, "Bad secret", 401);
    return;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(env.ROOT_ERP_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    sendError(res, "Bad secret", 401);
    return;
  }
  next();
}

router.use(portalOnly);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** The roles this CRM has, and what each one permits. */
router.get(
  "/roles",
  wrap(async (_req, res) => {
    const data = await listRolesForPortal();
    sendSuccess(res, "Roles", data);
  }),
);

/** What one account actually holds here — the portal's check against drift. */
router.get(
  "/user",
  wrap(async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email) { sendError(res, "email is required", 400); return; }
    sendSuccess(res, "Account", await describeUserForPortal(email));
  }),
);

/** Change an existing account's role or status. Creates nothing. */
router.post(
  "/set-user-role",
  wrap(async (req, res) => {
    const { email, role, status } = (req.body ?? {}) as Record<string, string>;
    if (!email) { sendError(res, "email is required", 400); return; }
    sendSuccess(res, "Changed", await setUserRoleFromPortal({ email, role, status }));
  }),
);

/** Create an account here, because a root admin asked. */
router.post(
  "/provision-user",
  wrap(async (req, res) => {
    const { email, name, role } = (req.body ?? {}) as Record<string, string>;
    if (!email || !role) { sendError(res, "email and role are required", 400); return; }
    sendSuccess(res, "Account created", await provisionFromPortal({ email, name: name ?? "", role }));
  }),
);

/**
 * The same question as /user, asked about many people at once.
 *
 * POST rather than GET because a page of addresses does not belong in a query
 * string, where it would be logged by every proxy in front of this.
 */
router.post(
  "/accounts",
  wrap(async (req, res) => {
    const { emails } = (req.body ?? {}) as { emails?: unknown };
    sendSuccess(res, "Accounts", await describeManyForPortal(emails));
  }),
);

/**
 * The enrolment workflow, for Root's Pending page (2026-10-14): every close
 * handed to finance — its steps as My Enrolments shows them, where it stands
 * and whom that waits on. Read only.
 */
router.get(
  "/enrolment-flow",
  wrap(async (_req, res) => {
    sendSuccess(res, "Enrolment flow", await enrolmentFlowForPortal());
  }),
);

/**
 * 3CX calls, for Root's "3CX calls" page and its Pending page (2026-10-14):
 * every call, with the totals and per-person table this CRM's Calls page shows,
 * and each person's email. Read only.
 */
router.get(
  "/calls",
  wrap(async (req, res) => {
    try {
      sendSuccess(res, "Calls", await callsForPortal(req.query as Record<string, unknown>));
    } catch (err) {
      if (err instanceof CallFilterError) { sendError(res, err.message, 400); return; }
      throw err;
    }
  }),
);

/** A recording's link on this server — signed, 10 minutes — for Root to hand to the browser. */
router.get(
  "/calls/:id/recording-link",
  wrap(async (req, res) => {
    const link = await recordingLinkForPortal(String(req.params.id), req.query.index);
    if (link === "bad") { sendError(res, "Invalid call or recording", 400); return; }
    if (!link) { sendError(res, "No recording for this call", 404); return; }
    sendSuccess(res, "Recording link", link);
  }),
);

/**
 * Inactive leads, for Root's Pending → Sales tab (2026-10-17): the leads whose
 * owner has not acted on them within the Settings limit — exactly this CRM's
 * Inactive leads page, longest waiting first (its first 2000; `summary.capped`
 * says when there were more). Read only: nothing is moved.
 */
router.get(
  "/inactive-leads",
  wrap(async (_req, res) => {
    const list = await listInactiveLeads({ page: 1, limit: 2000 });
    sendSuccess(res, "Inactive leads", { items: list.items, summary: list.summary, rule: list.rule });
  }),
);

/**
 * The lead workflow, for Root's Reports → Sales tab (2026-10-17): the leads that came in over some Dubai days
 * (?from&to, YYYY-MM-DD; today by default) and where each went — exactly this CRM's Workflow tab. ?teamId, ?personId
 * narrow it. Read only.
 */
router.get(
  "/lead-workflow",
  wrap(async (req, res) => {
    const parsed = leadWorkflowQuery.safeParse(req.query);
    if (!parsed.success) return sendError(res, "Use from/to as YYYY-MM-DD and ids for teamId/personId", 400);
    try {
      sendSuccess(res, "Lead workflow", await leadWorkflow(parsed.data));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (!status) throw err;
      sendError(res, (err as Error).message, status);
    }
  }),
);

/** The leads behind one box of the workflow map (?box, and ?status for a status), for Root's same map. Read only. */
router.get(
  "/lead-workflow/leads",
  wrap(async (req, res) => {
    const parsed = leadWorkflowLeadsQuery.safeParse(req.query);
    if (!parsed.success) return sendError(res, "Say which box (and status), with from/to as YYYY-MM-DD and ids for teamId/personId", 400);
    try {
      sendSuccess(res, "Workflow leads", await leadWorkflowLeads(parsed.data));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (!status) throw err;
      sendError(res, (err as Error).message, status);
    }
  }),
);

export default router;
