import mongoose, { Schema } from "mongoose";
import type { ICommissionSale } from "../types/index.js";

/**
 * One sale and the commission it earns.
 *
 * Followed from the close ("progress", saying which of its five steps it waits
 * on — enrolmentSteps.ts) and decided once every step is done, from the plan as
 * it stands then — so a plan changed in March leaves February's sales as they
 * were paid.
 * One per student: the unique index is what makes recording it twice
 * impossible, whichever sweep gets there first.
 *
 * Who earns it is decided once too, and only redone while the sale is waiting
 * or excluded — a counted sale is never recomputed, because "who led the team
 * when it sold" must not change because somebody moved teams later.
 */
const lineSchema = new Schema(
  {
    role: { type: String, enum: ["sales", "tl", "sm"], required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    amount: { type: Number, min: 0, default: 0 },
    note: { type: String },
  },
  { _id: false },
);

const commissionSaleSchema = new Schema<ICommissionSale>(
  {
    student: { type: Schema.Types.ObjectId, ref: "Student", required: true, unique: true },
    studentName: { type: String, default: "" },
    enrollmentNumber: { type: String },
    invoiceNumber: { type: String },
    course: { type: Schema.Types.ObjectId, ref: "Course", default: null },
    courseName: { type: String, default: "" },
    closer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closerName: { type: String, default: "" },
    team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    teamName: { type: String, default: "" },
    saleDate: { type: Date, required: true },
    month: { type: String, required: true },
    /** When finance approved it, where this CRM saw it happen. */
    approvedAt: { type: Date },
    /** When it was counted at finance's approval (since 2026-10-26; before, when its five steps were done) — and who earns what was decided. */
    stepsDoneAt: { type: Date },
    /**
     * The course fee in AED: finance's invoice total, refreshed by the sweep
     * (tax inside it, as the counsellor typed it). No default — a sale the
     * sweep hasn't reached falls back to the student's fee (salaryService).
     */
    fee: { type: Number, min: 0 },
    plan: {
      sales: { type: Number, default: 0 },
      tl: { type: Number, default: 0 },
      sm: { type: Number, default: 0 },
      creditUsd: { type: Number, default: 0 },
    },
    state: {
      type: String,
      enum: ["progress", "counted", "waiting", "excluded", "reversed"],
      required: true,
    },
    reason: { type: String, default: "" },
    lines: { type: [lineSchema], default: [] },
    countedAt: { type: Date },
    reversedAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: "commissionsales" },
);

commissionSaleSchema.index({ month: 1, state: 1 });
commissionSaleSchema.index({ "lines.user": 1, month: 1 });
commissionSaleSchema.index({ team: 1, month: 1 });
commissionSaleSchema.index({ state: 1 });

export const CommissionSale = mongoose.model<ICommissionSale>("CommissionSale", commissionSaleSchema);
