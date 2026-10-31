import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, isLidUser, isPnUser, normalizeMessageContent,
  useMultiFileAuthState, type proto, type WAMessage, type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { User } from "../../models/User.js";
import { contactName, WhatsAppContact, WhatsAppLink, WhatsAppMessage, type IWhatsAppMessage } from "../../models/WhatsAppMessage.js";
import { leadsByPhone, phoneKey } from "./leads.js";
import { sendPushToUser } from "../pushService.js";
import { emitToUser } from "../../socket.js";
import { asVoiceNote, VOICE_MIME } from "./voice.js";
import { tellees } from "./sharing.js";

/* ────────────────────────────────────────────────────────────────────────────
   WhatsApp, as in CS Portal (the user, 2026-10-27: "working of the
   CS Portal WhatsApp — we need it here also"): each salesperson links
   their own WhatsApp by scanning a QR — the server becomes one of their linked
   devices (Baileys, the WhatsApp Web protocol). Normal one-to-one messages only:
   no groups, no broadcasts.

   One session per person, held here and kept in WHATSAPP_SESSION_DIR/<user id>,
   so it comes back by itself when the server restarts. Every message —
   received, sent from the CRM, or sent from their phone — is kept in
   whatsapp_messages under the person whose WhatsApp it is (owner), and matched
   to a lead by its number's last 9 digits (leads.ts). Contacts
   WhatsApp knows by a private id (@lid) are traced back to their number. A
   number no lead has is never made one by itself — someone links it to a lead,
   or makes a lead of it.

   Past chats (the user, 2026-10-27: "get all old chats of Shan's number"):
   when a phone is linked, WhatsApp hands the new device a copy of its recent
   chats (asked for in full; WhatsApp gives its whole history only to a desktop
   app, and linking as one gets no QR — 2026-10-28, refused with 428). They are
   kept as read, tell nobody, and never start an automatic follow-up (`history`).
   Their files are downloaded like any other (2026-10-28: "audio and documents
   and all"); one WhatsApp no longer has is a line saying so. Older messages of
   a chat come on request too — "Load older messages" (fetchOlder).

   Names (2026-10-28): each contact's name as saved in the phone, else their own
   WhatsApp name, kept in whatsapp_contacts — a chat and a lead made of it are
   called by it, and a lead still called "WhatsApp +…" takes it when it comes.
──────────────────────────────────────────────────────────────────────────── */

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

