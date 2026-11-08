import mongoose, { Schema, type Types } from "mongoose";
import type { IFirstReplyItem, IFollowupStep } from "./WhatsAppFollowupSettings.js";

/*
 * A team's WhatsApp settings (the owner, 2026-11-08: "by the team, on the team's page — the current ones only for the AI
 * Academy team"): its automatic follow-ups — on or off, since when, how many a person's WhatsApp sends in a day, the
 * steps — and its first reply, with its own switch. Set by a Super Admin or the team's leader (Teams → the team →
 * WhatsApp); read by services/whatsapp/followups.ts. A team with none sends nothing automatic.
 *
 * The one-for-everyone document before it (whatsapp_followup_settings) was moved here once, to AI Academy.
 */
export interface IWhatsAppTeamSettings {
  _id: Types.ObjectId;
  team: Types.ObjectId;
  enabled: boolean;
  /** When follow-ups were last switched on: only chats a person wrote in after it are followed up. */
  startedAt: Date | null;
  dailyLimit: number;
  steps: IFollowupStep[];
  firstReply: { enabled: boolean; startedAt: Date | null; items: IFirstReplyItem[] };
  updatedByName: string;
  updatedAt: Date;
}

const fileSchema = new Schema({
  file: { type: String, required: true },
  name: { type: String, default: "" },
  mime: { type: String, default: "" },
  size: { type: Number, default: 0 },
}, { _id: false });

const settingsSchema = new Schema<IWhatsAppTeamSettings>(
  {
    team: { type: Schema.Types.ObjectId, ref: "Team", required: true, unique: true },
    enabled: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    dailyLimit: { type: Number, default: 60 },
    steps: {
      type: [new Schema<IFollowupStep>({
        waitMinutes: { type: Number, required: true },
        text: { type: String, required: true, maxlength: 1000 },
        file: { type: fileSchema, default: null },
      }, { _id: false })],
      default: [],
    },
    firstReply: {
      enabled: { type: Boolean, default: false },
      startedAt: { type: Date, default: null },
      items: {
        type: [new Schema<IFirstReplyItem>({
          text: { type: String, default: "", maxlength: 1000 },
          file: { type: fileSchema, default: null },
          voice: { type: Boolean, default: false },
        }, { _id: false })],
        default: [],
      },
    },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, collection: "whatsapp_team_settings" },
);

export const WhatsAppTeamSettings = mongoose.model<IWhatsAppTeamSettings>("WhatsAppTeamSettings", settingsSchema);
