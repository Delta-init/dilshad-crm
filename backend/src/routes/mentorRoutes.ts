import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission, checkAnyPermission } from "../middleware/permissions.js";
import {
  mentorSchedule, classDetail, scheduleMeeting, meetingDetail, updateMeeting, cancelMeeting, heldMeetings,
} from "../controllers/mentorController.js";

const router = Router();

/*
 * Open to anybody signed in — no permission check, by decision. Booking an
 * hour with a mentor is work the people doing the work do; a calendar only
 * some of them can see is one they have to ask somebody else to read for
 * them. The same reasoning the Root portal, which reads this same LMS, was
 * already built on.
 *
 * Nothing here reaches into the LMS on the viewer's behalf beyond what it
 * already authorises for itself: listing one academy's mentors, and booking,
 * reading, changing or cancelling one meeting. Editing or cancelling
 * somebody else's is the LMS's call, not this router's — it checks who
 * booked it, or whether this CRM's own super admin is asking.
 */
router.use(authenticate);

// The close form's "Meeting done by": the person closing's held meetings with a mentor (2026-11-18).
router.get("/held-meetings", heldMeetings);
// The Calendar's meeting dialog reads the mentors' week too.
router.get("/schedule", checkAnyPermission(["mentors", "view"], ["calendar", "view"]), mentorSchedule);
router.post("/meetings", checkPermission("mentors", "create"), scheduleMeeting);

router.get("/classes/:classId", checkPermission("mentors", "view"), classDetail);
router.get("/meetings/:meetingId", checkPermission("mentors", "view"), meetingDetail);
router.patch("/meetings/:meetingId", checkPermission("mentors", "edit"), updateMeeting);
router.post("/meetings/:meetingId/cancel", checkPermission("mentors", "delete"), cancelMeeting);

export default router;
