import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { Router, type NextFunction, type Response } from "express";
import multer from "multer";
import { Types } from "mongoose";
import { env } from "../config/env.js";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { WhatsAppLink, WhatsAppMessage } from "../models/WhatsAppMessage.js";
import { LeadService } from "../services/leadService.js";
import { phoneKey, phoneKeys } from "../services/whatsapp/leads.js";
import { canWhatsApp, leadScope, readableOwners, type Viewer } from "../services/whatsapp/access.js";
import {
  connect, disconnect, forgetLeads, intlNumbers, leadsByKey, mediaPath, sendFile, sendText, status, whatsappEnabled, WhatsAppError,
} from "../services/whatsapp/service.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";

/* ────────────────────────────────────────────────────────────────────────────
   The WhatsApp page and the lead page's WhatsApp card (2026-10-27, as in Tetra
   Commission; services/whatsapp/service.ts does the WhatsApp side).

   Each person links their own WhatsApp and is the only one who sends from it.
   Who reads it (services/whatsapp/access.ts): its owner; their team leader; the
   Sales Manager and a Super Admin — everyone's.
──────────────────────────────────────────────────────────────────────────── */

const router = Router();
const leadService = new LeadService();
const viewer = (req: AuthenticatedRequest): Viewer => ({ userId: req.user!.userId, role: req.user!.role ?? null });
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const isId = (v: string) => /^[a-f0-9]{24}$/.test(v);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** A WhatsApp failure as the answer; anything else on to the error handler. */
function fail(res: Response, next: NextFunction, err: unknown) {
  if (err instanceof WhatsAppError) { sendError(res, err.message, err.statusCode); return; }
  next(err);
}

/* ── Photos and files, on short-lived signed links (an <img> carries no token) ── */

const MEDIA_TTL_S = 60 * 60;
const sign = (payload: string) => createHmac("sha256", `${env.JWT_SECRET}|whatsapp-media`).update(payload).digest("base64url");
function mediaUrl(messageId: string, userId: string): string {
  const e = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  const q = new URLSearchParams({ m: messageId, e: String(e), u: userId, s: sign(`${messageId}.${e}.${userId}`) });
  return `/api/v1/whatsapp/media?${q}`;
}

