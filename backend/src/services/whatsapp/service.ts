import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { WhatsAppLink, WhatsAppMessage, type IWhatsAppMessage } from "../../models/WhatsAppMessage.js";
import { leadsByPhone, phoneKey } from "./leads.js";
import { sendPushToUser } from "../pushService.js";
import { emitToUser } from "../../socket.js";
import { asVoiceNote, VOICE_MIME } from "./voice.js";

/* ────────────────────────────────────────────────────────────────────────────
   WhatsApp, as in Tetra Commission (the user, 2026-10-27: "working of the
   commission portal WhatsApp — we need it here also"): each salesperson links
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
/** A number's last 9 digits (or a chat's address, when linked by it) → its lead. */
export async function leadsByKey(): Promise<Map<string, Types.ObjectId>> {
  if (byKeyCache && Date.now() - byKeyCache.at < 60_000) return byKeyCache.map;
  const map = new Map<string, Types.ObjectId>();
  for (const [k, id] of await leadsByPhone()) map.set(k, id);
  // A number linked to a lead by hand (it is not on the lead's record) wins over the record.
  for (const l of await WhatsAppLink.find({}).select("key lead").lean()) map.set(l.key, l.lead);
  byKeyCache = { at: Date.now(), map };
  return map;
}
export const forgetLeads = () => { byKeyCache = null; };

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
    if ((err as { code?: number }).code === 11000) return null;   // the same WhatsApp message again (a reconnect replays them)
    throw err;
  }
}

type Owner = { id: string; name: string };

/** A message on someone's WhatsApp — kept, matched to its lead, and the owner told when it is new and not theirs. */
export async function receive(owner: Owner, sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid ?? "";
  if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
  const content = normalizeMessageContent(msg.message);
  if (!content || content.protocolMessage) return;
  const body = bodyOf(content).trim();
  const media = mediaOf(content);
  if (!body && !media) return;

  const phone = await phoneOf(sock, msg.key as proto.IMessageKey & { remoteJidAlt?: string });
  const key = phone ? phoneKey(phone) : "";
  const lead = (await leadsByKey()).get(key || jid) ?? null;   // by number, or a chat linked by its address
  let saved: { file: string; size: number } | null = null;
  if (media) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer.length <= MAX_MEDIA_BYTES) saved = await saveMedia(owner.id, buffer, media.mime, media.fileName);
    } catch (err) {
      console.warn("[whatsapp] could not download a file", err instanceof Error ? err.message : err);
    }
  }
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
    read: fromMe,
    media: media ? { type: media.type, mime: media.mime, fileName: media.fileName, file: saved?.file ?? "", size: saved?.size ?? 0 } : null,
    at: new Date(ts > 0 ? ts * 1000 : Date.now()),
  });
  // A new message to them: a push to their phone and computer, and the open CRM refreshes its chats and count.
  if (kept && !fromMe) {
    const { Lead } = await import("../../models/Lead.js");
    const leadDoc = lead ? await Lead.findById(lead).select("name").lean<{ name?: string } | null>() : null;
    const who = String(leadDoc?.name ?? "").trim() || msg.pushName || (phone ? `+${phone}` : "WhatsApp");
    const text = body || LABEL[media!.type] || "File";
    emitToUser(owner.id, "whatsapp_message", { chat: kept.chat, name: who, body: text });
    void sendPushToUser(owner.id, {
      title: `WhatsApp · ${who}`,
      body: text.length > 140 ? `${text.slice(0, 137)}…` : text,
      tag: `wa-${kept.chat}`,
      url: `/whatsapp?chat=${encodeURIComponent(kept.chat)}`,
      data: { type: "whatsapp_message", chat: kept.chat },
    }).catch(() => undefined);
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
    browser: ["Delta Remote CRM", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,   // the phone keeps its notifications
    syncFullHistory: false,
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
    if (s.sock !== sock || type !== "notify") return;
    for (const msg of messages) await receive(owner, sock, msg).catch((err) => console.error(`[whatsapp] message not kept (${owner.name})`, err));
  });
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

