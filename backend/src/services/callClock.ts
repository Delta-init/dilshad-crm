import { Types } from "mongoose";
import { LeadCall as Calls } from "../models/LeadCall.js";
import { User } from "../models/User.js";
import { threecxConfigured, threecxFetch } from "../lib/threecx.js";

/*
 * Calls as time spans (the user, 2026-10-19: "on calling time also don't move
 * the inactive leads — it gets more time"): the inactive-lead clock stops
 * while a lead's owner is on a call — any call their 3CX extension made or
 * took, answered or not, from when it started ringing to hang-up — and
 * nothing of theirs moves while they are on one.
 *
 *   - calls that ended come from the 3CX call history this CRM already syncs
 *     every minute (by the CRM person, or their extension);
 *   - a call going on now is asked of 3CX itself (Call Control: the
 *     extension's participants), the same look the Call window takes.
 *
 * 3CX not connected, not answering, or a person with no extension: no call
 * time for them, and the mover carries on as before — never held up by it.
 */

/** [start, end] in ms. */
export type Span = [number, number];

/** Each person's calls that overlap `from` → `now`: the whole call, ringing and talking. */
export async function callSpansOf(userIds: string[], from: Date, now = new Date()): Promise<{ spans: Map<string, Span[]>; extensionOf: Map<string, string> }> {
  const spans = new Map<string, Span[]>();
  const extensionOf = new Map<string, string>();
  const ids = [...new Set(userIds)].filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return { spans, extensionOf };
  const users = await User.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).select("extension").lean<Array<{ _id: Types.ObjectId; extension?: string | null }>>();
  const byExtension = new Map<string, string>();
  for (const u of users) {
    const ext = String(u.extension ?? "").trim();
    if (ext) { extensionOf.set(String(u._id), ext); byExtension.set(ext, String(u._id)); }
  }
  // A call that started up to 6 hours before `from` may still overlap it.
  const calls = await Calls.find({
    startedAt: { $gte: new Date(from.getTime() - 6 * 3_600_000), $lte: now },
    $or: [{ user: { $in: ids.map((id) => new Types.ObjectId(id)) } }, ...(byExtension.size ? [{ extension: { $in: [...byExtension.keys()] } }] : [])],
  }).select("user extension startedAt ringSeconds talkSeconds").lean<Array<{ user?: Types.ObjectId | null; extension?: string; startedAt: Date; ringSeconds?: number; talkSeconds?: number }>>();
  for (const c of calls) {
    const owner = c.user ? String(c.user) : byExtension.get(String(c.extension ?? ""));
    if (!owner || !ids.includes(owner)) continue;
    const start = new Date(c.startedAt).getTime();
    const end = start + ((Number(c.ringSeconds) || 0) + (Number(c.talkSeconds) || 0)) * 1000;
    if (end <= start || end <= from.getTime()) continue;
    spans.set(owner, [...(spans.get(owner) ?? []), [start, Math.min(end, now.getTime())]]);
  }
  return { spans, extensionOf };
}

const LIVE_MS = 20_000;
const live = new Map<string, { at: number; onCall: boolean }>();
/** Forget what 3CX said about who is on a call — for the checks. */
export const forgetLiveCalls = (): void => live.clear();

/** Whether this extension is on a call right now, as 3CX has it (kept 20 s). Can't say → no. */
async function extensionOnCall(extension: string): Promise<boolean> {
  const seen = live.get(extension);
  if (seen && Date.now() - seen.at < LIVE_MS) return seen.onCall;
  let onCall = false;
  try {
    const r = await threecxFetch(`/callcontrol/${encodeURIComponent(extension)}`, { timeoutMs: 5_000 });
    if (r.ok) {
      const dn = (await r.json().catch(() => null)) as { participants?: unknown[] } | null;
      onCall = Array.isArray(dn?.participants) && dn!.participants!.length > 0;
    } else {
      await r.body?.cancel();
    }
  } catch {
    onCall = false;
  }
  live.set(extension, { at: Date.now(), onCall });
  return onCall;
}

/** Who among these people is on a call right now — none when 3CX isn't connected. */
export async function onCallNow(extensionOf: Map<string, string>): Promise<Set<string>> {
  const out = new Set<string>();
  if (!threecxConfigured() || !extensionOf.size) return out;
  const entries = [...extensionOf];
  for (let i = 0; i < entries.length; i += 10) {
    const chunk = entries.slice(i, i + 10);
    const answers = await Promise.all(chunk.map(([, ext]) => extensionOnCall(ext)));
    chunk.forEach(([userId], k) => { if (answers[k]) out.add(userId); });
  }
  return out;
}

/** Spans joined where they overlap, so time on a call during a break is taken off once. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
