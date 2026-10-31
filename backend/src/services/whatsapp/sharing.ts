import { Types } from "mongoose";
import { User } from "../../models/User.js";

/*
 * One WhatsApp used by more than one person (the owner, 2026-10-31: one salesperson using another's WhatsApp). A
 * Super Admin shares a person's linked phone with others (User.whatsappOf): they read its chats and send from it as
 * if it were their own — each message carries who sent it — they are told of new messages on it, and they see the
 * phone owner's leads. The phone stays its owner's: only they link or unlink it, and leads it makes are theirs.
 */

const TTL_MS = 30_000;
const ownerCache = new Map<string, { owner: string; at: number }>();

/** Whose WhatsApp this person uses: the one shared with them, else their own. */
export async function phoneOwnerOf(userId: string): Promise<string> {
  const hit = ownerCache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.owner;
  const u = Types.ObjectId.isValid(userId)
    ? await User.findById(userId).select("whatsappOf").lean<{ whatsappOf?: Types.ObjectId | null } | null>() : null;
  const owner = u?.whatsappOf ? String(u.whatsappOf) : userId;
  ownerCache.set(userId, { owner, at: Date.now() });
  return owner;
}

/** Whether this person uses someone else's WhatsApp — whose (id and name), or null. */
export async function sharedFrom(userId: string): Promise<{ id: string; name: string } | null> {
  const owner = await phoneOwnerOf(userId);
  if (owner === userId) return null;
  const u = await User.findById(owner).select("name email").lean<{ name?: string; email?: string } | null>();
  return { id: owner, name: String(u?.name || u?.email || "") };
}

/** The people (other than its owner) using this person's WhatsApp, by name. */
export async function sharersOf(ownerId: string): Promise<{ id: string; name: string }[]> {
  if (!Types.ObjectId.isValid(ownerId)) return [];
  const us = await User.find({ whatsappOf: new Types.ObjectId(ownerId), status: { $ne: "inactive" } })
    .select("name email").sort({ name: 1 }).lean<{ _id: Types.ObjectId; name?: string; email?: string }[]>();
  return us.map((u) => ({ id: String(u._id), name: String(u.name || u.email || "") }));
}

/** Who is told of a new message on this WhatsApp: its owner and everyone using it. */
export async function tellees(ownerId: string): Promise<string[]> {
  return [ownerId, ...(await sharersOf(ownerId)).map((u) => u.id)];
}

/** Everyone on the same WhatsApp as this person (them included): their leads are seen by each other. */
export async function phoneMates(userId: string): Promise<string[]> {
  const owner = await phoneOwnerOf(userId);
  const mates = await tellees(owner);
  return [...new Set([userId, ...mates])];
}

export class SharingError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

/**
 * Who uses this person's WhatsApp, as a Super Admin sets it: exactly these people. Someone using another WhatsApp moves
 * to this one; someone left out goes back to their own. Nobody shares the WhatsApp of a person who uses another's, and
 * an owner whose phone is shared can't be given to someone else's.
 */
export async function setSharers(ownerId: string, userIds: string[]): Promise<{ id: string; name: string }[]> {
  if (!Types.ObjectId.isValid(ownerId)) throw new SharingError("No such person", 404);
  const owner = await User.findById(ownerId).select("whatsappOf").lean<{ whatsappOf?: Types.ObjectId | null } | null>();
  if (!owner) throw new SharingError("No such person", 404);
  if (owner.whatsappOf) throw new SharingError("This person uses someone else's WhatsApp — share that one instead");
  const ids = [...new Set(userIds.map(String))].filter((i) => i !== ownerId);
  if (ids.some((i) => !Types.ObjectId.isValid(i))) throw new SharingError("Bad user id");
  const oids = ids.map((i) => new Types.ObjectId(i));
  if ((await User.countDocuments({ _id: { $in: oids } })) !== ids.length) throw new SharingError("No such person", 404);
  // One whose own WhatsApp others use can't be moved onto another's.
  const busy = await User.findOne({ whatsappOf: { $in: oids } }).select("name").lean<{ name?: string } | null>();
  if (busy) throw new SharingError(`Someone already uses the WhatsApp of a person you picked — take them off it first`);
  const me = new Types.ObjectId(ownerId);
  await User.updateMany({ whatsappOf: me, _id: { $nin: oids } }, { $set: { whatsappOf: null } });
  if (oids.length) await User.updateMany({ _id: { $in: oids } }, { $set: { whatsappOf: me } });
  ownerCache.clear();
  return sharersOf(ownerId);
}

/** For the check only: the cache forgotten, so a change made straight in the database is seen at once. */
export const forgetSharing = () => ownerCache.clear();
