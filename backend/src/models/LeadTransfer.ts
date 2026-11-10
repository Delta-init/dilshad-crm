import mongoose, { Schema, type Types } from "mongoose";

/*
 * One transfer of a person's open leads (the user, 2026-11-10: "transfer full leads from one user to another, or split
 * them"): who gave them up, who got how many and in which team, who did it — and, lead by lead, what each was before,
 * so it can be undone for 24 hours (only leads nobody has touched since).
 */
export interface ILeadTransferItem {
  lead: Types.ObjectId;
  to: Types.ObjectId;
  prevTeam: Types.ObjectId | null;
  newTeam: Types.ObjectId | null;
  prevStatus: string;
  prevCreatedAt: Date | null;
  prevOriginalCreatedAt: Date | null;
  /** The follow-up date it had (a hand-over clears it), put back by Undo. */
  prevNextFollowUpAt: Date | null;
  /** Their open reminders that moved with the lead (by id). */
  reminders: Types.ObjectId[];
}

export interface ILeadTransfer {
  _id: Types.ObjectId;
  from: Types.ObjectId;
  fromName: string;
  by: Types.ObjectId;
  byName: string;
  /** Why: by hand from the Users page, or on the way to deactivating / deleting the person. */
  reason: "transfer" | "remove";
  targets: { user: Types.ObjectId; name: string; count: number; team: Types.ObjectId | null; teamName: string }[];
  items: ILeadTransferItem[];
  moved: number;
  undoneAt: Date | null;
  undoneBy: string;
  undone: number;
  createdAt: Date;
}

const itemSchema = new Schema<ILeadTransferItem>(
  {
    lead: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    to: { type: Schema.Types.ObjectId, ref: "User", required: true },
    prevTeam: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    newTeam: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    prevStatus: { type: String, default: "" },
    prevCreatedAt: { type: Date, default: null },
    prevOriginalCreatedAt: { type: Date, default: null },
    prevNextFollowUpAt: { type: Date, default: null },
    reminders: [{ type: Schema.Types.ObjectId }],
  },
  { _id: false },
);

const leadTransferSchema = new Schema<ILeadTransfer>(
  {
    from: { type: Schema.Types.ObjectId, ref: "User", required: true },
    fromName: { type: String, default: "" },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byName: { type: String, default: "" },
    reason: { type: String, enum: ["transfer", "remove"], default: "transfer" },
    targets: [
      {
        _id: false,
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        name: { type: String, default: "" },
        count: { type: Number, default: 0 },
        team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
        teamName: { type: String, default: "" },
      },
    ],
    items: { type: [itemSchema], default: [] },
    moved: { type: Number, default: 0 },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: String, default: "" },
    undone: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

leadTransferSchema.index({ createdAt: -1 });
leadTransferSchema.index({ from: 1, createdAt: -1 });

export const LeadTransfer = mongoose.model<ILeadTransfer>("LeadTransfer", leadTransferSchema);
