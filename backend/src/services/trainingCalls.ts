import { Types, type FilterQuery } from "mongoose";
import { LeadCall, TRAINING_CATEGORIES, type ILeadCall, type ITrainingMark, type TrainingCategory } from "../models/LeadCall.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { loadConfig, isSuperAdmin } from "./commissionService.js";
import { canSeeCall, type Viewer } from "./leadCallService.js";
import { recordingCount, recordingSource } from "./callSyncService.js";
import { threecxFetch } from "../lib/threecx.js";
import { deleteFile, storageConfigured, uploadFile } from "../lib/storage.js";

/* ────────────────────────────────────────────────────────────────────────────
   Training calls (the user, 2026-11-03: "mark a call for training, and a new
   page for the training calls"; as in the Sales CRM).

   • Who marks: the Super Admin, the commission plan's Sales Manager and team
     leaders (of an active team) — a call they can see on the Calls page, with
     a recording. A category (good example, closing, objection handling,
     follow-up, what not to do) and a note on why.
   • Who listens: everyone with the Training calls module (open by default) —
     every marked call, whoever's it was, so new people learn from it. The
     customer's number is never shown there.
   • Its recordings are copied into the CRM's storage when it is marked, as
     3CX deletes old ones; it plays from the copy, from 3CX until then.
──────────────────────────────────────────────────────────────────────────── */

type CallDoc = ILeadCall & { _id: Types.ObjectId };

export const TRAINING_LABEL: Record<TrainingCategory, string> = {
  good_example: "Good example",
  closing: "Closing",
  objection: "Objection handling",
  follow_up: "Follow-up",
  avoid: "What not to do",
};

export const AUDIO_TYPES: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm" };

export class TrainingError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Whether `viewer` may mark calls for training: the Super Admin, the Sales Manager, a leader of an active team. */
export async function canMarkTraining(viewer: Viewer): Promise<boolean> {
  if (isSuperAdmin(viewer.role)) return true;
  if (!Types.ObjectId.isValid(viewer.userId)) return false;
  const config = await loadConfig();
  if (config.salesManager && String(config.salesManager) === viewer.userId) return true;
  return !!(await Team.exists({ leaders: new Types.ObjectId(viewer.userId), status: "active" }));
}

/** The mark as the pages show it. */
export function trainingView(t: ITrainingMark | null | undefined, recordings: number) {
  if (!t) return null;
  return {
    category: t.category,
    categoryLabel: TRAINING_LABEL[t.category] ?? t.category,
    note: t.note ?? "",
    byName: t.byName ?? "",
    at: t.at,
    /** Every recording kept in the CRM's storage — it plays even after 3CX deletes it. */
    saved: recordings > 0 && (t.copies ?? []).length >= recordings,
    copyError: t.copyError ?? "",
  };
}

async function markable(viewer: Viewer, callId: string): Promise<CallDoc> {
  if (!Types.ObjectId.isValid(callId)) throw new TrainingError("Invalid call id", 400);
  if (!(await canMarkTraining(viewer))) throw new TrainingError("Only the Super Admin, the Sales Manager and team leaders mark calls for training", 403);
  const call = await LeadCall.findById(callId).lean<CallDoc>();
  if (!call) throw new TrainingError("Call not found", 404);
  if (!(await canSeeCall(viewer, call))) throw new TrainingError("You can't open this call", 403);
  return call;
}

