import mongoose, { Schema } from "mongoose";
import { ACADEMIES, CLOSE_CURRENCIES, ENROLMENT_LANGUAGES, ENROLMENT_PAYMENT_METHODS } from "../types/index.js";
import type { IStudent } from "../types/index.js";

const studentSchema = new Schema<IStudent>(
  {
    enrollmentNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    course: { type: Schema.Types.ObjectId, ref: "Course", default: null },
    team:   { type: Schema.Types.ObjectId, ref: "Team",   default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, unique: true },

    // Lead insight fields (copied from lead at enrollment time)
    initialLeadResponse:  {
      type: String,
      enum: ["very_interested", "not_interested", "let_me_think", null],
      default: null,
    },
    primaryConcern: {
      type: String,
      enum: ["risk", "price", "time", "trust", "exact_concern", null],
      default: null,
    },
    followupStrategyType: {
      type: String,
      enum: ["risk_based", "price_based", "time_based", "trust_based", null],
      default: null,
    },
    demoScheduled:    { type: Boolean, default: false },
    demoAttended:     { type: Boolean, default: false },
    firstContactTime: { type: Date,    default: null },
    lastFollowupDate: { type: Date,    default: null },

    // Enrollment & fee
    enrollmentDate: { type: Date, default: Date.now },
    feeStatus: {
      type: String,
      enum: ["paid", "partial", "pending"],
      default: "pending",
    },
    totalFee:     { type: Number, default: 0, min: 0 },
    paidAmount:   { type: Number, default: 0, min: 0 },
    pendingAmount:{ type: Number, default: 0, min: 0 },
    /**
     * The lead's balance payments already in paidAmount, by finance's id (the user, 2026-10-31: an approved balance
     * payment stayed on the lead, and the enrolment still showed it owing). leadPaymentDecisions adds each once.
     */
    balanceApplied: { type: [String], default: undefined },

    /**
     * Which academy it was closed for (2026-10-10): Dubai, or Bangalore —
     * billed in Bangalore's finance organization, its fee and payments in INR.
     * Fixed at the close: a correction cannot change it, and every call to
     * finance about this enrolment goes to that academy's organization. Unset
     * on enrolments from before, which are Dubai (academyOf).
     */
    academy: { type: String, enum: ACADEMIES },

    status: {
      type: String,
      enum: ["active", "inactive", "graduated", "dropped"],
      default: "active",
    },
    /**
     * Taken at the close, and required there.
     *
     * Optional in the schema because enrolments predating these fields exist
     * and must still load. The requirement lives where the close happens, so
     * old records are readable and new ones cannot be made without them.
     */
    language: { type: String, enum: ENROLMENT_LANGUAGES },
    paymentMethod: { type: String, enum: ENROLMENT_PAYMENT_METHODS },
    paymentReceipt: {
      name: { type: String },
      url: { type: String },
      // The object key, which is what finance is given: both applications
      // address the same bucket, so a receipt is one file, not two copies.
      key: { type: String },
      size: { type: Number },
      mimeType: { type: String },
      uploadedAt: { type: Date },
    },
    /**
     * Each payment taken at the close — a client may pay part in cash and part
     * by card, each with its own receipt (the user, 2026-10-05). They add up to
     * paidAmount; the first is also paymentMethod / paymentReceipt above.
     * Absent on enrolments from before.
     */
    payments: {
      type: [
        new Schema(
          {
            method: { type: String, enum: ENROLMENT_PAYMENT_METHODS, required: true },
            amount: { type: Number, required: true, min: 0.01 },
            receipt: {
              name: { type: String },
              url: { type: String },
              key: { type: String },
              size: { type: Number },
              mimeType: { type: String },
              uploadedAt: { type: Date },
            },
            paidAt: { type: Date, required: true },
            collectedBefore: { type: Boolean },
            // Paid in another currency (the owner, 2026-10-05): which, how much
            // of it, and 1 of it = exchangeRate of the academy's currency (AED
            // for Dubai, INR for Bangalore). `amount` is the figure in that.
            currency: { type: String, enum: CLOSE_CURRENCIES },
            amountInCurrency: { type: Number, min: 0.01 },
            exchangeRate: { type: Number, min: 0 },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    notes: { type: String, trim: true, maxlength: 2000 },
    /**
     * Whether the client was given a bonus with this enrolment, and how much.
     *
     * Asked at the close, and required there — yes or no, with the amount when
     * yes. Information beside the money, never in it: the bonus is not part of
     * the fee, of what was paid, or of the balance (fee − paid). Unset on
     * enrolments from before it was asked, which is different from "no".
     */
    hasBonus: { type: Boolean },
    /** In US dollars, like the course bonus (2026-10-09); sent to finance as USD. */
    bonusAmount: { type: Number, min: 0, default: 0 },

    /*
     * Where this enrolment ended up in Delta Finance.
     *
     * Written by the handover worker once the invoice exists. Kept so somebody
     * looking at a student can see which invoice it became without opening the
     * other system — and so a student with no invoice is visibly a student with
     * no invoice, rather than one nobody thought to check.
     */
    financeInvoiceId: { type: String },
    financeInvoiceNumber: { type: String },
    financeSyncedAt: { type: Date },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

studentSchema.index({ leadId: 1 }, { unique: true });
studentSchema.index({ enrollmentNumber: 1 }, { unique: true });
studentSchema.index({ course: 1 });
studentSchema.index({ team: 1 });
studentSchema.index({ assignedTo: 1 });
studentSchema.index({ status: 1 });
studentSchema.index({ feeStatus: 1 });
studentSchema.index({ createdAt: -1 });

export const Student = mongoose.model<IStudent>("Student", studentSchema);
