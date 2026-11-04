import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { User } from "../models/User.js";
import { HrmsError, hrmsConfigured, hrmsRequest } from "../lib/hrms.js";
import { sendError, sendSuccess } from "../utils/response.js";

/*
 * My Wallet (2026-11-04: "the wallet on every portal"). The HRMS keeps it — salary a day at a time, what came off and
 * why, commission, what finance has paid — and finds the person by the email they sign in here with. Only ever your
 * own: not while viewing the CRM as somebody else, whose pay is not the viewer's to read.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The HRMS may ask finance, and finance the CRMs, before it answers. */
const WALLET_TIMEOUT_MS = 30_000;

// GET /wallet?month=YYYY-MM — this month when none is given
export async function myWallet(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const month = String(req.query.month ?? "");
    if (month && !MONTH.test(month)) { sendError(res, "month must be YYYY-MM", 400); return; }
    if (req.user!.impersonatedBy) { sendError(res, "Your wallet isn't shown while you're viewing the CRM as someone else.", 403); return; }
    if (!hrmsConfigured()) { sendError(res, "This CRM isn't linked to the HRMS yet, so there is no wallet to show.", 503); return; }
    const u = await User.findById(req.user!.userId).select("email").lean<{ email?: string } | null>();
    const email = String(u?.email ?? "").trim().toLowerCase();
    if (!email) { sendError(res, "Your account has no email to find your HRMS record with.", 400); return; }
    const wallet = await hrmsRequest<unknown>("GET", "/wallet", { email, ...(month ? { month } : {}) }, undefined, WALLET_TIMEOUT_MS);
    sendSuccess(res, "Your wallet", wallet);
  } catch (err) {
    if (err instanceof HrmsError) { sendError(res, err.message, err.status); return; }
    next(err);
  }
}
