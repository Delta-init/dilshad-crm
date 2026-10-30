import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { Types } from "mongoose";
import { Lead } from "../../models/Lead.js";
import { Team } from "../../models/Team.js";
import { User } from "../../models/User.js";
import { WhatsAppLink, WhatsAppMessage } from "../../models/WhatsAppMessage.js";
import { WhatsAppFollowupSettings, type IFirstReplyItem, type IFollowupStep, type IWhatsAppFollowupSettings } from "../../models/WhatsAppFollowupSettings.js";
import { getAppSettings, isWithinWorkingHours } from "../settingsService.js";
import { isStudentKey, studentKeys } from "./chatExtras.js";
import { phoneKeys } from "./leads.js";
import { connectedOwnerIds, contactNames, isAudioOnlyMp4, isConnected, leadsByKey, mediaPath, sendFile, sendText, whatsappEnabled, WhatsAppError } from "./service.js";

/* ────────────────────────────────────────────────────────────────────────────
   Automatic WhatsApp follow-ups (the user, 2026-10-27: "this type of follow-up
   thing we need in our CRMs — first in the Sales CRM", after loop2.ai's).

   A lead someone wrote to on WhatsApp and who has not answered is followed up
   from that person's own linked WhatsApp: step 1 a while after the last message,
   step 2 a while after step 1, and so on — by default 4 hours, 1 day, 3 days,
   7 days and 14 days, the last saying it is the last. Each step's text (and a
   file, if it has one) is the Super Admin's, with {name} and {salesperson}.

   It stops when the lead answers, when they are Closed, Lost or Repeated, or when
   someone presses Stop on the lead; a message a person writes to them starts it
   again from step 1. Only for the lead's own salesperson, on the teams switched
   on, inside the working hours (Settings → working hours), and only for chats a
   person wrote in after it was switched on.

   Gently, for the WhatsApp number's sake: one automatic message per person every
   1–2 minutes at most, and no more than the daily limit each (Dubai days).
   Nothing is sent while their WhatsApp is not linked here.

   The chain is never stored: it is read from the chat itself — the messages
   after the last one a person sent, each automatic one marked with its step.

   The first reply (2026-10-28: "two audios, a link and the brochure as the first
   message when a client messages first"): someone's first message ever to a
   linked WhatsApp of a team switched on is noted (whatsapp_first_contacts); a
   minute on, unless a person has answered, the Super Admin's items go out in
   order a few seconds apart — words, files, audio as voice notes — at any hour.
   They count as our message: if the client then goes quiet, the follow-ups
   start from them.
──────────────────────────────────────────────────────────────────────────── */

const MIN = 60_000;
export const DEFAULT_STEPS: IFollowupStep[] = [
  { waitMinutes: 4 * 60, text: "Hi {name}, just checking you saw my message. Happy to answer any questions about the course. — {salesperson}", file: null },
  { waitMinutes: 24 * 60, text: "Hi {name}, would a quick call help? Tell me a time that suits you and I'll call you.", file: null },
  { waitMinutes: 3 * 24 * 60, text: "Hi {name}, if it helps I can share the course details, or arrange a free session with one of our mentors.", file: null },
  { waitMinutes: 7 * 24 * 60, text: "Hi {name}, just following up — are you still interested in learning trading with Delta?", file: null },
  { waitMinutes: 14 * 24 * 60, text: "Hi {name}, this will be my last follow-up. Maybe now isn't the right time — whenever you're ready, just message me here. — {salesperson}", file: null },
];
/** Leads in these never get one. */
const ENDED = new Set(["closed", "lost", "repeated"]);
/** How far back a chat may have gone quiet and still be followed up: the whole default chain and then some. */
const LOOK_BACK_DAYS = 45;
const DEFAULT_DAILY_LIMIT = 60;

/* ── Settings ───────────────────────────────────────────────────────────── */

export type FollowupSettings = Pick<IWhatsAppFollowupSettings, "enabled" | "startedAt" | "dailyLimit" | "steps" | "updatedByName" | "firstReply"> & { teams: string[]; updatedAt: Date | null };

/**
 * A file's type as it really is: one uploaded as an MP4 before sound-only MP4s were told apart ("AUDIO-….m4a.mp4",
 * 2026-10-28) is audio — read from the file once, then remembered (a kept file never changes).
 */