/** GET /whatsapp/media?m=&e=&u=&s= — a photo or file from a chat, for whoever was given the link. */
router.get("/media", async (req, res, next) => {
  try {
    const m = str(req.query.m, 40), e = str(req.query.e, 20), u = str(req.query.u, 40), s = str(req.query.s, 100);
    if (!isId(m) || !/^\d{9,11}$/.test(e) || !isId(u) || !s) { sendError(res, "Not found", 404); return; }
    if (Number(e) < Date.now() / 1000) { sendError(res, "This link has expired — reopen the chat", 410); return; }
    const want = Buffer.from(sign(`${m}.${e}.${u}`)), got = Buffer.from(s);
    if (want.length !== got.length || !timingSafeEqual(want, got)) { sendError(res, "Not found", 404); return; }
    const doc = await WhatsAppMessage.findById(m).select("media").lean();
    const path = doc?.media?.file ? mediaPath(doc.media.file) : "";
    if (!path || !existsSync(path)) { sendError(res, "Not found", 404); return; }
    const name = String(doc!.media!.fileName || doc!.media!.file.split("/").pop() || "file").replace(/[^\w.\- ]+/g, "_");
    res.setHeader("Content-Type", doc!.media!.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    createReadStream(path).on("error", next).pipe(res);
  } catch (err) { next(err); }
});

type MessageDoc = { _id: Types.ObjectId; direction: string; body?: string; at: Date; senderName?: string; sentByName?: string;
  media?: { type: string; mime: string; fileName: string; size: number; file: string } | null };
const shape = (m: MessageDoc, viewerId: string) => ({
  id: String(m._id),
  direction: m.direction,
  body: m.body ?? "",
  at: m.at,
  senderName: m.senderName ?? "",
  sentByName: m.sentByName ?? "",
  media: m.media ? { type: m.media.type, mime: m.media.mime, fileName: m.media.fileName, size: m.media.size, url: m.media.file ? mediaUrl(String(m._id), viewerId) : "" } : null,
});

async function leadsBrief(ids: unknown[]) {
  const oids = [...new Set(ids.filter(Boolean).map(String))].filter(isId).map((i) => new Types.ObjectId(i));
  if (!oids.length) return new Map<string, { id: string; name: string; status: string; owner: string }>();
  const docs = await Lead.find({ _id: { $in: oids } }).select("name status assignedTo").populate("assignedTo", "name")
    .lean<{ _id: Types.ObjectId; name?: string; status?: string; assignedTo?: { name?: string } | null }[]>();
  return new Map(docs.map((d) => [String(d._id), { id: String(d._id), name: String(d.name ?? "").trim(), status: d.status ?? "", owner: d.assignedTo?.name ?? "" }]));
}

/** The owner asked about (yours by default) — one the viewer may read, or the refusal. */
async function ownerFor(req: AuthenticatedRequest, res: Response, raw: unknown): Promise<string | null> {
  const owner = str(raw, 40) || req.user!.userId;
  if (!isId(owner)) { sendError(res, "Bad ownerId", 400); return null; }
  const owners = await readableOwners(viewer(req));
  if (owners && !owners.has(owner)) { sendError(res, "Only its owner, their team leader, the Sales Manager and a Super Admin read these chats", 403); return null; }
  return owner;
}

router.use(authenticate);

/* ── Linking a WhatsApp ─────────────────────────────────────────────────── */

/**
 * GET /whatsapp/status — your own link (status, number, the QR while linking) and, for a team leader, the Sales
 * Manager or a Super Admin, the people whose chats you can read, with whether each has linked.
 */
router.get("/status", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const v = viewer(req);
    const owners = await readableOwners(v);
    let list: unknown[] = [];
    if (!owners || owners.size > 1) {
      const filter: Record<string, unknown> = { status: { $ne: "inactive" } };
      if (owners) filter._id = { $in: [...owners].map((i) => new Types.ObjectId(i)) };
      const [users, teams, counts] = await Promise.all([
        User.find(filter).select("name email").lean<{ _id: Types.ObjectId; name?: string; email?: string }[]>(),
        Team.find({ status: "active" }).select("name members leaders").lean<{ name?: string; members?: unknown[]; leaders?: unknown[] }[]>(),
        WhatsAppMessage.aggregate<{ _id: Types.ObjectId; n: number }>([{ $group: { _id: "$owner", n: { $sum: 1 } } }]),
      ]);
      const teamOf = new Map<string, string>();
      for (const t of teams) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) if (!teamOf.has(String(u))) teamOf.set(String(u), t.name ?? "");
      const n = new Map(counts.map((c) => [String(c._id), c.n]));
      list = users
        .map((u) => { const st = status(String(u._id)); return { id: String(u._id), name: String(u.name || u.email || ""), team: teamOf.get(String(u._id)) ?? "", status: st.status, phone: st.phone, messages: n.get(String(u._id)) ?? 0 }; })
        // Those with chats or a link first; then by name.
        .sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected") || Number(b.messages > 0) - Number(a.messages > 0) || a.name.localeCompare(b.name));
    }
    const me = await User.findById(v.userId).select("name email").lean<{ name?: string; email?: string } | null>();
    sendSuccess(res, "WhatsApp", { enabled: whatsappEnabled(), canLink: canWhatsApp(v, "create"), me: { id: v.userId, name: String(me?.name || me?.email || ""), ...status(v.userId) }, owners: list });
  } catch (err) { next(err); }
});

/** POST /whatsapp/connect — you start linking your WhatsApp; the QR follows in /status. */
router.post("/connect", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try { await connect(req.user!.userId); sendSuccess(res, "Linking", status(req.user!.userId)); } catch (err) { fail(res, next, err); }
});

/** POST /whatsapp/disconnect — unlinks your WhatsApp from the CRM. Your chats so far stay. */
router.post("/disconnect", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try { await disconnect(req.user!.userId); sendSuccess(res, "Unlinked", status(req.user!.userId)); } catch (err) { fail(res, next, err); }
});

/* ── Chats ──────────────────────────────────────────────────────────────── */

/**
 * GET /whatsapp/chats?ownerId= — one person's chats (yours by default), newest first: who (the lead, else their
 * WhatsApp name), the last message and how many are unread.
 */
