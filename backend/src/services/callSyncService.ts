import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { LeadCall } from "../models/LeadCall.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { threecxConfigured, threecxJson, threecxSettings } from "../lib/threecx.js";

/* ────────────────────────────────────────────────────────────────────────────
   Calls with leads, from 3CX — Tetra Commission's call sync
   (backend/src/students/calls.ts there), for leads.

   Every minute the 3CX call log (the report behind 3CX's own Call History) is
   read for the last few hours, and every call between a lead's number and the
   phone system is kept in `lead_calls`: when, in / out, answered or missed,
   who took it (3CX extension), ringing and talking time, and its recordings.
   Calls with numbers no lead has are ignored. The first run reaches 90 days
   back.

   Recordings are never copied: they play from 3CX through the backend on a
   short-lived signed link, so the 3CX key never reaches a browser.

   Who took a call = the CRM user whose `extension` is that 3CX extension.
   Extensions are filled in from 3CX's users by email every few hours; one
   typed on the Users screen (extensionSource "manual") is never overwritten.

   A lead's call counts (2026-10-14) come from here too, replacing the old
   hand-kept counters: callCount (every call), callConnected (answered) and
   callNotConnected (missed + not answered), counted again from lead_calls for
   every lead a run touched — and once over every lead with calls, the first
   run after this shipped (COUNTS_VERSION). In this CRM (brought over from the
   Draw CRM 2026-10-14) the counts before were the Call button's clicks and
   the lead page's + / −: that first run copies them aside once, into
   `lead_call_counts_before_3cx`, before 3CX's replace them.
──────────────────────────────────────────────────────────────────────────── */

const SETTINGS_ID = "threecx_calls";
const DAY_MS = 86_400_000;
export const BACKFILL_DAYS = 90;
export const OVERLAP_MS = 3 * 3_600_000; // a call is logged when it ends — look back far enough for long ones
const PAGE = 500;
const TICK_MS = 60_000; // every minute, so a call shows on the Calls page soon after it ends
/** How 3CX's rows are read into calls; when it changes, the next run reads the 90 days again (calls are keyed, so none
 *  is kept twice). 2 — a call is the rows sharing its call history id, its main row the lowest Indent (V20 sends 1). */
const PARSER = 2;
export const LOCK_MS = 15 * 60_000;
const EXTENSIONS_EVERY_MS = 6 * 3_600_000;
/** When it changes, the next run counts every lead's calls again (1 — 2026-10-14, the counts from 3CX; 2 — the same
 *  day: hand-typed counts on leads with no 3CX calls go back to 0 too). */
const COUNTS_VERSION = 2;
export const LINK_TTL_S = 10 * 60;

/* ── settings + a lock, so two servers never sync at once ────────────────── */

const settings = () => mongoose.connection.collection<{ _id: string } & Record<string, unknown>>("app_settings");

export interface CallSyncSettings {
  lockUntil?: Date | null;
  syncedTo?: Date | null;
  backfilledAt?: Date | null;
  parser?: number;
  lastOkAt?: Date | null;
  lastRun?: Record<string, unknown> | null;
  lastError?: { at: Date; message: string } | null;
  extensionsSyncedAt?: Date | null;
  extensions?: { threecxUsers: number; matched: number; updated: number } | null;
  extensionsError?: { at: Date; message: string } | null;
  countsVersion?: number;
  countsAt?: Date | null;
  /** When every lead's counts from before 3CX were in HAND_COUNTS — set only once the copy is whole. */
  handCountsCopiedAt?: Date | null;
  handCountsCopied?: number;
}

export async function getCallSettings(): Promise<CallSyncSettings> {
  const doc = await settings().findOne({ _id: SETTINGS_ID });
  const { _id, ...rest } = doc ?? { _id: SETTINGS_ID };
  return rest as CallSyncSettings;
}

async function saveSettings(patch: Partial<CallSyncSettings>) {
  await settings().updateOne({ _id: SETTINGS_ID }, { $set: patch }, { upsert: true });
}