const soundOnly = new Map<string, boolean>();
function realFile<T extends { file: string; mime: string } | null>(f: T): T {
  if (!f || !/^video\/mp4$/i.test(f.mime)) return f;
  let audio = soundOnly.get(f.file);
  if (audio === undefined) {
    try { audio = existsSync(mediaPath(f.file)) && isAudioOnlyMp4(readFileSync(mediaPath(f.file))); } catch { audio = false; }
    soundOnly.set(f.file, audio);
  }
  return audio ? { ...f, mime: "audio/mp4" } : f;
}

let cache: { at: number; value: FollowupSettings } | null = null;
export async function followupSettings(fresh = false): Promise<FollowupSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  const doc = await WhatsAppFollowupSettings.findOne({ key: "default" }).lean();
  const value: FollowupSettings = {
    enabled: doc?.enabled ?? false,
    startedAt: doc?.startedAt ?? null,
    teams: (doc?.teams ?? []).map(String),
    dailyLimit: doc?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    steps: doc?.steps?.length ? doc.steps.map((s) => ({ waitMinutes: s.waitMinutes, text: s.text, file: realFile(s.file ?? null) })) : DEFAULT_STEPS,
    updatedByName: doc?.updatedByName ?? "",
    updatedAt: doc?.updatedAt ?? null,
    firstReply: {
      enabled: doc?.firstReply?.enabled ?? false,
      startedAt: doc?.firstReply?.startedAt ?? null,
      items: (doc?.firstReply?.items ?? []).map((i) => ({ text: i.text ?? "", file: realFile(i.file ?? null), voice: i.voice === true })),
    },
  };
  cache = { at: Date.now(), value };
  return value;
}

export class FollowupError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

/** A Super Admin's change, checked: 1–8 steps, each 30 minutes to 60 days after the one before, with words; a limit of 1–300. */
export async function saveFollowupSettings(input: Record<string, unknown>, byName: string): Promise<FollowupSettings> {
  const before = await followupSettings(true);
  const raw = Array.isArray(input.steps) ? input.steps : null;
  if (!raw || raw.length < 1 || raw.length > 8) throw new FollowupError("Between 1 and 8 steps");
  const steps: IFollowupStep[] = raw.map((s, i) => {
    const r = (s ?? {}) as Record<string, unknown>;
    const wait = Math.round(Number(r.waitMinutes));
    if (!Number.isFinite(wait) || wait < 30 || wait > 60 * 24 * 60) throw new FollowupError(`Step ${i + 1}: wait between 30 minutes and 60 days`);
    const text = String(r.text ?? "").trim().slice(0, 1000);
    if (!text) throw new FollowupError(`Step ${i + 1}: write its message`);
    const f = r.file as Record<string, unknown> | null | undefined;
    const file = f && typeof f.file === "string" && /^followups\/[\w-]+\.\w{1,10}$/.test(f.file)
      ? { file: f.file, name: String(f.name ?? "").slice(0, 200), mime: String(f.mime ?? "").slice(0, 100), size: Number(f.size) || 0 }
      : null;
    return { waitMinutes: wait, text, file };
  });
  const limit = Math.round(Number(input.dailyLimit ?? DEFAULT_DAILY_LIMIT));
  if (!Number.isFinite(limit) || limit < 1 || limit > 300) throw new FollowupError("The daily limit is 1 to 300 messages");
  const teamIds = [...new Set((Array.isArray(input.teams) ? input.teams : []).map(String))].filter((t) => /^[a-f0-9]{24}$/.test(t));
  const known = await Team.countDocuments({ _id: { $in: teamIds.map((t) => new Types.ObjectId(t)) } });
  if (known !== teamIds.length) throw new FollowupError("One of those teams isn't here");
  const enabled = input.enabled === true;
  // The first reply: kept as it was by a screen that doesn't send it.
  const fr = input.firstReply as Record<string, unknown> | undefined;
  let firstReply = before.firstReply;
  if (fr && typeof fr === "object") {
    const raw = Array.isArray(fr.items) ? fr.items : [];
    if (raw.length > 6) throw new FollowupError("The first reply has at most 6 parts");
    const items: IFirstReplyItem[] = raw.map((x, i) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const f = r.file as Record<string, unknown> | null | undefined;
      const file = f && typeof f.file === "string" && /^followups\/[\w-]+\.\w{1,10}$/.test(f.file)
        ? { file: f.file, name: String(f.name ?? "").slice(0, 200), mime: String(f.mime ?? "").slice(0, 100), size: Number(f.size) || 0 }
        : null;
      const text = String(r.text ?? "").trim().slice(0, 1000);
      if (!text && !file) throw new FollowupError(`First reply part ${i + 1}: words or a file`);
      // A voice note only from Opus (Ogg / WebM); any other audio — an M4A, an MP3 — goes as ordinary audio.
      return { text, file, voice: !!file && /^audio\/(ogg|webm)/.test(file.mime) && r.voice !== false };
    });
    const on = fr.enabled === true;
    if (on && !items.length) throw new FollowupError("Add what the first reply sends, or switch it off");
    firstReply = { enabled: on, items, startedAt: on && !before.firstReply.enabled ? new Date() : on ? before.firstReply.startedAt : null };
  }
  await WhatsAppFollowupSettings.updateOne({ key: "default" }, {
    $set: {
      key: "default", enabled, steps, dailyLimit: limit, teams: teamIds.map((t) => new Types.ObjectId(t)), updatedByName: byName, firstReply,
      // Switched on now: only chats written in from now on.
      ...(enabled && !before.enabled ? { startedAt: new Date() } : {}),
    },
  }, { upsert: true });
  cache = null;
  return followupSettings(true);
}

