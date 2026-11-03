import mongoose, { Schema, type Types } from "mongoose";

/**
 * Which teams a lead source is split to (the owner, 2026-11-03: "we can select which source's leads go to which team").
 * One per source, matched without regard to case or spaces at the ends. A source with none here goes to every team
 * with auto-assign on (leadService.autoAssignLeads). Set by a Super Admin on the Teams page.
 */
export interface ILeadSourceTeam {
  _id: Types.ObjectId;
  /** As leads carry it ("FOREX LEADS SEIRRA"). */
  source: string;
  /** Lower case, trimmed — what a lead's source is matched on. */
  key: string;
  teams: Types.ObjectId[];
  updatedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const leadSourceTeamSchema = new Schema<ILeadSourceTeam>(
  {
    source: { type: String, required: true, trim: true, maxlength: 100 },
    key: { type: String, required: true, unique: true },
    teams: { type: [{ type: Schema.Types.ObjectId, ref: "Team" }], default: [] },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false, collection: "lead_source_teams" },
);

export const sourceKey = (source: unknown) => String(source ?? "").trim().toLowerCase();

export const LeadSourceTeam = mongoose.model<ILeadSourceTeam>("LeadSourceTeam", leadSourceTeamSchema);
