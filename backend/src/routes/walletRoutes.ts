import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { myWallet } from "../controllers/walletController.js";

/* My Wallet, from the HRMS (2026-11-04) — open to everyone signed in, and only ever their own. */
const router = Router();

router.use(authenticate);
router.get("/", myWallet);

export default router;