/* ── One chat's chain, read from its messages ───────────────────────────── */

type Msg = { _id: Types.ObjectId; direction: "in" | "out"; at: Date; chat: string; auto?: { kind?: string; step: number } | null; history?: boolean };

export type ChainState =
  | { state: "replied" }                        // their message is the last: nothing to follow up
  | { state: "before" }                         // a person last wrote before follow-ups were switched on
  | { state: "stopped"; byName: string }
  | { state: "done"; sent: number }             // every step sent
  | { state: "waiting"; step: number; of: number; dueAt: Date; chat: string };

/** Where a chat stands: newest first, the automatic messages since the last one a person sent, and what comes next. */
export function chainOf(newestFirst: Msg[], settings: FollowupSettings, stopped: { at: Date | null; byName: string }): ChainState | null {
  const last = newestFirst[0];
  if (!last) return null;
  if (last.direction === "in") return { state: "replied" };
  let sent = 0;
  let anchor: Msg | null = null;
  for (const m of newestFirst) {
    // An automatic first reply is our message like one a person writes: the follow-ups count from it.
    if (m.direction === "out" && m.auto && m.auto.kind !== "first_reply") { sent++; continue; }
    if (m.direction === "in") return { state: "replied" };   // can't be: nothing goes after an answer on its own
    anchor = m;
    break;
  }
  if (!anchor) return null;   // only automatic messages kept (an older chat cut off): leave it be
  // A past chat brought in at linking never starts one.
  if (!settings.startedAt || anchor.at < settings.startedAt || anchor.history) return { state: "before" };
  if (stopped.at && stopped.at >= anchor.at) return { state: "stopped", byName: stopped.byName };
  if (sent >= settings.steps.length) return { state: "done", sent };
  return { state: "waiting", step: sent + 1, of: settings.steps.length, dueAt: new Date(last.at.getTime() + settings.steps[sent]!.waitMinutes * MIN), chat: last.chat };
}

const recent = (owner: Types.ObjectId | string, key: string) =>
  WhatsAppMessage.find({ owner: new Types.ObjectId(String(owner)), key }).sort({ at: -1, _id: -1 }).limit(40).select("direction at chat auto history").lean<Msg[]>();

/** The first working moment at or after `at` (in 15-minute steps, a week and a day at most). */
async function nextWorkingMoment(at: Date): Promise<Date> {
  const app = await getAppSettings();
  let t = at.getTime();
  for (let i = 0; i < 8 * 24 * 4; i++, t += 15 * MIN) if (isWithinWorkingHours(app, new Date(t))) return new Date(t);
  return at;
}

const firstName = (v: unknown) => String(v ?? "").trim().split(/\s+/)[0] ?? "";
/** {name} — the lead's first name (or "there"); {salesperson} — the sender's. */
export const fillText = (text: string, leadName: unknown, ownerName: unknown) =>
  text.replace(/\{name\}/g, firstName(leadName) || "there").replace(/\{salesperson\}/g, firstName(ownerName) || "the Delta team");

/* ── The lead page: where its follow-ups stand ──────────────────────────── */

export type LeadFollowup = {
  on: boolean;                 // switched on for this lead's team
  state: "off" | "ended" | "student" | "no_chat" | ChainState["state"];
  step?: number; of?: number; nextAt?: string; sent?: number; byName?: string;
  ownerName?: string; linked?: boolean;
};