interface Session {
  sock: WASocket | null;
  status: WAStatus;
  phone: string;
  qr: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WhatsAppError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/** Off with WHATSAPP=off, and only in the process that runs the timed jobs: a link lives in the process that made it. */
export const whatsappEnabled = () => !/^(off|false|0|no)$/i.test(env.WHATSAPP) && env.RUN_SCHEDULERS;

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const logger = pino({ level: "silent" });
const sessions = new Map<string, Session>();

const session = (userId: string): Session => {
  let s = sessions.get(userId);
  if (!s) sessions.set(userId, (s = { sock: null, status: "disconnected", phone: "", qr: "", timer: null }));
  return s;
};
const sessionDir = (userId: string) => join(resolve(env.WHATSAPP_SESSION_DIR), userId);
export const mediaPath = (file: string) => join(resolve(env.WHATSAPP_MEDIA_DIR), file);

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
/** A number as WhatsApp wants it — digits with the country code. Local UAE numbers (5x…, 05x…) and Indian mobiles get theirs. */
export function toIntl(raw: unknown): string {
  let d = digits(raw).replace(/^00/, "");
  if (/^05\d{8}$/.test(d)) d = `971${d.slice(1)}`;
  else if (/^5\d{8}$/.test(d)) d = `971${d}`;
  else if (/^[6-9]\d{9}$/.test(d)) d = `91${d}`;
  return d;
}
/** Each number in a lead's phone field ("050… / 055…" holds two), ready for WhatsApp. */
export const intlNumbers = (v: unknown) => [...new Set(String(v ?? "").split(/[\n\r/,;|]+| - /).map(toIntl).filter((x) => x.length >= 9))];

/* ── Leads by number, cached for a minute ───────────────────────────────── */

let byKeyCache: { at: number; map: Map<string, Types.ObjectId> } | null = null;
let building: Promise<Map<string, Types.ObjectId>> | null = null;
let mustRead = false;   // forgetLeads: the next one reads it again before answering
async function buildLeadsByKey(): Promise<Map<string, Types.ObjectId>> {
  const map = new Map<string, Types.ObjectId>();
  for (const [k, id] of await leadsByPhone()) map.set(k, id);
  // A number linked to a lead by hand (it is not on the lead's record) wins over the record.
  for (const l of await WhatsAppLink.find({}).select("key lead").lean()) map.set(l.key, l.lead);
  byKeyCache = { at: Date.now(), map };
  mustRead = false;
  return map;
}
/**
 * A number's last 9 digits (or a chat's address, when linked by it) → its lead. Read from every lead once a minute —
 * and never in a send's way (2026-10-29: messages took long to go): an older list is used while a new one is read in
 * the background, and many asking at once share one read.
 */
export async function leadsByKey(): Promise<Map<string, Types.ObjectId>> {
  if (byKeyCache && !mustRead && Date.now() - byKeyCache.at < 60_000) return byKeyCache.map;
  if (!building) building = buildLeadsByKey().finally(() => { building = null; });
  if (byKeyCache && !mustRead) { building.catch(() => undefined); return byKeyCache.map; }
  return building;
}
/** A lead changed outside the list's knowledge: the next one to ask waits for it to be read again. */
export const forgetLeads = () => { mustRead = true; };
/** A lead just made or linked, put in the list at once — so it is known without reading every lead again. */
export const rememberLead = (key: string, leadId: Types.ObjectId) => { byKeyCache?.map.set(key, leadId); };

/* ── A number that is no lead's, writing in ─────────────────────────────── */

/** The team new WhatsApp leads go to (the owner, 2026-10-28): the one named "AI Academy", however it is written. */
const AI_ACADEMY = /^\s*ai[\s_-]*academy\s*$/i;
let aiAcademyCache: { at: number; id: Types.ObjectId | null } | null = null;
async function aiAcademyTeam(): Promise<Types.ObjectId | null> {
  if (aiAcademyCache && Date.now() - aiAcademyCache.at < 5 * 60_000) return aiAcademyCache.id;
  const { Team } = await import("../../models/Team.js");
  const team = await Team.findOne({ name: AI_ACADEMY, status: { $ne: "inactive" } }).select("_id").lean<{ _id: Types.ObjectId } | null>();
  if (!team) console.warn('[whatsapp] no team named "AI Academy" — WhatsApp leads are made without a team');
  aiAcademyCache = { at: Date.now(), id: team?._id ?? null };
  return aiAcademyCache.id;
}

/** One lead at a time per number, so two messages (or two people's WhatsApps) in the same moment make one lead. */
const makingLead = new Map<string, Promise<Types.ObjectId | null>>();

/**
 * A number that is no lead's has written to someone's WhatsApp (the owner, 2026-10-28: "if they message, create it as
 * a lead … in the AI Academy team, assigned"): a lead is made of it — their WhatsApp name (else "WhatsApp +number"),
 * source WhatsApp, held by the person whose WhatsApp it is, in the AI Academy team — and that person is told.
 * A number that turns out to be a lead after all (the 60-second list was behind) gets that lead instead.
 */
export function leadForNewNumber(owner: Owner, phone: string, key: string, pushName: string): Promise<Types.ObjectId | null> {
  const running = makingLead.get(key);
  if (running) return running;
  const job = (async () => {
    const { Lead } = await import("../../models/Lead.js");
    // Fresh, not the cached list: by the number's last 9 digits, anywhere in a lead's phone field.
    const already = await Lead.findOne({ phone: new RegExp(`${key.split("").join("\\D*")}(?!\\d)`) })
      .select("_id").lean<{ _id: Types.ObjectId } | null>();
    if (already) { rememberLead(key, already._id); return already._id; }
    const saved = (await contactNames(owner.id, [key])).get(key) ?? "";
    const name = (saved && !/^\+?\d+$/.test(saved) ? saved : "")
      || (pushName && !/^\+?\d+$/.test(pushName.trim()) ? pushName.trim().slice(0, 100) : "")
      || `WhatsApp +${phone}`;
    const team = await aiAcademyTeam();
    const lead = await Lead.create({
      name, phone: `+${phone}`, source: "WhatsApp", status: "assigned",
      assignedTo: new Types.ObjectId(owner.id), assignedAt: new Date(), team,
      reporter: new Types.ObjectId(owner.id),
      activityLogs: [{
        action: "lead_created",
        description: `Lead made automatically — +${phone} wrote to ${owner.name}'s WhatsApp`,
        performedBy: new Types.ObjectId(owner.id),
        createdAt: new Date(),
      }],
    });
    rememberLead(key, lead._id as Types.ObjectId);
    const { notifyLeadAssignment } = await import("../pushService.js");
    void notifyLeadAssignment(owner.id, String(lead._id), name, emitToUser).catch(() => null);
    console.log(`[whatsapp] new lead ${name} (+${phone}) for ${owner.name}${team ? " in AI Academy" : ""}`);
    return lead._id as Types.ObjectId;
  })().catch((err) => {
    console.error(`[whatsapp] could not make a lead of +${phone}`, err instanceof Error ? err.message : err);
    return null;
  }).finally(() => makingLead.delete(key));
  makingLead.set(key, job);
  return job;
}

/* ── Messages ───────────────────────────────────────────────────────────── */

export const LABEL: Record<string, string> = { image: "📷 Photo", video: "🎥 Video", audio: "🎵 Audio", ptt: "🎤 Voice note", document: "📄 Document", sticker: "🔖 Sticker" };

function bodyOf(m: proto.IMessage): string {
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption || LABEL.image!;
  if (m.videoMessage) return m.videoMessage.caption || LABEL.video!;
  if (m.audioMessage) return m.audioMessage.ptt ? LABEL.ptt! : LABEL.audio!;
  if (m.documentMessage) return m.documentMessage.caption || `📄 ${m.documentMessage.fileName || "Document"}`;
  if (m.stickerMessage) return LABEL.sticker!;
  if (m.locationMessage) return `📍 Location${m.locationMessage.name ? `: ${m.locationMessage.name}` : ""}`;
  if (m.liveLocationMessage) return "📍 Live location";
  if (m.contactMessage) return `👤 ${m.contactMessage.displayName || "Contact"}`;
  if (m.contactsArrayMessage) return `👤 ${m.contactsArrayMessage.contacts?.length ?? 0} contacts`;
  if (m.reactionMessage) return `${m.reactionMessage.text || "👍"} (reaction)`;
  if (m.pollCreationMessage || m.pollCreationMessageV3) return `📊 Poll: ${(m.pollCreationMessage || m.pollCreationMessageV3)?.name ?? ""}`;
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || "Button reply";
  if (m.listResponseMessage) return m.listResponseMessage.title || "List reply";
  return "";
}

function mediaOf(m: proto.IMessage): { type: string; mime: string; fileName: string } | null {
  if (m.imageMessage) return { type: "image", mime: m.imageMessage.mimetype || "image/jpeg", fileName: "" };
  if (m.videoMessage) return { type: "video", mime: m.videoMessage.mimetype || "video/mp4", fileName: "" };
  if (m.audioMessage) return { type: "audio", mime: m.audioMessage.mimetype || "audio/ogg", fileName: "" };
  if (m.documentMessage) return { type: "document", mime: m.documentMessage.mimetype || "application/octet-stream", fileName: m.documentMessage.fileName || "" };
  if (m.stickerMessage) return { type: "sticker", mime: m.stickerMessage.mimetype || "image/webp", fileName: "" };
  return null;
}

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4",
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "application/pdf": ".pdf" };
async function saveMedia(owner: string, buffer: Buffer, mime: string, fileName: string) {
  const ext = EXT[mime.split(";")[0]!.trim()] || extname(fileName).slice(0, 10) || ".bin";
  const file = `${owner}/${randomUUID()}${ext}`;
  await mkdir(mediaPath(owner), { recursive: true });
  await writeFile(mediaPath(file), buffer);
  return { file, size: buffer.length };
}

