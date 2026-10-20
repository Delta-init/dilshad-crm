import { Types } from "mongoose";
import { Lead } from "../models/Lead.js";
import { LeadMove } from "../models/LeadMove.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { getAppSettings } from "./settingsService.js";
import { actedOn, inactiveNow } from "./inactiveLeadService.js";
import { breaksOf } from "./breakClock.js";

/*
 * The lead workflow, as the Sales CRM's (brought to the Remote CRM, 2026-10-17) (the user, 2026-10-17: "a map of the workflow — how many
 * leads came today, how many moved, how many with which status, by team and
 * by each employee"): the leads that came in over some Dubai days and where
 * each went —
 *
 *   came in      first created in the period (a hand-over keeps the first date)
 *   assigned     has an owner now; the rest wait for a split
 *   moved        moved on at least once since (automatically, or only by hand)
 *   inactive now not moved, inactive right now — its owner on a break, nobody
 *                left in the team to take it, or waiting for the mover (breaks
 *                kept here since 2026-10-20, as the Sales CRM)
 *   worked       its owner acted on it (status, note, follow-up, reminder) or
 *                anyone called it — the Inactive leads page's rules
 *   fresh        none of these yet, and not past the limit
 *
 * with each lead's status now, and the same per team (the lead's team) and per
 * person (everyone who held one of them: its owner now, and whoever it moved
 * from or to). For a past day, "inactive now" and the statuses are as they
 * stand today. Read only.
 */

