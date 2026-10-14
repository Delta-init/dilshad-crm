import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  listFilterTeamsHandler,
  listInactiveLeadsHandler,
  listLeadMovesHandler,
  listMovePeopleHandler,
  reassignInactiveLeadsHandler,
} from "../controllers/inactiveLeadController.js";

/** The Inactive leads page. */
const router = Router();

// The Super Admin, and any role given the Inactive Leads box: view to look,
// edit to move leads to someone else. The page's own team filter and the
// Move dialog's people come from here, so neither needs the Teams or Users box.
router.use(authenticate);

router.get("/", checkPermission("inactive-leads", "view"), listInactiveLeadsHandler);
router.get("/moves", checkPermission("inactive-leads", "view"), listLeadMovesHandler);
router.get("/teams", checkPermission("inactive-leads", "view"), listFilterTeamsHandler);
router.get("/people", checkPermission("inactive-leads", "edit"), listMovePeopleHandler);
router.post("/reassign", checkPermission("inactive-leads", "edit"), reassignInactiveLeadsHandler);

export default router;
