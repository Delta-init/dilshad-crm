import mongoose, { Schema, type Types } from "mongoose";

/*
 * Automatic WhatsApp follow-ups (2026-10-27, services/whatsapp/followups.ts) — one document, set by a Super Admin:
 * on or off, the teams whose leads get them, how many one person's WhatsApp sends in a day, and the steps: how long
 * after the last message each waits, what it says, and a file to go with it.
 *
 * `startedAt` is when it was last switched on: only chats whose last message by a person came after it are followed up,
 * so switching it on never chases every quiet chat there ever was.
 */
export interface IFollowupStep {
  waitMinutes: number;
  text: string;
  file: { file: string; name: string; mime: string; size: number } | null;
}

export interface IWhatsAppFollowupSettings {
  _id: Types.ObjectId;
  key: "default";
  enabled: boolean;
  startedAt: Date | null;
  teams: Types.ObjectId[];
  dailyLimit: number;
  steps: IFollowupStep[];
  updatedByName: string;
  updatedAt: Date;
}

const stepSchema = new Schema<IFollowupStep>({
  waitMinutes: { type: Number, required: true },
  text: { type: String, required: true, maxlength: 1000 },
  file: {
    type: new Schema({
      file: { type: String, required: true },
      name: { type: String, default: "" },
      mime: { type: String, default: "" },
      size: { type: Number, default: 0 },
    }, { _id: false }),
    default: null,
  },
}, { _id: false });

const settingsSchema = new Schema<IWhatsAppFollowupSettings>(
  {
    key: { type: String, enum: ["default"], default: "default", unique: true },
    enabled: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    teams: [{ type: Schema.Types.ObjectId, ref: "Team" }],
    dailyLimit: { type: Number, default: 60 },
    steps: { type: [stepSchema], default: [] },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, collection: "whatsapp_followup_settings" },
);

export const WhatsAppFollowupSettings = mongoose.model<IWhatsAppFollowupSettings>("WhatsAppFollowupSettings", settingsSchema);