/** The other side's number, also for contacts WhatsApp knows by a private id (@lid). "" when it cannot be told. */
async function phoneOf(sock: WASocket, key: proto.IMessageKey & { remoteJidAlt?: string }): Promise<string> {
  for (const jid of [key.remoteJid, key.remoteJidAlt]) {
    if (jid && (jid.endsWith("@s.whatsapp.net") || isPnUser(jid))) return digits(jid.split("@")[0]!.split(":")[0]);
  }
  if (key.remoteJid && isLidUser(key.remoteJid)) {
    const repo = (sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } }).signalRepository;
    const pn = await repo?.lidMapping?.getPNForLID?.(key.remoteJid).catch(() => null);
    if (pn) return digits(String(pn).split("@")[0]!.split(":")[0]);
  }
  return "";
}

type NewMessage = Omit<IWhatsAppMessage, "_id" | "createdAt">;
interface Saved { id: string; chat: string }
async function store(doc: NewMessage): Promise<Saved | null> {
  try {
    const saved = await WhatsAppMessage.create(doc);
    return { id: String(saved._id), chat: saved.chat };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      // The same WhatsApp message again (a reconnect replays them). Kept before without its file, and it has one now
      // (asked for again with "Load older messages"): the file goes on the one kept.
      if (doc.media?.file && doc.messageId) {
        await WhatsAppMessage.updateOne(
          { owner: doc.owner, messageId: doc.messageId, $or: [{ media: null }, { "media.file": "" }] },
          { $set: { media: doc.media, body: doc.body } },
        );
      }
      return null;
    }
    throw err;
  }
}

/* ── Contacts' names ────────────────────────────────────────────────────── */

type ContactIn = { id?: string | null; phoneNumber?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null };
const pnOf = (c: ContactIn) => {
  for (const jid of [c.phoneNumber, c.id]) if (jid && (jid.endsWith("@s.whatsapp.net") || isPnUser(jid))) return digits(jid.split("@")[0]!.split(":")[0]);
  return "";
};