router.get("/chats", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.query.ownerId);
    if (!owner) return;
    const rows = await WhatsAppMessage.aggregate<{ _id: string; last: MessageDoc & { phone?: string; key?: string; lead?: Types.ObjectId | null }; count: number; unread: number; name: string }>([
      { $match: { owner: new Types.ObjectId(owner) } },
      // Newest first; two in one second by the order they came in.
      { $sort: { at: -1, _id: -1 } },
      { $group: {
        _id: "$chat", last: { $first: "$$ROOT" }, count: { $sum: 1 },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$read", false] }] }, 1, 0] } },
        name: { $max: { $cond: [{ $eq: ["$direction", "in"] }, "$senderName", ""] } },
      } },
      { $sort: { "last.at": -1 } },
      { $limit: 300 },
    ]);
    const byKey = await leadsByKey();
    const leadOf = (r: (typeof rows)[number]) => byKey.get(r.last.key || r._id) ?? r.last.lead ?? null;
    const leads = await leadsBrief(rows.map(leadOf));
    sendSuccess(res, "Chats", {
      ownerId: owner,
      canSend: owner === req.user!.userId && canWhatsApp(viewer(req), "create") && status(owner).status === "connected",
      chats: rows.map((r) => {
        const lead = leads.get(String(leadOf(r) ?? "")) ?? null;
        return {
          chat: r._id, phone: r.last.phone ?? "",
          name: lead?.name || r.name || (r.last.phone ? `+${r.last.phone}` : "Unknown"),
          whatsappName: r.name || "",
          lead,
          last: { body: r.last.body ?? "", at: r.last.at, direction: r.last.direction, media: r.last.media?.type ?? null },
          unread: r.unread, count: r.count,
        };
      }),
    });
  } catch (err) { next(err); }
});

/** GET /whatsapp/messages?ownerId=&chat= — one chat, oldest first (the last 300). */
router.get("/messages", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.query.ownerId);
    if (!owner) return;
    const chat = str(req.query.chat, 120);
    if (!chat) { sendError(res, "chat is required", 400); return; }
    const docs = (await WhatsAppMessage.find({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).limit(300).lean<MessageDoc[]>()).reverse();
    sendSuccess(res, "Messages", {
      ownerId: owner, chat,
      canSend: owner === req.user!.userId && canWhatsApp(viewer(req), "create") && status(owner).status === "connected",
      messages: docs.map((m) => shape(m, req.user!.userId)),
    });
  } catch (err) { next(err); }
});

/**
 * GET /whatsapp/unread?since= — your own unread WhatsApp: how many, and the messages that came in after `since` (the
 * `now` of your last call), newest first — the menu's count and the pop-ups.
 */
router.get("/unread", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const now = new Date();
    const since = typeof req.query.since === "string" && /^\d{4}-\d{2}-\d{2}T/.test(req.query.since) ? new Date(req.query.since) : null;
    const base = { owner: new Types.ObjectId(req.user!.userId), direction: "in", read: false };
    const unread = await WhatsAppMessage.countDocuments(base);
    // By when the CRM got them (a message can carry an older WhatsApp time).
    const fresh = since ? await WhatsAppMessage.find({ ...base, createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(5)
      .lean<(MessageDoc & { chat: string; phone?: string; key?: string; lead?: Types.ObjectId | null })[]>() : [];
    const byKey = await leadsByKey();
    const leads = await leadsBrief(fresh.map((m) => byKey.get(m.key || m.chat) ?? m.lead));
    sendSuccess(res, "Unread", {
      unread, now,
      messages: fresh.map((m) => ({
        id: String(m._id), chat: m.chat, at: m.at, body: m.body ?? "",
        name: leads.get(String(byKey.get(m.key || m.chat) ?? m.lead ?? ""))?.name || m.senderName || (m.phone ? `+${m.phone}` : "WhatsApp"),
      })),
    });
  } catch (err) { next(err); }
});

/** POST /whatsapp/read { chat } — your own chat only (someone else reading it leaves it unread for you). */
router.post("/read", checkPermission("whatsapp", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const chat = str(req.body?.chat, 120);
    if (!chat) { sendError(res, "chat is required", 400); return; }
    const r = await WhatsAppMessage.updateMany({ owner: new Types.ObjectId(req.user!.userId), chat, direction: "in", read: false }, { $set: { read: true } });
    sendSuccess(res, "Read", { marked: r.modifiedCount });
  } catch (err) { next(err); }
});

/** POST /whatsapp/send { chat, text } — from your own WhatsApp; chat is the number (or a chat's address). */
router.post("/send", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const chat = str(req.body?.chat, 120), text = String(req.body?.text ?? "").trim().slice(0, 4000);
    if (!chat || !text) { sendError(res, "chat and text are required", 400); return; }
    const saved = await sendText(req.user!.userId, chat, text);
    sendSuccess(res, "Sent", { chat: saved?.chat ?? chat });
  } catch (err) { fail(res, next, err); }
});

