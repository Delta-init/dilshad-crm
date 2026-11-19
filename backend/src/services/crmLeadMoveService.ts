import axios from "axios";
import mongoose, { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { idOf, isSuperAdmin, loadConfig } from "./commissionService.js";
import { LeadService } from "./leadService.js";
import { notifyBulkLeadAssignment } from "./pushService.js";
import { emitToUser } from "../socket.js";
import { findLeadByPhone, holdRepeatLead, announceRepeats } from "./repeatLeadService.js";
import { PORTAL } from "./rootCommission.js";
import type { IRole } from "../types/index.js";

/*
 * Moving leads to another sales CRM — Sales, Draw, Remote (the user, 2026-11-19: "option to transfer between crms").
 *
 * Sending: a Super Admin, the Sales Manager, or a team leader for their own teams' leads picks open leads, a CRM and
 * how that CRM gives them out — to one person, split across one team, or that CRM's own split. Root hands them over
 * (ROOT_ERP_API_URL, with ROOT_ORG_SECRET saying which CRM is asking — what the commission plan already uses). Only a
 * lead the other CRM took leaves here: the whole lead, its notes, reminders and history, is kept in crm_moved_leads
 * ("Moved to Draw CRM", read only) and taken out of the leads, so no list, count or report sees it any more. Undo,
 * within 24 hours, asks the other CRM to give it back (it refuses one closed there) and puts it back as it was.
 *
 * Taking in (sheetsRoutes, the CRM's sheet key — Root's door in): a new lead with what came with it, or, for a number
 * this CRM already has, the repeat rule (its team leader verifies it). Nothing about WhatsApp moves: the chat stays on
 * the phone it was on.
 */

export const CRM_NAME: Record<string, string> = { delta: "Sales CRM", draw: "Draw CRM", remote: "Remote CRM" };
const MOVED = "crm_moved_leads";
const DONE = ["closed", "lost"];
const UNDO_MS = 24 * 3_600_000;
const MAX = 500;
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const oid = (v: string) => new Types.ObjectId(v);
const moved = () => mongoose.connection.collection(MOVED);
const leadsRaw = () => mongoose.connection.collection("leads");
/** Someone signed in here — or Root's Lead moves page (`system`: a root admin moving it from Root, named). */
type Viewer = { userId: string; role?: IRole | null; system?: { name: string } };
const whoIs = async (viewer: Viewer) => viewer.system ? { name: viewer.system.name } : await User.findById(viewer.userId).select("name").lean();
const byOf = (viewer: Viewer) => (viewer.system || !Types.ObjectId.isValid(viewer.userId) ? null : oid(viewer.userId));

/* ── Root ─────────────────────────────────────────────────────────────────── */

async function askRoot<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = process.env.ROOT_ERP_API_URL?.replace(/\/+$/, "");
  const secret = process.env.ROOT_ORG_SECRET;
  if (!base || !secret) throw fail("Moving leads to another CRM goes through Root, and ROOT_ERP_API_URL / ROOT_ORG_SECRET aren't set on this server", 503);
  try {
    const { data } = await axios.request({ method, url: `${base}/api/v1/service${path}`, data: body, headers: { "x-org-secret": secret }, timeout: 60_000 });
    return data.data as T;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const said = axios.isAxiosError(err) ? (err.response?.data as { message?: string } | undefined)?.message : undefined;
    if (status === 404 && !said) throw fail("Root is on an older version that can't move leads yet", 503);
    throw fail(said || (status ? `Root answered ${status}` : "Root can't be reached"), status && status < 500 ? status : 502);
  }
}

/* ── Who may move what ────────────────────────────────────────────────────── */

/** all (a Super Admin, the Sales Manager), the teams they lead (a team leader), or nothing. */
export async function moveScope(viewer: Viewer): Promise<{ all: true } | { all: false; teamIds: string[]; people: Set<string> }> {
  if (viewer.system || isSuperAdmin(viewer.role)) return { all: true };
  try {
    if (idOf((await loadConfig()).salesManager) === viewer.userId) return { all: true };
  } catch { /* no settings yet */ }
  if (!Types.ObjectId.isValid(viewer.userId)) return { all: false, teamIds: [], people: new Set() };
  const led = await Team.find({ status: { $ne: "inactive" }, leaders: oid(viewer.userId) }).select("leaders members").lean();
  return {
    all: false,
    teamIds: led.map((t) => String(t._id)),
    people: new Set(led.flatMap((t) => [...(t.leaders ?? []), ...(t.members ?? [])].map(String))),
  };
}
export const mayMove = async (viewer: Viewer) => { const s = await moveScope(viewer); return s.all || s.teamIds.length > 0; };

