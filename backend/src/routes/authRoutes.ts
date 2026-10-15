import { Router } from "express";
import { login, refreshToken, getProfile, changePassword, ssoLogin, logout, getPreferences, updatePreferences } from "../controllers/authController.js";
import { stopImpersonation } from "../controllers/impersonationController.js";
import { authenticate, authenticateViewAsExit } from "../middleware/auth.js";

const router = Router();

// Public routes
router.post("/login", login);
router.post("/refresh-token", refreshToken);
router.post("/sso-login", ssoLogin); // Root ERP SSO

// Protected routes
router.get("/profile", authenticate, getProfile);
router.put("/change-password", authenticate, changePassword);
// The signed-in person's own preferences — the currency they see amounts in, on every device (2026-10-15).
router.get("/preferences", authenticate, getPreferences);
router.put("/preferences", authenticate, updatePreferences);
router.post("/logout", authenticate, logout);
// "Back to my account" from View as — the one write a view-as pass may make.
router.post("/impersonation/stop", authenticateViewAsExit, stopImpersonation);

export default router;
