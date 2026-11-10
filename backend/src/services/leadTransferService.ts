import { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { LeadTransfer, type ILeadTransferItem } from "../models/LeadTransfer.js";
import { notifyBulkLeadAssignment } from "./pushService.js";

/*
 * Transferring a person's leads (the user, 2026-11-10): all of their open leads to one person, or split between
 * several (evenly, or the counts given) — from the Users page, and before a person is deactivated or deleted.
 *
 *   What moves   open leads only. Closed and lost leads stay with them, so commission, reports and the leaderboard
 *                don't change.
 *   Team         each lead goes to the new owner's team: the one they lead, else the one they're in — a lead already
 *                in one of their teams stays there; someone in no team leaves the lead's team as it was.
 *   With it      their open reminders on those leads; a line in each lead's history; the receivers told.
 *   As new       the lead model's hand-over rule makes each moved lead new for the receiver (Today's Leads, status
 *                Assigned, its follow-up date cleared) — as every assignment does.
 *   Undo         for 24 hours, the leads nobody has touched since — back exactly as they were.
 *
 * One lead at a time, never all at once, so the split can't hand everything to one person.
 */

const DONE = ["closed", "lost"];
/** Whether leads here carry a next follow-up date (a CRM that keeps follow-ups otherwise has none to put back). */
const HAS_FOLLOW_UP_DATE = () => !!Lead.schema.path("nextFollowUpAt");
const UNDO_MS = 24 * 3_600_000;
const MAX_TARGETS = 50;

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw fail("Not a valid id", 400);
  return new Types.ObjectId(id);
};
const idOf = (v: unknown) => (v == null ? null : String((v as { _id?: unknown })._id ?? v));

/** A person's open leads — everything they hold that isn't closed or lost. */
export const openLeadsOf = (userId: string) => ({ assignedTo: oid(userId), status: { $nin: DONE } });

export async function openLeadCount(userId: string): Promise<number> {
  return Lead.countDocuments(openLeadsOf(userId));
}