/* ── Sending ──────────────────────────────────────────────────────────────── */

export const moveTargets = () => askRoot<unknown[]>("GET", "/lead-moves/targets");

export interface MoveInput { leadIds: string[]; /** Or: every open lead this person holds (Users → Transfer leads). */ fromUserId?: string | null; to: string; mode: "person" | "team" | "split"; teamId?: string | null; userId?: string | null }

interface RootAnswer { fromLeadId: string; moved: boolean; reason?: string; moveId?: string; to?: string; toLeadId?: string; outcome?: "created" | "repeat"; holder?: string }

const nameOf = (u: unknown) => (u && typeof u === "object" ? String((u as { name?: string }).name ?? "") : "");

export async function moveLeads(viewer: Viewer, input: MoveInput) {
  let ids = [...new Set((input.leadIds ?? []).map(String))].filter((i) => Types.ObjectId.isValid(i));
  if (!ids.length && input.fromUserId && Types.ObjectId.isValid(input.fromUserId)) {
    ids = (await Lead.find({ assignedTo: oid(input.fromUserId), status: { $nin: DONE } }).select("_id").sort({ createdAt: 1 }).limit(MAX).lean()).map((l) => String(l._id));
    if (!ids.length) throw fail("They hold no open leads", 400);
  }
  if (!ids.length) throw fail("Pick the leads to move", 400);
  if (ids.length > MAX) throw fail(`At most ${MAX} leads at a time`, 400);
  if (!CRM_NAME[input.to] || input.to === PORTAL) throw fail("Pick another CRM", 400);
  if (!["person", "team", "split"].includes(input.mode)) throw fail("Pick how they're given out", 400);
  const scope = await moveScope(viewer);
  if (!scope.all && !scope.teamIds.length) throw fail("Moving leads to another CRM is for Super Admins, the Sales Manager and team leaders", 403);

  const leads = await Lead.find({ _id: { $in: ids.map(oid) } }).populate("assignedTo", "name").populate("team", "name").lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));
  const refused: { leadId: string; name: string; reason: string }[] = [];
  const going: typeof leads = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) { refused.push({ leadId: id, name: "", reason: "Not here any more — already moved or deleted" }); continue; }
    if (DONE.includes(String(l.status))) { refused.push({ leadId: id, name: l.name, reason: l.status === "closed" ? "Closed — a closed lead stays (its enrolment and payments are here)" : "Lost — only open leads move" }); continue; }
    if (!scope.all && !scope.teamIds.includes(idOf(l.team)) && !scope.people.has(idOf(l.assignedTo))) { refused.push({ leadId: id, name: l.name, reason: "Not in a team you lead" }); continue; }
    going.push(l);
  }
  if (!going.length) return { moved: [], refused };

  const me = await whoIs(viewer);
  const answers = await askRoot<RootAnswer[]>("POST", "/lead-moves", {
    to: input.to, mode: input.mode, teamId: input.teamId || null, userId: input.userId || null, byName: me?.name ?? "",
    leads: going.map((l) => ({
      fromLeadId: String(l._id),
      name: l.name ?? "",
      phone: String(l.phone ?? ""),
      email: (l as { email?: string }).email || null,
      source: (l as { source?: string }).source || null,
      platform: (l as { platform?: string }).platform || null,
      campaign: (l as { campaign?: string }).campaign || null,
      ownerName: nameOf(l.assignedTo),
      teamName: nameOf(l.team),
      status: String(l.status ?? ""),
      history: ((l as { activityLogs?: { description?: string; createdAt?: Date }[] }).activityLogs ?? [])
        .slice(-15).map((a) => `${a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : ""} ${a.description ?? ""}`.trim()).join("\n").slice(0, 4000),
      notes: ((l as { notes?: { content?: string; createdAt?: Date; author?: unknown }[] }).notes ?? [])
        .filter((n) => n.content).slice(-100).map((n) => ({ content: String(n.content).slice(0, 4000), at: n.createdAt ? new Date(n.createdAt).toISOString() : null })),
    })),
  });

  const done: { leadId: string; name: string; moveId: string; toLeadId: string; outcome: string; holder: string }[] = [];
  for (const a of answers ?? []) {
    const l = byId.get(a.fromLeadId);
    if (!l) continue;
    if (!a.moved || !a.moveId) { refused.push({ leadId: a.fromLeadId, name: l.name, reason: a.reason || "The other CRM didn't take it" }); continue; }
    const raw = await leadsRaw().findOne({ _id: oid(a.fromLeadId) });
    if (!raw) continue;
    // Replacing, not adding: a lead moved before and brought back (Undo) has its old, undone row here already.
    await moved().replaceOne({ _id: raw._id }, {
      lead: raw, to: input.to, toName: CRM_NAME[input.to], toLeadId: a.toLeadId ?? "", outcome: a.outcome ?? "created",
      holder: a.holder ?? "", moveId: a.moveId, by: byOf(viewer), byName: me?.name ?? "", ownerName: nameOf(l.assignedTo),
      at: new Date(), undoneAt: null,
    }, { upsert: true });
    await leadsRaw().deleteOne({ _id: raw._id });
    done.push({ leadId: a.fromLeadId, name: l.name, moveId: a.moveId, toLeadId: a.toLeadId ?? "", outcome: a.outcome ?? "created", holder: a.holder ?? "" });
  }
  return { moved: done, refused };
}