/** Names WhatsApp gave for contacts — kept per owner by number; a lead still called "WhatsApp +<number>" takes the name. */
export async function keepContacts(owner: Owner, contacts: ContactIn[]): Promise<number> {
  let kept = 0;
  for (const c of contacts) {
    const phone = pnOf(c);
    const key = phone ? phoneKey(phone) : "";
    if (!key) continue;
    const set: Record<string, string> = {};
    for (const f of ["name", "notify", "verifiedName"] as const) { const v = String(c[f] ?? "").trim(); if (v) set[f] = v.slice(0, 120); }
    if (!Object.keys(set).length) continue;
    const doc = await WhatsAppContact.findOneAndUpdate({ owner: new Types.ObjectId(owner.id), key }, { $set: { ...set, phone } }, { upsert: true, new: true }).lean();
    kept++;
    const best = contactName(doc);
    if (best && !/^\+?\d+$/.test(best)) {
      const { Lead } = await import("../../models/Lead.js");
      await Lead.updateMany({ name: `WhatsApp +${phone}` }, { $set: { name: best } });
    }
  }
  return kept;
}

/** Names of these numbers (last 9 digits) on the owner's WhatsApp. */
export async function contactNames(owner: string, keys: string[]): Promise<Map<string, string>> {
  const list = [...new Set(keys.filter(Boolean))];
  if (!list.length || !Types.ObjectId.isValid(owner)) return new Map();
  const docs = await WhatsAppContact.find({ owner: new Types.ObjectId(owner), key: { $in: list } }).lean();
  return new Map(docs.map((d) => [d.key, contactName(d)]).filter(([, n]) => !!n) as [string, string][]);
}

export type Owner = { id: string; name: string };

const captionOf = (m: proto.IMessage) => String(m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "").trim();

/**
 * A message on someone's WhatsApp — kept, matched to its lead, and the owner told when it is new and not theirs.
 * `history`: one from WhatsApp's copy of past chats — kept as read, nobody told. `quiet`: one WhatsApp catches up on
 * after linking or a reconnect — kept as it is (unread if it is theirs), with no push for each.
 */
export async function receive(owner: Owner, sock: WASocket, msg: WAMessage, opts: { history?: boolean; quiet?: boolean } = {}): Promise<void> {
  const jid = msg.key.remoteJid ?? "";
  if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
  const content = normalizeMessageContent(msg.message);
  if (!content || content.protocolMessage) return;
  let body = bodyOf(content).trim();
  let media = mediaOf(content);
  if (!body && !media) return;
  const history = opts.history === true;

  const phone = await phoneOf(sock, msg.key as proto.IMessageKey & { remoteJidAlt?: string });
  const key = phone ? phoneKey(phone) : "";
  let lead = (await leadsByKey()).get(key || jid) ?? null;   // by number, or a chat linked by its address
  // Someone who is no lead's writing in — now, not a past chat, and not more than a day ago — becomes one.
  const sentAt = Number(msg.messageTimestamp ?? 0) * 1000;
  if (!lead && !history && !msg.key.fromMe && phone && key && (!sentAt || Date.now() - sentAt < 24 * 3_600_000)) {
    lead = await leadForNewNumber(owner, phone, key, msg.pushName ?? "");
  }
  let saved: { file: string; size: number } | null = null;
  if (media) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer.length <= MAX_MEDIA_BYTES) saved = await saveMedia(owner.id, buffer, media.mime, media.fileName);
    } catch (err) {
      console.warn("[whatsapp] could not download a file", err instanceof Error ? err.message : err);
    }
    // An old one WhatsApp no longer has: a line saying so (its caption with it, unless it is just the file's name).
    if (!saved && history) {
      const what = media.type === "document" ? `📄 ${media.fileName || "Document"}`
        : content.audioMessage?.ptt ? LABEL.ptt! : (LABEL[media.type] ?? "File");
      const caption = captionOf(content);
      body = `${what} (older — couldn't be fetched)${caption && caption !== media.fileName ? `: ${caption}` : ""}`;
      media = null;
    }
  }
  // Their own name on WhatsApp, kept for the chat (and a lead made of it).
  if (!msg.key.fromMe && msg.pushName && phone) await keepContacts(owner, [{ id: `${phone}@s.whatsapp.net`, notify: msg.pushName }]).catch(() => 0);
  const fromMe = !!msg.key.fromMe;
  const ts = Number(msg.messageTimestamp ?? 0);
  const kept = await store({
    owner: new Types.ObjectId(owner.id), ownerName: owner.name,
    chat: phone || jid, phone, key, jid,
    direction: fromMe ? "out" : "in",
    body: body || LABEL[media!.type] || "File",
    messageId: msg.key.id ?? "",
    senderName: fromMe ? "From their phone" : msg.pushName || phone || "",
    sentBy: null, sentByName: fromMe ? "From their phone" : "",
    lead,
    read: fromMe || history,
    media: media ? { type: media.type, mime: media.mime, fileName: media.fileName, file: saved?.file ?? "", size: saved?.size ?? 0 } : null,
    ...(history ? { history: true } : {}),
    at: new Date(ts > 0 ? ts * 1000 : Date.now()),
  });
  // Their first message ever to this WhatsApp: noted for the automatic first reply (followups.ts runFirstReplies) —
  // only one sent just now. One WhatsApp catches up on (after linking or a reconnect) from earlier is not a new
  // person writing in: a pile of those queued behind each other held real first replies up for many minutes.
  const fresh = !ts || Date.now() - ts * 1000 < FIRST_CONTACT_FRESH_MS;
  if (kept && !fromMe && !history && key && fresh) {
    const earlier = await WhatsAppMessage.countDocuments({ owner: new Types.ObjectId(owner.id), key, _id: { $ne: new Types.ObjectId(kept.id) } });
    if (!earlier) {
      await WhatsAppMessage.db.collection("whatsapp_first_contacts").insertOne({
        _id: `${owner.id}|${key}` as never, owner: new Types.ObjectId(owner.id), key, chat: kept.chat, at: new Date(ts > 0 ? ts * 1000 : Date.now()), status: "waiting", createdAt: new Date(),
      }).catch(() => undefined);   // noted already
    }
  }
  // A new message to them: a push to their phone and computer, and the open CRM refreshes its chats and count.
  if (kept && !fromMe && !history && !opts.quiet) {
    const { Lead } = await import("../../models/Lead.js");
    const leadDoc = lead ? await Lead.findById(lead).select("name").lean<{ name?: string } | null>() : null;
    const who = String(leadDoc?.name ?? "").trim() || msg.pushName || (phone ? `+${phone}` : "WhatsApp");
    const text = body || LABEL[media!.type] || "File";
    // Its owner, and whoever uses this WhatsApp with them (sharing.ts).
    for (const to of await tellees(owner.id).catch(() => [owner.id])) {
      emitToUser(to, "whatsapp_message", { chat: kept.chat, name: who, body: text });
      void sendPushToUser(to, {
        title: `WhatsApp · ${who}`,
        body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
        tag: `wa-${kept.chat}`,
        url: `/whatsapp?chat=${encodeURIComponent(kept.chat)}`,
        data: { type: "whatsapp_message", chat: kept.chat },
      }).catch(() => undefined);
    }
  }
}

