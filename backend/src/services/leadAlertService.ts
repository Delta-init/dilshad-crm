import { AsyncLocalStorage } from "node:async_hooks";
import { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { notify, superAdminIds } from "./notificationService.js";
import { idOf, loadConfig } from "./commissionService.js";

/*
 * Telling people about leads (the user, 2026-10-19: "when a new lead comes an
 * app-level notification needs to go, and when a new lead is assigned"):
 *
 *   - a lead assigned to someone: that person — kept in the bell, live on the
 *     socket and pushed to their phone, every way a lead gets an owner;
 *   - a new lead arriving (the form, an Excel upload, the sheet / Root sync, a
 *     3CX inbound call) or leads moved into a team: the leaders of its team,
 *     the Super Admins and the Sales Manager — a lead with no team only the
 *     last two. Not whoever brought it in themselves.
 *
 * One notice per person per batch: an upload of 200 is "200 new leads" and
 * "12 leads assigned", never 200 pushes. A bulk action runs inside
 * collectAssignments() and every assignment made in it is sent at the end,
 * grouped by person.
 *
 * Never throws: the lead is in already, and a push service having a bad
 * minute must not undo that.
 */

type Assignment = { userId: string; leadId: string; leadName: string };
type Batch = { items: Assignment[]; closed: boolean };
const batch = new AsyncLocalStorage<Batch>();

/** Runs `fn`; the assignments made in it go out once it is done, one notice per person. */
export async function collectAssignments<T>(fn: () => Promise<T>): Promise<T> {
  if (batch.getStore() && !batch.getStore()!.closed) return fn(); // inside another: that one sends
  const b: Batch = { items: [], closed: false };
  try {
    return await batch.run(b, fn);
  } finally {
    // Notices started at the very end (fire-and-forget) land in this batch, not after it.
    await new Promise((r) => setImmediate(r));
    b.closed = true;
    void sendAssignments(b.items);
  }
}

/** A lead given to someone — sent now, or with the rest of the batch it is part of. */
export async function announceAssignment(userId: string, leadId: string, leadName: string): Promise<void> {
  if (!userId || !Types.ObjectId.isValid(userId)) return;
  const b = batch.getStore();
  if (b && !b.closed) {
    b.items.push({ userId, leadId, leadName });
    return;
  }
  await sendAssignments([{ userId, leadId, leadName }]);
}

/** Several leads given to one person when only the count is known. */
export async function announceBulkAssignment(userId: string, count: number): Promise<void> {
  if (!userId || !Types.ObjectId.isValid(userId) || count < 1) return;
  try {
    await notify({
      userIds: [userId],
      type: "lead_assigned",
      title: `${count} Lead${count !== 1 ? "s" : ""} Assigned`,
      body: `${count} lead${count !== 1 ? "s have" : " has"} been assigned to you`,
      url: "/leads",
      tag: `bulk-assigned-${userId}-${Date.now()}`,
      data: { count },
    });
  } catch (err) {
    console.error("[leadAlerts] bulk assignment notice failed:", err instanceof Error ? err.message : err);
  }
}

const listNames = (names: string[], max = 3) =>
  names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "");

async function sendAssignments(items: Assignment[]): Promise<void> {
  try {
    const byUser = new Map<string, Map<string, string>>();
    for (const a of items) {
      const m = byUser.get(a.userId) ?? new Map<string, string>();
      m.set(a.leadId, a.leadName);
      byUser.set(a.userId, m);
    }
    await Promise.all([...byUser].map(async ([userId, leads]) => {
      const list = [...leads];
      if (list.length === 1) {
        const [leadId, name] = list[0];
        await notify({
          userIds: [userId],
          type: "lead_assigned",
          title: "New Lead Assigned",
          body: `You have been assigned: ${name || "a lead"}`,
          url: `/leads/${leadId}`,
          tag: `lead-assigned-${leadId}`,
          data: { leadId },
        });
        return;
      }
      await notify({
        userIds: [userId],
        type: "lead_assigned",
        title: `${list.length} Leads Assigned`,
        body: `${list.length} leads have been assigned to you: ${listNames(list.map(([, n]) => n || "a lead"))}`,
        url: "/leads",
        tag: `bulk-assigned-${userId}-${list[0][0]}`,
        data: { count: list.length },
      });
    }));
  } catch (err) {
    console.error("[leadAlerts] assignment notices failed:", err instanceof Error ? err.message : err);
  }
}