/** Leads this CRM moved out, newest first. */
export async function listMovedOut(viewer: Viewer, limit = 100) {
  const scope = await moveScope(viewer);
  if (!scope.all && !scope.teamIds.length) throw fail("Not yours to see", 403);
  const filter = scope.all ? {} : { $or: [{ "lead.team": { $in: scope.teamIds.map(oid) } }, { "lead.assignedTo": { $in: [...scope.people].filter((i) => Types.ObjectId.isValid(i)).map(oid) } }] };
  const rows = await moved().find(filter, { projection: { "lead.activityLogs": 0, "lead.notes": 0, "lead.reminders": 0 } }).sort({ at: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  return rows.map((r) => ({
    id: String(r._id), name: r.lead?.name ?? "", phone: r.lead?.phone ?? "", status: r.lead?.status ?? "", ownerName: r.ownerName ?? "",
    to: r.to, toName: r.toName, outcome: r.outcome, holder: r.holder ?? "", byName: r.byName ?? "", at: r.at, undoneAt: r.undoneAt ?? null,
    canUndo: !r.undoneAt && Date.now() - new Date(r.at).getTime() <= UNDO_MS,
  }));
}

/** One moved lead, read only (its page after it left). */
export async function movedLead(id: string) {
  if (!Types.ObjectId.isValid(id)) throw fail("No such lead", 404);
  const r = await moved().findOne({ _id: oid(id) });
  if (!r) throw fail("No such lead", 404);
  return { ...r, canUndo: !r.undoneAt && Date.now() - new Date(r.at).getTime() <= UNDO_MS };
}

/** Undo a move (24 hours): the other CRM gives it back, then it is here again as it was. */
export async function undoMove(viewer: Viewer, id: string) {
  if (!Types.ObjectId.isValid(id)) throw fail("No such lead", 404);
  const scope = await moveScope(viewer);
  const r = await moved().findOne({ _id: oid(id) });
  if (!r) throw fail("No such lead", 404);
  if (!scope.all && !scope.teamIds.includes(idOf(r.lead?.team)) && !scope.people.has(idOf(r.lead?.assignedTo))) throw fail("Not in a team you lead", 403);
  if (r.undoneAt) throw fail("Already undone", 409);
  if (Date.now() - new Date(r.at).getTime() > UNDO_MS) throw fail("A move can only be undone within 24 hours", 409);
  if (await leadsRaw().findOne({ _id: r._id })) throw fail("The lead is here already", 409);
  const me = await whoIs(viewer);
  await askRoot("POST", `/lead-moves/${r.moveId}/undo`, { byName: me?.name ?? "" });
  const lead = { ...r.lead };
  lead.activityLogs = [...(lead.activityLogs ?? []), { _id: new Types.ObjectId(), action: "lead_moved", description: `Move to ${r.toName} undone by ${me?.name ?? "someone"} — back here as it was`, ...(byOf(viewer) ? { performedBy: byOf(viewer) } : {}), createdAt: new Date() }];
  await leadsRaw().insertOne(lead);
  await moved().updateOne({ _id: r._id }, { $set: { undoneAt: new Date(), undoneBy: me?.name ?? "" } });
  return { leadId: String(r._id) };
}

/* ── Taking in (Root, through the sheet door) ─────────────────────────────── */

export interface IncomingLead {
  fromLeadId: string; name?: string; phone: string; email?: string | null; source?: string | null; platform?: string | null;
  campaign?: string | null; ownerName?: string | null; teamName?: string | null; status?: string | null; history?: string | null;
  notes?: { content: string; at?: string | null }[];
}
export interface Incoming { from: string; fromName?: string; mode: "person" | "team" | "split"; teamId?: string | null; userId?: string | null; byName?: string; leads: IncomingLead[] }

const validEmail = (e?: string | null) => { const v = e?.trim().toLowerCase(); return v && /^\S+@\S+\.\S+$/.test(v) ? v : undefined; };

/** Who gets them: one person, the people of one team in turn (fewest open leads first), or nobody yet (the split). */
async function receivers(input: Incoming): Promise<{ team: { _id: Types.ObjectId; name: string } | null; people: { id: string; name: string }[] }> {
  if (input.mode === "split") return { team: null, people: [] };
  if (!input.teamId || !Types.ObjectId.isValid(input.teamId)) throw fail("Pick a team", 400);
  const team = await Team.findOne({ _id: oid(input.teamId), status: { $ne: "inactive" } }).select("name leaders members inactiveMembers").lean();
  if (!team) throw fail("That team isn't here or isn't active", 400);
  const inTeam = [...new Set([...(team.leaders ?? []), ...(team.members ?? [])].map(String))];
  if (input.mode === "person") {
    if (!input.userId || !inTeam.includes(String(input.userId))) throw fail("That person isn't in that team", 400);
    const u = await User.findOne({ _id: oid(input.userId), status: { $ne: "inactive" } }).select("name").lean();
    if (!u) throw fail("That person isn't active", 400);
    return { team: { _id: team._id as Types.ObjectId, name: team.name }, people: [{ id: String(u._id), name: u.name }] };
  }
  const off = new Set(((team as { inactiveMembers?: unknown[] }).inactiveMembers ?? []).map(String));
  const users = await User.find({ _id: { $in: inTeam.filter((i) => !off.has(i)).map(oid) }, status: { $ne: "inactive" } }).select("name").lean();
  if (!users.length) throw fail(`${team.name} has nobody active to give them to`, 400);
  const open = await Lead.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { assignedTo: { $in: users.map((u) => u._id) }, status: { $nin: DONE } } },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ]);
  const load = new Map(open.map((o) => [String(o._id), o.n]));
  const people = users.map((u) => ({ id: String(u._id), name: u.name })).sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.name.localeCompare(b.name));
  return { team: { _id: team._id as Types.ObjectId, name: team.name }, people };
}