/* ── Linking ────────────────────────────────────────────────────────────── */

export function status(userId: string): { status: WAStatus; phone: string; qr: string } {
  const s = session(userId);
  return { status: s.status, phone: s.phone, qr: s.qr };
}

async function ownerOf(userId: string): Promise<Owner> {
  const user = Types.ObjectId.isValid(userId) ? await User.findById(userId).select("name email").lean<{ name?: string; email?: string } | null>() : null;
  if (!user) throw new WhatsAppError("No such user", 404);
  return { id: userId, name: String(user.name || user.email || "") };
}

export async function connect(userId: string): Promise<void> {
  if (!whatsappEnabled()) throw new WhatsAppError("WhatsApp is switched off on this server", 503);
  const owner = await ownerOf(userId);
  const s = session(userId);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.sock) { const old = s.sock; s.sock = null; try { old.end(undefined); } catch { /* already closed */ } }
  s.status = "connecting";
  s.qr = "";

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir(userId));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    // A browser, as WhatsApp Web. Not a desktop app ("Mac OS" / "Desktop", which full history needs): WhatsApp closes
    // that link (428) before it ever sends a QR, so nobody can link (2026-10-28).
    browser: ["Delta Remote CRM", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,   // the phone keeps its notifications
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    generateHighQualityLinkPreview: false,
  });
  s.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (s.sock !== sock) return;   // a socket already put aside — its late events must not bring it back
    if (qr) {
      s.status = "qr_ready";
      s.qr = await qrcode.toDataURL(qr).catch(() => "");
    }
    if (connection === "open") {
      s.status = "connected";
      s.phone = digits(String(sock.user?.id ?? "").split(":")[0]!.split("@")[0]);
      s.qr = "";
      console.log(`[whatsapp] linked — ${owner.name} (${s.phone})`);
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      s.status = "disconnected";
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: the saved keys are dead, so the next link starts with a fresh QR.
        s.sock = null;
        s.phone = "";
        await rm(sessionDir(userId), { recursive: true, force: true }).catch(() => undefined);
        console.log(`[whatsapp] unlinked from the phone — ${owner.name}`);
      } else {
        s.timer = setTimeout(() => void connect(userId).catch((err) => console.error("[whatsapp] reconnect failed", err)), 5_000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (s.sock !== sock) return;
    // "append": ones WhatsApp catches up on after linking or a reconnect — kept as they are, without a push for each.
    const quiet = type !== "notify";
    for (const msg of messages) await receive(owner, sock, msg, { quiet }).catch((err) => console.error(`[whatsapp] message not kept (${owner.name})`, err));
  });

  // WhatsApp's copy of past chats, in parts, when the phone is linked — and older messages asked for (fetchOlder).
  sock.ev.on("messaging-history.set", async ({ messages, contacts, progress }) => {
    if (s.sock !== sock) return;
    if (contacts?.length) await keepContacts(owner, contacts).catch((err) => console.error(`[whatsapp] contacts not kept (${owner.name})`, err));
    for (const msg of messages) await receive(owner, sock, msg, { history: true }).catch((err) => console.error(`[whatsapp] past message not kept (${owner.name})`, err));
    console.log(`[whatsapp] past chats — ${owner.name}: ${messages.length} messages${progress != null ? ` (${progress}%)` : ""}`);
  });

  // Contacts' names as WhatsApp tells them (saved in the phone, or their own).
  sock.ev.on("contacts.upsert", (contacts) => { if (s.sock === sock) void keepContacts(owner, contacts).catch(() => 0); });
  sock.ev.on("contacts.update", (contacts) => { if (s.sock === sock) void keepContacts(owner, contacts as ContactIn[]).catch(() => 0); });
}

