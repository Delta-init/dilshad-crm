import { Types, type PipelineStage } from "mongoose";
import { Lead } from "../models/Lead.js";
import { LeadMove } from "../models/LeadMove.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { CallLog } from "../models/CallLog.js";
import { LeadCall } from "../models/LeadCall.js";
import { AppSetting } from "../models/AppSetting.js";
import { emitTeamUpdate } from "../socket.js";
import { getAppSettings, isWithinWorkingHours, type AppSettingsDTO } from "./settingsService.js";
import { notify, superAdminIds } from "./notificationService.js";
import { pickSplitAssignee, runInTeamQueue, type SplitTeam } from "./leadService.js";
import { formatMinutes, startOfLocalDay, workingCutoff, workingMinutesBetween } from "../utils/workingHours.js";
import { buildPagination } from "../utils/response.js";
import type { PaginationMeta } from "../types/index.js";

/*
 * Inactive leads — a lead assigned to someone who has not acted on it within
 * the limit set in Settings (working time only).
 *
 * "Acted" means the owner, since the lead became theirs, changed its status,
 * added a note, logged a follow-up or set a reminder — or anyone has called it,
 * ever (2026-10-17: a lead that was called is active). Opening the lead is not
 * acting on it. A lead whose status has moved past new/assigned
 * has been worked by someone, so it never counts.
 *
 * Such leads move on to the next person by the team's own split rule — never
 * back to anyone who already lost it — either automatically (Settings switch,
 * leads assigned since it went on) or by hand from the super admin's Inactive
 * leads page.
 */

/** Statuses a lead nobody has worked is still in. */
const UNTOUCHED_STATUSES = ["new", "assigned"];
/** Activity entries that count as acting on the lead, when the owner made them. */
const ACTING_LOGS = ["status_changed", "note_added", "note_updated"];
/** Most leads one list holds — the page says when there were more. */
const CANDIDATE_CAP = 2000;
/** Most chunks of CANDIDATE_CAP one search reads past leads their owners phoned (50,000 leads). */
const MAX_CHUNKS = 25;
/** Most leads one automatic pass moves; the rest wait a minute for the next. */
const SWEEP_CAP = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Candidate {
  _id: Types.ObjectId;
  name?: string;
  phone: string;
  source?: string;
  status: string;
  assignedTo: Types.ObjectId;
  assignedAt: Date;
  team?: Types.ObjectId | null;
  inactivity?: { lostBy?: Types.ObjectId[]; moves?: number; stuckAt?: Date | null } | null;
}

interface CandidateFilter {
  /** Assigned at or before this: past the limit in working time. */
  cutoff: Date;
  /** Automatic moves only look at leads assigned since the switch went on. */
  assignedFrom?: Date;
  teamId?: string;
  ownerId?: string;
  search?: string;
  leadIds?: Types.ObjectId[];
  /** Leave out leads already found to have nobody to move to, this assignment. */
  skipStuck?: boolean;
}

interface Person {
  id: string;
  name: string;
}

interface MoveRecord {
  leadId: string;
  leadName: string;
  from: Person;
  to: Person;
  inactiveMinutes: number;
}

export type AutoMoveState = "due" | "off" | "before_switch" | "stuck" | "no_team";

export interface InactiveLeadDTO {
  id: string;
  name: string;
  phone: string;
  source: string | null;
  status: string;
  team: { id: string; name: string } | null;
  owner: { id: string; name: string; email: string; active: boolean } | null;
  assignedAt: string;
  /** Working minutes since it was assigned, with no action. */
  waitingMinutes: number;
  moves: number;
  lostBy: Person[];
  /** What the automatic mover will do with it. */
  autoMove: AutoMoveState;
}

export interface InactiveRuleDTO {
  limitMinutes: number;
  autoReassign: boolean;
  enabledAt: string | null;
  workingHours: AppSettingsDTO["workingHours"];
  inWorkingHours: boolean;
}

export interface InactiveLeadList {
  items: InactiveLeadDTO[];
  summary: { total: number; stuck: number; movedToday: number; capped: boolean };
  rule: InactiveRuleDTO;
  pagination: PaginationMeta;
}

export interface LeadMoveDTO {
  id: string;
  lead: { id: string; name: string };
  team: { id: string; name: string } | null;
  from: Person | null;
  to: Person | null;
  kind: "automatic" | "manual";
  by: Person | null;
  inactiveMinutes: number;
  createdAt: string;
}

export interface ReassignResult {
  moved: Array<{ leadId: string; leadName: string; from: Person; to: Person }>;
  skipped: Array<{ leadId: string; leadName: string; reason: string }>;
}