export async function receiveLeads(input: Incoming) {
  const fromName = CRM_NAME[input.from] ?? input.fromName ?? "another CRM";
  if (!Array.isArray(input.leads) || !input.leads.length) throw fail("No leads", 400);
  const { team, people } = await receivers(input);
  const reporter = await User.findOne({ email: process.env.SUPER_ADMIN_EMAIL }).select("_id").lean();
  if (!reporter) throw fail("System reporter (Super Admin) not found. Check SUPER_ADMIN_EMAIL", 500);
  const by = input.byName || "someone";
  const results: { index: number; status: "created" | "repeat" | "invalid"; leadId?: string; holder?: string; reason?: string; teamName?: string; personName?: string }[] = [];
  const toSplit: string[] = [];
  const given = new Map<string, number>();
  const held: Parameters<typeof announceRepeats>[0] = [];
  let turn = 0;

  for (let index = 0; index < input.leads.length; index++) {
    const l = input.leads[index];
    try {
      const phone = String(l.phone ?? "").trim();
      if (!phone) { results.push({ index, status: "invalid", reason: "No phone number" }); continue; }
      const header = [
        `📦 Moved in from ${fromName} by ${by}`,
        "─────────────────────────────",
        `There: ${l.ownerName ? `${l.ownerName}'s lead` : "nobody's lead"}${l.teamName ? ` (${l.teamName})` : ""}, status ${l.status || "—"}`,
        ...(l.history ? ["", "History there", "─────────────────────────────", l.history] : []),
      ].join("\n").slice(0, 9000);

      const existing = await findLeadByPhone(phone);
      if (existing) {
        const outcome = await holdRepeatLead(existing._id.toString(), { name: l.name, source: l.source, platform: l.platform, campaign: l.campaign, note: header }, String(reporter._id));
        if (outcome.kind === "split") toSplit.push(outcome.leadId);
        else held.push(outcome);
        const now = await Lead.findById(existing._id).populate("assignedTo", "name").select("assignedTo").lean();
        results.push({ index, status: "repeat", leadId: existing._id.toString(), holder: nameOf(now?.assignedTo) });
        continue;
      }

      const person = people.length ? people[turn++ % people.length] : null;
      const at = new Date();
      const lead = await Lead.create({
        name: l.name?.trim() || "no name",
        phone,
        email: validEmail(l.email),
        source: l.source?.trim() || "other",
        platform: l.platform?.trim() || undefined,
        campaign: l.campaign?.trim() || undefined,
        status: person ? "assigned" : "new",
        assignedTo: person ? oid(person.id) : null,
        assignedAt: person ? at : null,
        ...(team ? { team: team._id } : {}),
        reporter: reporter._id,
        movedFrom: { crm: input.from, leadId: l.fromLeadId, ownerName: l.ownerName ?? "", status: l.status ?? "", byName: by, at },
        notes: [
          { content: header, author: reporter._id, createdAt: at, updatedAt: at },
          ...(l.notes ?? []).map((n) => ({ content: `[${fromName}${n.at ? ` · ${n.at.slice(0, 10)}` : ""}] ${n.content}`.slice(0, 5000), author: reporter._id, createdAt: n.at ? new Date(n.at) : at, updatedAt: at })),
        ],
        activityLogs: [
          { action: "lead_moved", description: `Moved in from ${fromName} by ${by}${person ? ` — to ${person.name}` : ""}`.slice(0, 500), performedBy: reporter._id, createdAt: at },
        ],
      });
      if (person) given.set(person.id, (given.get(person.id) ?? 0) + 1);
      else toSplit.push(String(lead._id));
      results.push({ index, status: "created", leadId: String(lead._id), holder: person?.name ?? "", teamName: team?.name ?? "", personName: input.mode === "person" ? person?.name ?? "" : "" });
    } catch (e) {
      results.push({ index, status: "invalid", reason: (e as Error).message.slice(0, 300) });
    }
  }

  if (toSplit.length) {
    const r = await new LeadService().autoAssignLeads(toSplit).catch(() => null);
    for (const res of results) {
      const hit = r?.results?.find((x: { leadId?: string }) => String(x.leadId) === res.leadId);
      if (hit && !res.holder) res.holder = String((hit as { assignedTo?: string }).assignedTo ?? "");
    }
  }
  for (const [userId, count] of given) void notifyBulkLeadAssignment(userId, count, emitToUser).catch(() => null);
  if (held.length) void announceRepeats(held);
  return { results };
}