export async function disconnect(userId: string): Promise<void> {
  const s = session(userId);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  const sock = s.sock;
  s.sock = null;   // first, so the close that logout fires does not reconnect
  s.status = "disconnected";
  s.phone = "";
  s.qr = "";
  if (sock) { try { await sock.logout(); } catch { /* already gone */ } }
  await rm(sessionDir(userId), { recursive: true, force: true }).catch(() => undefined);
}

/** Everyone whose WhatsApp was linked on this server comes back after a restart, without a new QR. */
export function startWhatsApp(): void {
  if (!whatsappEnabled()) { console.log("[whatsapp] off in this process (WHATSAPP=off, or not the one running the timed jobs)"); return; }
  const dir = resolve(env.WHATSAPP_SESSION_DIR);
  if (!existsSync(dir)) return;
  for (const id of readdirSync(dir)) {
    if (/^[a-f0-9]{24}$/.test(id) && existsSync(join(dir, id, "creds.json"))) {
      void connect(id).catch((err) => console.error(`[whatsapp] could not restore ${id}`, err instanceof Error ? err.message : err));
    }
  }
}

/** For the check only (scripts/whatsapp-check.ts): a stand-in socket, linked, in place of a real WhatsApp. */
export function attachSocketForCheck(userId: string, sock: WASocket | null, phone = ""): void {
  const s = session(userId);
  s.sock = sock;
  s.status = sock ? "connected" : "disconnected";
  s.phone = sock ? phone : "";
}

/* ── Older messages, on request ─────────────────────────────────────────── */

/**
 * "Load older messages": asks the owner's phone for the `count` messages before the oldest kept in this chat. They
 * come a few seconds later as past chats (messaging-history.set) — the chat shows them as they land.
 */
export async function fetchOlder(userId: string, chat: string, count = 50): Promise<{ before: Date }> {
  const sock = connected(userId);
  const oldest = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(userId), chat, messageId: { $gt: "" }, jid: { $gt: "" } })
    .sort({ at: 1, _id: 1 }).select("messageId jid direction at").lean<{ messageId: string; jid: string; direction: string; at: Date } | null>();
  if (!oldest) throw new WhatsAppError("Nothing in this chat to start from — older messages come once there is one", 409);
  await sock.fetchMessageHistory(count, { remoteJid: oldest.jid, fromMe: oldest.direction === "out", id: oldest.messageId }, Math.floor(oldest.at.getTime() / 1000));
  return { before: oldest.at };
}

/**
 * "Load older messages for all chats" (2026-10-28): the phone asked for the `count` messages before the oldest kept,
 * chat by chat — newest chats first, up to 300, one every `gapMs` so WhatsApp is not flooded — in the background.
 * One run per person at a time. Answers how many chats it will ask about.
 */
const olderRuns = new Map<string, { chats: number; done: number; startedAt: Date }>();
export const ALL_OLDER_CAP = 300;
export async function fetchOlderForAll(userId: string, opts: { count?: number; gapMs?: number } = {}): Promise<{ chats: number; seconds: number }> {
  connected(userId);
  if (olderRuns.has(userId)) {
    const r = olderRuns.get(userId)!;
    throw new WhatsAppError(`Already asking your phone — ${r.done} of ${r.chats} chats so far`, 409);
  }
  // Each chat once, newest first, that has a message WhatsApp can start from.
  const rows = await WhatsAppMessage.aggregate<{ _id: string; last: Date }>([
    { $match: { owner: new Types.ObjectId(userId), messageId: { $gt: "" }, jid: { $gt: "" } } },
    { $group: { _id: "$chat", last: { $max: "$at" } } },
    { $sort: { last: -1 } },
    { $limit: ALL_OLDER_CAP },
  ]);
  const chats = rows.map((r) => r._id);
  if (!chats.length) throw new WhatsAppError("No chats yet to load older messages for", 409);
  const gap = opts.gapMs ?? 1500;
  const run = { chats: chats.length, done: 0, startedAt: new Date() };
  olderRuns.set(userId, run);
  void (async () => {
    try {
      for (const chat of chats) {
        if (!isConnected(userId)) break;   // unlinked meanwhile: stop
        await fetchOlder(userId, chat, opts.count ?? 50).catch((err) => console.warn(`[whatsapp] older messages not asked for ${chat}`, err instanceof Error ? err.message : err));
        run.done++;
        if (run.done < chats.length) await new Promise((r) => setTimeout(r, gap));
      }
    } finally {
      olderRuns.delete(userId);
    }
  })();
  return { chats: chats.length, seconds: Math.ceil((chats.length * gap) / 1000) };
}

