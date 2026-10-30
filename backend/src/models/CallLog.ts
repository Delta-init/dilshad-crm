import mongoose, { Schema } from "mongoose";

export interface ICallLog {
  leadId:         mongoose.Types.ObjectId | null;
  contactName:    string | null;
  phoneNumber:    string;
  callType:       "Inbound" | "Outbound" | "Missed" | "Notanswered";
  callDirection:  "inbound" | "outbound";
  callDuration:   number;            // seconds
  callDate:       Date;
  recordingUrl:   string | null;
  agentExtension: string | null;
  agentName:      string | null;
  initiatedBy:    mongoose.Types.ObjectId | null;
  source:         "3cx_journal" | "click_to_call" | "manual";
  /** A call logged by hand (from a WhatsApp chat, 2026-10-30): what was said, if anything. */
  note?:          string | null;
  threecxCallId:  string | null;
  qcRating:       number | null;     // 1-5
  qcNotes:        string | null;
  qcStatus:       "pending" | "reviewed" | "flagged";
  qcReviewedBy:   mongoose.Types.ObjectId | null;
  qcReviewedAt:   Date | null;
  createdAt:      Date;
  updatedAt:      Date;
}

const callLogSchema = new Schema<ICallLog>(
  {
    leadId:         { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    contactName:    { type: String, default: null },
    phoneNumber:    { type: String, required: true, trim: true },
    callType:       { type: String, enum: ["Inbound", "Outbound", "Missed", "Notanswered"], required: true },
    callDirection:  { type: String, enum: ["inbound", "outbound"], required: true },
    callDuration:   { type: Number, default: 0 },
    callDate:       { type: Date, required: true },
    recordingUrl:   { type: String, default: null },
    agentExtension: { type: String, default: null },
    agentName:      { type: String, default: null },
    initiatedBy:    { type: Schema.Types.ObjectId, ref: "User", default: null },
    source:         { type: String, enum: ["3cx_journal", "click_to_call", "manual"], default: "3cx_journal" },
    note:           { type: String, default: null, trim: true, maxlength: 500 },
    threecxCallId:  { type: String, default: null },
    qcRating:       { type: Number, min: 1, max: 5, default: null },
    qcNotes:        { type: String, default: null },
    qcStatus:       { type: String, enum: ["pending", "reviewed", "flagged"], default: "pending" },
    qcReviewedBy:   { type: Schema.Types.ObjectId, ref: "User", default: null },
    qcReviewedAt:   { type: Date, default: null },
  },
  { timestamps: true },
);

callLogSchema.index({ leadId: 1, callDate: -1 });
callLogSchema.index({ phoneNumber: 1 });
callLogSchema.index({ agentExtension: 1, callDate: -1 });
callLogSchema.index({ callDate: -1 });

export const CallLog = mongoose.model<ICallLog>("CallLog", callLogSchema);