export async function leadFollowup(leadId: string): Promise<LeadFollowup> {
  const settings = await followupSettings();
  const lead = await Lead.findById(leadId).select("phone status team assignedTo waFollowupStoppedAt waFollowupStoppedByName")
    .lean<{ phone?: string; status?: string; team?: Types.ObjectId | null; assignedTo?: Types.ObjectId | null; waFollowupStoppedAt?: Date | null; waFollowupStoppedByName?: string } | null>();
  if (!lead) return { on: false, state: "off" };
  const on = settings.enabled && !!lead.team && settings.teams.includes(String(lead.team));
  if (!on) return { on, state: "off" };
  if (ENDED.has(String(lead.status))) return { on, state: "ended" };
  // A student — marked so in a chat, or enrolled — gets none (2026-10-30).
  if ((await studentKeys(phoneKeys(lead.phone))).size) return { on, state: "student" };
  if (!lead.assignedTo) return { on, state: "no_chat" };
  const owner = await User.findById(lead.assignedTo).select("name").lean<{ name?: string } | null>();
  const linked = (await WhatsAppLink.find({ lead: new Types.ObjectId(leadId) }).select("key").lean()).map((l) => l.key).filter((k) => /^\d{9}$/.test(k));
  // The chat with the latest message, of the lead's numbers.
  let best: Msg[] = [];
  for (const key of new Set([...phoneKeys(lead.phone), ...linked])) {
    const msgs = await recent(lead.assignedTo, key);
    if (msgs[0] && (!best[0] || msgs[0].at > best[0].at)) best = msgs;
  }
  const base = { on, ownerName: String(owner?.name ?? ""), linked: isConnected(String(lead.assignedTo)) };
  const chain = chainOf(best, settings, { at: lead.waFollowupStoppedAt ?? null, byName: lead.waFollowupStoppedByName ?? "" });
  if (!chain) return { ...base, state: "no_chat" };
  if (chain.state === "waiting") return { ...base, state: "waiting", step: chain.step, of: chain.of, nextAt: (await nextWorkingMoment(chain.dueAt)).toISOString() };
  if (chain.state === "done") return { ...base, state: "done", sent: chain.sent };
  if (chain.state === "stopped") return { ...base, state: "stopped", byName: chain.byName };
  return { ...base, state: chain.state };
}

/** Stop the follow-ups on a lead (until someone writes to them again), or let them go on. */
export async function setLeadFollowupStopped(leadId: string, stop: boolean, byName: string) {
  await Lead.updateOne({ _id: new Types.ObjectId(leadId) }, { $set: stop
    ? { waFollowupStoppedAt: new Date(), waFollowupStoppedByName: byName }
    : { waFollowupStoppedAt: null, waFollowupStoppedByName: "" } });
}

/* ── The job ────────────────────────────────────────────────────────────── */

const nextSendAt = new Map<string, number>();      // owner → not before (the 1–2 minute gap)
const failedUntil = new Map<string, number>();     // owner|key|step → don't try again before
const gapMs = () => MIN + Math.floor(Math.random() * MIN);
const RETRY_FAILED_MS = 6 * 60 * MIN;

export type RunResult = { ok: boolean; sent: number; skipped?: string; failed?: number };
let running = false;

