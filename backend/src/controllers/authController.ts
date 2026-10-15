import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { AuthService } from "../services/authService.js";
import { loginSchema, refreshTokenSchema, changePasswordSchema, preferencesSchema } from "../validations/authValidation.js";
import { User } from "../models/User.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { recordLogin, recordLoginFailure, recordLogout } from "../services/activityService.js";
import axios from "axios";

const authService = new AuthService();

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    // Every sign-in, and every refused one, goes in the Activity page's history.
    let result: Awaited<ReturnType<typeof authService.login>>;
    try {
      result = await authService.login(parsed.data);
    } catch (err) {
      await recordLoginFailure(req, parsed.data.email, err, "password");
      throw err;
    }
    await recordLogin(req, result.user, "password");
    sendSuccess(res, "Login successful", result, 200);
  } catch (error) {
    next(error);
  }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = refreshTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const result = await authService.refreshToken(parsed.data.refreshToken);
    sendSuccess(res, "Token refreshed successfully", result, 200);
  } catch (error) {
    next(error);
  }
};

export const getProfile = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await authService.getProfile(req.user!.userId);
    sendSuccess(res, "Profile retrieved successfully", user);
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }

    const result = await authService.changePassword(req.user!.userId, parsed.data);
    sendSuccess(res, result.message);
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/logout — the app calls it on "Logout", so the sign-out is on record.
// Tokens are not revoked (they are stateless); the app drops its own copy.
export const logout = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    await recordLogout(req, req.user!.userId);
    sendSuccess(res, "Signed out");
  } catch (error) {
    next(error);
  }
};

// ── Root ERP SSO Login ─────────────────────────────────────────────────────
/**
 * POST /api/v1/auth/sso-login
 *
 * Exchanges a one-time handoff token issued by the Root portal for a normal
 * CRM session. The token arrives in the request body, never the URL — the
 * portal redirects the browser with it in the query string, and the CRM's
 * /sso page immediately POSTs it here rather than letting it sit in history.
 */
export const ssoLogin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { ssoToken } = req.body as { ssoToken?: string };
    if (!ssoToken) {
      sendError(res, "ssoToken is required", 400);
      return;
    }

    // Fail closed. An unset ROOT_ERP_API_URL previously fell back to
    // localhost, which in production means this server quietly asks itself
    // to vouch for the token.
    const rootApi = process.env.ROOT_ERP_API_URL;
    if (!rootApi) {
      sendError(res, "SSO is not configured on this server", 503);
      return;
    }

    const verifyRes = await axios.get(`${rootApi.replace(/\/+$/, "")}/api/auth/verify-sso-token`, {
      params: { token: ssoToken },
      timeout: 5000,
    });

    const admin = verifyRes.data?.data as { id: string; email: string; name: string; role: string };
    if (!admin?.email) {
      sendError(res, "Invalid SSO token", 401);
      return;
    }

    let result: Awaited<ReturnType<typeof authService.ssoLogin>>;
    try {
      result = await authService.ssoLogin(admin);
    } catch (err) {
      await recordLoginFailure(req, admin.email, err, "sso");
      throw err;
    }
    await recordLogin(req, result.user, "sso");
    sendSuccess(res, "SSO login successful", result, 200);
  } catch (error) {
    // The portal rejects a spent or expired token with a 401. Surface that as
    // a 401 here too, rather than letting it bubble up as a generic 500.
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      sendError(res, "Invalid or expired SSO token", 401);
      return;
    }
    if (axios.isAxiosError(error)) {
      sendError(res, "Could not reach the Root portal to verify this token", 502);
      return;
    }
    next(error);
  }
};

// GET /api/v1/auth/preferences — the signed-in person's own: the currency they see amounts in (null: never picked),
// and when they picked it.
export const getPreferences = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = await User.findById(req.user!.userId)
      .select("currency currencyAt")
      .lean<{ currency?: string | null; currencyAt?: Date | null } | null>();
    if (!user) {
      sendError(res, "User not found", 404);
      return;
    }
    sendSuccess(res, "Preferences", { currency: user.currency ?? null, currencyAt: user.currencyAt ?? null });
  } catch (error) {
    next(error);
  }
};

// PUT /api/v1/auth/preferences — { currency, pickedAgoMs? }: kept on their own account, so it follows them to every
// device. The newest pick wins by when it was picked — this server's time, less how long ago the pick was made for one
// sent late (the app was offline): not kept over a newer one from another device, and the answer says what is
// (`applied: false`). Sent at once, a pick is "now".
export const updatePreferences = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      // All of it — an unknown field is a form error, not a field's.
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const at = new Date(Date.now() - (parsed.data.pickedAgoMs ?? 0));
    const select = "currency currencyAt";
    type Prefs = { currency?: string | null; currencyAt?: Date | null } | null;
    const updated = await User.findOneAndUpdate(
      { _id: req.user!.userId, $or: [{ currencyAt: null }, { currencyAt: { $lte: at } }] },
      { $set: { currency: parsed.data.currency, currencyAt: at } },
      { new: true }
    ).select(select).lean<Prefs>();
    const user = updated ?? (await User.findById(req.user!.userId).select(select).lean<Prefs>());
    if (!user) {
      sendError(res, "User not found", 404);
      return;
    }
    sendSuccess(res, updated ? "Preferences saved" : "A newer choice is already saved", {
      currency: user.currency ?? null,
      currencyAt: user.currencyAt ?? null,
      applied: Boolean(updated),
    });
  } catch (error) {
    next(error);
  }
};