/** Takes the sync lock for LOCK_MS; false when another run (this server or another) holds it. */
export async function takeLock(): Promise<boolean> {
  try {
    const res = await settings().updateOne(
      { _id: SETTINGS_ID, $or: [{ lockUntil: null }, { lockUntil: { $exists: false } }, { lockUntil: { $lt: new Date() } }] },
      { $set: { lockUntil: new Date(Date.now() + LOCK_MS) } },
      { upsert: true },
    );
    return res.modifiedCount === 1 || res.upsertedCount === 1;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false; // held by another run
    throw err;
  }
}
const extendLock = () => saveSettings({ lockUntil: new Date(Date.now() + LOCK_MS) });
export const releaseLock = () => saveSettings({ lockUntil: null });

/* ── reading 3CX's rows ──────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

/** ISO 8601 duration ("PT1M23.5S") or a TimeSpan ("00:01:23") → whole seconds. */
export function durationSeconds(v: unknown): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const p = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (p) return Math.round((Number(p[1] || 0) * 7 + Number(p[2] || 0)) * 86400 + Number(p[3] || 0) * 3600 + Number(p[4] || 0) * 60 + Number(p[5] || 0));
  const t = s.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (t) return Number(t[1] || 0) * 86400 + Number(t[2]) * 3600 + Number(t[3]) * 60 + Number(t[4]);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * The last 9 digits of a number — how 3CX numbers are matched to leads (country codes and leading zeros vary: the
 * same tail the 3CX contact lookup in callController.ts matches on). Fewer than 7 digits is an extension, not a phone.
 */
export function phoneKey(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^00/, "");
  return d.length >= 7 ? d.slice(-9) : "";
}

/** Every number written in a lead's phone field ("050 123 4567 / +971 55 765 4321" is two). */
export function phoneKeysOf(raw: unknown): string[] {
  return [...new Set(String(raw ?? "").split(/[\n\r/,;|]+| - /).map(phoneKey).filter(Boolean))];
}

interface Side { dn: string; number: string; key: string; name: string }

/** One end of a row: its DN, a real phone number if it has one (caller ID first), its name. */
function sideOf(row: Row | undefined, which: "Source" | "Destination"): Side {
  const dn = String(row?.[`${which}Dn`] ?? "").trim();
  const callerId = String(row?.[`${which}CallerId`] ?? "").trim();
  const number = [callerId, dn].find((v) => phoneKey(v)) ?? "";
  return { dn, number, key: phoneKey(number), name: String(row?.[`${which}DisplayName`] ?? "").trim() };
}

const indent = (r: Row | undefined) => Number(r?.Indent) || 0;
const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/**
 * Rows → calls: the rows of one call share its call history id (MainCallHistoryId). Which of them is the main row
 * is the call's own business (parseCall): 3CX V20 sends Indent 1 on every row, older versions 0 on the main one. A
 * row without that id stands alone — CallId cannot join them (V20 has given every row CallId 1).
 */
export function groupRows(rows: Row[]): Row[][] {
  const calls = new Map<string, Row[]>();
  const alone: Row[][] = [];
  for (const r of rows) {
    const k = text(r?.MainCallHistoryId) || text(r?.CallHistoryId);
    if (!k) { alone.push([r]); continue; }
    calls.set(k, [...(calls.get(k) ?? []), r]);
  }
  return [...calls.values(), ...alone];
}

export interface ParsedCall {
  key: string;
  callId: string;
  segmentId: string;
  startedAt: Date;
  direction: "in" | "out";
  status: "answered" | "missed" | "no_answer";
  answered: boolean;
  talkSeconds: number;
  ringSeconds: number;
  number: string;
  numberKey: string;
  extension: string;
  agentName: string;
  recordingIds: number[];
  recordingUrl: string;
  reason: string;
  rows: number;
}

/**
 * One call (its rows) → what we keep, when one end of it is a lead's number (`isLead`); null otherwise. The lead's
 * end is found by its number, not by 3CX's DN type codes: extensions and trunks have short numbers and never match.
 */
