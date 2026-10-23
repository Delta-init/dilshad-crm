import { Router } from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth.js";
import { checkAnyPermission, checkPermission } from "../middleware/permissions.js";
import {
  createStudent, getStudents, getStudentById,
  getStudentByLeadId, updateStudent, deleteStudent,
  getMyEnrolments,
  getEnrolment, requestInvoice, getCorrection, correctEnrolment, getDailyClosings, uploadPaymentReceipt,
  getCloseOptions, addEnrolmentEmail, checkClientEmail,
} from "../controllers/studentController.js";

const router = Router();

/**
 * A receipt is a photograph or a PDF of one, so the list is short and the
 * limit is what a phone camera produces rather than what a scanner can.
 */
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error("A receipt must be a JPG, PNG, WebP, HEIC or PDF"));
  },
});

// Static before parameterized
router.get("/by-lead/:leadId", authenticate, checkPermission("students", "view"), getStudentByLeadId);
// What the close dialog may offer here (the academies) — for whoever is signed in; it says nothing about anybody.
router.get("/close-options", authenticate, getCloseOptions);
// Whether an email is already another client's (one email, one client) — asked by the close
// dialog, the correction and the add-email box; before "/:id". Gated as the receipt upload is.
router.get(
  "/email-check",
  authenticate,
  checkAnyPermission(["students", "create"], ["enrolments", "edit"]),
  checkClientEmail,
);

// The enrolments screen: a counsellor's own sales, with the state of each
// invoice beside them, so the question does not have to be taken to finance.
// Its own module, not "students" — seeing your own sales is not the same
// grant as seeing the whole student list.
router.get("/enrolments/mine", authenticate, checkPermission("enrolments", "view"), getMyEnrolments);
// One enrolment, for its own page — before "/:id", which would take "enrolments" for a student id.
router.get("/enrolments/:id", authenticate, checkPermission("enrolments", "view"), getEnrolment);
// Before "/:id", or Express reads "closings" as a student id.
router.get("/closings/daily", authenticate, checkPermission("closings", "view"), getDailyClosings);
// Before "/:id", or Express reads "receipts" as a student id. Taken at a close,
// and at the correction of one finance sent back.
router.post(
  "/receipts/:leadId",
  authenticate,
  // …and with every payment added on a lead (2026-10-23), so whoever may edit the lead.
  checkAnyPermission(["students", "create"], ["enrolments", "edit"], ["leads", "edit"]),
  receiptUpload.single("file"),
  uploadPaymentReceipt,
);

// Generate the invoice — the same handover that runs when a lead closes,
// asked for by hand when it never ran or did not get through. Reached only
// from the enrolments screen, so it is gated the same way that screen is.
router.post("/:id/invoice", authenticate, checkPermission("enrolments", "edit"), requestInvoice);
// Correct an enrolment finance sent back, and send it again — from the same screen.
router.get("/:id/correction", authenticate, checkPermission("enrolments", "edit"), getCorrection);
router.put("/:id/correction", authenticate, checkPermission("enrolments", "edit"), correctEnrolment);
// A close finance refused for want of the client's email: add it, and it goes again — gated as the correction is.
router.post("/:id/enrolment/email", authenticate, checkPermission("enrolments", "edit"), addEnrolmentEmail);

router.get("/",    authenticate, checkPermission("students", "view"),   getStudents);
router.post("/",   authenticate, checkPermission("students", "create"), createStudent);
router.get("/:id", authenticate, checkPermission("students", "view"),   getStudentById);
router.put("/:id", authenticate, checkPermission("students", "edit"),   updateStudent);
router.delete("/:id", authenticate, checkPermission("students", "delete"), deleteStudent);

export default router;