/** POST /whatsapp/send-file (form: chat, caption, file, voice?) — a photo, video, audio or document, up to 25 MB; voice=1: a voice note. */
router.post("/send-file", checkPermission("whatsapp", "create"), upload.single("file"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
    const chat = str(req.body?.chat, 120), caption = String(req.body?.caption ?? "").trim().slice(0, 1000);
    const voice = String(req.body?.voice ?? "") === "1";
    if (!chat || !file) { sendError(res, "chat and file are required", 400); return; }
    const saved = await sendFile(req.user!.userId, chat, file.buffer, file.mimetype || "application/octet-stream", file.originalname || "file", voice ? "" : caption, voice);
    sendSuccess(res, "Sent", { chat: saved?.chat ?? chat });
  } catch (err) { fail(res, next, err); }
});

/* ── A chat that is no lead's ───────────────────────────────────────────── */

/** The chat's key (its number's last 9 digits, or its address), from its latest message. */
async function chatKey(owner: string, chat: string): Promise<string | null> {
  const last = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).select("key").lean<{ key?: string } | null>();
  return last ? last.key || chat : null;
}

async function linkKey(key: string, leadId: Types.ObjectId, req: AuthenticatedRequest) {
  const me = await User.findById(req.user!.userId).select("name").lean<{ name?: string } | null>();
  await WhatsAppLink.updateOne({ key }, { $set: { key, lead: leadId, by: new Types.ObjectId(req.user!.userId), byName: me?.name ?? "", at: new Date() } }, { upsert: true });
  await WhatsAppMessage.updateMany(/^\d{9}$/.test(key) ? { key } : { chat: key }, { $set: { lead: leadId } });
  forgetLeads();
}

/** GET /whatsapp/lead-options?search= — leads you may link a chat to: by name or number, up to 20. */
router.get("/lead-options", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const q = str(req.query.search, 60);
    const filter: Record<string, unknown> = { ...(await leadScope(viewer(req))) };
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // A number typed any way ("050 123 4567", "+97150…") finds the lead by its last 7 digits, spaces and all.
      const tail = q.replace(/\D/g, "").slice(-7);
      const byPhone = tail.length >= 5 ? [{ phone: { $regex: tail.split("").join("[\\s\\-.()]*") } }] : [];
      filter.$and = [{ $or: [{ name: { $regex: esc, $options: "i" } }, ...byPhone] }];
    }
    const leads = await Lead.find(filter).sort({ updatedAt: -1 }).limit(20).select("name phone status").lean<{ _id: Types.ObjectId; name?: string; phone?: string; status?: string }[]>();
    sendSuccess(res, "Leads", leads.map((l) => ({ id: String(l._id), name: String(l.name ?? "").trim(), phone: l.phone ?? "", status: l.status ?? "" })));
  } catch (err) { next(err); }
});

/**
 * POST /whatsapp/link { ownerId?, chat, leadId } — a number on no lead's record is theirs: the chat, its earlier
 * messages and anything that comes later from that number show under the lead. By whoever reads the chat and may see
 * the lead.
 */
router.post("/link", checkPermission("whatsapp", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.body?.ownerId);
    if (!owner) return;
    const chat = str(req.body?.chat, 120), leadId = str(req.body?.leadId, 40);
    if (!chat || !isId(leadId)) { sendError(res, "chat and leadId are required", 400); return; }
    const lead = await Lead.findOne({ _id: new Types.ObjectId(leadId), ...(await leadScope(viewer(req))) }).select("name").lean<{ _id: Types.ObjectId; name?: string } | null>();
    if (!lead) { sendError(res, "You can link chats only to leads you can see", 403); return; }
    const key = await chatKey(owner, chat);
    if (!key) { sendError(res, "No such chat", 404); return; }
    await linkKey(key, lead._id, req);
    sendSuccess(res, "Linked", { lead: { id: String(lead._id), name: String(lead.name ?? "").trim() } });
  } catch (err) { next(err); }
});

/**
 * POST /whatsapp/create-lead { ownerId?, chat, name? } — a lead made of a chat that is no lead's: its number, the name
 * given (else their WhatsApp name), source WhatsApp, held by the person whose WhatsApp it is. A number that turns out
 * to be a lead after all is linked to it instead.
 */