/** Whether an all-chats run is going for this person, and how far it is. */
export const olderRunOf = (userId: string) => olderRuns.get(userId) ?? null;

/* ── Sending ────────────────────────────────────────────────────────────── */

/** Where to send: a known number (checked on WhatsApp), or the chat's own address when only that is known. */
/** Numbers WhatsApp said are on it, and their address — remembered a day, so a send doesn't ask again. */
const onWhatsAppCache = new Map<string, { jid: string; at: number }>();
const ON_WHATSAPP_TTL_MS = 24 * 3_600_000;
async function target(sock: WASocket, chat: string, ownerId?: string): Promise<{ jid: string; phone: string }> {
  if (chat.includes("@")) return { jid: chat, phone: "" };
  const phone = toIntl(chat);
  if (phone.length < 9) throw new WhatsAppError("That is not a phone number");
  // A chat already going on has its address on its messages: no need to ask WhatsApp before each send (2026-10-29).
  if (ownerId) {
    const known = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(ownerId), chat: phone, jid: /@s\.whatsapp\.net$/ })
      .sort({ at: -1, _id: -1 }).select("jid").lean<{ jid?: string } | null>();
    if (known?.jid) return { jid: known.jid, phone };
  }
  const cached = onWhatsAppCache.get(phone);
  if (cached && Date.now() - cached.at < ON_WHATSAPP_TTL_MS) return { jid: cached.jid, phone };
  const [found] = (await sock.onWhatsApp(phone).catch(() => [])) ?? [];
  if (!found?.exists) throw new WhatsAppError(`+${phone} is not on WhatsApp`);
  onWhatsAppCache.set(phone, { jid: String(found.jid), at: Date.now() });
  return { jid: String(found.jid), phone };
}

function connected(userId: string): WASocket {
  const s = session(userId);
  if (!s.sock || s.status !== "connected") throw new WhatsAppError("Your WhatsApp is not linked — link it on the WhatsApp page", 409);
  return s.sock;
}

/** How a send was made: by a person (the default), or by the CRM on its own — an automatic follow-up. */
export type SendOpts = {
  auto?: { kind: "followup" | "first_reply"; step: number; of: number };
  /** By a person: Forward from another chat, or one of the saved messages picked — a person's message, not automatic. */
  forwarded?: boolean;
  saved?: { kind: "followup" | "first_reply"; step: number };
  /** Who sent it, when not the WhatsApp's owner: someone it is shared with (sharing.ts) — named on the message. */
  by?: Owner;
};

async function keepSent(owner: Owner, to: { jid: string; phone: string }, chat: string, sentId: string, body: string,
  media: { type: string; mime: string; fileName: string; file: string; size: number } | null, opts: SendOpts = {}) {
  const phone = to.phone;
  const key = phone ? phoneKey(phone) : "";
  return store({
    owner: new Types.ObjectId(owner.id), ownerName: owner.name,
    chat: phone || chat, phone, key, jid: to.jid,
    direction: "out", body, messageId: sentId,
    senderName: (opts.by ?? owner).name, sentBy: new Types.ObjectId((opts.by ?? owner).id),
    sentByName: opts.auto ? (opts.auto.kind === "first_reply" ? "Auto first reply" : "Auto follow-up") : (opts.by ?? owner).name,
    lead: (await leadsByKey()).get(key || chat) ?? null,
    read: true, media, at: new Date(), auto: opts.auto ?? null,
    ...(opts.forwarded ? { forwarded: true } : {}),
    ...(opts.saved ? { saved: opts.saved } : {}),
  });
}

/** How old a message may be and still count as someone writing in for the first time (2026-10-28). */
export const FIRST_CONTACT_FRESH_MS = 5 * 60_000;

/** Everyone whose WhatsApp is linked and up in this process. */
export const connectedOwnerIds = () => [...sessions].filter(([, s]) => !!s.sock && s.status === "connected").map(([id]) => id);

/** Whether this person's WhatsApp is linked and up, here — the automatic follow-ups send only then. */
export const isConnected = (userId: string) => { const s = session(userId); return !!s.sock && s.status === "connected"; };