const MAX_DAYS = 92;
// Dubai days (UTC+4 all year), as the page's date filters mean them.
const GST_MS = 4 * 3_600_000;
const dubaiDateISO = (d: Date) => new Date(d.getTime() + GST_MS).toISOString().slice(0, 10);
const dubaiDayStart = (day: string) => new Date(`${day}T00:00:00.000+04:00`);
const dubaiDayEnd = (day: string) => new Date(`${day}T23:59:59.999+04:00`);
const UNTOUCHED = new Set(["new", "assigned"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type WorkflowStage = "unassigned" | "moved_auto" | "moved_hand" | "on_break" | "nobody_left" | "waiting" | "worked" | "fresh";

type Counts = {
  came: number; assigned: number; unassigned: number; worked: number; fresh: number; inactive: number;
  movedAuto: number; movedHand: number; onBreak: number; nobodyLeft: number; waiting: number;
};
const blank = (): Counts => ({ came: 0, assigned: 0, unassigned: 0, worked: 0, fresh: 0, inactive: 0, movedAuto: 0, movedHand: 0, onBreak: 0, nobodyLeft: 0, waiting: 0 });

function tally(c: Counts, stage: WorkflowStage) {
  c.came++;
  if (stage === "unassigned") { c.unassigned++; return; }
  c.assigned++;
  if (stage === "worked") c.worked++;
  else if (stage === "fresh") c.fresh++;
  else {
    c.inactive++;
    if (stage === "moved_auto") c.movedAuto++;
    else if (stage === "moved_hand") c.movedHand++;
    else if (stage === "on_break") c.onBreak++;
    else if (stage === "nobody_left") c.nobodyLeft++;
    else c.waiting++;
  }
}

export interface WorkflowPerson {
  id: string; name: string; active: boolean; team: string | null;
  /** Leads of the period they held at some point: theirs now, or moved from or to them. */
  held: number;
  /** Theirs now. */
  now: number;
  worked: number; fresh: number;
  /** Theirs now and inactive right now. */
  inactiveNow: number;
  /** Moves away from them, and to them. */
  lost: number; got: number;
  /** The status of the ones that are theirs now. */
  statuses: Record<string, number>;
  /** Minutes on a break in the period. */
  breakMinutes: number;
}

export interface LeadWorkflow {
  generatedAt: string;
  period: { from: string; to: string; days: number };
  /** breaks: true — this CRM keeps breaks ("Take break", 2026-10-20), so the page shows "owner on a break". */
  rule: { limitMinutes: number; hours: { start: string; end: string }; timezone: string; breaks: boolean };
  totals: Counts & { moves: number };
  statuses: Array<{ status: string; count: number }>;
  timeline: { unit: "hour" | "day"; rows: Array<{ key: string; came: number }> };
  teams: Array<Counts & { id: string | null; name: string; statuses: Record<string, number> }>;
  people: WorkflowPerson[];
  movesMap: Array<{ from: { id: string; name: string }; to: { id: string; name: string }; count: number; automatic: number }>;
}

interface LeadRow {
  _id: Types.ObjectId;
  name?: string;
  phone?: string;
  source?: string;
  status: string;
  assignedTo: Types.ObjectId | null;
  assignedAt?: Date | null;
  team: Types.ObjectId | null;
  createdAt: Date;
  originalCreatedAt?: Date | null;
}
type MoveRow = { lead: Types.ObjectId; from: Types.ObjectId; to: Types.ObjectId; kind: "automatic" | "manual"; createdAt: Date };

const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * What the map and the lists behind its boxes share: the period's leads (one person's, one team's) and which box each
 * is in — so a box's list is always exactly its number.
 */
async function workflowBase(q: { from?: string; to?: string; teamId?: string; personId?: string }, now: Date) {
  const today = dubaiDateISO(now);
  const fromDay = q.from || q.to || today;
  const toDay = q.to || (q.from ? today : fromDay);
  if (!DAY.test(fromDay) || !DAY.test(toDay)) throw fail("Use YYYY-MM-DD days");
  if (fromDay > toDay) throw fail("The start is after the end");
  const start = dubaiDayStart(fromDay), end = dubaiDayEnd(toDay);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw fail("Not a real day");
  const days = Math.round((dubaiDayStart(toDay).getTime() - start.getTime()) / 86_400_000) + 1;
  if (days > MAX_DAYS) throw fail(`At most ${MAX_DAYS} days at a time`);
  for (const id of [q.teamId, q.personId]) if (id && !Types.ObjectId.isValid(id)) throw fail("Invalid id");

  // Came in: first created in the period. A hand-over resets createdAt and keeps the first one in originalCreatedAt.
  const range = { $gte: start, $lte: end };
  const match: Record<string, unknown> = {
    $or: [{ originalCreatedAt: range }, { originalCreatedAt: { $in: [null] }, createdAt: range }],
  };
  if (q.teamId) match.team = new Types.ObjectId(q.teamId);
  let leads = await Lead.find(match).select("name phone source status assignedTo assignedAt team createdAt originalCreatedAt").lean<LeadRow[]>();

  const ids = leads.map((l) => l._id);
  const moves = ids.length
    ? await LeadMove.find({ lead: { $in: ids }, createdAt: { $gte: start } })
        .select("lead from to kind createdAt").sort({ createdAt: 1 })
        .lean<MoveRow[]>()
    : [];
  const movesOf = new Map<string, MoveRow[]>();
  for (const m of moves) movesOf.set(String(m.lead), [...(movesOf.get(String(m.lead)) ?? []), m]);

  // One person: the leads they held — theirs now, or moved from or to them.
  if (q.personId) {
    const held = (l: LeadRow) => String(l.assignedTo ?? "") === q.personId
      || (movesOf.get(String(l._id)) ?? []).some((m) => String(m.from) === q.personId || String(m.to) === q.personId);
    leads = leads.filter(held);
  }

  const settings = await getAppSettings();
  const [inactive, acted] = await Promise.all([
    // Only this period's leads that have an owner — not every inactive lead in the CRM.
    inactiveNow(now, leads.filter((l) => l.assignedTo).map((l) => l._id)),
    actedOn(leads.filter((l) => l.assignedTo && UNTOUCHED.has(l.status) && !movesOf.has(String(l._id))).map((l) => l._id)),
  ]);

  const stageOf = (l: LeadRow): WorkflowStage => {
    if (!l.assignedTo) return "unassigned";
    const mv = movesOf.get(String(l._id));
    if (mv?.length) return mv.some((m) => m.kind === "automatic") ? "moved_auto" : "moved_hand";
    const off = inactive.get(String(l._id));
    if (off) return off.state === "on_break" ? "on_break" : off.state === "stuck" ? "nobody_left" : "waiting";
    if (!UNTOUCHED.has(l.status) || acted.has(String(l._id))) return "worked";
    return "fresh";
  };
  return { fromDay, toDay, days, start, end, leads, movesOf, inactive, stageOf, settings };
}

export async function leadWorkflow(
  q: { from?: string; to?: string; teamId?: string; personId?: string },
  now: Date = new Date(),
): Promise<LeadWorkflow> {
  const { fromDay, toDay, days, start, end, leads, movesOf, inactive, stageOf, settings } = await workflowBase(q, now);

  const totals = blank();
  const statuses = new Map<string, number>();
  const teams = new Map<string, Counts & { statuses: Record<string, number> }>();
  const people = new Map<string, Omit<WorkflowPerson, "name" | "active" | "team" | "breakMinutes"> & { teamCount: Map<string, number> }>();
  const person = (id: string) => {
    let p = people.get(id);
    if (!p) {
      p = { id, held: 0, now: 0, worked: 0, fresh: 0, inactiveNow: 0, lost: 0, got: 0, statuses: {}, teamCount: new Map() };
      people.set(id, p);
    }
    return p;
  };
  const unit: "hour" | "day" = days === 1 ? "hour" : "day";
  const timeline = new Map<string, number>();
  const GST = 4 * 3_600_000;

  for (const l of leads) {
    const stage = stageOf(l);
    tally(totals, stage);
    statuses.set(l.status, (statuses.get(l.status) ?? 0) + 1);
    const tk = l.team ? String(l.team) : "";
    const t = teams.get(tk) ?? { ...blank(), statuses: {} };
    tally(t, stage);
    t.statuses[l.status] = (t.statuses[l.status] ?? 0) + 1;
    teams.set(tk, t);

    const first = new Date(l.originalCreatedAt ?? l.createdAt);
    const local = new Date(first.getTime() + GST).toISOString();
    const key = unit === "hour" ? local.slice(11, 13) : local.slice(0, 10);
    timeline.set(key, (timeline.get(key) ?? 0) + 1);

    // Everyone who held it, once each.
    const holders = new Set<string>();
    if (l.assignedTo) holders.add(String(l.assignedTo));
    for (const m of movesOf.get(String(l._id)) ?? []) {
      holders.add(String(m.from)); holders.add(String(m.to));
      person(String(m.from)).lost++;
      person(String(m.to)).got++;
    }
    for (const h of holders) {
      const p = person(h);
      p.held++;
      p.teamCount.set(tk, (p.teamCount.get(tk) ?? 0) + 1);
    }
    if (l.assignedTo) {
      const p = person(String(l.assignedTo));
      p.now++;
      p.statuses[l.status] = (p.statuses[l.status] ?? 0) + 1;
      if (stage === "worked") p.worked++;
      else if (stage === "fresh") p.fresh++;
      if (inactive.get(String(l._id))?.owner === String(l.assignedTo)) p.inactiveNow++;
    }
  }
  // One person's view: only their own row.
  if (q.personId) for (const id of [...people.keys()]) if (id !== q.personId) people.delete(id);

  const personIds = [...people.keys()];
  const teamIds = [...teams.keys()].filter(Boolean);
  const pairs = new Map<string, { from: string; to: string; count: number; automatic: number }>();
  for (const l of leads) for (const m of movesOf.get(String(l._id)) ?? []) {
    const k = `${m.from}>${m.to}`;
    const pr = pairs.get(k) ?? { from: String(m.from), to: String(m.to), count: 0, automatic: 0 };
    pr.count++;
    if (m.kind === "automatic") pr.automatic++;
    pairs.set(k, pr);
  }
  const allPeople = [...new Set([...personIds, ...[...pairs.values()].flatMap((p) => [p.from, p.to])])];
  const [users, teamDocs, breaks] = await Promise.all([
    User.find({ _id: { $in: allPeople.map((id) => new Types.ObjectId(id)) } }).select("name status").lean<Array<{ _id: Types.ObjectId; name: string; status?: string }>>(),
    Team.find({ _id: { $in: teamIds.map((id) => new Types.ObjectId(id)) } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>(),
    breaksOf(personIds, start, now),
  ]);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const teamName = new Map(teamDocs.map((t) => [String(t._id), t.name]));
  const nameOf = (id: string) => userOf.get(id)?.name ?? "Unknown";
  const periodEnd = Math.min(end.getTime(), now.getTime());

  return {
    generatedAt: now.toISOString(),
    period: { from: fromDay, to: toDay, days },
    rule: { limitMinutes: settings.inactiveLeads.limitMinutes, hours: { start: settings.workingHours.start, end: settings.workingHours.end }, timezone: settings.workingHours.timezone, breaks: true },
    totals: { ...totals, moves: leads.reduce((n, l) => n + (movesOf.get(String(l._id))?.length ?? 0), 0) },
    statuses: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    timeline: {
      unit,
      rows: unit === "hour"
        ? Array.from({ length: 24 }, (_, h) => { const key = String(h).padStart(2, "0"); return { key, came: timeline.get(key) ?? 0 }; })
        : Array.from({ length: days }, (_, i) => { const key = new Date(start.getTime() + GST + i * 86_400_000).toISOString().slice(0, 10); return { key, came: timeline.get(key) ?? 0 }; }),
    },
    teams: [...teams].map(([id, c]) => ({ id: id || null, name: id ? teamName.get(id) ?? "Unknown team" : "No team", ...c }))
      .sort((a, b) => b.came - a.came),
    people: [...people.values()].map(({ teamCount, ...p }) => {
      const top = [...teamCount].sort((a, b) => b[1] - a[1])[0]?.[0];
      let breakMinutes = 0;
      for (const [s, e] of breaks.spans.get(p.id) ?? []) {
        const a = Math.max(s, start.getTime()), b = Math.min(e, periodEnd);
        if (b > a) breakMinutes += (b - a) / 60_000;
      }
      return { ...p, name: nameOf(p.id), active: userOf.get(p.id)?.status !== "inactive", team: top ? teamName.get(top) ?? null : null, breakMinutes: Math.round(breakMinutes) };
    }).sort((a, b) => b.held - a.held || a.name.localeCompare(b.name)),
    movesMap: [...pairs.values()].sort((a, b) => b.count - a.count).slice(0, 50)
      .map((p) => ({ from: { id: p.from, name: nameOf(p.from) }, to: { id: p.to, name: nameOf(p.to) }, count: p.count, automatic: p.automatic })),
  };
}

// ─── The leads behind a box (the user, 2026-10-19: "click a card and see its breakdown") ─────────────────────────────

/** A box on the map: a stage, a group of stages, or one status in "where they stand now". */
export const WORKFLOW_BOXES = ["came", "assigned", "unassigned", "worked", "fresh", "inactive", "moved_auto", "moved_hand", "on_break", "nobody_left", "waiting", "status"] as const;
export type WorkflowBox = (typeof WORKFLOW_BOXES)[number];
const INACTIVE_STAGES = new Set<WorkflowStage>(["moved_auto", "moved_hand", "on_break", "nobody_left", "waiting"]);
const LIST_CAP = 500;

export interface WorkflowLeadRow {
  id: string; name: string; phone: string; source: string; status: string; stage: WorkflowStage;
  owner: { id: string; name: string } | null; team: { id: string; name: string } | null;
  cameIn: string; assignedAt: string | null;
  /** The last time it moved in the period. */
  move: { from: { id: string; name: string }; to: { id: string; name: string }; at: string; kind: "automatic" | "manual"; times: number } | null;
  /** Inactive now: the minutes it has waited (breaks and calls off). */
  waitedMinutes: number | null;
  /** On a break now: since when. */
  breakSince: string | null;
}

/** The leads behind one box, newest first (the first 500), and how many each owner and team holds of all of them. */
export async function leadWorkflowLeads(
  q: { from?: string; to?: string; teamId?: string; personId?: string; box: WorkflowBox; status?: string },
  now: Date = new Date(),
): Promise<{ box: WorkflowBox; status: string | null; total: number; capped: boolean; rows: WorkflowLeadRow[]; byOwner: Array<{ id: string | null; name: string; count: number }>; byTeam: Array<{ id: string | null; name: string; count: number }> }> {
  if (!WORKFLOW_BOXES.includes(q.box)) throw fail("Unknown box");
  if (q.box === "status" && !q.status) throw fail("Say which status");
  const { leads, movesOf, inactive, stageOf } = await workflowBase(q, now);
  const inBox = (l: LeadRow): boolean => {
    const stage = stageOf(l);
    switch (q.box) {
      case "came": return true;
      case "assigned": return stage !== "unassigned";
      case "inactive": return INACTIVE_STAGES.has(stage);
      case "status": return l.status === q.status;
      default: return stage === q.box;
    }
  };
  const chosen = leads.filter(inBox).sort((a, b) => new Date(b.originalCreatedAt ?? b.createdAt).getTime() - new Date(a.originalCreatedAt ?? a.createdAt).getTime());
  const shown = chosen.slice(0, LIST_CAP);

  const userIds = new Set<string>(), teamIds = new Set<string>();
  for (const l of chosen) { if (l.assignedTo) userIds.add(String(l.assignedTo)); if (l.team) teamIds.add(String(l.team)); }
  for (const l of shown) for (const m of movesOf.get(String(l._id)) ?? []) { userIds.add(String(m.from)); userIds.add(String(m.to)); }
  const [users, teamDocs] = await Promise.all([
    User.find({ _id: { $in: [...userIds].map((id) => new Types.ObjectId(id)) } }).select("name breakSince").lean<Array<{ _id: Types.ObjectId; name: string; breakSince?: Date | null }>>(),
    Team.find({ _id: { $in: [...teamIds].map((id) => new Types.ObjectId(id)) } }).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>(),
  ]);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const teamName = new Map(teamDocs.map((t) => [String(t._id), t.name]));
  const who = (id: unknown) => ({ id: String(id), name: userOf.get(String(id))?.name ?? "Unknown" });

  const count = (key: (l: LeadRow) => string | null, label: (id: string | null) => string) => {
    const m = new Map<string | null, number>();
    for (const l of chosen) { const k = key(l); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].map(([id, n]) => ({ id, name: label(id), count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  return {
    box: q.box,
    status: q.box === "status" ? q.status ?? null : null,
    total: chosen.length,
    capped: chosen.length > LIST_CAP,
    byOwner: count((l) => (l.assignedTo ? String(l.assignedTo) : null), (id) => (id ? userOf.get(id)?.name ?? "Unknown" : "Not assigned")),
    byTeam: count((l) => (l.team ? String(l.team) : null), (id) => (id ? teamName.get(id) ?? "Unknown team" : "No team")),
    rows: shown.map((l) => {
      const stage = stageOf(l);
      const mv = movesOf.get(String(l._id)) ?? [];
      const last = mv[mv.length - 1];
      const off = inactive.get(String(l._id));
      const owner = l.assignedTo ? userOf.get(String(l.assignedTo)) : undefined;
      return {
        id: String(l._id), name: l.name ?? "", phone: l.phone ?? "", source: l.source ?? "", status: l.status, stage,
        owner: l.assignedTo ? who(l.assignedTo) : null,
        team: l.team ? { id: String(l.team), name: teamName.get(String(l.team)) ?? "Unknown team" } : null,
        cameIn: new Date(l.originalCreatedAt ?? l.createdAt).toISOString(),
        assignedAt: l.assignedAt ? new Date(l.assignedAt).toISOString() : null,
        move: last ? { from: who(last.from), to: who(last.to), at: new Date(last.createdAt).toISOString(), kind: last.kind, times: mv.length } : null,
        waitedMinutes: off ? Math.floor(off.minutes) : null,
        breakSince: stage === "on_break" && owner?.breakSince ? new Date(owner.breakSince).toISOString() : null,
      };
    }),
  };
}
