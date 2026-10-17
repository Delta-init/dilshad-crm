import mongoose, { Schema } from "mongoose";
import { ACADEMIES } from "../types/index.js";

/**
 * An enrolment waiting to reach Delta Finance.
 *
 * The outbox exists so that closing a lead never depends on another server
 * being up. A salesperson who cannot record a sale because finance is
 * restarting is a worse outcome than an invoice that appears a minute late, so
 * the student is created first and this row is what remembers to deliver it.
 *
 * One row per student, and the student's id is what finance is given as the
 * idempotency key — a retry after a timeout finds the invoice that already
 * exists rather than billing the client twice.
 */
const financeHandoverSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "Student", required: true, unique: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead" },

    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true,
    },

    /** The payload as it was when the sale happened, not as the data looks now. */
    payload: { type: Schema.Types.Mixed, required: true },

    /*
     * Which academy it was closed for, and the finance organization that means
     * (2026-10-10) — written when it is queued, and never changed after. Every
     * later call about it (the delivery and its retries, a resend, a
     * correction, the decision poll, its status) goes to this organization,
     * so changing the default one later never moves an enrolment already
     * billed. A row from before has neither, and is Dubai's (FINANCE_ORG_ID).
     */
    academy: { type: String, enum: ACADEMIES },
    financeOrgId: { type: String },

    attempts: { type: Number, default: 0 },
    /** Not before this time. Backed off after each failure. */
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lastError: { type: String },

    // What finance answered, kept so the CRM can link to the invoice.
    invoiceId: { type: String },
    invoiceNumber: { type: String },
    /** Anything finance wants somebody to look at — an unmapped course, say. */
    flags: { type: [String], default: [] },
    sentAt: { type: Date },

    /*
     * What finance decided, once somebody there has looked.
     *
     * Delivered is not decided. `status: "sent"` only means the enrolment
     * arrived; an approver still has to accept it, and may send it back for a
     * correction. The enrolments screen has always read that live from finance,
     * which is right for a screen and useless for anything that has to happen
     * once — you cannot tell a counsellor their sale was sent back if the only
     * place that fact exists is a panel nobody has opened.
     *
     * So the outcome is kept here as well. `returnedNotifiedAt` is what makes
     * the telling happen once: it is stamped when the counsellor has been told
     * about this particular send-back, and cleared when the enrolment goes to
     * finance again, so a second send-back is a second message.
     */
    approvalState: {
      type: String,
      enum: ["pending", "approved", "returned", "not_required", "unknown"],
      default: "unknown",
      index: true,
    },
    returnedReason: { type: String, default: "" },
    returnedAt: { type: Date },
    returnedNotifiedAt: { type: Date },
    /*
     * When it was last sent again after a send-back — corrected, or resent as
     * it stood — and how many times (the user, 2026-10-05: "if send again show
     * that also"), so the screens say it went rather than leaving the
     * counsellor to wonder whether it did.
     */
    resentAt: { type: Date },
    resends: { type: Number, default: 0 },
    /** The sales note changed after this was sent and finance has not taken
        it yet — the worker retries (financeSalesNote.ts). */
    salesNotePending: { type: Boolean, default: false, index: true },
    salesNoteSyncedAt: { type: Date },
    /** When finance was last asked. Keeps the poll off rows just looked at. */
    checkedAt: { type: Date },

    /*
     * When this CRM saw finance approve it, and when its commission was
     * recorded.
     *
     * `approvedAt` is stamped on the move to approved (or not_required) and is
     * what commission counts from: enrolments approved before commission
     * existed have none, so they are never paid on retroactively.
     * `commissionAt` marks the sale recorded, so the sweep looks at each
     * approval once.
     */
    approvedAt: { type: Date },
    commissionAt: { type: Date },
  },
  { timestamps: true },
);

export const FinanceHandover = mongoose.model("FinanceHandover", financeHandoverSchema);
