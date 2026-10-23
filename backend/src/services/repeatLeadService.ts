import { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import type { IRole } from "../types/index.js";
import { notify, superAdminIds } from "./notificationService.js";
import { idOf, isSuperAdmin, loadConfig } from "./commissionService.js";
import { announceAssignment } from "./leadAlertService.js";

/*
 * Repeat leads (the user, 2026-10-23): "if repeated leads come, it will go to the team leader first, then he
 * verifies the lead and can move it to the same or another guy in the same team".
 *
 * A number the CRM already has, coming in again from the ads (the sheet / Root sync), used to be skipped without a
 * word. Now it is kept on the lead it belongs to — counted, its campaign noted — and the lead goes to a leader of
 * its team (the holder) instead of back to whoever had it. The team's leaders are told; one of them verifies it and
 * gives it to the same person or another member of that team, and it lands in that person's Today's Leads (the
 * hand-over rule, models/leadHandOver.ts).
 *
 *   - Already a client (closed): it stays with its owner — the enrolment and commission are theirs — and is only
 *     verified.
 *   - No owner and no team: nothing to verify — it goes through the split like a new lead (the caller does that).
 *   - A team with no active leader: a Super Admin holds it; Super Admins and the Sales Manager can give out any.
 *   - Already waiting when it comes again: counted and noted again, the leaders reminded — still one decision.
 */

type Viewer = { userId: string; role?: IRole | null };

export interface RepeatRow {
  name?: string;
  source?: string | null;
  platform?: string | null;
  campaign?: string | null;
  /** What came with it (the sheet's columns), kept as a note on the lead. */
  note?: string;
}

export type RepeatOutcome =
  | { kind: "held"; leadId: string; leadName: string; tell: string[]; alreadyClient: boolean; previousOwnerName: string }
  | { kind: "split"; leadId: string };

const oid = (v: string) => new Types.ObjectId(v);

/** The active leaders of a team that are still active people. */
async function activeLeaders(team: { leaders?: unknown[]; status?: string } | null): Promise<string[]> {
  if (!team || team.status === "inactive") return [];
  const ids = (team.leaders ?? []).map(idOf).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return [];
  const active = new Set(
    (await User.find({ _id: { $in: ids.map(oid) }, status: { $ne: "inactive" } }).select("_id").lean()).map((u) => String(u._id)),
  );
  return ids.filter((id) => active.has(id)); // in the team's order: the first is who holds it
}

/** The team a lead belongs to: its own, else the active team its owner is in. */
async function teamOfLead(lead: { team?: unknown; assignedTo?: unknown }) {
  const teamId = idOf(lead.team);
  if (Types.ObjectId.isValid(teamId)) {
    const t = await Team.findById(teamId).select("name leaders members status").lean<{ _id: Types.ObjectId; name: string; leaders?: unknown[]; members?: unknown[]; status?: string }>();
    if (t) return t;
  }
  const owner = idOf(lead.assignedTo);
  if (!Types.ObjectId.isValid(owner)) return null;
  return Team.findOne({ status: "active", $or: [{ members: oid(owner) }, { leaders: oid(owner) }] })
    .select("name leaders members status")
    .lean<{ _id: Types.ObjectId; name: string; leaders?: unknown[]; members?: unknown[]; status?: string }>();
}

/**
 * The lead `leadId` came in again: counted, noted, and held by its team leader (see above). Returns who to tell, or
 * that it has no owner and no team and should go through the split.
 */
export async function holdRepeatLead(leadId: string, row: RepeatRow, reporterId: string): Promise<RepeatOutcome> {
  const lead = await Lead.findById(leadId);
  if (!lead) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  const now = new Date();
  const where = [row.source, row.platform, row.campaign].filter(Boolean).join(" · ");
  const doc = lead as unknown as Record<string, any>;
  doc.repeatCount = (Number(doc.repeatCount) || 0) + 1;
  lead.notes.push({ content: `Came in again${where ? ` (${where})` : ""} — ${now.toISOString().slice(0, 10)}${row.note ? `\n${row.note}` : ""}`.slice(0, 2000), author: oid(reporterId), createdAt: now, updatedAt: now } as never);

  const ownerId = idOf(lead.assignedTo);
  const team = await teamOfLead(lead);
  if (!Types.ObjectId.isValid(ownerId) && !team) {
    lead.activityLogs.push({ action: "repeat_enquiry", description: `Came in again${where ? ` (${where})` : ""} — no owner or team, so it goes through the split`, performedBy: oid(reporterId), createdAt: now } as never);
    await lead.save();
    return { kind: "split", leadId };
  }

  const leaders = await activeLeaders(team);
  const tell = leaders.length ? leaders : await superAdminIds();
  const alreadyWaiting = doc.repeat?.waiting === true;
  const alreadyClient = lead.status === "closed";
  const previousOwner = alreadyWaiting ? idOf(doc.repeat.previousOwner) : ownerId;
  const previousOwnerName = Types.ObjectId.isValid(previousOwner)
    ? String((await User.findById(previousOwner).select("name").lean<{ name?: string }>())?.name ?? "")
    : "";

  if (alreadyWaiting) {
    doc.repeat.at = now;
    doc.repeat.source = row.source ?? row.platform ?? null;
    doc.repeat.campaign = row.campaign ?? null;
    lead.markModified("repeat");
    lead.activityLogs.push({ action: "repeat_enquiry", description: `Came in again${where ? ` (${where})` : ""} — still waiting for the team leader`, performedBy: oid(reporterId), createdAt: now } as never);
  } else {
    // A leader holds it — the previous owner themselves when they lead the team; else the team's first leader.
    const holder = alreadyClient ? ownerId : leaders.includes(ownerId) ? ownerId : (leaders[0] ?? tell[0] ?? null);
    doc.repeat = {
      waiting: true, at: now, team: team?._id ?? null,
      previousOwner: Types.ObjectId.isValid(previousOwner) ? oid(previousOwner) : null, previousStatus: lead.status,
      alreadyClient, holder: holder && Types.ObjectId.isValid(holder) ? oid(holder) : null,
      source: row.source ?? row.platform ?? null, campaign: row.campaign ?? null,
      decidedBy: null, decidedAt: null, givenTo: null,
    };
    if (!alreadyClient && holder && holder !== ownerId) {
      // A fresh enquiry: Assigned again (a lost lead too), with the leader until they verify it.
      lead.status = "assigned";
      doc.assignedTo = oid(holder);
      doc.assignedAt = now;
    } else if (!alreadyClient && lead.status !== "assigned") {
      lead.status = "assigned";
    }
    if (team && !idOf(lead.team)) doc.team = team._id;
    const holderName = holder && holder !== ownerId ? String((await User.findById(holder).select("name").lean<{ name?: string }>())?.name ?? "the team leader") : "";
    lead.activityLogs.push({
      action: "repeat_enquiry",
      description: (alreadyClient
        ? `Came in again${where ? ` (${where})` : ""} — already a client; waiting for the team leader to verify`
        : `Came in again${where ? ` (${where})` : ""} — ${holderName ? `with ${holderName} (team leader)` : "with the team leader"} to verify${previousOwnerName ? `; was with ${previousOwnerName}` : ""}`).slice(0, 500),
      performedBy: oid(reporterId),
      changes: { assignedTo: { from: ownerId || null, to: idOf(lead.assignedTo) || null } },
      createdAt: now,
    } as never);
  }
  await lead.save();
  return { kind: "held", leadId, leadName: lead.name, tell, alreadyClient, previousOwnerName };
}

/** Tells the leaders about the repeats just held — one notice per person, however many. */
export async function announceRepeats(held: Array<Extract<RepeatOutcome, { kind: "held" }>>): Promise<void> {
  try {
    const byUser = new Map<string, typeof held>();
    for (const h of held) for (const u of h.tell) byUser.set(u, [...(byUser.get(u) ?? []), h]);
    await Promise.all([...byUser].map(async ([userId, list]) => {
      if (list.length === 1) {
        const h = list[0];
        await notify({
          userIds: [userId],
          type: "repeat_lead",
          title: h.alreadyClient ? "Repeat lead — already a client" : "Repeat lead to verify",
          body: `${h.leadName || "A lead"} came in again${h.previousOwnerName ? ` — was with ${h.previousOwnerName}` : ""}. Verify it and give it out.`,
          url: "/repeat-leads",
          tag: `repeat-lead-${h.leadId}`,
          data: { leadId: h.leadId },
        });
        return;
      }
      await notify({
        userIds: [userId],
        type: "repeat_lead",
        title: `${list.length} repeat leads to verify`,
        body: list.slice(0, 3).map((h) => h.leadName || "A lead").join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "") + " came in again.",
        url: "/repeat-leads",
        tag: `repeat-leads-${userId}-${list[0].leadId}`,
        data: { count: list.length },
      });
    }));
  } catch (err) {
    console.error("[repeatLeads] notices failed:", err instanceof Error ? err.message : err);
  }
}

