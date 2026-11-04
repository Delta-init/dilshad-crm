import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { rewardsClaim, rewardsMe, rewardsPhoto } from "../controllers/rewardsController.js";

// Gift rewards (2026-11-04): everybody signed in sees their own; the photos are open, for an <img>.
const router = Router();

router.get("/photos/:id", rewardsPhoto);
router.use(authenticate);
router.get("/me", rewardsMe);
router.post("/claim", rewardsClaim);

export default router;