router.post("/create-lead", checkPermission("whatsapp", "create"), checkPermission("leads", "create"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const owner = await ownerFor(req, res, req.body?.ownerId);
    if (!owner) return;
    const chat = str(req.body?.chat, 120);
    const last = chat ? await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat }).sort({ at: -1, _id: -1 }).select("phone key senderName direction").lean<{ phone?: string; key?: string } | null>() : null;
    if (!last) { sendError(res, "No such chat", 404); return; }
    if (!last.phone) { sendError(res, "WhatsApp didn't give this chat's number — link it to a lead instead", 400); return; }
    const existingId = (await leadsByKey()).get(phoneKey(last.phone));
    const existing = existingId ? await Lead.findById(existingId).select("name").lean<{ _id: Types.ObjectId; name?: string } | null>() : null;
    if (existing) {
      await linkKey(last.key || chat, existing._id, req);
      sendSuccess(res, "Already a lead — linked to it", { lead: { id: String(existing._id), name: String(existing.name ?? "").trim() }, existed: true });
      return;
    }
    const inName = await WhatsAppMessage.findOne({ owner: new Types.ObjectId(owner), chat, direction: "in", senderName: { $gt: "" } }).sort({ at: -1 }).select("senderName").lean<{ senderName?: string } | null>();
    const name = str(req.body?.name, 100) || (inName?.senderName && !/^\d+$/.test(inName.senderName) ? inName.senderName : "") || `WhatsApp +${last.phone}`;
    const lead = await leadService.createLead({ name, phone: `+${last.phone}`, source: "WhatsApp", assignedTo: owner }, req.user!.userId) as unknown as { _id: Types.ObjectId };
    await linkKey(last.key || chat, lead._id, req);
    sendSuccess(res, "Lead created", { lead: { id: String(lead._id), name }, existed: false }, 201);
  } catch (err) { next(err); }
});

/* ── The lead page ──────────────────────────────────────────────────────── */

/**
 * GET /whatsapp/lead/:leadId — the lead's WhatsApp chats you may read (yours with them, and for a team leader, the
 * Sales Manager or a Super Admin their people's), and the numbers on their record, to message them from your own.
 */
router.get("/lead/:leadId", checkPermission("whatsapp", "view"), checkPermission("leads", "view"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const leadId = str(req.params.leadId, 40);
    if (!isId(leadId)) { sendError(res, "Lead not found", 404); return; }
    const lead = await Lead.findById(leadId).select("phone").lean<{ phone?: string } | null>();
    if (!lead) { sendError(res, "Lead not found", 404); return; }
    const v = viewer(req);
    const owners = await readableOwners(v);
    const linked = (await WhatsAppLink.find({ lead: new Types.ObjectId(leadId) }).select("key").lean()).map((l) => l.key);
    const filter: Record<string, unknown> = { $or: [{ key: { $in: [...phoneKeys(lead.phone), ...linked] } }, { chat: { $in: linked } }, { lead: new Types.ObjectId(leadId) }] };
    if (owners) filter.owner = { $in: [...owners].map((i) => new Types.ObjectId(i)) };
    const docs = (await WhatsAppMessage.find(filter).sort({ at: -1, _id: -1 }).limit(400).lean<(MessageDoc & { owner: Types.ObjectId; ownerName?: string; chat: string; phone?: string })[]>()).reverse();
    const threads = new Map<string, { ownerId: string; ownerName: string; chat: string; phone: string; messages: ReturnType<typeof shape>[] }>();
    for (const m of docs) {
      const k = `${m.owner}|${m.chat}`;
      if (!threads.has(k)) threads.set(k, { ownerId: String(m.owner), ownerName: m.ownerName ?? "", chat: m.chat, phone: m.phone ?? "", messages: [] });
      threads.get(k)!.messages.push(shape(m, v.userId));
    }
    const mine = status(v.userId);
    const canLink = canWhatsApp(v, "create");
    sendSuccess(res, "WhatsApp", {
      numbers: intlNumbers(lead.phone),
      canSend: canLink && mine.status === "connected",
      canLink,
      linked: mine.status === "connected",
      me: v.userId,
      threads: [...threads.values()].sort((a, b) => Number(b.ownerId === v.userId) - Number(a.ownerId === v.userId)),
    });
  } catch (err) { next(err); }
});

export default router;
