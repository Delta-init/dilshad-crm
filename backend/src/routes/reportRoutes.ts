import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  getOverview,
  getTimeline,
  getUserRankings,
  getTeamRankings,
  getTeamSplit,
  getRevenueOverview,
  getRevenueTimeline,
  getRevenueTeams,
  getOldBooks,
  getSourceAnalytics,
  getSourceCampaigns,
  getResponseTimeReport,
  getLeadTimingReport,
  getFollowUpReport,
  getPipelineBreakdown,
  getLeadQualityReport,
  getSalesFunnelReport,
  getManagementAlerts,
  getAuditReport,
  getMemberSplitReport,
} from "../controllers/reportController.js";
import { exportExcel, exportPdf } from "../controllers/exportController.js";

const router = Router();

// All report routes require authentication + "reports" → "view" permission
router.use(authenticate);
router.use(checkPermission("reports", "view"));

router.get("/overview",       getOverview);
router.get("/timeline",       getTimeline);
router.get("/users",          getUserRankings);
router.get("/teams",          getTeamRankings);
router.get("/team-split",     getTeamSplit);

// Source analytics — static before parameterized
router.get("/sources",                    getSourceAnalytics);
router.get("/sources/:source/campaigns",  getSourceCampaigns);

// Revenue routes
router.get("/revenue/overview",  getRevenueOverview);
router.get("/revenue/timeline",  getRevenueTimeline);
router.get("/revenue/teams",     getRevenueTeams);
// Finance's old books counted here (2026-11-25) — the "Old books collected" card
router.get("/old-books",         getOldBooks);

// Response time SLA
router.get("/response-time",  getResponseTimeReport);
router.get("/lead-timing",    getLeadTimingReport);

// Follow-up tracking
router.get("/followups",  getFollowUpReport);

// Pipeline breakdown
router.get("/pipeline",       getPipelineBreakdown);

// Lead quality analysis
router.get("/lead-quality",   getLeadQualityReport);

// Sales funnel
router.get("/funnel",         getSalesFunnelReport);

// Management alerts (no date filter — always live)
router.get("/alerts",         getManagementAlerts);

// Audit trail
router.get("/audit",          getAuditReport);

// Member-wise split (assignment counts, source cross-tab, daily timeline)
router.get("/member-split",   getMemberSplitReport);

// Export routes  (?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  — both optional)
router.get("/export/excel",   exportExcel);
router.get("/export/pdf",     exportPdf);

export default router;
