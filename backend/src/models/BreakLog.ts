import mongoose, { Schema, type Types } from "mongoose";
import { BREAK_KINDS, type BreakKind } from "../types/index.js";

/**
 * Every break that ended — when it started and when it ended (as the Sales
 * CRM, brought here 2026-10-20: the inactive-lead clock stops while a lead's
 * owner is on a break). The break going on now is the user's own `breakSince`;
 * it is written here once it ends ("End break", a new one the next day, or the
 * GST day ending under it).
 */
export interface IBreakLog {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  start: Date;
  end: Date;
  /** Meeting, lunch, tea or washroom; null when not said. */
  kind?: BreakKind | null;
}

const breakLogSchema = new Schema<IBreakLog>(
  {
    user:  { type: Schema.Types.ObjectId, ref: "User", required: true },
    start: { type: Date, required: true },
    end:   { type: Date, required: true },
    kind:  { type: String, enum: [...BREAK_KINDS, null], default: null },
  },
  { versionKey: false }
);

breakLogSchema.index({ user: 1, end: -1 });
// One break is written once, however many "End break" presses arrive together.
breakLogSchema.index({ user: 1, start: 1 }, { unique: true });

export const BreakLog = mongoose.model<IBreakLog>("BreakLog", breakLogSchema);
