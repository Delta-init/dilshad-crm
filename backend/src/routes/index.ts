import { Router } from "express";
import authRoutes from "./authRoutes.js";
import myTrackerRoutes from "./myTrackerRoutes.js";
import userRoutes from "./userRoutes.js";
import roleRoutes from "./roleRoutes.js";
import leadRoutes from "./leadRoutes.js";
import userLeadRoutes from "./userLeadRoutes.js";
import teamRoutes from "./teamRoutes.js";
import courseRoutes from "./courseRoutes.js";
import sheetsRoutes from "./sheetsRoutes.js";
import reportRoutes from "./reportRoutes.js";
import pushRoutes from "./pushRoutes.js";
import aiRoutes from "./aiRoutes.js";
import studentRoutes from "./studentRoutes.js";
import balancePaymentRoutes from "./balancePaymentRoutes.js";
import callRoutes from "./callRoutes.js";
import sheetSourceRoutes from "./sheetSourceRoutes.js";
import portalRoutes from "./portalRoutes.js";
import mentorRoutes from "./mentorRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import settingsRoutes from "./settingsRoutes.js";
import inactiveLeadRoutes from "./inactiveLeadRoutes.js";
import activityRoutes from "./activityRoutes.js";
import meetingRoutes from "./meetingRoutes.js";
import meetingRoomRoutes from "./meetingRoomRoutes.js";
import commissionRoutes from "./commissionRoutes.js";
import leaderboardRoutes from "./leaderboardRoutes.js";
import publicRoutes from "./publicRoutes.js";

const router = Router();

router.use("/auth", authRoutes);
// Server-to-server, from the Root portal. Guarded by a shared secret, not a
// session — see portalRoutes.
router.use("/service", portalRoutes);
router.use("/my-tracker", myTrackerRoutes);
router.use("/users", userRoutes);
router.use("/users", userLeadRoutes);
router.use("/roles", roleRoutes);
router.use("/leads", leadRoutes);
router.use("/teams", teamRoutes);
router.use("/courses", courseRoutes);
router.use("/sheets",  sheetsRoutes);
router.use("/reports", reportRoutes);
router.use("/push",    pushRoutes);
router.use("/ai",       aiRoutes);
router.use("/students", studentRoutes);
// Part-paid closes and their next payments, for finance to approve (2026-10-13).
router.use("/balance-payments", balancePaymentRoutes);
router.use("/calls",         callRoutes);
router.use("/sheet-sources", sheetSourceRoutes);
// The mentor calendar this CRM reads from the Delta LMS — see mentorRoutes.
router.use("/mentors", mentorRoutes);
// Sales commission: the plan per course, and what each approved sale earns.
router.use("/commission", commissionRoutes);
router.use("/leaderboard", leaderboardRoutes);
router.use("/public", publicRoutes); // no sign-in: the open leaderboard only
router.use("/notifications", notificationRoutes);
router.use("/settings", settingsRoutes);
// The super admin's Inactive leads page — see inactiveLeadRoutes.
router.use("/inactive-leads", inactiveLeadRoutes);
// Heartbeats from everyone; the Activity page for the super admin — see activityRoutes.
router.use("/activity", activityRoutes);
// Meetings between colleagues, clients and mentors, and each person's calendar — see meetingRoutes.
router.use("/meetings", meetingRoutes);
// The office's meeting rooms, booked through the HRMS — see meetingRoomRoutes.
router.use("/meeting-rooms", meetingRoomRoutes);

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