/** Whose repeats this person sees and gives out: all of them (a Super Admin, the Sales Manager), the teams they lead, or none. */
export async function repeatScope(viewer: Viewer): Promise<{ kind: "all" } | { kind: "team"; teamIds: Types.ObjectId[] } | { kind: "none" }> {
  if (isSuperAdmin(viewer.role)) return { kind: "all" };
  const config = await loadConfig();
  if (idOf(config.salesManager) === viewer.userId) return { kind: "all" };
  if (!Types.ObjectId.isValid(viewer.userId)) return { kind: "none" };
  const led = await Team.find({ status: "active", leaders: oid(viewer.userId) }).select("_id").lean();
  return led.length ? { kind: "team", teamIds: led.map((t) => t._id as Types.ObjectId) } : { kind: "none" };
}

const nameOf = (u: unknown) => (u && typeof u === "object" ? String((u as { name?: string }).name ?? "") : "");

/** The repeats this person may see — waiting, decided, or all — with each team's people to give them to. */
export async function listRepeatLeads(viewer: Viewer, state: "waiting" | "done" | "all" = "waiting") {
  const scope = await repeatScope(viewer);
  if (scope.kind === "none") return null;
  const filter: Record<string, unknown> = { "repeat.at": { $ne: null } };
  if (state === "waiting") filter["repeat.waiting"] = true;
  if (state === "done") filter["repeat.waiting"] = false;
  // A team leader: their teams' — and a team-less repeat only an admin gives out.
  if (scope.kind === "team") filter["repeat.team"] = { $in: scope.teamIds };
  const rows = await Lead.find(filter)
    .sort({ "repeat.at": -1 })
    .limit(500)
    .select("name phone email status source campaign platform assignedTo team repeat repeatCount")
    .populate("assignedTo", "name")
    .populate("team", "name")
    .populate("repeat.previousOwner", "name")
    .populate("repeat.decidedBy", "name")
    .populate("repeat.givenTo", "name")
    .lean<Array<Record<string, any>>>();

  const teamIds = [...new Set(rows.map((r) => idOf(r.repeat?.team)).filter((id) => Types.ObjectId.isValid(id)))];
  const teams = await Team.find({ _id: { $in: teamIds.map(oid) } }).select("name leaders members").lean<Array<{ _id: Types.ObjectId; name: string; leaders?: unknown[]; members?: unknown[] }>>();
  const peopleIds = [...new Set(teams.flatMap((t) => [...(t.leaders ?? []), ...(t.members ?? [])].map(idOf)))].filter((id) => Types.ObjectId.isValid(id));
  const people = new Map(
    (await User.find({ _id: { $in: peopleIds.map(oid) }, status: { $ne: "inactive" } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>())
      .map((u) => [String(u._id), u.name]),
  );

  return {
    scope: scope.kind,
    teams: teams.map((t) => ({
      id: String(t._id),
      name: t.name,
      people: [...new Set([...(t.leaders ?? []), ...(t.members ?? [])].map(idOf))]
        .filter((id) => people.has(id))
        .map((id) => ({ id, name: people.get(id)!, leader: (t.leaders ?? []).map(idOf).includes(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
    leads: rows.map((r) => ({
      id: String(r._id),
      name: r.name ?? "",
      phone: r.phone ?? "",
      email: r.email ?? "",
      status: r.status,
      repeatCount: r.repeatCount ?? 0,
      owner: r.assignedTo ? { id: idOf(r.assignedTo), name: nameOf(r.assignedTo) } : null,
      team: r.team ? { id: idOf(r.team), name: nameOf(r.team) } : null,
      repeat: {
        waiting: r.repeat?.waiting === true,
        at: r.repeat?.at,
        teamId: idOf(r.repeat?.team) || null,
        previousOwner: r.repeat?.previousOwner ? { id: idOf(r.repeat.previousOwner), name: nameOf(r.repeat.previousOwner) } : null,
        previousStatus: r.repeat?.previousStatus ?? null,
        alreadyClient: r.repeat?.alreadyClient === true,
        source: r.repeat?.source ?? null,
        campaign: r.repeat?.campaign ?? null,
        decidedBy: r.repeat?.decidedBy ? { id: idOf(r.repeat.decidedBy), name: nameOf(r.repeat.decidedBy) } : null,
        decidedAt: r.repeat?.decidedAt ?? null,
        givenTo: r.repeat?.givenTo ? { id: idOf(r.repeat.givenTo), name: nameOf(r.repeat.givenTo) } : null,
      },
    })),
  };
}

/** How many wait for this person — the sidebar's badge (null: not theirs to see). */
export async function waitingRepeatCount(viewer: Viewer): Promise<number | null> {
  const scope = await repeatScope(viewer);
  if (scope.kind === "none") return null;
  return Lead.countDocuments({ "repeat.waiting": true, ...(scope.kind === "team" ? { "repeat.team": { $in: scope.teamIds } } : {}) });
}

/**
 * The leader verified it: given to `toUserId` — the same person or another of the same team (an already-client
 * lead stays with its owner). It becomes theirs as a new lead, and they are told.
 */
export async function giveRepeatLead(viewer: Viewer, leadId: string, toUserId: string) {
  if (!Types.ObjectId.isValid(leadId)) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  if (!Types.ObjectId.isValid(toUserId)) throw Object.assign(new Error("Pick who gets it"), { statusCode: 400 });
  const lead = await Lead.findById(leadId);
  const doc = lead as unknown as Record<string, any> | null;
  if (!lead || !doc?.repeat) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
  if (!doc.repeat.waiting) throw Object.assign(new Error("This repeat has already been verified"), { statusCode: 409 });

  const scope = await repeatScope(viewer);
  const teamId = idOf(doc.repeat.team);
  const mayDecide = scope.kind === "all" || (scope.kind === "team" && scope.teamIds.some((t) => String(t) === teamId));
  if (!mayDecide) throw Object.assign(new Error("Only a leader of its team can verify this repeat"), { statusCode: 403 });

  const to = await User.findOne({ _id: oid(toUserId), status: { $ne: "inactive" } }).select("name").lean<{ _id: Types.ObjectId; name: string }>();
  if (!to) throw Object.assign(new Error("That person isn't active"), { statusCode: 400 });
  if (Types.ObjectId.isValid(teamId)) {
    const team = await Team.findById(teamId).select("leaders members").lean<{ leaders?: unknown[]; members?: unknown[] }>();
    const inTeam = [...(team?.leaders ?? []), ...(team?.members ?? [])].map(idOf).includes(toUserId);
    if (!inTeam) throw Object.assign(new Error("Give it to someone in the same team"), { statusCode: 400 });
  }
  const ownerNow = idOf(lead.assignedTo);
  if (doc.repeat.alreadyClient && toUserId !== ownerNow) {
    throw Object.assign(new Error("Already a client — it stays with its owner"), { statusCode: 400 });
  }

  const now = new Date();
  const by = await User.findById(viewer.userId).select("name").lean<{ name?: string }>();
  if (toUserId !== ownerNow) {
    doc.assignedTo = to._id;
    doc.assignedAt = now;
    if (!doc.repeat.alreadyClient) lead.status = "assigned";
  }
  doc.repeat.waiting = false;
  doc.repeat.decidedBy = oid(viewer.userId);
  doc.repeat.decidedAt = now;
  doc.repeat.givenTo = to._id;
  lead.markModified("repeat");
  const same = idOf(doc.repeat.previousOwner) === toUserId;
  lead.activityLogs.push({
    action: "repeat_verified",
    description: `Repeat verified by ${by?.name ?? "the team leader"} — ${doc.repeat.alreadyClient ? "already a client, stays with" : same ? "given back to" : "given to"} ${to.name}`.slice(0, 500),
    performedBy: oid(viewer.userId),
    changes: { assignedTo: { from: ownerNow || null, to: toUserId } },
    createdAt: now,
  } as never);
  await lead.save();
  if (toUserId !== viewer.userId && toUserId !== ownerNow) void announceAssignment(toUserId, String(lead._id), lead.name);
  return { id: String(lead._id), givenTo: { id: toUserId, name: to.name } };
}
