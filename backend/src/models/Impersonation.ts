import mongoose, { Schema } from "mongoose";
import type { IImpersonation } from "../types/index.js";

/**
 * A super admin viewing the CRM as someone else ("View as"): who, as whom, from
 * where, and when it ended. The pass it issues names this record, so ending the
 * record ends the pass at once. Kept a year, like the sign-in history.
 */
const impersonationSchema = new Schema<IImpersonation>(
  {
    admin:       { type: Schema.Types.ObjectId, ref: "User", required: true },
    adminEmail:  { type: String, default: "", lowercase: true, trim: true, maxlength: 200 },
    target:      { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetEmail: { type: String, default: "", lowercase: true, trim: true, maxlength: 200 },
    startedAt:   { type: Date, required: true },
    expiresAt:   { type: Date, required: true },
    endedAt:     { type: Date, default: null },
    ip:          { type: String, default: "" },
    userAgent:   { type: String, default: "", maxlength: 500 },
    device:      { type: String, default: "" },
    /** What the Super Admin did while acting as them (2026-10-30) — the latest 500. */
    actions: {
      type: [{ _id: false, method: String, path: String, status: Number, at: Date }],
      default: [],
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

impersonationSchema.index({ admin: 1, startedAt: -1 });
impersonationSchema.index({ target: 1, startedAt: -1 });
impersonationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const Impersonation = mongoose.model<IImpersonation>("Impersonation", impersonationSchema);
