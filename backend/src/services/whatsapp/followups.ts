import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Types } from "mongoose";
import { Lead } from "../../models/Lead.js";
import { Team } from "../../models/Team.js";
import { User } from "../../models/User.js";
import { WhatsAppLink, WhatsAppMessage } from "../../models/WhatsAppMessage.js";
import { WhatsAppFollowupSettings, type IFollowupStep, type IWhatsAppFollowupSettings } from "../../models/WhatsAppFollowupSettings.js";
import { getAppSettings, isWithinWorkingHours } from "../settingsService.js";
import { phoneKeys } from "./leads.js";
import { isConnected, leadsByKey, mediaPath, sendFile, sendText, whatsappEnabled } from "./service.js";

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

export type FollowupSettings = Pick<IWhatsAppFollowupSettings, "enabled" | "startedAt" | "dailyLimit" | "steps" | "updatedByName"> & { teams: string[]; updatedAt: Date | null };

let cache: { at: number; value: FollowupSettings } | null = null;
export async function followupSettings(fresh = false): Promise<FollowupSettings> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.value;
  const doc = await WhatsAppFollowupSettings.findOne({ key: "default" }).lean();
  const value: FollowupSettings = {
    enabled: doc?.enabled ?? false,
    startedAt: doc?.startedAt ?? null,
    teams: (doc?.teams ?? []).map(String),
    dailyLimit: doc?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    steps: doc?.steps?.length ? doc.steps.map((s) => ({ waitMinutes: s.waitMinutes, text: s.text, file: s.file ?? null })) : DEFAULT_STEPS,
    updatedByName: doc?.updatedByName ?? "",
    updatedAt: doc?.updatedAt ?? null,
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
  await WhatsAppFollowupSettings.updateOne({ key: "default" }, {
    $set: {
      key: "default", enabled, steps, dailyLimit: limit, teams: teamIds.map((t) => new Types.ObjectId(t)), updatedByName: byName,
      // Switched on now: only chats written in from now on.
      ...(enabled && !before.enabled ? { startedAt: new Date() } : {}),
    },
  }, { upsert: true });
  cache = null;
  return followupSettings(true);
}

/* ── One chat's chain, read from its messages ───────────────────────────── */

type Msg = { _id: Types.ObjectId; direction: "in" | "out"; at: Date; chat: string; auto?: { step: number } | null };

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
    if (m.direction === "out" && m.auto) { sent++; continue; }
    if (m.direction === "in") return { state: "replied" };   // can't be: nothing goes after an answer on its own
    anchor = m;
    break;
  }
  if (!anchor) return null;   // only automatic messages kept (an older chat cut off): leave it be
  if (!settings.startedAt || anchor.at < settings.startedAt) return { state: "before" };
  if (stopped.at && stopped.at >= anchor.at) return { state: "stopped", byName: stopped.byName };
  if (sent >= settings.steps.length) return { state: "done", sent };
  return { state: "waiting", step: sent + 1, of: settings.steps.length, dueAt: new Date(last.at.getTime() + settings.steps[sent]!.waitMinutes * MIN), chat: last.chat };
}

const recent = (owner: Types.ObjectId | string, key: string) =>
  WhatsAppMessage.find({ owner: new Types.ObjectId(String(owner)), key }).sort({ at: -1, _id: -1 }).limit(40).select("direction at chat auto").lean<Msg[]>();

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
  state: "off" | "ended" | "no_chat" | ChainState["state"];
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
    const live = lasts.filter((c) => isConnected(String(c._id.owner)));
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
}

/** For the check only: forget the gaps and the failures, as a fresh process would. */
export function resetFollowupPacingForCheck(): void {
  nextSendAt.clear();
  failedUntil.clear();
  cache = null;
}
