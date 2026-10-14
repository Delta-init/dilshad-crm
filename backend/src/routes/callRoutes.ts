import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission, requireSuperAdmin } from "../middleware/permissions.js";
import {
  getLeadCalls,
  getRecentCalls,
  getQcQueue,
  updateQc,
  getCallById,
  logClickToCall,
  contactLookup,
  contactSearch,
  contactCreate,
  journalCall,
  webhookJournal,
  get3cxTemplate,
} from "../controllers/callController.js";
import {
  getCallLog,
  getLeadCallLog,
  getRecordingLink,
  streamRecording,
  syncCallsNow,
  testThreecx,
} from "../controllers/leadCallController.js";
import { getClickToCall, startThreecxCall, getMyCallState, hangUpMyCall } from "../controllers/clickToCallController.js";

const router = Router();

// ── Public routes — called by 3CX (no auth token) ────────────────────────────
router.get("/contact-lookup",  contactLookup);
router.get("/contact-search",  contactSearch);
router.post("/contact-create", contactCreate);
router.post("/journal",        journalCall);
router.get("/webhook",         webhookJournal);
router.post("/webhook",        webhookJournal);
router.get("/3cx-template",    get3cxTemplate);

// ── 3CX calls with leads (lead_calls, synced from 3CX's call log) — the Calls page ──
// The recording itself: no sign-in header (an <audio> element sends none); its signed 10-minute link is the permission.
router.get("/log/recording",               streamRecording);
router.get("/log",                         authenticate, checkPermission("calls", "view"), getCallLog);
router.post("/log/sync",                   authenticate, requireSuperAdmin, syncCallsNow);
router.post("/log/test",                   authenticate, requireSuperAdmin, testThreecx);
router.get("/log/lead/:leadId",            authenticate, checkPermission("leads", "view"), getLeadCallLog);
router.get("/log/:id/recording-link",      authenticate, getRecordingLink);

// ── The Call button through 3CX (2026-10-14): rings the caller's own extension, then the lead; the call window
//    follows it and can hang up — always the caller's own extension, never another's.
router.get("/click-to-call",               authenticate, getClickToCall);
router.post("/3cx/call",                   authenticate, checkPermission("leads", "edit"), startThreecxCall);
router.get("/3cx/state",                   authenticate, getMyCallState);
router.post("/3cx/hang-up",                authenticate, hangUpMyCall);

// ── Authenticated routes — static BEFORE parameterised /:callId ──────────────
router.post("/click",           authenticate, logClickToCall);
router.get("/recent",           authenticate, getRecentCalls);
router.get("/qc-queue",         authenticate, getQcQueue);
router.get("/lead/:leadId",     authenticate, getLeadCalls);

// ── Parameterised ────────────────────────────────────────────────────────────
router.get("/:callId",          authenticate, getCallById);
router.put("/:callId/qc",       authenticate, updateQc);

export default router;