export function parseCall(group: Row[], isLead: (numberKey: string) => boolean): ParsedCall | null {
  // The main row: the lowest Indent (V20: 1 on every row; older: 0), the earliest of those.
  const top = Math.min(...group.map(indent));
  const main = group.filter((r) => indent(r) === top).sort((a, b) => text(a?.StartTime).localeCompare(text(b?.StartTime)))[0] ?? group[0];
  const started = Date.parse(String(main?.StartTime ?? ""));
  if (!main || !Number.isFinite(started)) return null;
  const src = sideOf(main, "Source");
  const dst = sideOf(main, "Destination");
  const inbound = !!src.key && isLead(src.key);
  if (!inbound && !(dst.key && isLead(dst.key))) return null;
  const lead = inbound ? src : dst;

  // Who took it: an extension on a row that talked (a queue call is answered on a row under the main one) —
  // the far end first; never the lead's own end.
  const order = inbound ? (["Destination", "Source"] as const) : (["Source", "Destination"] as const);
  const extOf = (r: Row): Side | null => {
    for (const which of order) {
      const s = sideOf(r, which);
      if (/^\d{2,6}$/.test(s.dn) && s.key !== lead.key) return s;
    }
    return null;
  };
  const talked = group.filter((r) => r?.Answered === true && durationSeconds(r?.TalkingDuration) > 0);
  const answered = talked.length > 0 || main.Answered === true;
  // Rows under the main one first: the main row of a queue call names the queue, not who answered.
  const taker = [...talked.filter((r) => indent(r) > top), ...talked.filter((r) => indent(r) === top)].map(extOf).find(Boolean) ?? extOf(main);

  const recordingIds = [...new Set(group.flatMap((r) => [r?.SrcRecId, r?.DstRecId]).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  const recordingUrl = String(group.map((r) => r?.RecordingUrl).find((u) => typeof u === "string" && u) ?? "");
  // The call's own id — its call history id. (Not SegmentId: 3CX V20 sends 1 on every row, so every call would be one.)
  const historyId = text(main.MainCallHistoryId) || text(main.CallHistoryId);
  const key = historyId
    ? `call:${historyId}`
    : `h:${createHash("sha1").update([main.StartTime, main.SourceDn, main.SourceCallerId, main.DestinationDn, main.DestinationCallerId].join("|")).digest("hex")}`;

  return {
    key,
    callId: text(main.CallId),
    segmentId: text(main.SegmentId),
    startedAt: new Date(started),
    direction: inbound ? "in" : "out",
    status: answered ? "answered" : inbound ? "missed" : "no_answer",
    answered,
    talkSeconds: Math.max(0, ...group.map((r) => durationSeconds(r?.TalkingDuration))),
    ringSeconds: durationSeconds(main.RingingDuration),
    number: lead.number,
    numberKey: lead.key,
    extension: taker?.dn ?? "",
    agentName: taker?.name ?? (inbound ? dst.name : src.name),
    recordingIds,
    recordingUrl,
    reason: text(main.Reason),
    rows: group.length,
  };
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The call log report for [from, to), one page. */
export const callLogPath = (from: number, to: number, skip: number, top = PAGE) =>
  `/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(periodFrom=${stamp(from)},periodTo=${stamp(to)},sourceType=0,sourceFilter='',destinationType=0,destinationFilter='',callsType=0,callTimeFilterType=0,callTimeFilterFrom='0:00:0',callTimeFilterTo='0:00:0',hidePcalls=false)?$orderby=StartTime%20asc&$skip=${skip}&$top=${top}`;

async function fetchWindow(from: number, to: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (let skip = 0; skip < 500_000; skip += PAGE) {
    const data = await threecxJson<{ value?: Row[] }>(callLogPath(from, to, skip));
    const page = Array.isArray(data?.value) ? data.value : [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/* ── matching ────────────────────────────────────────────────────────────── */

export interface LeadMatch { _id: Types.ObjectId; name: string; assignedTo: string }

/** Every lead by each number on it, newest first (a number on several leads — a repeat — keeps them all). */
export async function leadsByPhone(): Promise<Map<string, LeadMatch[]>> {
  const map = new Map<string, LeadMatch[]>();
  const cursor = Lead.find({ phone: { $nin: [null, ""] } })
    .select("name phone assignedTo createdAt")
    .sort({ createdAt: -1 })
    .lean<{ _id: Types.ObjectId; name?: string; phone?: string; assignedTo?: Types.ObjectId | null }[]>()
    .cursor();
  for await (const l of cursor as AsyncIterable<{ _id: Types.ObjectId; name?: string; phone?: string; assignedTo?: Types.ObjectId | null }>) {
    const match = { _id: l._id, name: String(l.name ?? "").trim(), assignedTo: l.assignedTo ? String(l.assignedTo) : "" };
    for (const k of phoneKeysOf(l.phone)) map.set(k, [...(map.get(k) ?? []), match]);
  }
  return map;
}

/** Which lead a call is with: the one assigned to whoever took it, else the newest with that number. */
export function pickLead(candidates: LeadMatch[] | undefined, userId: string): LeadMatch | null {
  if (!candidates?.length) return null;
  return (userId && candidates.find((l) => l.assignedTo === userId)) || candidates[0]!;
}

interface UserByExt { _id: Types.ObjectId; name: string }

async function usersByExtension(): Promise<Map<string, UserByExt>> {
  const users = await User.find({ extension: { $nin: [null, ""] } }).select("name extension").lean<{ _id: Types.ObjectId; name: string; extension: string }[]>();
  return new Map(users.map((u) => [String(u.extension).trim(), { _id: u._id, name: u.name }]));
}

/** Calls nobody was matched to yet get their person once that person's extension is known (history is never re-assigned). */
async function linkUnmatchedCalls(users: Map<string, UserByExt>) {
  for (const [ext, u] of users) {
    await LeadCall.updateMany({ extension: ext, user: null }, { $set: { user: u._id, userName: u.name } });
  }
}

/**
 * 3CX's users → CRM users with the same email get that extension. Never over one typed by hand: extensionSource
 * "manual", or one already there before this sync existed (no source — they were all typed on the Users screen).
 */
export async function syncExtensions(): Promise<{ threecxUsers: number; matched: number; updated: number }> {
  const all: Row[] = [];
  for (let skip = 0; skip < 20_000; skip += 100) {
    const data = await threecxJson<{ value?: Row[] }>(`/xapi/v1/Users?$select=Id,FirstName,LastName,Number,EmailAddress&$orderby=Number&$top=100&$skip=${skip}`);
    const page = Array.isArray(data?.value) ? data.value : [];
    all.push(...page);
    if (page.length < 100) break;
  }
  const byEmail = new Map(
    all.filter((u) => u?.EmailAddress && u?.Number).map((u) => [String(u.EmailAddress).trim().toLowerCase(), u]),
  );
  const users = await User.find({}).select("email extension extensionSource").lean<{ _id: Types.ObjectId; email: string; extension?: string | null; extensionSource?: string | null }[]>();
  let matched = 0;
  let updated = 0;
  for (const u of users) {
    const t = byEmail.get(String(u.email ?? "").trim().toLowerCase());
    if (!t) continue;
    matched++;
    const current = String(u.extension ?? "").trim();
    if (u.extensionSource === "manual" || (current && u.extensionSource !== "3cx")) continue;
    const ext = String(t.Number).trim();
    if (current === ext) continue;
    await User.updateOne({ _id: u._id }, { $set: { extension: ext, extensionSource: "3cx" } });
    updated++;
  }
  const out = { threecxUsers: all.length, matched, updated };
  await saveSettings({ extensionsSyncedAt: new Date(), extensions: out, extensionsError: null });
  return out;
}

/* ── the sync ────────────────────────────────────────────────────────────── */

export interface SyncSummary {
  ok: boolean;
  skipped?: string;
  error?: string;
  from?: string;
  to?: string;
  windows: number;
  rows: number;
  calls: number;
  inserted: number;
  updated: number;
  /** Leads whose call counts changed. */
  leadsRecounted?: number;
}

async function syncWindow(from: number, to: number, leads: Map<string, LeadMatch[]>, users: Map<string, UserByExt>, now: Date) {
  const rows = await fetchWindow(from, to);
  const ops: Parameters<typeof LeadCall.bulkWrite>[0] = [];
  const parsed: { key: string; lead: string }[] = [];
  for (const group of groupRows(rows)) {
    const c = parseCall(group, (k) => leads.has(k));
    if (!c) continue; // not a call with a lead
    const u = c.extension ? users.get(c.extension) : undefined;
    const lead = pickLead(leads.get(c.numberKey), u ? String(u._id) : "");
    if (!lead) continue;
    parsed.push({ key: c.key, lead: String(lead._id) });
    ops.push({
      updateOne: {
        filter: { key: c.key },
        update: {
          $set: {
            ...c,
            lead: lead._id,
            leadName: lead.name,
            // Who took it, when that extension is someone's now; a call read again keeps the person it already has.
            ...(u ? { user: u._id, userName: u.name } : {}),
            syncedAt: now,
          },
          ...(u ? {} : { $setOnInsert: { user: null, userName: "" } }),
        },
        upsert: true,
      },
    });
  }
  let inserted = 0;
  let updated = 0;
  const touched = new Set<string>();
  if (ops.length) {
    // The leads these calls are on now, and the ones they were on before (a call read again can move to another
    // lead with that number): both are counted again.
    const keys = parsed.map((p) => p.key);
    const before = await LeadCall.find({ key: { $in: keys } }).select("lead").lean<{ lead: Types.ObjectId }[]>();
    for (const b of before) touched.add(String(b.lead));
    for (const p of parsed) touched.add(p.lead);
    const r = await LeadCall.bulkWrite(ops, { ordered: false });
    inserted = r.upsertedCount;
    updated = r.modifiedCount;
  }
  return { rows: rows.length, calls: ops.length, inserted, updated, touched };
}

/* ── a lead's call counts, from its 3CX calls ────────────────────────────── */

/**
 * Counts each lead's calls again from lead_calls: callCount, callConnected (answered), callNotConnected (missed +
 * not answered). `leadIds` — those leads (one left with no calls goes back to 0); none — every lead: those with calls
 * counted, and any other still carrying a hand-typed count reset to 0 (the counts are 3CX's only).
 * Written straight to the collection, and only where a number changed: no hooks, and the lead's updatedAt stays.
 * Returns how many leads changed.
 */
export async function recountLeadCalls(leadIds?: Iterable<string | Types.ObjectId>): Promise<number> {
  const ids = leadIds
    ? [...new Set([...leadIds].map(String))].filter((v) => Types.ObjectId.isValid(v)).map((v) => new Types.ObjectId(v))
    : null;
  if (ids && !ids.length) return 0;
  const counted = await LeadCall.aggregate<{ _id: Types.ObjectId; total: number; connected: number; notConnected: number }>([
    ...(ids ? [{ $match: { lead: { $in: ids } } }] : []),
    {
      $group: {
        _id: "$lead",
        total: { $sum: 1 },
        connected: { $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] } },
        notConnected: { $sum: { $cond: [{ $in: ["$status", ["missed", "no_answer"]] }, 1, 0] } },
      },
    },
  ]);
  const byLead = new Map(counted.map((c) => [String(c._id), c]));
  const targets = ids ?? counted.map((c) => c._id);
  let changed = 0;
  for (let i = 0; i < targets.length; i += 1000) {
    const ops = targets.slice(i, i + 1000).map((id) => {
      const c = byLead.get(String(id));
      const want = { callCount: c?.total ?? 0, callConnected: c?.connected ?? 0, callNotConnected: c?.notConnected ?? 0 };
      return {
        updateOne: {
          filter: { _id: id, $or: Object.entries(want).map(([k, v]) => ({ [k]: { $ne: v } })) },
          update: { $set: want },
        },
      };
    });
    if (ops.length) changed += (await Lead.collection.bulkWrite(ops, { ordered: false })).modifiedCount;
  }
  if (!ids) {
    // Every lead with no 3CX calls: a count typed by hand before goes back to 0.
    const withCalls = counted.map((c) => c._id);
    const r = await Lead.collection.updateMany(
      { _id: { $nin: withCalls }, $or: [{ callCount: { $gt: 0 } }, { callConnected: { $gt: 0 } }, { callNotConnected: { $gt: 0 } }] },
      { $set: { callCount: 0, callConnected: 0, callNotConnected: 0 } },
    );
    changed += r.modifiedCount;
  }
  return changed;
}

/** Where the counts kept before 3CX's are copied, once — so they can be put back. */
export const HAND_COUNTS = "lead_call_counts_before_3cx";

/**
 * Every lead's call counts as they stand before the first count from 3CX replaces them, copied into HAND_COUNTS
 * (_id = the lead's) — once. The copy counts as done only when every lead is in (`handCountsCopiedAt`): one cut short
 * (a restart, a database error) is finished by the next run before any count is replaced, and a lead copied already
 * keeps its first copy. Returns how many leads were copied this time.
 */
export async function keepHandCounts(): Promise<number> {
  if ((await getCallSettings()).handCountsCopiedAt) return 0;
  const backup = mongoose.connection.collection<{ _id: Types.ObjectId } & Record<string, unknown>>(HAND_COUNTS);
  const rows = await Lead.collection
    .find(
      { $or: [{ callCount: { $gt: 0 } }, { callConnected: { $gt: 0 } }, { callNotConnected: { $gt: 0 } }] },
      { projection: { callCount: 1, callConnected: 1, callNotConnected: 1 } },
    )
    .toArray();
  const savedAt = new Date();
  let copied = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await backup.bulkWrite(
      rows.slice(i, i + 1000).map(({ _id, ...counts }) => ({
        updateOne: { filter: { _id }, update: { $setOnInsert: { ...counts, savedAt } }, upsert: true },
      })),
      { ordered: false },
    );
    copied += r.upsertedCount;
  }
  await saveSettings({ handCountsCopiedAt: new Date(), handCountsCopied: rows.length });
  return copied;
}

/**
 * Bring `lead_calls` up to date: from where the last run got to (less a few hours, for calls that were still going),
 * or 90 days back the first time — a day at a time, noting progress so a failed run resumes.
 */
export async function syncCalls(by = "Schedule"): Promise<SyncSummary> {
  const sum: SyncSummary = { ok: true, windows: 0, rows: 0, calls: 0, inserted: 0, updated: 0 };
  if (!threecxConfigured()) return { ...sum, ok: false, skipped: "3CX is not connected" };
  if (!(await takeLock())) return { ...sum, ok: false, skipped: "A sync is already running" };
  const now = new Date();
  try {
    const s = await getCallSettings();
    if (!s.extensionsSyncedAt || Date.now() - new Date(s.extensionsSyncedAt).getTime() > EXTENSIONS_EVERY_MS) {
      await syncExtensions().catch((err) =>
        saveSettings({ extensionsSyncedAt: new Date(), extensionsError: { at: new Date(), message: err instanceof Error ? err.message : String(err) } }));
    }
    const [leads, users] = await Promise.all([leadsByPhone(), usersByExtension()]);
    await linkUnmatchedCalls(users);

    // Rows read a new way since the last run: the 90 days again, from the start.
    if (s.parser !== PARSER) {
      await saveSettings({ parser: PARSER, syncedTo: null, backfilledAt: null });
      Object.assign(s, { parser: PARSER, syncedTo: null, backfilledAt: null });
    }
    const to = Date.now();
    const from = s.syncedTo
      ? Math.max(new Date(s.syncedTo).getTime() - OVERLAP_MS, to - BACKFILL_DAYS * DAY_MS)
      : to - BACKFILL_DAYS * DAY_MS;
    sum.from = new Date(from).toISOString();
    sum.to = new Date(to).toISOString();
    const touched = new Set<string>();
    for (let a = from; a < to; a += DAY_MS) {
      const b = Math.min(a + DAY_MS, to);
      // Every day after the first is read from a few hours before it starts: a call whose rows straddle the start of a
      // day (a queue call answered a moment later) is then read whole by the later day, over the part the day before
      // saw — read from its own start, that day kept only its own rows of it (2026-10-14).
      const r = await syncWindow(a === from ? a : a - OVERLAP_MS, b, leads, users, now);
      sum.windows++;
      sum.rows += r.rows;
      sum.calls += r.calls;
      sum.inserted += r.inserted;
      sum.updated += r.updated;
      for (const id of r.touched) touched.add(id);
      await saveSettings({ syncedTo: new Date(b) });
      await extendLock();
    }
    // The leads' call counts: every lead the first time (and whenever COUNTS_VERSION changes) — those with calls
    // counted, the rest's hand-typed counts back to 0 — otherwise the leads whose calls this run read.
    if (s.countsVersion !== COUNTS_VERSION) {
      if (!s.countsVersion) await keepHandCounts();
      sum.leadsRecounted = await recountLeadCalls();
      await saveSettings({ countsVersion: COUNTS_VERSION, countsAt: new Date() });
    } else {
      sum.leadsRecounted = await recountLeadCalls(touched);
    }
    await saveSettings({
      lastRun: { ...sum, at: new Date(), by },
      lastOkAt: new Date(),
      lastError: null,
      ...(s.backfilledAt ? {} : { backfilledAt: new Date() }),
    });
  } catch (err) {
    sum.ok = false;
    sum.error = err instanceof Error ? err.message : String(err);
    await saveSettings({ lastRun: { ...sum, at: new Date(), by }, lastError: { at: new Date(), message: sum.error } });
  } finally {
    await releaseLock();
  }
  return sum;
}

/** Every minute, when 3CX is connected and this process runs the timed jobs (RUN_SCHEDULERS). */
export function startCallSyncWorker(): void {
  if (!env.RUN_SCHEDULERS) {
    console.log("[calls] RUN_SCHEDULERS is off — no 3CX call sync in this process");
    return;
  }
  if (!threecxConfigured()) {
    console.log("[calls] 3CX not connected — no call sync (THREECX_URL / THREECX_CLIENT_ID / THREECX_API_KEY)");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncCalls();
      if (r.error) console.error(`[calls] sync failed: ${r.error}`);
      else if (r.inserted) console.log(`[calls] ${r.inserted} new call(s) with leads`);
    } catch (err) {
      console.error("[calls] sync failed", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 2 * 60_000);
  setInterval(() => void tick(), TICK_MS);
}

/* ── recordings: short-lived signed links, played through the backend ────── */

const sign = (payload: string) => createHmac("sha256", `${env.JWT_SECRET}|call-recordings`).update(payload).digest("base64url");

export const RECORDING_PATH = "/api/v1/calls/log/recording";

/** The path a browser plays recording `index` of call `callId` from (valid 10 minutes, for `userId`). */
export function recordingPath(callId: string, index: number, userId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_TTL_S;
  const q = new URLSearchParams({ c: callId, i: String(index), e: String(exp), u: userId, s: sign(`${callId}.${index}.${exp}.${userId}`) });
  return `${RECORDING_PATH}?${q}`;
}

export function checkRecordingLink(params: URLSearchParams): { callId: string; index: number; userId: string } | null {
  const c = params.get("c") ?? "";
  const i = params.get("i") ?? "";
  const e = params.get("e") ?? "";
  const u = params.get("u") ?? "";
  const s = params.get("s") ?? "";
  if (!/^[a-f0-9]{24}$/.test(c) || !/^\d{1,2}$/.test(i) || !/^\d{9,11}$/.test(e) || !s) return null;
  if (Number(e) < Date.now() / 1000) return null;
  const want = Buffer.from(sign(`${c}.${i}.${e}.${u}`));
  const got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { callId: c, index: Number(i), userId: u };
}

/**
 * Where on 3CX recording `index` of `call` is; "" if none. By recording id; RecordingUrl only when it is a path on
 * the configured 3CX (usually it is just the file name, which can't be fetched).
 */
export function recordingSource(call: { recordingIds?: number[]; recordingUrl?: string } | null | undefined, index: number): string {
  const id = Number(call?.recordingIds?.[index]);
  if (Number.isInteger(id) && id > 0) return `/xapi/v1/Recordings/Pbx.DownloadRecording(recId=${id})`;
  const url = String(call?.recordingUrl ?? "");
  if (index !== 0 || !url) return "";
  if (url.startsWith("/")) return url;
  const base = threecxSettings().url;
  if (base && url.startsWith(`${base}/`)) return url.slice(base.length);
  return "";
}

/** How many recordings of `call` can be played. */
export const recordingCount = (call: { recordingIds?: number[]; recordingUrl?: string }): number =>
  call?.recordingIds?.length || (recordingSource(call, 0) ? 1 : 0);