/* ── Sending ────────────────────────────────────────────────────────────── */

/** Where to send: a known number (checked on WhatsApp), or the chat's own address when only that is known. */
async function target(sock: WASocket, chat: string): Promise<{ jid: string; phone: string }> {
  if (chat.includes("@")) return { jid: chat, phone: "" };
  const phone = toIntl(chat);
  if (phone.length < 9) throw new WhatsAppError("That is not a phone number");
  const [found] = (await sock.onWhatsApp(phone).catch(() => [])) ?? [];
  if (!found?.exists) throw new WhatsAppError(`+${phone} is not on WhatsApp`);
  return { jid: String(found.jid), phone };
}

function connected(userId: string): WASocket {
  const s = session(userId);
  if (!s.sock || s.status !== "connected") throw new WhatsAppError("Your WhatsApp is not linked — link it on the WhatsApp page", 409);
  return s.sock;
}

async function keepSent(owner: Owner, to: { jid: string; phone: string }, chat: string, sentId: string, body: string,
  media: { type: string; mime: string; fileName: string; file: string; size: number } | null) {
  const phone = to.phone;
  const key = phone ? phoneKey(phone) : "";
  return store({
    owner: new Types.ObjectId(owner.id), ownerName: owner.name,
    chat: phone || chat, phone, key, jid: to.jid,
    direction: "out", body, messageId: sentId,
    senderName: owner.name, sentBy: new Types.ObjectId(owner.id), sentByName: owner.name,
    lead: (await leadsByKey()).get(key || chat) ?? null,
    read: true, media, at: new Date(),
  });
}

export async function sendText(userId: string, chat: string, text: string) {
  const sock = connected(userId);
  const owner = await ownerOf(userId);
  const to = await target(sock, chat);
  const sent = await sock.sendMessage(to.jid, { text });
  return keepSent(owner, to, chat, sent?.key?.id ?? "", text, null);
}

/**
 * A file, as a photo, a video, audio or a document by its type — or, with `voice`, a recording made in the CRM as a
 * voice note (the blue microphone on the phone): Opus in Ogg, re-wrapped from the browser's WebM when it has to be
 * (voice.ts). A recording that can't be one (an older Safari's MP4) goes as plain audio.
 */
export async function sendFile(userId: string, chat: string, buffer: Buffer, mime: string, fileName: string, caption: string, voice = false) {
  if (buffer.length > MAX_MEDIA_BYTES) throw new WhatsAppError("Files up to 25 MB");
  const sock = connected(userId);
  const owner = await ownerOf(userId);
  const to = await target(sock, chat);
  if (voice) {
    const note = await asVoiceNote(buffer, mime).catch(() => { throw new WhatsAppError("That recording could not be sent as a voice note — record it again"); });
    if (note) {
      const sent = await sock.sendMessage(to.jid, { audio: note, mimetype: VOICE_MIME, ptt: true });
      const saved = await saveMedia(owner.id, note, "audio/ogg", "");
      return keepSent(owner, to, chat, sent?.key?.id ?? "", LABEL.ptt!, { type: "audio", mime: "audio/ogg", fileName: "", file: saved.file, size: saved.size });
    }
  }
  const type = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";
  const content = type === "image" ? { image: buffer, caption } : type === "video" ? { video: buffer, caption }
    : type === "audio" ? { audio: buffer, mimetype: mime, ptt: false } : { document: buffer, mimetype: mime, fileName, caption };
  const sent = await sock.sendMessage(to.jid, content);
  const saved = await saveMedia(owner.id, buffer, mime, fileName);
  return keepSent(owner, to, chat, sent?.key?.id ?? "", caption || (type === "document" ? `📄 ${fileName || "Document"}` : LABEL[type]!),
    { type, mime, fileName, file: saved.file, size: saved.size });
}
