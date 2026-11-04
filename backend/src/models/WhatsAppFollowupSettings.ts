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

/** One part of the automatic first reply: words, a file (a voice note when it can be one), or a file with words. */
export interface IFirstReplyItem {
  text: string;
  file: { file: string; name: string; mime: string; size: number } | null;
  voice: boolean;
}

export interface ITeamMessageSet {
  team: Types.ObjectId;
  steps: IFollowupStep[];
  firstReply: { enabled: boolean; startedAt: Date | null; items: IFirstReplyItem[] };
  updatedByName: string;
  updatedAt: Date | null;
}

export interface IWhatsAppFollowupSettings {
  _id: Types.ObjectId;
  key: "default";
  enabled: boolean;
  startedAt: Date | null;
  teams: Types.ObjectId[];
  dailyLimit: number;
  steps: IFollowupStep[];
  /** The automatic first reply (2026-10-28): to someone's first message ever, a minute on unless a person answered. */
  firstReply: { enabled: boolean; startedAt: Date | null; items: IFirstReplyItem[] };
  /**
   * A team's own messages (2026-11-03: "different ads per team"): its own follow-up steps and first reply, with the first
   * reply's own switch. A team not here uses the ones above (the "Default").
   */
  teamSets: ITeamMessageSet[];
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

const fileSchema = new Schema({
  file: { type: String, required: true },
  name: { type: String, default: "" },
  mime: { type: String, default: "" },
  size: { type: Number, default: 0 },
}, { _id: false });

const firstReplyItemSchema = new Schema<IFirstReplyItem>({
  text: { type: String, default: "", maxlength: 1000 },
  file: { type: fileSchema, default: null },
  voice: { type: Boolean, default: false },
}, { _id: false });

const settingsSchema = new Schema<IWhatsAppFollowupSettings>(
  {
    key: { type: String, enum: ["default"], default: "default", unique: true },
    enabled: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    teams: [{ type: Schema.Types.ObjectId, ref: "Team" }],
    dailyLimit: { type: Number, default: 60 },
    steps: { type: [stepSchema], default: [] },
    firstReply: {
      enabled: { type: Boolean, default: false },
      startedAt: { type: Date, default: null },
      items: { type: [firstReplyItemSchema], default: [] },
    },
    teamSets: {
      type: [new Schema<ITeamMessageSet>({
        team: { type: Schema.Types.ObjectId, ref: "Team", required: true },
        steps: { type: [stepSchema], default: [] },
        firstReply: {
          enabled: { type: Boolean, default: false },
          startedAt: { type: Date, default: null },
          items: { type: [firstReplyItemSchema], default: [] },
        },
        updatedByName: { type: String, default: "" },
        updatedAt: { type: Date, default: null },
      }, { _id: false })],
      default: [],
    },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, collection: "whatsapp_followup_settings" },
);

export const WhatsAppFollowupSettings = mongoose.model<IWhatsAppFollowupSettings>("WhatsAppFollowupSettings", settingsSchema);