export async function sendText(userId: string, chat: string, text: string, opts: SendOpts = {}) {
  const sock = connected(userId);
  const owner = await ownerOf(userId);
  const to = await target(sock, chat, userId);
  const sent = await sock.sendMessage(to.jid, { text });
  return keepSent(owner, to, chat, sent?.key?.id ?? "", text, null, opts);
}

/**
 * A file, as a photo, a video, audio or a document by its type — or, with `voice`, a recording made in the CRM as a
 * voice note (the blue microphone on the phone): Opus in Ogg, re-wrapped from the browser's WebM when it has to be
 * (voice.ts). A recording that can't be one (an older Safari's MP4) goes as plain audio.
 */
/**
 * Whether an MP4 holds sound only (2026-10-28: WhatsApp's own recordings saved as "AUDIO-….m4a.mp4", which a browser
 * calls a video): its tracks' handlers (the hdlr boxes) say "soun" and none says "vide".
 */
export function isAudioOnlyMp4(buffer: Buffer): boolean {
  let sound = false;
  for (let i = buffer.indexOf("hdlr"); i !== -1 && i + 16 <= buffer.length; i = buffer.indexOf("hdlr", i + 4)) {
    const handler = buffer.toString("latin1", i + 12, i + 16);
    if (handler === "vide") return false;
    if (handler === "soun") sound = true;
  }
  return sound;
}
/** The type a file really is: an MP4 with sound only is audio (sent as audio, not a video). */
export const realMime = (buffer: Buffer, mime: string) =>
  /^video\/mp4$/i.test(mime.split(";")[0]!.trim()) && isAudioOnlyMp4(buffer) ? "audio/mp4" : mime;

export async function sendFile(userId: string, chat: string, buffer: Buffer, mime: string, fileName: string, caption: string, voice = false,
  opts: SendOpts & { storedFile?: string } = {}) {
  if (buffer.length > MAX_MEDIA_BYTES) throw new WhatsAppError("Files up to 25 MB");
  mime = realMime(buffer, mime);
  const sock = connected(userId);
  const owner = await ownerOf(userId);
  const to = await target(sock, chat, userId);
  if (voice) {
    const note = await asVoiceNote(buffer, mime).catch(() => { throw new WhatsAppError("That recording could not be sent as a voice note — record it again"); });
    if (note) {
      const sent = await sock.sendMessage(to.jid, { audio: note, mimetype: VOICE_MIME, ptt: true });
      const saved = await saveMedia(owner.id, note, "audio/ogg", "");
      return keepSent(owner, to, chat, sent?.key?.id ?? "", LABEL.ptt!, { type: "audio", mime: "audio/ogg", fileName: "", file: saved.file, size: saved.size }, opts);
    }
  }
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
  const content = type === "image" ? { image: buffer, caption } : type === "video" ? { video: buffer, caption }
    : type === "audio" ? { audio: buffer, mimetype: mime, ptt: false } : { document: buffer, mimetype: mime, fileName, caption };
  const sent = await sock.sendMessage(to.jid, content);
  // A file kept once already (a follow-up's video, sent to many) is pointed at, not copied again for each.
  const saved = opts.storedFile ? { file: opts.storedFile, size: buffer.length } : await saveMedia(owner.id, buffer, mime, fileName);
  return keepSent(owner, to, chat, sent?.key?.id ?? "", caption || (type === "document" ? `📄 ${fileName || "Document"}` : LABEL[type]!),
    { type, mime, fileName, file: saved.file, size: saved.size }, opts);
}

/* ── Forward ────────────────────────────────────────────────────────────── */

/**
 * A message kept here, sent again from this person's own WhatsApp to another chat (the owner, 2026-10-28: "forward
 * message option"): its words, or its file with the caption it had — a voice note as a voice note. Marked forwarded.
 */
export async function forwardMessage(userId: string, source: Pick<IWhatsAppMessage, "body" | "media">, chat: string, by?: Owner) {
  const media = source.media;
  if (!media) {
    const text = String(source.body ?? "").trim();
    if (!text) throw new WhatsAppError("There is nothing in that message to forward");
    return sendText(userId, chat, text, { forwarded: true, by });
  }
  if (!media.file || !existsSync(mediaPath(media.file))) throw new WhatsAppError("That file is no longer kept here, so it can't be forwarded");
  const buffer = await readFile(mediaPath(media.file));
  const body = String(source.body ?? "").trim();
  const voice = media.type === "audio" && body === LABEL.ptt;
  // The words that went with it — not the label the CRM gave a file with none ("📷 Photo", "📄 name").
  const caption = voice || body === LABEL[media.type] || body.startsWith("📄 ") ? "" : body;
  return sendFile(userId, chat, buffer, media.mime || "application/octet-stream", media.fileName || "file", caption, voice,
    { forwarded: true, by, ...(voice ? {} : { storedFile: media.file }) });
}