async function leadCounts(userId: string) {
  const rows = await Lead.aggregate<{ _id: string; n: number }>([
    { $match: { assignedTo: oid(userId) } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const open = rows.filter((r) => !DONE.includes(r._id)).reduce((a, r) => a + r.n, 0);
  return { open, closed: byStatus.closed ?? 0, lost: byStatus.lost ?? 0, byStatus };
}

/** Who they are and what they hold — the transfer dialog's first look. */
export async function transferSummary(userId: string) {
  const user = await User.findById(oid(userId)).select("name email status").lean<{ _id: Types.ObjectId; name: string; email: string; status: string } | null>();
  if (!user) throw fail("User not found", 404);
  return { user: { id: String(user._id), name: user.name, email: user.email, status: user.status }, ...(await leadCounts(userId)) };
}

/* ── The new owner's team ──────────────────────────────────────────────────────────────────────────────────────── */

interface TeamInfo { ids: Set<string>; first: { id: string; name: string } | null }

/** Each person's active teams — the one they lead first, else one they're a member of. */
async function teamsOf(userIds: string[]): Promise<Map<string, TeamInfo>> {
  const ids = userIds.map(oid);
  const teams = await Team.find({ status: { $ne: "inactive" }, $or: [{ leaders: { $in: ids } }, { members: { $in: ids } }] })
    .select("name leaders members")
    .sort({ name: 1, _id: 1 })
    .lean<Array<{ _id: Types.ObjectId; name: string; leaders?: Types.ObjectId[]; members?: Types.ObjectId[] }>>();
  const out = new Map<string, TeamInfo>();
  for (const u of userIds) {
    const leads = teams.filter((t) => (t.leaders ?? []).some((x) => String(x) === u));
    const inIt = teams.filter((t) => (t.members ?? []).some((x) => String(x) === u));
    const first = leads[0] ?? inIt[0] ?? null;
    out.set(u, {
      ids: new Set([...leads, ...inIt].map((t) => String(t._id))),
      first: first ? { id: String(first._id), name: first.name } : null,
    });
  }
  return out;
}

/** The team a lead lands in with its new owner: its own if that is one of theirs, else theirs, else as it was. */
function teamFor(info: TeamInfo | undefined, current: unknown): string | null {
  const cur = idOf(current);
  if (cur && info?.ids.has(cur)) return cur;
  return info?.first?.id ?? cur;
}

/* ── The plan: who gets how many ───────────────────────────────────────────────────────────────────────────────── */

export interface TargetInput { userId: string; count?: number | null }

async function plan(fromId: string, targets: TargetInput[]) {
  const from = await User.findById(oid(fromId)).select("name status").lean<{ _id: Types.ObjectId; name: string; status: string } | null>();
  if (!from) throw fail("User not found", 404);
  if (!Array.isArray(targets) || !targets.length) throw fail("Choose who gets the leads", 400);
  if (targets.length > MAX_TARGETS) throw fail(`At most ${MAX_TARGETS} people at once`, 400);
  const userIds = targets.map((t) => String(t.userId ?? ""));
  if (new Set(userIds).size !== userIds.length) throw fail("Someone is chosen twice", 400);
  if (userIds.includes(fromId)) throw fail(`${from.name} can't be given their own leads`, 400);
  const people = await User.find({ _id: { $in: userIds.map(oid) } }).select("name status").lean<Array<{ _id: Types.ObjectId; name: string; status: string }>>();
  const byId = new Map(people.map((p) => [String(p._id), p]));
  for (const u of userIds) {
    const p = byId.get(u);
    if (!p) throw fail("One of the people chosen doesn't exist", 400);
    if (p.status === "inactive") throw fail(`${p.name} is deactivated — choose someone active`, 400);
  }

  const open = await openLeadCount(fromId);
  const given = targets.filter((t) => t.count !== undefined && t.count !== null);
  let counts: number[];
  if (given.length === 0) {
    // Evenly: the first ones get one more when it doesn't divide.
    const base = Math.floor(open / targets.length), extra = open % targets.length;
    counts = targets.map((_, i) => base + (i < extra ? 1 : 0));
  } else if (given.length === targets.length) {
    counts = targets.map((t) => Number(t.count));
    if (counts.some((c) => !Number.isInteger(c) || c < 0)) throw fail("Counts are whole numbers, 0 or more", 400);
    const sum = counts.reduce((a, c) => a + c, 0);
    if (sum !== open) throw fail(`The counts add up to ${sum}, not the ${open} open leads`, 400);
  } else {
    throw fail("Give everyone a count, or nobody for an even split", 400);
  }

  const teams = await teamsOf(userIds);
  return {
    from: { id: String(from._id), name: from.name, status: from.status },
    open,
    targets: userIds.map((u, i) => ({ userId: u, name: byId.get(u)!.name, count: counts[i]!, team: teams.get(u)?.first ?? null })),
    teams,
  };
}

/** What a transfer would do — the dialog shows it before anything moves. */
export async function previewTransfer(fromId: string, targets: TargetInput[]) {
  const p = await plan(fromId, targets);
  return {
    from: p.from,
    open: p.open,
    targets: p.targets,
    warnings: p.targets.filter((t) => !t.team).map((t) => `${t.name} isn't in a team — their leads keep the team they're in`),
  };
}

/** Move them. Returns the transfer's id (for Undo) and who got how many. */
export async function transferLeads(fromId: string, targets: TargetInput[], byUserId: string, reason: "transfer" | "remove" = "transfer") {
  const p = await plan(fromId, targets);
  if (!p.open) throw fail(`${p.from.name} has no open leads to move`, 400);
  const leads = await Lead.find(openLeadsOf(fromId)).sort({ createdAt: 1, _id: 1 });
  if (leads.length !== p.open) throw fail("Their open leads changed just now — check again", 409);

  // Who gets each lead, oldest first: round the people, skipping whoever has their share.
  const left = p.targets.map((t) => t.count);
  const order: number[] = [];
  for (let i = 0; order.length < leads.length; i++) {
    const k = i % p.targets.length;
    if (left[k]! > 0) { order.push(k); left[k]!--; }
  }

  const by = await User.findById(oid(byUserId)).select("name").lean<{ name: string } | null>();
  const byName = by?.name ?? "";
  const batch = await LeadTransfer.create({
    from: oid(fromId), fromName: p.from.name, by: oid(byUserId), byName, reason,
    targets: p.targets.map((t) => ({ user: oid(t.userId), name: t.name, count: t.count, team: t.team ? oid(t.team.id) : null, teamName: t.team?.name ?? "" })),
    items: [], moved: 0,
  });

  let pending: ILeadTransferItem[] = [];
  let moved = 0;
  const flush = async () => {
    if (!pending.length) return;
    await LeadTransfer.updateOne({ _id: batch._id }, { $push: { items: { $each: pending } }, $set: { moved } });
    pending = [];
  };
  for (let k = 0; k < leads.length; k++) {
    const lead = leads[k]!;
    const t = p.targets[order[k]!]!;
    const to = oid(t.userId);
    const prevTeam = idOf(lead.team);
    const newTeam = teamFor(p.teams.get(t.userId), lead.team);
    const doc = lead as unknown as {
      assignedTo: unknown; team: unknown; status: string; createdAt?: Date; originalCreatedAt?: Date | null; nextFollowUpAt?: Date | null;
      reminders?: Array<{ _id: Types.ObjectId; isDone?: boolean; createdBy?: unknown }>;
      activityLogs: Array<unknown>; save: () => Promise<unknown>;
    };
    const item: ILeadTransferItem = {
      lead: lead._id as Types.ObjectId, to, prevTeam: prevTeam ? oid(prevTeam) : null, newTeam: newTeam ? oid(newTeam) : null,
      prevStatus: doc.status, prevCreatedAt: doc.createdAt ?? null, prevOriginalCreatedAt: doc.originalCreatedAt ?? null,
      prevNextFollowUpAt: doc.nextFollowUpAt ?? null, reminders: [],
    };
    doc.assignedTo = to;
    if (newTeam && newTeam !== prevTeam) doc.team = oid(newTeam);
    // Their open reminders on it go with it.
    for (const r of doc.reminders ?? []) {
      if (!r.isDone && idOf(r.createdBy) === fromId) { r.createdBy = to; item.reminders.push(r._id); }
    }
    doc.activityLogs.push({
      action: "lead_transferred",
      description: `Transferred from ${p.from.name} to ${t.name}${byName ? ` by ${byName}` : ""}`,
      performedBy: oid(byUserId),
      changes: { assignedTo: { from: fromId, to: t.userId }, ...(newTeam !== prevTeam ? { team: { from: prevTeam, to: newTeam } } : {}) },
      createdAt: new Date(),
    });
    await doc.save();
    pending.push(item);
    moved++;
    if (pending.length >= 200) await flush();
  }
  await flush();
  await LeadTransfer.updateOne({ _id: batch._id }, { $set: { moved } });
  for (const t of p.targets) if (t.count > 0) void notifyBulkLeadAssignment(t.userId, t.count).catch(() => {});
  return {
    id: String(batch._id),
    from: p.from.name,
    moved,
    targets: p.targets.map((t) => ({ userId: t.userId, name: t.name, count: t.count, team: t.team?.name ?? "" })),
  };
}

/* ── Recent transfers, and Undo ────────────────────────────────────────────────────────────────────────────────── */

export async function listTransfers(limit = 30) {
  const rows = await LeadTransfer.find().select("-items").sort({ createdAt: -1 }).limit(Math.min(100, Math.max(1, limit))).lean();
  const now = Date.now();
  return rows.map((b) => ({
    id: String(b._id), from: b.fromName, by: b.byName, reason: b.reason, moved: b.moved, createdAt: b.createdAt,
    targets: b.targets.map((t) => ({ name: t.name, count: t.count, team: t.teamName })),
    undoneAt: b.undoneAt, undone: b.undone,
    mayUndo: !b.undoneAt && now - new Date(b.createdAt).getTime() < UNDO_MS,
  }));
}

/**
 * Put a transfer back, within 24 hours: each lead nobody has touched since (still with whoever got it, nothing in its
 * history after the transfer) returns to its old owner, team, status and dates; the rest stay and are counted.
 */
export async function undoTransfer(batchId: string, byUserId: string) {
  const batch = await LeadTransfer.findById(oid(batchId));
  if (!batch) throw fail("No such transfer", 404);
  if (batch.undoneAt) throw fail("It was already undone", 409);
  if (Date.now() - new Date(batch.createdAt).getTime() > UNDO_MS) throw fail("It's over 24 hours old — move the leads by hand instead", 409);
  const from = await User.findById(batch.from).select("name status").lean<{ name: string; status: string } | null>();
  if (!from || from.status === "inactive") throw fail(`${batch.fromName} is deactivated or gone — transfer the leads to someone else instead`, 409);
  const by = await User.findById(oid(byUserId)).select("name").lean<{ name: string } | null>();
  const since = new Date(batch.createdAt).getTime();
  let undone = 0, skipped = 0;
  for (const item of batch.items) {
    const lead = await Lead.findById(item.lead).select("assignedTo activityLogs").lean<{ assignedTo?: unknown; activityLogs?: Array<{ action: string; createdAt?: Date }> } | null>();
    const touched = (lead?.activityLogs ?? []).some((l) => l.action !== "lead_transferred" && l.createdAt && new Date(l.createdAt).getTime() > since);
    if (!lead || idOf(lead.assignedTo) !== String(item.to) || touched) { skipped++; continue; }
    // Straight to the collection: the hand-over rule must not re-date it — it goes back exactly as it was.
    const res = await Lead.collection.updateOne(
      { _id: item.lead, assignedTo: item.to },
      {
        $set: {
          assignedTo: batch.from, team: item.prevTeam, status: item.prevStatus,
          createdAt: item.prevCreatedAt, originalCreatedAt: item.prevOriginalCreatedAt,
          ...(HAS_FOLLOW_UP_DATE() ? { nextFollowUpAt: item.prevNextFollowUpAt } : {}),
          "reminders.$[r].createdBy": batch.from, updatedAt: new Date(),
        },
        $push: {
          activityLogs: {
            _id: new Types.ObjectId(), action: "lead_transferred",
            description: `Transfer undone — back to ${batch.fromName}${by?.name ? ` by ${by.name}` : ""}`,
            performedBy: oid(byUserId), createdAt: new Date(),
          },
        } as never,
      },
      { arrayFilters: [{ "r._id": { $in: item.reminders }, "r.createdBy": item.to }] },
    );
    if (res.modifiedCount) undone++; else skipped++;
  }
  batch.undoneAt = new Date();
  batch.undoneBy = by?.name ?? "";
  batch.undone = undone;
  await batch.save();
  return { undone, skipped };
}