/** One look: every chat a step is due in, oldest due first, at most one per person — and sent. */
export async function runFollowups(now = new Date()): Promise<RunResult> {
  if (running) return { ok: false, sent: 0, skipped: "a run is already going" };
  running = true;
  try {
    const settings = await followupSettings(true);
    if (!settings.enabled || !settings.teams.length || !settings.startedAt) return { ok: true, sent: 0, skipped: "off" };
    if (!isWithinWorkingHours(await getAppSettings(), now)) return { ok: true, sent: 0, skipped: "outside working hours" };

    const since = new Date(Math.max(settings.startedAt.getTime(), now.getTime() - LOOK_BACK_DAYS * 24 * 60 * MIN));
    // Each chat's latest message (by number), where it is ours: theirs is an answer, and nothing is due.
    const lasts = await WhatsAppMessage.aggregate<{ _id: { owner: Types.ObjectId; key: string }; direction: string }>([
      { $match: { at: { $gte: since }, key: { $gt: "" } } },
      { $sort: { at: -1, _id: -1 } },
      { $group: { _id: { owner: "$owner", key: "$key" }, direction: { $first: "$direction" } } },
      { $match: { direction: "out" } },
    ]);
    const connectedLive = lasts.filter((c) => isConnected(String(c._id.owner)));
    // Never to a student — marked so in a chat, or enrolled (2026-10-30).
    const students = await studentKeys(connectedLive.map((c) => c._id.key));
    const live = connectedLive.filter((c) => !students.has(c._id.key));
    if (!live.length) return { ok: true, sent: 0 };

    const byKey = await leadsByKey();
    const leadIds = [...new Set(live.map((c) => byKey.get(c._id.key)).filter(Boolean).map(String))];
    const leads = new Map((await Lead.find({ _id: { $in: leadIds.map((i) => new Types.ObjectId(i)) } })
      .select("name status team assignedTo waFollowupStoppedAt waFollowupStoppedByName")
      .lean<{ _id: Types.ObjectId; name?: string; status?: string; team?: Types.ObjectId | null; assignedTo?: Types.ObjectId | null; waFollowupStoppedAt?: Date | null; waFollowupStoppedByName?: string }[]>())
      .map((l) => [String(l._id), l]));

    type Due = { owner: string; key: string; lead: NonNullable<ReturnType<typeof leads.get>>; chain: Extract<ChainState, { state: "waiting" }> };
    const due: Due[] = [];
    for (const c of live) {
      const owner = String(c._id.owner);
      const lead = leads.get(String(byKey.get(c._id.key) ?? ""));
      // The lead's own salesperson, on a team switched on, and not over.
      if (!lead || String(lead.assignedTo ?? "") !== owner || !lead.team || !settings.teams.includes(String(lead.team)) || ENDED.has(String(lead.status))) continue;
      const chain = chainOf(await recent(owner, c._id.key), settings, { at: lead.waFollowupStoppedAt ?? null, byName: lead.waFollowupStoppedByName ?? "" });
      if (chain?.state !== "waiting" || chain.dueAt > now) continue;
      if ((failedUntil.get(`${owner}|${c._id.key}|${chain.step}`) ?? 0) > now.getTime()) continue;
      due.push({ owner, key: c._id.key, lead, chain });
    }
    due.sort((a, b) => a.chain.dueAt.getTime() - b.chain.dueAt.getTime());

    // Today in Dubai (UTC+4, no summer time) — the daily limit's day.
    const dayStart = new Date(Math.floor((now.getTime() + 4 * 60 * MIN) / (24 * 60 * MIN)) * 24 * 60 * MIN - 4 * 60 * MIN);
    const done = new Set<string>();
    let sent = 0, failed = 0;
    for (const d of due) {
      if (done.has(d.owner) || (nextSendAt.get(d.owner) ?? 0) > now.getTime()) continue;
      const today = await WhatsAppMessage.countDocuments({ owner: new Types.ObjectId(d.owner), "auto.kind": "followup", at: { $gte: dayStart } });
      if (today >= settings.dailyLimit) { done.add(d.owner); continue; }
      done.add(d.owner);
      nextSendAt.set(d.owner, now.getTime() + gapMs());
      const step = settings.steps[d.chain.step - 1]!;
      const ownerDoc = await User.findById(d.owner).select("name").lean<{ name?: string } | null>();
      const text = fillText(step.text, d.lead.name, ownerDoc?.name);
      const auto = { kind: "followup" as const, step: d.chain.step, of: d.chain.of };
      try {
        if (step.file && existsSync(mediaPath(step.file.file))) {
          const buffer = await readFile(mediaPath(step.file.file));
          await sendFile(d.owner, d.chain.chat, buffer, step.file.mime || "application/octet-stream", step.file.name || "file", text, false, { auto, storedFile: step.file.file });
        } else {
          await sendText(d.owner, d.chain.chat, text, { auto });
        }
        sent++;
        await Lead.updateOne({ _id: d.lead._id }, { $push: { activityLogs: {
          action: "whatsapp_followup",
          description: `WhatsApp follow-up ${d.chain.step} of ${d.chain.of} sent automatically from ${ownerDoc?.name ?? "their"} WhatsApp`,
          createdAt: new Date(),
        } } });
      } catch (err) {
        failed++;
        failedUntil.set(`${d.owner}|${d.key}|${d.chain.step}`, now.getTime() + RETRY_FAILED_MS);
        console.warn(`[whatsapp follow-ups] step ${d.chain.step} to ${d.lead.name ?? d.key} not sent`, err instanceof Error ? err.message : err);
      }
    }
    return { ok: true, sent, failed };
  } finally {
    running = false;
  }
}

/* ── The first reply ────────────────────────────────────────────────────── */

