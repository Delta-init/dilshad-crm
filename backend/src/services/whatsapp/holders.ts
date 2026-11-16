import { Types } from "mongoose";
import { Lead } from "../../models/Lead.js";
import { User } from "../../models/User.js";
import { WhatsAppChatHolder, WhatsAppMessage } from "../../models/WhatsAppMessage.js";
import { tellees } from "./sharing.js";

/*
 * Each chat on a WhatsApp more than one person uses is one person's (the user, 2026-11-16: "user 1 and user 2 on the
 * same WhatsApp — user 1 only sees his leads' WhatsApp, and they can start a new chat from here"). Its holder:
 *   1. the lead's holder (Lead.assignedTo), when they are on that WhatsApp — a lead moved to the other one takes its
 *      chat along;
 *   2. else whoever started it from the CRM (WhatsAppChatHolder), when they still are;
 *   3. else the WhatsApp's owner.
 * Each sees, gets the unread count and the pop-ups of, and sends in their own chats only. A team leader also their
 * teams' people's, the Sales Manager and a Super Admin all (access.ts visibleHolders). A WhatsApp nobody else uses:
 * every chat is its owner's, as before.
 *
 * The phone itself still shows every chat: both hold it.
 */

export type ChatRef = { chat: string; lead?: Types.ObjectId | string | null };

/** Whose each chat is on this WhatsApp (chat → user id) — null when nobody else uses it: all its owner's. */
export async function holdersOf(owner: string, refs: ChatRef[]): Promise<Map<string, string> | null> {
  const people = new Set(await tellees(owner));
  if (people.size < 2) return null;
  const leadIds = [...new Set(refs.map((r) => (r.lead ? String(r.lead) : "")).filter((i) => Types.ObjectId.isValid(i)))];
  const [leads, records] = await Promise.all([
    leadIds.length ? Lead.find({ _id: { $in: leadIds.map((i) => new Types.ObjectId(i)) } }).select("assignedTo").lean<{ _id: Types.ObjectId; assignedTo?: Types.ObjectId | null }[]>() : [],
    refs.length ? WhatsAppChatHolder.find({ owner: new Types.ObjectId(owner), chat: { $in: [...new Set(refs.map((r) => r.chat))] } }).select("chat user").lean<{ chat: string; user: Types.ObjectId }[]>() : [],
  ]);
  const leadHolder = new Map(leads.map((l) => [String(l._id), l.assignedTo ? String(l.assignedTo) : ""]));
  const started = new Map(records.map((r) => [r.chat, String(r.user)]));
  const out = new Map<string, string>();
  for (const r of refs) {
    const byLead = r.lead ? leadHolder.get(String(r.lead)) ?? "" : "";
    const byStart = started.get(r.chat) ?? "";
    out.set(r.chat, byLead && people.has(byLead) ? byLead : byStart && people.has(byStart) ? byStart : owner);
  }
  return out;
}

/** Whether a chat has anything on this WhatsApp yet. */
export async function chatExists(owner: string, chat: string): Promise<boolean> {
  return !!(await WhatsAppMessage.exists({ owner: new Types.ObjectId(owner), chat }));
}

/** This person started this chat from the CRM: it is theirs while it is no lead's (or its lead is no one's here). */
export async function holdChat(owner: string, chat: string, userId: string): Promise<void> {
  await WhatsAppChatHolder.updateOne(
    { owner: new Types.ObjectId(owner), chat },
    { $set: { user: new Types.ObjectId(userId), at: new Date() } },
    { upsert: true },
  );
}

/** Who started this chat from the CRM, when they are on this WhatsApp — for the lead made when the number answers. */
export async function starterOf(owner: string, chat: string): Promise<string | null> {
  const r = await WhatsAppChatHolder.findOne({ owner: new Types.ObjectId(owner), chat }).select("user").lean<{ user: Types.ObjectId } | null>();
  if (!r) return null;
  const people = await tellees(owner);
  return people.includes(String(r.user)) ? String(r.user) : null;
}

/** A person's name, for "This chat is Sara's". */
export async function nameOf(userId: string): Promise<string> {
  const u = Types.ObjectId.isValid(userId) ? await User.findById(userId).select("name email").lean<{ name?: string; email?: string } | null>() : null;
  return String(u?.name || u?.email || "someone else");
}
