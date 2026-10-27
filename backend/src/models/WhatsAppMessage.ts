import mongoose, { Schema, type Types } from "mongoose";

/*
 * One WhatsApp message on a salesperson's own linked WhatsApp (2026-10-27, as in Tetra Commission) — received, sent
 * from the CRM, or sent from their phone (services/whatsapp/service.ts). `owner` is the person whose WhatsApp it is.
 *
 * `chat` is the other side's number (digits with the country code), or WhatsApp's own address for it when the number
 * can't be told. `key` is the number's last 9 digits — how a number is matched to a lead, as the Sales CRM matches
 * them; `lead` is the lead it was matched or linked to, null for a number no lead has.
 *
 * Photos and files are kept on the server's disk (WHATSAPP_MEDIA_DIR), `media.file` the path under it.
 */
export interface IWhatsAppMessage {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  ownerName: string;
  chat: string;
  phone: string;
  key: string;
  jid: string;
  direction: "in" | "out";
  body: string;
  messageId: string;
  senderName: string;
  sentBy: Types.ObjectId | null;
  sentByName: string;
  lead: Types.ObjectId | null;
  read: boolean;
  media: { type: string; mime: string; fileName: string; file: string; size: number } | null;
  at: Date;
  createdAt: Date;
}

const whatsAppMessageSchema = new Schema<IWhatsAppMessage>(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    ownerName: { type: String, default: "" },
    chat: { type: String, required: true },
    phone: { type: String, default: "" },
    key: { type: String, default: "" },
    jid: { type: String, default: "" },
    direction: { type: String, enum: ["in", "out"], required: true },
    body: { type: String, default: "" },
    messageId: { type: String, default: "" },
    senderName: { type: String, default: "" },
    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sentByName: { type: String, default: "" },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", default: null },
    read: { type: Boolean, default: false },
    media: {
      type: new Schema({
        type: { type: String, required: true },
        mime: { type: String, default: "" },
        fileName: { type: String, default: "" },
        file: { type: String, default: "" },
        size: { type: Number, default: 0 },
      }, { _id: false }),
      default: null,
    },
    at: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: "whatsapp_messages" },
);

// The same WhatsApp message once per owner: a reconnect replays what came while away.
whatsAppMessageSchema.index({ owner: 1, messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $gt: "" } } });
whatsAppMessageSchema.index({ owner: 1, chat: 1, at: -1 });
whatsAppMessageSchema.index({ owner: 1, direction: 1, read: 1 });
whatsAppMessageSchema.index({ key: 1 });
whatsAppMessageSchema.index({ lead: 1, at: -1 });

export const WhatsAppMessage = mongoose.model<IWhatsAppMessage>("WhatsAppMessage", whatsAppMessageSchema);

/*
 * A number linked to a lead by hand: it is on no lead's record (a second number, a relative's), so its chats — earlier
 * and later — show under that lead. `key` is the number's last 9 digits, or the chat's WhatsApp address when no
 * number could be told.
 */
export interface IWhatsAppLink {
  _id: Types.ObjectId;
  key: string;
  lead: Types.ObjectId;
  by: Types.ObjectId;
  byName: string;
  at: Date;
}

const whatsAppLinkSchema = new Schema<IWhatsAppLink>(
  {
    key: { type: String, required: true, unique: true },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byName: { type: String, default: "" },
    at: { type: Date, required: true },
  },
  { versionKey: false, collection: "whatsapp_links" },
);

export const WhatsAppLink = mongoose.model<IWhatsAppLink>("WhatsAppLink", whatsAppLinkSchema);