// ─── Finding them ─────────────────────────────────────────────────────────────

/** True when an entry of `array` was made by the owner at or after assignment. */
const byOwnerSinceAssigned = (array: string, userField: string) => ({
  $anyElementTrue: [
    {
      $map: {
        input: { $ifNull: [array, []] },
        as: "x",
        in: {
          $and: [{ $eq: [`$$x.${userField}`, "$assignedTo"] }, { $gte: ["$$x.createdAt", "$assignedAt"] }],
        },
      },
    },
  ],
});

/** Everything on the lead itself that shows its owner acted on it since it became theirs. */
const OWNER_ACTED = {
  $or: [
    // They added the lead themselves and took it on the spot — timed from when it was first
    // created: every hand-over resets createdAt to that moment (leadHandOver.ts), and a lead
    // handed back to the person who once added it is theirs to act on like any other.
    {
      $and: [
        { $eq: ["$reporter", "$assignedTo"] },
        { $lte: [{ $subtract: ["$assignedAt", { $ifNull: ["$originalCreatedAt", "$createdAt"] }] }, 60_000] },
      ],
    },
    // Stamped by the assigned agent's first call, note or status change. (Not lastContactedAt: the Call button
    // sets it for anyone's call — a colleague phoning the lead is not its owner acting.)
    { $gte: ["$firstContactTime", "$assignedAt"] },
    {
      $anyElementTrue: [
        {
          $map: {
            input: { $ifNull: ["$activityLogs", []] },
            as: "l",
            in: {
              $and: [
                { $eq: ["$$l.performedBy", "$assignedTo"] },
                { $gte: ["$$l.createdAt", "$assignedAt"] },
                {
                  $or: [
                    { $in: ["$$l.action", ACTING_LOGS] },
                    // A status change made through the edit form
                    {
                      $and: [
                        { $eq: ["$$l.action", "lead_updated"] },
                        { $ne: [{ $type: "$$l.changes.status" }, "missing"] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
    byOwnerSinceAssigned("$notes", "author"),
    byOwnerSinceAssigned("$followUps", "followedUpBy"),
    byOwnerSinceAssigned("$reminders", "createdBy"),
  ],
};

/**
 * Still a lead to move: the same owner since the same moment, untouched, and nothing on it showing the owner acted —
 * the filter every move and flag is written under, so a lead worked or closed while the move was on its way is left
 * alone. (Calls live in their own collections and are checked when the leads are found.)
 */
const stillInactive = (lead: Pick<Candidate, "_id" | "assignedTo" | "assignedAt">) => ({
  _id: lead._id,
  assignedTo: lead.assignedTo,
  assignedAt: lead.assignedAt,
  status: { $in: UNTOUCHED_STATUSES },
  $expr: { $not: [OWNER_ACTED] },
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Leads anyone has called (the user, 2026-10-17: "inactive leads only marks leads not called — a lead that was called
 * is an active lead"): any call on record for it, by anyone — its owner, a colleague, someone it had before — at any
 * time, in the Call button's log (call_logs) or the calls 3CX synced (LeadCall, a call made straight from 3CX too). A
 * call out counts even unanswered (somebody tried); a call in only when it was picked up — the client ringing and
 * nobody answering is not the lead being called.
 */
async function leadsCalled(leads: Candidate[]): Promise<Set<string>> {
  const called = new Set<string>();
  if (!leads.length) return called;
  const ids = leads.map((l) => l._id);
  const [logged, synced] = await Promise.all([
    CallLog.distinct("leadId", {
      leadId: { $in: ids },
      $nor: [{ callDirection: "inbound", callType: { $in: ["Missed", "Notanswered"] } }],
    }),
    LeadCall.distinct("lead", { lead: { $in: ids }, $or: [{ direction: "out" }, { status: "answered" }] }),
  ]);
  for (const id of [...logged, ...synced]) if (id) called.add(String(id));
  return called;
}

/** Inactive leads matching `f`, longest-waiting first. */
async function findInactiveLeads(f: CandidateFilter): Promise<{ leads: Candidate[]; capped: boolean }> {
  const assignedAt: Record<string, unknown> = { $ne: null, $lte: f.cutoff };
  if (f.assignedFrom) assignedAt.$gte = f.assignedFrom;

  const match: Record<string, unknown> = {
    status: { $in: UNTOUCHED_STATUSES },
    assignedTo: f.ownerId ? new Types.ObjectId(f.ownerId) : { $ne: null },
    assignedAt,
  };
  if (f.teamId) match.team = new Types.ObjectId(f.teamId);
  if (f.leadIds) match._id = { $in: f.leadIds };
  if (f.search) {
    const rx = new RegExp(escapeRegex(f.search), "i");
    match.$or = [{ name: rx }, { phone: rx }, { email: rx }];
  }

  const notActed: PipelineStage[] = [];
  if (f.skipStuck) {
    notActed.push({ $match: { $expr: { $not: [{ $gte: ["$inactivity.stuckAt", "$assignedAt"] }] } } });
  }
  notActed.push({ $match: { $expr: { $not: [OWNER_ACTED] } } });
  const project: PipelineStage = {
    $project: { name: 1, phone: 1, source: 1, status: 1, assignedTo: 1, assignedAt: 1, team: 1, inactivity: 1 },
  };

  // Calls live in their own collections, so they are checked a chunk at a time, and the cap counts what is left —
  // leads somebody phoned (their status not moved on) must not fill it and hide newer inactive ones. Each chunk
  // carries on from the last lead read (longest waiting first).
  const leads: Candidate[] = [];
  let last: Candidate | null = null;
  let more = false;
  for (let chunk = 0; leads.length <= CANDIDATE_CAP; chunk++) {
    if (chunk === MAX_CHUNKS) {
      more = true;
      break;
    }
    const after: PipelineStage[] = last
      ? [{ $match: { $or: [{ assignedAt: { $gt: last.assignedAt } }, { assignedAt: last.assignedAt, _id: { $gt: last._id } }] } }]
      : [];
    const rows = await Lead.aggregate<Candidate>([
      { $match: match },
      ...after,
      ...notActed,
      { $sort: { assignedAt: 1, _id: 1 } },
      { $limit: CANDIDATE_CAP },
      project,
    ]);
    const called = await leadsCalled(rows);
    for (const r of rows) if (!called.has(String(r._id))) leads.push(r);
    if (rows.length < CANDIDATE_CAP) break;
    last = rows[rows.length - 1];
  }
  return { leads: leads.slice(0, CANDIDATE_CAP), capped: more || leads.length > CANDIDATE_CAP };
}

const isStuck = (l: Candidate): boolean => Boolean(l.inactivity?.stuckAt && l.inactivity.stuckAt >= l.assignedAt);

function autoMoveState(l: Candidate, s: AppSettingsDTO): AutoMoveState {
  if (!s.inactiveLeads.autoReassign) return "off";
  if (!l.team) return "no_team";
  if (isStuck(l)) return "stuck";
  if (s.inactiveLeads.enabledAt && l.assignedAt < new Date(s.inactiveLeads.enabledAt)) return "before_switch";
  return "due";
}

const ruleOf = (s: AppSettingsDTO, now: Date): InactiveRuleDTO => ({
  limitMinutes: s.inactiveLeads.limitMinutes,
  autoReassign: s.inactiveLeads.autoReassign,
  enabledAt: s.inactiveLeads.enabledAt,
  workingHours: s.workingHours,
  inWorkingHours: isWithinWorkingHours(s, now),
});

// ─── For the Workflow tab (2026-10-17) ───────────────────────────────────────

/** Every lead inactive right now, as the page and the mover count it, with what the mover will do with it. The first 2,000. */
export async function inactiveNow(now: Date = new Date()): Promise<Map<string, { owner: string; state: AutoMoveState }>> {
  const settings = await getAppSettings();
  const cutoff = workingCutoff(settings.workingHours, now, settings.inactiveLeads.limitMinutes);
  const { leads } = await findInactiveLeads({ cutoff });
  return new Map(leads.map((l) => [String(l._id), { owner: String(l.assignedTo), state: autoMoveState(l, settings) }]));
}

/** Of these leads, the ones their owner acted on since they became theirs, or anyone has called — the page's rules. */
export async function actedOn(ids: Types.ObjectId[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const rows = await Lead.aggregate<Candidate & { acted: boolean }>([
    { $match: { _id: { $in: ids }, assignedTo: { $ne: null } } },
    { $project: { assignedTo: 1, assignedAt: 1, acted: OWNER_ACTED } },
  ]);
  for (const r of rows) if (r.acted) out.add(String(r._id));
  for (const id of await leadsCalled(rows)) out.add(id);
  return out;
}

// ─── The page ─────────────────────────────────────────────────────────────────

export async function listInactiveLeads(
  q: { page: number; limit: number; teamId?: string; ownerId?: string; search?: string },
  now: Date = new Date(),
): Promise<InactiveLeadList> {
  const settings = await getAppSettings();
  const cutoff = workingCutoff(settings.workingHours, now, settings.inactiveLeads.limitMinutes);
  const { leads, capped } = await findInactiveLeads({ cutoff, teamId: q.teamId, ownerId: q.ownerId, search: q.search });

  const pageRows = leads.slice((q.page - 1) * q.limit, q.page * q.limit);

  const userIds = new Set<string>();
  for (const l of pageRows) {
    userIds.add(String(l.assignedTo));
    for (const u of l.inactivity?.lostBy ?? []) userIds.add(String(u));
  }
  const teamIds = [...new Set(pageRows.filter((l) => l.team).map((l) => String(l.team)))];
  const [users, teams, movedToday] = await Promise.all([
    User.find({ _id: { $in: [...userIds] } })
      .select("name email status")
      .lean<Array<{ _id: Types.ObjectId; name: string; email: string; status: string }>>(),
    Team.find({ _id: { $in: teamIds } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>(),
    LeadMove.countDocuments({ createdAt: { $gte: startOfLocalDay(settings.workingHours.timezone, now) } }),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const teamById = new Map(teams.map((t) => [String(t._id), t]));

  const items: InactiveLeadDTO[] = pageRows.map((l) => {
    const owner = userById.get(String(l.assignedTo));
    const team = l.team ? teamById.get(String(l.team)) : undefined;
    return {
      id: String(l._id),
      name: l.name ?? "",
      phone: l.phone,
      source: l.source ?? null,
      status: l.status,
      team: team ? { id: String(team._id), name: team.name } : null,
      owner: owner
        ? { id: String(owner._id), name: owner.name, email: owner.email, active: owner.status !== "inactive" }
        : null,
      assignedAt: l.assignedAt.toISOString(),
      waitingMinutes: Math.floor(workingMinutesBetween(settings.workingHours, l.assignedAt, now)),
      moves: l.inactivity?.moves ?? 0,
      lostBy: (l.inactivity?.lostBy ?? []).map((u) => ({ id: String(u), name: userById.get(String(u))?.name ?? "Unknown" })),
      autoMove: autoMoveState(l, settings),
    };
  });

  return {
    items,
    summary: { total: leads.length, stuck: leads.filter(isStuck).length, movedToday, capped },
    rule: ruleOf(settings, now),
    pagination: buildPagination(leads.length, q.page, q.limit),
  };
}

export async function listLeadMoves(q: {
  page: number;
  limit: number;
  kind?: "automatic" | "manual";
  teamId?: string;
}): Promise<{ items: LeadMoveDTO[]; pagination: PaginationMeta }> {
  const filter: Record<string, unknown> = {};
  if (q.kind) filter.kind = q.kind;
  if (q.teamId) filter.team = new Types.ObjectId(q.teamId);

  type Ref = { _id: Types.ObjectId; name: string } | null;
  const [rows, total] = await Promise.all([
    LeadMove.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("from", "name")
      .populate("to", "name")
      .populate("by", "name")
      .populate("team", "name")
      .lean<
        Array<{
          _id: Types.ObjectId;
          lead: Types.ObjectId;
          leadName: string;
          team: Ref;
          from: Ref;
          to: Ref;
          by: Ref;
          kind: "automatic" | "manual";
          inactiveMinutes: number;
          createdAt: Date;
        }>
      >(),
    LeadMove.countDocuments(filter),
  ]);

  const person = (r: Ref): Person | null => (r ? { id: String(r._id), name: r.name } : null);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      lead: { id: String(r.lead), name: r.leadName },
      team: r.team ? { id: String(r.team._id), name: r.team.name } : null,
      from: person(r.from),
      to: person(r.to),
      kind: r.kind,
      by: person(r.by),
      inactiveMinutes: r.inactiveMinutes,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    pagination: buildPagination(total, q.page, q.limit),
  };
}

// ─── Moving one ───────────────────────────────────────────────────────────────

/**
 * Hands the lead to `to` — only if it is still inactive with the same person
 * from the same moment it was read (`stillInactive`), so a lead reassigned,
 * moved, worked or closed in between is left alone. Logged on the lead and in
 * the move log. True when it moved.
 */
async function moveLead(
  lead: Candidate,
  to: Person,
  from: Person,
  ctx: { kind: "automatic" | "manual"; by: Person | null; now: Date; inactiveMinutes: number },
): Promise<boolean> {
  const waited = formatMinutes(ctx.inactiveMinutes);
  const description =
    ctx.kind === "automatic"
      ? `Moved from ${from.name} to ${to.name} automatically — no action for ${waited} of working time`
      : `Moved from ${from.name} to ${to.name} from the Inactive leads page — no action for ${waited} of working time`;

  const log: Record<string, unknown> = {
    action: "inactive_reassigned",
    description,
    changes: { owner: { from: from.name, to: to.name } },
    createdAt: ctx.now,
  };
  if (ctx.by) log.performedBy = new Types.ObjectId(ctx.by.id);

  const result = await Lead.updateOne(
    stillInactive(lead),
    {
      $set: {
        assignedTo: new Types.ObjectId(to.id),
        assignedAt: ctx.now,
        status: "assigned",
        firstContactTime: null,
        "inactivity.lastMovedAt": ctx.now,
        "inactivity.stuckAt": null,
      },
      $addToSet: { "inactivity.lostBy": lead.assignedTo },
      $inc: { "inactivity.moves": 1 },
      $push: { activityLogs: log },
    },
  );
  if (!result.modifiedCount) return false;

  await LeadMove.create({
    lead: lead._id,
    leadName: lead.name ?? "",
    team: lead.team ?? null,
    from: lead.assignedTo,
    to: new Types.ObjectId(to.id),
    kind: ctx.kind,
    by: ctx.by ? new Types.ObjectId(ctx.by.id) : null,
    inactiveMinutes: Math.floor(ctx.inactiveMinutes),
  });

  // The team's live activity feed, in the shape leadService already sends it.
  if (lead.team) {
    emitTeamUpdate(String(lead.team), {
      _id: new Types.ObjectId().toString(),
      type: "activity",
      action: "inactive_reassigned",
      description,
      performedBy: ctx.by ? { _id: ctx.by.id, name: ctx.by.name, email: "" } : null,
      leadId: String(lead._id),
      leadName: lead.name ?? "",
      changes: log.changes,
      createdAt: ctx.now.toISOString(),
    });
  }
  return true;
}

/**
 * The lead's next owner by its team's split rule, and the move — both inside
 * the team's split queue so the pick sees every assignment before it.
 * Nobody who already lost it, and nobody deactivated, is picked. `changed`:
 * the lead was worked, closed or moved meanwhile, and nobody's turn was spent.
 */
async function moveWithinTeam(
  lead: Candidate,
  from: Person,
  ctx: { kind: "automatic" | "manual"; by: Person | null; now: Date; inactiveMinutes: number },
): Promise<{ to: Person | null; moved: boolean; changed?: boolean }> {
  if (!lead.team) return { to: null, moved: false };
  const teamId = String(lead.team);
  return runInTeamQueue(teamId, async () => {
    // Checked here, where every move queued before it has landed: a lead another pass or a hand move already took,
    // or its owner has acted on, is left alone before anyone's turn is spent on it.
    if (!(await Lead.exists(stillInactive(lead)))) return { to: null, moved: false, changed: true };
    const team = await Team.findById(teamId)
      .populate("members", "_id status")
      .populate("leaders", "_id status")
      .lean<(SplitTeam & { status?: string; members: Array<{ _id: Types.ObjectId; status?: string }>; leaders: Array<{ _id: Types.ObjectId; status?: string }> }) | null>();
    if (!team || team.status === "inactive") return { to: null, moved: false };

    const exclude = new Set<string>([String(lead.assignedTo), ...(lead.inactivity?.lostBy ?? []).map(String)]);
    for (const u of [...team.members, ...team.leaders]) {
      if (u.status === "inactive") exclude.add(String(u._id));
    }

    const pick = await pickSplitAssignee(team, String(lead._id), { exclude: [...exclude] });
    if (!pick) return { to: null, moved: false };
    const user = await User.findById(pick).select("name").lean<{ _id: Types.ObjectId; name: string } | null>();
    if (!user) return { to: null, moved: false };
    const to = { id: String(user._id), name: user.name };
    const moved = await moveLead(lead, to, from, ctx);
    return moved ? { to, moved } : { to, moved, changed: true };
  });
}

async function markStuck(lead: Candidate, now: Date): Promise<boolean> {
  const result = await Lead.updateOne(stillInactive(lead), { $set: { "inactivity.stuckAt": now } });
  return result.modifiedCount > 0;
}

// ─── Telling people ───────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

/** "A, B and 3 more" — for a title-length list. */
function shortList(names: string[], max = 3): string {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * One notice per person per pass, however many leads it covers: the person
 * who lost leads, the person who got them and — for automatic moves — the
 * super admins. A manual move was made by a super admin; they know.
 */
async function notifyMoves(moves: MoveRecord[], kind: "automatic" | "manual", limitMinutes: number): Promise<void> {
  if (!moves.length) return;
  const limit = formatMinutes(limitMinutes);
  const tasks: Array<Promise<void>> = [];

  for (const [fromId, list] of groupBy(moves, (m) => m.from.id)) {
    const one = list.length === 1 ? list[0] : null;
    const title = one ? `Lead moved to ${one.to.name}` : `${list.length} of your leads were moved on`;
    const body = one
      ? `${one.leadName} had no action from you within ${limit} of working time, so it went to ${one.to.name}.`
      : `${shortList(list.map((m) => m.leadName))} had no action from you within ${limit} of working time, so they went to others.`;
    tasks.push(
      notify({
        userIds: [fromId],
        type: "inactive_lead_moved",
        title,
        body,
        url: "/leads",
        tag: `inactive-moved-${fromId}`,
        email: {
          setting: "inactiveLeads",
          subject: title,
          paragraphs: [
            one
              ? `${one.leadName} was assigned to you but had no status change, note, follow-up, call or reminder from you within ${limit} of working time, so it has gone to ${one.to.name}.`
              : `These leads were assigned to you but had no status change, note, follow-up, call or reminder from you within ${limit} of working time, so they have gone to others:`,
            ...(one ? [] : list.map((m) => `• ${m.leadName} → ${m.to.name}`)),
            "Leads that are acted on quickly stay with you.",
          ],
          actionLabel: "Open my leads",
        },
      }),
    );
  }

  for (const [toId, list] of groupBy(moves, (m) => m.to.id)) {
    const one = list.length === 1 ? list[0] : null;
    const title = one ? `New lead: ${one.leadName}` : `${list.length} new leads for you`;
    const body = one
      ? `Moved to you from ${one.from.name}, who didn't act on it in time. Please contact them now.`
      : `${shortList(list.map((m) => m.leadName))} were moved to you because nobody acted on them in time. Please contact them now.`;
    tasks.push(
      notify({
        userIds: [toId],
        // The bell and the sidebar treat it like any lead handed to them.
        type: "lead_assigned",
        title,
        body,
        url: one ? `/leads/${one.leadId}` : "/leads",
        tag: one ? `lead-assigned-${one.leadId}` : `inactive-received-${toId}`,
        email: {
          setting: "inactiveLeads",
          subject: title,
          paragraphs: [
            one
              ? `${one.leadName} has been moved to you from ${one.from.name}, who didn't act on it within ${limit} of working time.`
              : `These leads have been moved to you because nobody acted on them within ${limit} of working time:`,
            ...(one ? [] : list.map((m) => `• ${m.leadName} (from ${m.from.name})`)),
            "Please contact them as soon as you can — the same limit applies to you.",
          ],
          actionLabel: one ? "Open the lead" : "Open my leads",
        },
      }),
    );
  }

  if (kind === "automatic") {
    const admins = await superAdminIds();
    if (admins.length) {
      const title = moves.length === 1 ? `Inactive lead moved: ${moves[0].leadName}` : `${moves.length} inactive leads moved`;
      const lines = moves.map((m) => `${m.leadName}: ${m.from.name} → ${m.to.name}`);
      tasks.push(
        notify({
          userIds: admins,
          type: "inactive_leads_moved",
          title,
          body: lines.length <= 3 ? lines.join(" · ") : `${lines.slice(0, 3).join(" · ")} and ${lines.length - 3} more`,
          url: "/inactive-leads",
          tag: "inactive-leads-moved",
          email: {
            setting: "inactiveLeads",
            subject: title,
            paragraphs: [
              `These leads had no action within ${limit} of working time and were moved to the next person in their team:`,
              ...lines.map((l) => `• ${l}`),
            ],
            actionLabel: "Open Inactive leads",
          },
        }),
      );
    }
  }

  await Promise.allSettled(tasks);
}

/** Leads nobody is left to take — the super admins, once per lead and assignment. */
async function notifyStuck(stuck: Array<{ lead: Candidate; ownerName: string; teamName: string | null }>, limitMinutes: number): Promise<void> {
  if (!stuck.length) return;
  const admins = await superAdminIds();
  if (!admins.length) return;
  const limit = formatMinutes(limitMinutes);
  const lines = stuck.map(
    (s) => `${s.lead.name ?? "A lead"} (${s.ownerName}${s.teamName ? `, ${s.teamName}` : ", no team"})`,
  );
  const title = stuck.length === 1 ? `Inactive lead needs you: ${stuck[0].lead.name ?? ""}` : `${stuck.length} inactive leads need you`;
  await notify({
    userIds: admins,
    type: "inactive_leads_stuck",
    title,
    body: `No action within ${limit}, and nobody else in the team can take ${stuck.length === 1 ? "it" : "them"}. Move ${stuck.length === 1 ? "it" : "them"} by hand.`,
    url: "/inactive-leads",
    tag: "inactive-leads-stuck",
    email: {
      setting: "inactiveLeads",
      subject: title,
      paragraphs: [
        `These leads had no action within ${limit} of working time, but there is nobody left in their team to move them to — everyone else has lost them before, is away, or they have no team:`,
        ...lines.map((l) => `• ${l}`),
        "Pick someone for them on the Inactive leads page.",
      ],
      actionLabel: "Open Inactive leads",
    },
  });
}

async function names(ids: string[]): Promise<Map<string, string>> {
  const users = await User.find({ _id: { $in: ids } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>();
  return new Map(users.map((u) => [String(u._id), u.name]));
}

// ─── For the page's pickers ───────────────────────────────────────────────────

/**
 * Who a lead can be moved to by hand — everyone active, by name: the Move
 * dialog's list, for whoever may move leads (no Users permission needed).
 */
export async function listMovePeople(
  q: { search?: string },
): Promise<Array<{ id: string; name: string; email: string; designation: string | null }>> {
  const filter: Record<string, unknown> = { status: { $ne: "inactive" } };
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const users = await User.find(filter)
    .select("name email designation")
    .sort({ name: 1, _id: 1 })
    .limit(100)
    .lean<Array<{ _id: Types.ObjectId; name: string; email: string; designation?: string | null }>>();
  return users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, designation: u.designation ?? null }));
}

/** Every active team, by name — the page's team filter (no Teams permission needed). */
export async function listFilterTeams(): Promise<Array<{ id: string; name: string }>> {
  const teams = await Team.find({ status: { $ne: "inactive" } })
    .select("name")
    .sort({ name: 1, _id: 1 })
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  return teams.map((t) => ({ id: String(t._id), name: t.name }));
}

// ─── By hand, from the page ───────────────────────────────────────────────────

/**
 * Moves the chosen leads — to one person, or each to the next in its team by
 * the split rule. Each lead is checked again first: one worked or moved since
 * the page loaded is skipped and says why.
 */
export async function reassignInactiveLeads(
  input: { leadIds: string[]; to?: string },
  byUserId: string,
  now: Date = new Date(),
): Promise<ReassignResult> {
  const settings = await getAppSettings();
  const limitMinutes = settings.inactiveLeads.limitMinutes;
  const ids = [...new Set(input.leadIds)].map((id) => new Types.ObjectId(id));

  let target: Person | null = null;
  if (input.to) {
    const user = await User.findOne({ _id: input.to, status: { $ne: "inactive" } })
      .select("name")
      .lean<{ _id: Types.ObjectId; name: string } | null>();
    if (!user) throw Object.assign(new Error("That person doesn't exist or is deactivated"), { statusCode: 400 });
    target = { id: String(user._id), name: user.name };
  }

  const cutoff = workingCutoff(settings.workingHours, now, limitMinutes);
  const { leads } = await findInactiveLeads({ cutoff, leadIds: ids });
  const inactive = new Map(leads.map((l) => [String(l._id), l]));

  const result: ReassignResult = { moved: [], skipped: [] };
  const missing = ids.filter((id) => !inactive.has(String(id)));
  if (missing.length) {
    const found = await Lead.find({ _id: { $in: missing } }).select("name").lean<Array<{ _id: Types.ObjectId; name?: string }>>();
    const nameOf = new Map(found.map((l) => [String(l._id), l.name ?? ""]));
    for (const id of missing) {
      result.skipped.push({
        leadId: String(id),
        leadName: nameOf.get(String(id)) ?? "",
        reason: nameOf.has(String(id)) ? "Not inactive any more — it was worked, closed or moved" : "Lead not found",
      });
    }
  }

  const byName = (await names([byUserId])).get(byUserId) ?? "Super admin";
  const by: Person = { id: byUserId, name: byName };
  const ownerNames = await names([...new Set(leads.map((l) => String(l.assignedTo)))]);
  const moves: MoveRecord[] = [];

  for (const id of ids) {
    const lead = inactive.get(String(id));
    if (!lead) continue;
    const from: Person = { id: String(lead.assignedTo), name: ownerNames.get(String(lead.assignedTo)) ?? "Unknown" };
    const ctx = {
      kind: "manual" as const,
      by,
      now,
      inactiveMinutes: workingMinutesBetween(settings.workingHours, lead.assignedAt, now),
    };
    const skip = (reason: string) => result.skipped.push({ leadId: String(lead._id), leadName: lead.name ?? "", reason });

    let to: Person | null = null;
    let moved = false;
    let changed = false;
    if (target) {
      if (target.id === from.id) {
        skip(`It is already ${target.name}'s`);
        continue;
      }
      to = target;
      moved = await moveLead(lead, target, from, ctx);
    } else {
      if (!lead.team) {
        skip("It has no team — pick a person instead");
        continue;
      }
      ({ to, moved, changed = false } = await moveWithinTeam(lead, from, ctx));
      if (!to && !changed) {
        skip("Nobody else in the team can take it — pick a person instead");
        continue;
      }
    }

    if (!moved || !to) {
      // Worked, closed or moved on while this request was on its way.
      skip("Not inactive any more — it was worked, closed or moved");
      continue;
    }
    result.moved.push({ leadId: String(lead._id), leadName: lead.name ?? "", from, to });
    moves.push({ leadId: String(lead._id), leadName: lead.name ?? "", from, to, inactiveMinutes: ctx.inactiveMinutes });
  }

  await notifyMoves(moves, "manual", limitMinutes);
  return result;
}

// ─── Automatically, every minute ──────────────────────────────────────────────

export interface SweepResult {
  moved: number;
  stuck: number;
  /** Why nothing was looked at, when nothing was. */
  idle?: "off" | "outside working hours";
}

/**
 * One pass of the automatic mover: every lead assigned since the switch went
 * on that is now past the limit moves to the next person in its team, or —
 * with nobody left to take it — is flagged to the super admins, once.
 * Only in working hours: nobody is handed a lead, or told they lost one, at night.
 */
export async function sweepInactiveLeads(now: Date = new Date()): Promise<SweepResult> {
  const settings = await getAppSettings();
  const { autoReassign, limitMinutes } = settings.inactiveLeads;
  if (!autoReassign) return { moved: 0, stuck: 0, idle: "off" };

  let enabledAt = settings.inactiveLeads.enabledAt ? new Date(settings.inactiveLeads.enabledAt) : null;
  if (!enabledAt) {
    // Switched on before the time was recorded: count from now, never the backlog.
    enabledAt = now;
    await AppSetting.updateOne(
      { key: "app", "inactiveLeads.autoReassign": true, "inactiveLeads.enabledAt": null },
      { $set: { "inactiveLeads.enabledAt": now } },
    );
  }
  if (!isWithinWorkingHours(settings, now)) return { moved: 0, stuck: 0, idle: "outside working hours" };

  const cutoff = workingCutoff(settings.workingHours, now, limitMinutes);
  if (cutoff < enabledAt) return { moved: 0, stuck: 0 };

  const { leads } = await findInactiveLeads({ cutoff, assignedFrom: enabledAt, skipStuck: true });
  const batch = leads.slice(0, SWEEP_CAP);
  if (!batch.length) return { moved: 0, stuck: 0 };

  const ownerNames = await names([...new Set(batch.map((l) => String(l.assignedTo)))]);
  const teamNames = new Map(
    (
      await Team.find({ _id: { $in: batch.filter((l) => l.team).map((l) => l.team) } })
        .select("name")
        .lean<Array<{ _id: Types.ObjectId; name: string }>>()
    ).map((t) => [String(t._id), t.name]),
  );

  const moves: MoveRecord[] = [];
  const stuck: Array<{ lead: Candidate; ownerName: string; teamName: string | null }> = [];

  for (const lead of batch) {
    const from: Person = { id: String(lead.assignedTo), name: ownerNames.get(String(lead.assignedTo)) ?? "Unknown" };
    const inactiveMinutes = workingMinutesBetween(settings.workingHours, lead.assignedAt, now);
    try {
      const { to, moved, changed } = await moveWithinTeam(lead, from, { kind: "automatic", by: null, now, inactiveMinutes });
      if (moved && to) {
        moves.push({ leadId: String(lead._id), leadName: lead.name ?? "", from, to, inactiveMinutes });
      } else if (!to && !changed && (await markStuck(lead, now))) {
        stuck.push({ lead, ownerName: from.name, teamName: lead.team ? teamNames.get(String(lead.team)) ?? null : null });
      }
      // Worked, closed or moved meanwhile: left alone (still inactive, it is looked at again next minute).
    } catch (err) {
      console.error(`[inactiveLeads] could not move lead ${String(lead._id)}:`, err instanceof Error ? err.message : err);
    }
  }

  await notifyMoves(moves, "automatic", limitMinutes);
  await notifyStuck(stuck, limitMinutes);
  if (moves.length || stuck.length) {
    console.log(`[inactiveLeads] moved ${moves.length}, nobody to take ${stuck.length}`);
  }
  return { moved: moves.length, stuck: stuck.length };
}