/** Mark a call for training, or change its category and note. Its recordings are then kept (in the background). */
export async function markTraining(viewer: Viewer, callId: string, input: { category: string; note?: string }) {
  if (!(TRAINING_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new TrainingError(`Category is one of: ${TRAINING_CATEGORIES.join(", ")}`, 400);
  }
  const note = String(input.note ?? "").trim();
  if (note.length > 1000) throw new TrainingError("Keep the note under 1,000 characters", 400);
  const call = await markable(viewer, callId);
  if (!recordingCount(call)) throw new TrainingError("Only a call with a recording can be marked for training", 400);
  const me = await User.findById(viewer.userId).select("name").lean<{ name?: string }>();
  const now = new Date();
  const was = call.training;
  const training: ITrainingMark = {
    category: input.category as TrainingCategory,
    note,
    by: was?.by ?? new Types.ObjectId(viewer.userId),
    byName: was?.byName || me?.name || "",
    at: was?.at ?? now,
    updatedAt: now,
    copies: was?.copies ?? [],
    copyError: was?.copyError ?? "",
  };
  await LeadCall.updateOne({ _id: call._id }, { $set: { training } });
  void keepRecordings(String(call._id));
  return trainingView(training, recordingCount(call));
}

/** A call no longer a training call: the mark and its kept recordings go. */
export async function unmarkTraining(viewer: Viewer, callId: string) {
  const call = await markable(viewer, callId);
  if (!call.training) throw new TrainingError("This call isn't marked for training", 404);
  await LeadCall.updateOne({ _id: call._id }, { $set: { training: null } });
  for (const c of call.training.copies ?? []) await deleteFile(c.key);
  return { unmarked: true };
}

const copying = new Set<string>();

/**
 * A marked call's recordings copied into the CRM's storage, those not kept yet. Never throws: what went wrong is
 * kept on the mark (`copyError`) and the page says so; marking it again tries again.
 */
export async function keepRecordings(callId: string): Promise<void> {
  if (copying.has(callId)) return;
  copying.add(callId);
  try {
    const call = await LeadCall.findById(callId).lean<CallDoc>();
    if (!call?.training) return;
    if (!storageConfigured()) {
      await LeadCall.updateOne({ _id: call._id, training: { $ne: null } }, { $set: { "training.copyError": "This CRM's file storage isn't set up (R2) — the recording plays from 3CX while 3CX keeps it" } });
      return;
    }
    const have = new Set((call.training.copies ?? []).map((c) => c.index));
    for (let i = 0; i < recordingCount(call); i++) {
      if (have.has(i)) continue;
      try {
        const path = recordingSource(call, i);
        const res = path ? await threecxFetch(path, { timeoutMs: 180_000 }) : null;
        if (!res || !res.ok) throw new Error(res ? `3CX could not give the recording (HTTP ${res.status})` : "No recording");
        const given = res.headers.get("content-type") ?? "";
        const file = (res.headers.get("content-disposition") ?? "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? "";
        const ext = AUDIO_TYPES[(file.split(".").pop() ?? "").toLowerCase()] ? (file.split(".").pop() ?? "").toLowerCase() : "wav";
        const mimeType = given.startsWith("audio/") ? given : AUDIO_TYPES[ext] ?? "audio/wav";
        const buffer = Buffer.from(await res.arrayBuffer());
        const up = await uploadFile({ key: `training-calls/${callId}/${i}.${ext}`, buffer, mimeType, originalName: `training-call-${callId}-${i}.${ext}` });
        // Only onto a mark still there: unmarked while copying, the copy goes again.
        const kept = await LeadCall.updateOne(
          { _id: call._id, training: { $ne: null } },
          { $push: { "training.copies": { index: i, key: up.key, size: up.size, mimeType } }, $set: { "training.copyError": "" } },
        );
        if (!kept.modifiedCount) { await deleteFile(up.key); return; }
      } catch (err) {
        await LeadCall.updateOne(
          { _id: call._id, training: { $ne: null } },
          { $set: { "training.copyError": `Recording ${i + 1} not kept yet: ${err instanceof Error ? err.message : "failed"} — mark it again to retry` } },
        );
        return;
      }
    }
  } catch (err) {
    console.error(`[training-calls] could not keep the recordings of call ${callId}`, err);
  } finally {
    copying.delete(callId);
  }
}

export interface TrainingFilters { category?: string; person?: string; search?: string; page?: string; limit?: string }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Training calls page: every marked call, newest mark first — without the customer's number. */
export async function listTraining(viewer: Viewer, f: TrainingFilters) {
  const match: FilterQuery<ILeadCall> = { training: { $ne: null } };
  if (f.category) {
    if (!(TRAINING_CATEGORIES as readonly string[]).includes(f.category)) throw new TrainingError("Unknown category", 400);
    match["training.category"] = f.category;
  }
  if (f.person) {
    if (!Types.ObjectId.isValid(f.person)) throw new TrainingError("Unknown person", 400);
    match.user = new Types.ObjectId(f.person);
  }
  const q = String(f.search ?? "").trim().slice(0, 80);
  if (q) {
    const re = new RegExp(escape(q), "i");
    match.$or = [{ leadName: re }, { userName: re }, { agentName: re }, { "training.note": re }];
  }
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(f.limit) || 30)));
  const [docs, total, people, byCategory, canMark] = await Promise.all([
    LeadCall.find(match).sort({ "training.at": -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean<CallDoc[]>(),
    LeadCall.countDocuments(match),
    LeadCall.aggregate<{ _id: Types.ObjectId; name: string; calls: number }>([
      { $match: { training: { $ne: null }, user: { $ne: null } } },
      { $group: { _id: "$user", name: { $last: "$userName" }, calls: { $sum: 1 } } },
      { $sort: { name: 1 } },
    ]),
    LeadCall.aggregate<{ _id: string; calls: number }>([
      { $match: { training: { $ne: null } } },
      { $group: { _id: "$training.category", calls: { $sum: 1 } } },
    ]),
    canMarkTraining(viewer),
  ]);
  return {
    calls: docs.map((c) => ({
      id: String(c._id),
      startedAt: c.startedAt,
      direction: c.direction,
      status: c.status,
      talkSeconds: c.talkSeconds ?? 0,
      userId: c.user ? String(c.user) : "",
      userName: c.userName || c.agentName || "",
      leadName: c.leadName ?? "",
      recordings: recordingCount(c),
      training: trainingView(c.training, recordingCount(c)),
    })),
    total, page, limit, canMark,
    categories: TRAINING_CATEGORIES.map((k) => ({ key: k, label: TRAINING_LABEL[k], calls: byCategory.find((b) => b._id === k)?.calls ?? 0 })),
    people: people.map((p) => ({ id: String(p._id), name: p.name, calls: p.calls })),
  };
}

/** A training call (anyone on the page may play it), or why not. */
export async function trainingCall(callId: string): Promise<CallDoc> {
  if (!Types.ObjectId.isValid(callId)) throw new TrainingError("Invalid call id", 400);
  const call = await LeadCall.findById(callId).lean<CallDoc>();
  if (!call?.training) throw new TrainingError("Not a training call", 404);
  return call;
}