const FIRST = "whatsapp_first_contacts";
export const FIRST_REPLY_AFTER_MS = MIN;
/** How long a first message waits for its sender's WhatsApp to be linked again before it is let go. */
const FIRST_REPLY_WAIT_LINK_MS = 30 * MIN;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let firstRunning = false;

/** A first message noted more than this after it was sent is a catch-up, not someone writing in now. */
const FIRST_REPLY_CATCH_UP_MS = 5 * MIN;

/**
 * One look at the first messages noted: a minute on, the first reply goes — unless a person answered, it's off, the
 * owner isn't on a team switched on, or it came before the first reply was switched on. `gapMs`: between its parts.
 *
 * Quick (2026-10-28 — first replies were coming many minutes late): only messages of people whose WhatsApp is linked
 * are taken, so ones waiting for someone to relink never fill the batch; each person's are sent alongside everyone
 * else's rather than one after another; and anything that can no longer be a first reply in time is let go first —
 * waited 30 minutes, or a catch-up from earlier that was queued as new.
 */
export async function runFirstReplies(now = new Date(), gapMs = () => 3000 + Math.floor(Math.random() * 2000)): Promise<{ sent: number; skipped: number }> {
  if (firstRunning) return { sent: 0, skipped: 0 };
  firstRunning = true;
  const col = WhatsAppMessage.db.collection(FIRST);
  let sent = 0, skipped = 0;
  try {
    const linked = connectedOwnerIds().map((id) => new Types.ObjectId(id));
    const tooOld = new Date(now.getTime() - FIRST_REPLY_WAIT_LINK_MS);
    // Let go first, so they never stand in front of a real one: too late now…
    skipped += (await col.updateMany({ status: "waiting", at: { $lt: tooOld }, owner: { $nin: linked } }, { $set: { status: "not_linked", decidedAt: now } })).modifiedCount;
    skipped += (await col.updateMany({ status: "waiting", at: { $lt: tooOld } }, { $set: { status: "too_late", decidedAt: now } })).modifiedCount;
    // …and a catch-up from earlier, noted as new (before only fresh ones were noted).
    skipped += (await col.updateMany(
      { status: "waiting", $expr: { $gt: [{ $subtract: [{ $ifNull: ["$createdAt", "$at"] }, "$at"] }, FIRST_REPLY_CATCH_UP_MS] } },
      { $set: { status: "catch_up", decidedAt: now } },
    )).modifiedCount;
    if (!linked.length) return { sent, skipped };

    const settings = await followupSettings(true);
    const fr = settings.firstReply;
    const due = (await col.find({ status: "waiting", owner: { $in: linked }, at: { $lte: new Date(now.getTime() - FIRST_REPLY_AFTER_MS) } }).sort({ at: 1 }).limit(200).toArray()) as unknown as
      { _id: string; owner: Types.ObjectId; key: string; chat: string; at: Date; createdAt?: Date }[];

    const one = async (d: (typeof due)[number]) => {
      const close = async (status: string) => { await col.updateOne({ _id: d._id as never }, { $set: { status, decidedAt: now } }); skipped++; };
      // Before it was switched on — by when it reached the CRM (WhatsApp's own times are whole seconds).
      if (!fr.enabled || !fr.items.length || !fr.startedAt || (d.createdAt ?? d.at) < fr.startedAt) { await close("off"); return; }
      const onTeam = await Team.countDocuments({ _id: { $in: settings.teams.map((t) => new Types.ObjectId(t)) }, status: "active", $or: [{ members: d.owner }, { leaders: d.owner }] });
      if (!onTeam) { await close("not_on_team"); return; }
      const answered = await WhatsAppMessage.countDocuments({ owner: d.owner, key: d.key, direction: "out", at: { $gte: d.at } });
      if (answered) { await close("answered"); return; }
      // Not to a student, nor to a lead already closed, lost or a repeat (2026-10-30).
      if (await isStudentKey(d.key)) { await close("student"); return; }
      const leadNow = (await leadsByKey()).get(d.key);
      if (leadNow && ENDED.has(String((await Lead.findById(leadNow).select("status").lean<{ status?: string } | null>())?.status))) { await close("ended"); return; }
      const owner = String(d.owner);
      if (!isConnected(owner)) return;   // unlinked a moment ago: looked at again next time
      // Taken first: another process (or run) doesn't send it twice.
      const claim = await col.updateOne({ _id: d._id as never, status: "waiting" }, { $set: { status: "sending", decidedAt: now } });
      if (claim.modifiedCount !== 1) return;
      const lead = (await leadsByKey()).get(d.key) ?? null;
      const leadDoc = lead ? await Lead.findById(lead).select("name").lean<{ name?: string } | null>() : null;
      const ownerDoc = await User.findById(owner).select("name").lean<{ name?: string } | null>();
      // {name}: the lead's, else theirs as saved in the phone or on WhatsApp — a first message is often from no lead yet.
      const theirName = leadDoc?.name || (await contactNames(owner, [d.key])).get(d.key) || "";
      let parts = 0;
      try {
        for (const [i, item] of fr.items.entries()) {
          if (i > 0) await sleep(gapMs());
          const auto = { kind: "first_reply" as const, step: i + 1, of: fr.items.length };
          const text = fillText(item.text, theirName, ownerDoc?.name);
          if (item.file && existsSync(mediaPath(item.file.file))) {
            const buffer = await readFile(mediaPath(item.file.file));
            await sendFile(owner, d.chat, buffer, item.file.mime || "application/octet-stream", item.file.name || "file", item.voice ? "" : text, item.voice, { auto, storedFile: item.file.file });
            // A voice note carries no words: they follow on their own.
            if (item.voice && text) await sendText(owner, d.chat, text, { auto });
          } else if (text) {
            await sendText(owner, d.chat, text, { auto });
          }
          parts++;
        }
        await col.updateOne({ _id: d._id as never }, { $set: { status: "sent", parts, sentAt: new Date() } });
        sent++;
        if (lead) await Lead.updateOne({ _id: lead }, { $push: { activityLogs: { action: "whatsapp_followup", description: `WhatsApp first reply sent automatically from ${ownerDoc?.name ?? "their"} WhatsApp (${parts} part${parts === 1 ? "" : "s"})`, createdAt: new Date() } } });
      } catch (err) {
        await col.updateOne({ _id: d._id as never }, { $set: { status: "failed", parts, error: err instanceof Error ? err.message : String(err) } });
        console.warn(`[whatsapp first reply] to ${d.chat} stopped after ${parts} part(s)`, err instanceof Error ? err.message : err);
      }
    };

    // Each person's one after another (their WhatsApp sends one at a time); everyone's alongside each other.
    const byOwner = new Map<string, typeof due>();
    for (const d of due) byOwner.set(String(d.owner), [...(byOwner.get(String(d.owner)) ?? []), d]);
    await Promise.all([...byOwner.values()].map(async (list) => {
      for (const d of list) await one(d).catch((err) => console.error("[whatsapp first reply] not decided", err));
    }));
    return { sent, skipped };
  } finally {
    firstRunning = false;
  }
}