/** Most leads one arrival notice reads; a bigger batch still says how many came. */
const ARRIVAL_CAP = 5000;

/**
 * New leads in (or, `movedIn`, leads moved into a team): the leaders of each lead's team, the Super Admins and the
 * Sales Manager hear about them — each person once, about the leads that are theirs to see. `by` (whoever brought
 * them in) is left out.
 */
export async function announceNewLeads(
  leadIds: Array<string | Types.ObjectId>,
  opts: { by?: string | null; movedIn?: boolean } = {},
): Promise<void> {
  try {
    const ids = [...new Set(leadIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return;
    const leads = await Lead.find({ _id: { $in: ids.slice(0, ARRIVAL_CAP).map((id) => new Types.ObjectId(id)) } })
      .select("name source team")
      .lean<Array<{ _id: Types.ObjectId; name?: string; source?: string; team?: Types.ObjectId | null }>>();
    if (!leads.length) return;

    const teamIds = [...new Set(leads.map((l) => idOf(l.team)).filter(Boolean))];
    const [teams, admins, config] = await Promise.all([
      Team.find({ _id: { $in: teamIds } }).select("name leaders status").lean<Array<{ _id: Types.ObjectId; name: string; leaders?: unknown[]; status?: string }>>(),
      superAdminIds(),
      loadConfig(),
    ]);
    const teamOf = new Map(teams.map((t) => [String(t._id), t]));
    const leaderIds = [...new Set(teams.filter((t) => t.status !== "inactive").flatMap((t) => (t.leaders ?? []).map(idOf)))];
    const activeLeaders = new Set(
      leaderIds.length
        ? (await User.find({ _id: { $in: leaderIds }, status: { $ne: "inactive" } }).select("_id").lean()).map((u) => String(u._id))
        : [],
    );
    const everyone = new Set([...admins, ...(idOf(config.salesManager) ? [idOf(config.salesManager)] : [])]);

    // Who hears about which leads.
    const leadsOf = new Map<string, typeof leads>();
    const add = (userId: string, lead: (typeof leads)[number]) => {
      if (!userId || userId === opts.by) return;
      leadsOf.set(userId, [...(leadsOf.get(userId) ?? []), lead]);
    };
    for (const lead of leads) {
      const heard = new Set<string>(everyone);
      const team = lead.team ? teamOf.get(String(lead.team)) : undefined;
      if (team && team.status !== "inactive") for (const l of (team.leaders ?? []).map(idOf)) if (activeLeaders.has(l)) heard.add(l);
      for (const u of heard) add(u, lead);
    }

    const total = ids.length;
    // People told about the same leads share one notice.
    const groups = new Map<string, { userIds: string[]; leads: typeof leads }>();
    for (const [userId, theirs] of leadsOf) {
      const key = theirs.map((l) => String(l._id)).join(",");
      const g = groups.get(key) ?? { userIds: [], leads: theirs };
      g.userIds.push(userId);
      groups.set(key, g);
    }
    const teamName = (l: (typeof leads)[number]) => (l.team ? teamOf.get(String(l.team))?.name ?? "a team" : "No team");

    await Promise.all([...groups.values()].map(async ({ userIds, leads: theirs }) => {
      // Admins hear of the whole batch (beyond the cap too); a team leader of their teams' share.
      const allOfThem = theirs.length === leads.length;
      const count = allOfThem ? total : theirs.length;
      if (count === 1) {
        const l = theirs[0];
        await notify({
          userIds,
          type: "new_lead",
          title: opts.movedIn ? `Lead moved into ${teamName(l)}` : "New Lead",
          body: [l.name || "A lead", teamName(l), l.source].filter(Boolean).join(" · "),
          url: `/leads/${l._id}`,
          tag: `new-lead-${l._id}`,
          data: { leadId: String(l._id) },
        });
        return;
      }
      const perTeam = new Map<string, number>();
      for (const l of theirs) perTeam.set(teamName(l), (perTeam.get(teamName(l)) ?? 0) + 1);
      const split = [...perTeam].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(" · ");
      await notify({
        userIds,
        type: "new_lead",
        title: opts.movedIn ? `${count} leads moved in` : `${count} New Leads`,
        body: split,
        url: "/leads",
        tag: `new-leads-${theirs[0]._id}`,
        data: { count },
      });
    }));
  } catch (err) {
    console.error("[leadAlerts] new-lead notices failed:", err instanceof Error ? err.message : err);
  }
}
