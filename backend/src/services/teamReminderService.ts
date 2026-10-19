import { Types, type PipelineStage } from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import type { IRole } from "../types/index.js";
import { idOf, isSuperAdmin, loadConfig } from "./commissionService.js";

/*
 * Other people's reminders (the user, 2026-10-19): the Reminders page opens on
 * your own, as before. A Super Admin or the Sales Manager gets an "All
 * reminders" button — everyone's — and a team leader a "Team reminders" button
 * — the members and leaders of the active teams they lead. Nothing of anyone
 * else's loads until the button is clicked, and it is view only: a reminder is
 * marked done, edited or deleted by the person who set it.
 *
 * "Whose" is who set the reminder (createdBy), the same as "my reminders".
 */

export interface Viewer {
  userId: string;
  role?: IRole | null;
}

export type ReminderScope =
  | { kind: "all" }
  | { kind: "team"; people: Types.ObjectId[]; teamIds: Types.ObjectId[] }
  | { kind: "none" };

/** Most reminders one list holds — the page says when there were more. */
const CAP = 1000;

export async function reminderScope(viewer: Viewer): Promise<ReminderScope> {
  if (isSuperAdmin(viewer.role)) return { kind: "all" };
  const config = await loadConfig();
  if (idOf(config.salesManager) === viewer.userId) return { kind: "all" };
  if (!Types.ObjectId.isValid(viewer.userId)) return { kind: "none" };
  const led = await Team.find({ status: "active", leaders: new Types.ObjectId(viewer.userId) })
    .select("_id members leaders")
    .lean<Array<{ _id: Types.ObjectId; members?: unknown[]; leaders?: unknown[] }>>();
  if (!led.length) return { kind: "none" };
  const people = new Map<string, Types.ObjectId>();
  for (const t of led) {
    for (const u of [...(t.members ?? []), ...(t.leaders ?? [])]) {
      const id = idOf(u);
      if (Types.ObjectId.isValid(id)) people.set(id, new Types.ObjectId(id));
    }
  }
  return { kind: "team", people: [...people.values()], teamIds: led.map((t) => t._id) };
}

export interface TeamReminderOptions {
  scope: "all" | "team" | null;
  people: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
}

/** Which button the page shows, and the people and teams its filters list. */
export async function teamReminderOptions(viewer: Viewer): Promise<TeamReminderOptions> {
  const scope = await reminderScope(viewer);
  if (scope.kind === "none") return { scope: null, people: [], teams: [] };
  const [users, teams] = await Promise.all([
    User.find(scope.kind === "all" ? { status: "active" } : { _id: { $in: scope.people } })
      .select("name").sort({ name: 1 })
      .lean<Array<{ _id: Types.ObjectId; name: string }>>(),
    Team.find(scope.kind === "all" ? { status: "active" } : { _id: { $in: scope.teamIds } })
      .select("name").sort({ name: 1 })
      .lean<Array<{ _id: Types.ObjectId; name: string }>>(),
  ]);
  return {
    scope: scope.kind,
    people: users.map((u) => ({ id: String(u._id), name: u.name })),
    teams: teams.map((t) => ({ id: String(t._id), name: t.name })),
  };
}

export type ReminderState = "active" | "done" | "all";

export interface TeamRemindersQuery {
  personId?: string;
  teamId?: string;
  state?: ReminderState;
}

type Row = {
  _id: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  status: string;
  assignedTo?: Types.ObjectId | null;
  team?: Types.ObjectId | null;
  reminder: { _id: Types.ObjectId; createdBy: Types.ObjectId; remindAt: Date; isDone: boolean; title?: string; note?: string; createdAt?: Date };
};

/**
 * The reminders the viewer may see of others, in the shape of "my reminders" plus who set each (`owner`).
 * Returns null when the viewer has no such view, or asked for a person or team outside it.
 */
export async function listTeamReminders(viewer: Viewer, q: TeamRemindersQuery) {
  const scope = await reminderScope(viewer);
  if (scope.kind === "none") return null;

  // Whose reminders: everyone in the scope, narrowed by the person or team asked for.
  let people: Types.ObjectId[] | null = scope.kind === "team" ? scope.people : null;
  if (q.teamId) {
    if (!Types.ObjectId.isValid(q.teamId)) return null;
    if (scope.kind === "team" && !scope.teamIds.some((t) => t.equals(q.teamId!))) return null;
    const team = await Team.findById(q.teamId).select("members leaders").lean<{ members?: unknown[]; leaders?: unknown[] } | null>();
    if (!team) return null;
    const ids = [...(team.members ?? []), ...(team.leaders ?? [])].map(idOf).filter((id) => Types.ObjectId.isValid(id));
    people = (people ?? ids.map((id) => new Types.ObjectId(id))).filter((p) => ids.includes(String(p)));
  }
  if (q.personId) {
    if (!Types.ObjectId.isValid(q.personId)) return null;
    if (people && !people.some((p) => p.equals(q.personId!))) return q.teamId ? { items: [], capped: false } : null;
    people = [new Types.ObjectId(q.personId)];
  }

  const state = q.state ?? "active";
  const byWhom = people ? { "reminders.createdBy": { $in: people } } : {};
  const done = state === "active" ? { "reminders.isDone": { $ne: true } } : state === "done" ? { "reminders.isDone": true } : {};
  const pipeline: PipelineStage[] = [
    { $match: people ? byWhom : { "reminders.0": { $exists: true } } },
    { $unwind: "$reminders" },
    { $match: { ...byWhom, ...done } },
    // Open ones soonest first; done ones latest first.
    { $sort: state === "done" ? { "reminders.remindAt": -1 } : { "reminders.isDone": 1, "reminders.remindAt": 1 } },
    { $limit: CAP + 1 },
    { $project: { name: 1, phone: 1, email: 1, status: 1, assignedTo: 1, team: 1, reminder: "$reminders" } },
  ];
  const rows = await Lead.aggregate<Row>(pipeline);
  const capped = rows.length > CAP;
  const kept = rows.slice(0, CAP);

  const userIds = [...new Set(kept.flatMap((r) => [idOf(r.reminder.createdBy), idOf(r.assignedTo)]).filter(Boolean))];
  const teamIds = [...new Set(kept.map((r) => idOf(r.team)).filter(Boolean))];
  const [users, teams] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select("name email").lean<Array<{ _id: Types.ObjectId; name: string; email: string }>>(),
    Team.find({ _id: { $in: teamIds } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>(),
  ]);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const teamOf = new Map(teams.map((t) => [String(t._id), t]));

  const items = kept.map((r) => {
    const owner = userOf.get(idOf(r.reminder.createdBy));
    const assignee = r.assignedTo ? userOf.get(idOf(r.assignedTo)) : undefined;
    const team = r.team ? teamOf.get(idOf(r.team)) : undefined;
    return {
      ...r.reminder,
      owner: { _id: idOf(r.reminder.createdBy), name: owner?.name ?? "Unknown" },
      lead: {
        _id: r._id,
        name: r.name,
        phone: r.phone,
        email: r.email,
        status: r.status,
        assignedTo: assignee ? { _id: assignee._id, name: assignee.name, email: assignee.email } : null,
        team: team ? { _id: team._id, name: team.name } : null,
      },
    };
  });
  return { items, capped };
}