/** Every minute, in the process that holds the WhatsApp links — does nothing until switched on. */
export function startWhatsAppFollowups(): void {
  if (!whatsappEnabled()) return;
  const tick = async () => {
    const r = await runFollowups().catch((err) => ({ ok: false, sent: 0, skipped: String(err) }) as RunResult);
    if (r.sent || r.failed) console.log(`[whatsapp follow-ups] ${r.sent} sent${r.failed ? `, ${r.failed} not sent` : ""}`);
    else if (!r.ok && r.skipped !== "a run is already going") console.error(`[whatsapp follow-ups] not run: ${r.skipped}`);
  };
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), MIN);
  // The first reply, every 15 seconds — it is meant to come a minute after their message.
  const first = async () => {
    const r = await runFirstReplies().catch((err) => { console.error("[whatsapp first reply] not run", err); return { sent: 0, skipped: 0 }; });
    if (r.sent) console.log(`[whatsapp first reply] ${r.sent} sent`);
  };
  setInterval(() => void first(), 15_000);
}

/** For the check only: forget the gaps and the failures, as a fresh process would. */
export function resetFollowupPacingForCheck(): void {
  nextSendAt.clear();
  failedUntil.clear();
  cache = null;
  firstRunning = false;
}

/* ── The saved messages, sent by hand ───────────────────────────────────── */

/** One of the Super Admin's saved messages, as the chat's picker lists it. */
export type SavedMessage = {
  id: string;                                   // "first_reply:1", "followup:3"
  kind: "first_reply" | "followup";
  step: number;
  label: string;                                // "First reply · part 1 of 2", "Follow-up 3 of 5 · after 3 days"
  text: string;                                 // as written, {name}/{salesperson} unfilled
  file: { name: string; mime: string } | null;
  voice: boolean;
};