/**
 * Give one back (the CRM it came from undid the move, within its 24 hours). A lead it created here goes — unless it
 * has been closed here; a repeat only loses the note it brought.
 */
export async function takeBack(input: { from: string; leadId: string; outcome: string; fromLeadId: string }) {
  if (!Types.ObjectId.isValid(input.leadId)) throw fail("No such lead", 404);
  const lead = await Lead.findById(input.leadId).select("status movedFrom name").lean<{ status?: string; movedFrom?: { crm?: string; leadId?: string }; name?: string }>();
  if (input.outcome === "repeat" || !lead?.movedFrom || lead.movedFrom.leadId !== input.fromLeadId) {
    // It was already here (a repeat): it stays; nothing of the move to take off but its note.
    return { kept: true };
  }
  if (lead.status === "closed") throw fail(`${lead.name || "The lead"} has been closed here — it can't be taken back`, 409);
  const raw = await leadsRaw().findOne({ _id: oid(input.leadId) });
  if (raw) {
    await moved().replaceOne({ _id: raw._id }, { lead: raw, to: input.from, toName: CRM_NAME[input.from] ?? input.from, toLeadId: input.fromLeadId, outcome: "taken_back", moveId: "", byName: "", ownerName: "", at: new Date(), undoneAt: new Date() }, { upsert: true });
    await leadsRaw().deleteOne({ _id: raw._id });
  }
  return { kept: false };
}
