import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { bookMeetingRoom, cancelMeetingRoomBooking, meetingRoomsDay } from "../controllers/meetingRoomController.js";

/*
 * The office's meeting rooms, kept in the HRMS (2026-10-19). Open to anybody
 * signed in — no permission module, by decision: booking a room is everyday
 * work. Cancelling somebody else's booking is the HRMS's call (a super admin
 * may cancel any made from this CRM). A "View as" pass only reads.
 */
const router = Router();

router.use(authenticate);

router.get("/day", meetingRoomsDay);
router.post("/bookings", bookMeetingRoom);
router.delete("/bookings/:id", cancelMeetingRoomBooking);

export default router;