const afterWait = (minutes: number) =>
  minutes % (24 * 60) === 0 ? `${minutes / (24 * 60)} day${minutes === 24 * 60 ? "" : "s"}`
    : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} min`;

/**
 * Every saved message — the first reply's parts and the follow-up steps — for a person to pick and send now (the
 * owner, 2026-10-28: "the first message and the follow-up messages … we can select and send"). Whether the automatic
 * ones are switched on makes no difference here.
 */
export async function listSavedMessages(): Promise<SavedMessage[]> {
  const s = await followupSettings();
  const first = s.firstReply?.items ?? [];
  return [
    ...first.map((it, i) => ({
      id: `first_reply:${i + 1}`, kind: "first_reply" as const, step: i + 1,
      label: first.length > 1 ? `First reply · part ${i + 1} of ${first.length}` : "First reply",
      text: it.text ?? "", file: it.file ? { name: it.file.name, mime: it.file.mime } : null, voice: !!it.voice,
    })),
    ...s.steps.map((st, i) => ({
      id: `followup:${i + 1}`, kind: "followup" as const, step: i + 1,
      label: `Follow-up ${i + 1} of ${s.steps.length} · after ${afterWait(st.waitMinutes)}`,
      text: st.text, file: st.file ? { name: st.file.name, mime: st.file.mime } : null, voice: false,
    })),
  ].filter((m) => m.text.trim() || m.file);
}

/**
 * A saved message sent now from this person's WhatsApp to this chat, {name} and {salesperson} filled in — one part
 * ("first_reply:2", "followup:3"), or the whole first reply ("first_reply:all": every part in order, a few seconds
 * apart, as the automatic one goes). Their own message (marked with which saved one it was), not an automatic one:
 * the automatic steps carry on as if they had typed it.
 */
export async function sendSavedMessage(userId: string, chat: string, id: string, gapMs = () => 3000 + Math.floor(Math.random() * 2000)): Promise<{ parts: number }> {
  const [kind, stepRaw] = id.split(":");
  const s = await followupSettings();
  const owner = await User.findById(userId).select("name").lean<{ name?: string } | null>();
  // {name}: the lead's, else theirs as saved in the phone or on WhatsApp.
  const key = phoneKeys(chat)[0] ?? "";
  const leadId = key ? (await leadsByKey()).get(key) : undefined;
  const lead = leadId ? await Lead.findById(leadId).select("name").lean<{ name?: string } | null>() : null;
  const theirName = lead?.name || (key ? (await contactNames(userId, [key])).get(key) : "") || "";

  /** One part; how many messages it took (a voice note with words is two), 0 when it had nothing left to send. */
  const one = async (item: { text?: string; file?: { file: string; name: string; mime: string } | null; voice?: boolean }, saved: { kind: "first_reply" | "followup"; step: number }) => {
    const text = fillText(item.text ?? "", theirName, owner?.name);
    const voice = !!item.voice;
    if (item.file && existsSync(mediaPath(item.file.file))) {
      const buffer = await readFile(mediaPath(item.file.file));
      await sendFile(userId, chat, buffer, item.file.mime || "application/octet-stream", item.file.name || "file", voice ? "" : text, voice,
        { saved, ...(voice ? {} : { storedFile: item.file.file }) });
      // A voice note carries no words: they follow on their own.
      if (voice && text.trim()) { await sendText(userId, chat, text, { saved }); return 2; }
      return 1;
    }
    if (!text.trim()) return 0;
    await sendText(userId, chat, text, { saved });
    return 1;
  };

  if (kind === "first_reply" && stepRaw === "all") {
    const items = s.firstReply?.items ?? [];
    if (!items.length) throw new WhatsAppError("There is no first reply saved yet", 404);
    let parts = 0;
    for (const [i, item] of items.entries()) {
      if (parts > 0) await sleep(gapMs());
      parts += await one(item, { kind: "first_reply", step: i + 1 });
    }
    if (!parts) throw new WhatsAppError("The first reply's files are no longer kept here", 410);
    return { parts };
  }

  const step = Number(stepRaw);
  const item = kind === "first_reply" ? s.firstReply?.items?.[step - 1]
    : kind === "followup" ? s.steps[step - 1] : undefined;
  if (!item || !Number.isInteger(step)) throw new WhatsAppError("That saved message is not there any more — reopen the list", 404);
  const parts = await one(item, { kind: kind as "first_reply" | "followup", step });
  if (!parts) throw new WhatsAppError("That saved message's file is no longer kept here", 410);
  return { parts };
}
