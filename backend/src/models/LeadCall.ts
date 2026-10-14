import mongoose, { Schema, type Types } from "mongoose";

/**
 * A call with a lead, read from 3CX's call log by the call sync
 * (services/callSyncService.ts) — the only calls the Calls page lists.
 *
 * One document per 3CX call (`key`: its call history id), written again when
 * the sync reads it a second time, so nothing is stored twice. Calls with
 * numbers no lead has are not kept. Recordings stay on 3CX: `recordingIds`
 * are played through the backend on a short-lived signed link.
 *
 * Who took it: `user` is the CRM user whose `extension` is `extension`;
 * null while nobody here has that extension (linked later, when one does).
 *
 * The older `call_logs` (click-to-call / 3CX journal / manual) stay as they
 * are and are not shown here.
 */
export interface ILeadCall {
  key: string;
  callId: string;
  segmentId: string;
  startedAt: Date;
  direction: "in" | "out";
  /** answered = connected; missed = they called, nobody answered; no_answer = we called, they didn't pick up. */
  status: "answered" | "missed" | "no_answer";
  answered: boolean;
  talkSeconds: number;
  ringSeconds: number;
  /** The lead's end of the call, as 3CX has it, and its last 9 digits. */
  number: string;
  numberKey: string;
  /** The 3CX extension that took or made it, and 3CX's name for it. */
  extension: string;
  agentName: string;
  recordingIds: number[];
  recordingUrl: string;
  reason: string;
  rows: number;
  lead: Types.ObjectId;
  leadName: string;
  user: Types.ObjectId | null;
  userName: string;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const leadCallSchema = new Schema<ILeadCall>(
  {
    key: { type: String, required: true, unique: true },
    callId: { type: String, default: "" },
    segmentId: { type: String, default: "" },
    startedAt: { type: Date, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    status: { type: String, enum: ["answered", "missed", "no_answer"], required: true },
    answered: { type: Boolean, default: false },
    talkSeconds: { type: Number, default: 0 },
    ringSeconds: { type: Number, default: 0 },
    number: { type: String, default: "" },
    numberKey: { type: String, default: "" },
    extension: { type: String, default: "" },
    agentName: { type: String, default: "" },
    recordingIds: { type: [Number], default: [] },
    recordingUrl: { type: String, default: "" },
    reason: { type: String, default: "" },
    rows: { type: Number, default: 1 },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    leadName: { type: String, default: "" },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    userName: { type: String, default: "" },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false, collection: "lead_calls" },
);

leadCallSchema.index({ startedAt: -1 });
leadCallSchema.index({ lead: 1, startedAt: -1 });
leadCallSchema.index({ user: 1, startedAt: -1 });
leadCallSchema.index({ extension: 1, user: 1 });

export const LeadCall = mongoose.model<ILeadCall>("LeadCall", leadCallSchema);
