import { Types, type PipelineStage } from "mongoose";
import { LeadCall, type ILeadCall } from "../models/LeadCall.js";
import { Lead } from "../models/Lead.js";
import { Team } from "../models/Team.js";
import { loadConfig, isSuperAdmin } from "./commissionService.js";
import { threecxConfigured } from "../lib/threecx.js";
import { BACKFILL_DAYS, getCallSettings, recordingCount } from "./callSyncService.js";
import { dubaiDayRange, dubaiToday } from "../utils/dubaiDay.js";
import { buildPagination } from "../utils/response.js";
import type { IRole } from "../types/index.js";

/* ────────────────────────────────────────────────────────────────────────────
   The Calls page and a lead's Calls section: the 3CX calls in `lead_calls`
   (services/callSyncService.ts) — never the older call_logs.

   Who sees which calls follows the lead list (leadService.getLeads):
     - the Super Admin, the Reporter role and the Sales Manager (Commission
       settings): every call;
     - a team leader: calls taken by anyone in the team(s) they lead, and every
       call with a lead of those teams;
     - anyone else: calls they took themselves (their extension), and every
       call with a lead assigned to them.
   Calls nobody here took (missed, an extension no user has) show to those who
   see everything, and to whoever the lead belongs to.
──────────────────────────────────────────────────────────────────────────── */

export interface Viewer { userId: string; role?: IRole }

type Scope = { everyone: true } | { everyone: false; users: Types.ObjectId[]; teams: Types.ObjectId[]; me: Types.ObjectId };

const oid = (v: string) => new Types.ObjectId(v);

export async function scopeOf(viewer: Viewer): Promise<Scope> {
  if (isSuperAdmin(viewer.role) || viewer.role?.roleName === "Reporter") return { everyone: true };
  const config = await loadConfig();
  if (config.salesManager && String(config.salesManager) === viewer.userId) return { everyone: true };
  const me = oid(viewer.userId);
  const teams = await Team.find({ leaders: me }).select("leaders members").lean<{ _id: Types.ObjectId; leaders: Types.ObjectId[]; members: Types.ObjectId[] }[]>();
  const users = new Map<string, Types.ObjectId>([[viewer.userId, me]]);
  for (const t of teams) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) users.set(String(u), u);
  return { everyone: false, users: [...users.values()], teams: teams.map((t) => t._id), me };
}

/** The calls a scope covers, as a filter (null = every call). */
async function scopeFilter(scope: Scope): Promise<Record<string, unknown> | null> {
  if (scope.everyone) return null;
  const leads = await Lead.distinct("_id", scope.teams.length ? { team: { $in: scope.teams } } : { assignedTo: scope.me });
  return { $or: [{ user: { $in: scope.users } }, { lead: { $in: leads } }] };
}

/** Whether the lead list shows this lead to the viewer (getLeads' rule). */
async function leadInScope(scope: Scope, leadId: Types.ObjectId): Promise<boolean> {
  if (scope.everyone) return true;
  const lead = await Lead.findById(leadId).select("team assignedTo").lean<{ team?: Types.ObjectId | null; assignedTo?: Types.ObjectId | null }>();
  if (!lead) return false;
  if (scope.teams.length) return !!lead.team && scope.teams.some((t) => t.equals(lead.team!));
  return !!lead.assignedTo && scope.me.equals(lead.assignedTo);
}

/** Whether the viewer's lead list shows this lead — who may call it from the CRM (Call button, 3CX makecall). */
export async function canWorkLead(viewer: Viewer, leadId: Types.ObjectId): Promise<boolean> {
  return leadInScope(await scopeOf(viewer), leadId);
}

/** Whether the viewer may see (and play) one call: it is in their Calls list, or its lead is theirs. */
export async function canSeeCall(viewer: Viewer, call: Pick<ILeadCall, "user" | "lead">): Promise<boolean> {
  const scope = await scopeOf(viewer);
  if (scope.everyone) return true;
  if (call.user && scope.users.some((u) => u.equals(call.user!))) return true;
  return leadInScope(scope, call.lead);
}

/* ── who a call is counted under ─────────────────────────────────────────── */

/** The CRM user, else the 3CX extension, else "-" (nobody took it). */
const personKey = (userId: string, extension: string) => (userId ? `u:${userId}` : extension ? `x:${extension}` : "-");
function personFilter(key: string): Record<string, unknown> | null {
  if (key === "-") return { user: null, extension: "" };
  if (key.startsWith("u:") && Types.ObjectId.isValid(key.slice(2))) return { user: oid(key.slice(2)) };
  if (key.startsWith("x:")) return { user: null, extension: key.slice(2) };
  return null;
}

/* ── filters ─────────────────────────────────────────────────────────────── */

export interface CallFilters {
  preset?: string;   // today | 7d | 30d | month — or from/to
  from?: string;     // YYYY-MM-DD, Dubai days
  to?: string;
  direction?: string; // in | out
  result?: string;    // connected | missed | not_answered
  person?: string;    // u:<userId> | x:<extension> | -
  search?: string;    // lead name or number
  sort?: string;      // date | talk | ring
  order?: string;     // asc | desc
  page?: string;
  limit?: string;
}

const RESULT: Record<string, ILeadCall["status"]> = {
  connected: "answered", answered: "answered", missed: "missed", not_answered: "no_answer", no_answer: "no_answer",
};
const SORT: Record<string, string> = { date: "startedAt", talk: "talkSeconds", ring: "ringSeconds" };

/** A YYYY-MM-DD moved by whole days. */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** From and to (Dubai calendar days) for the filters; 7 days to today when nothing is picked. */
export function periodOf(f: Pick<CallFilters, "preset" | "from" | "to">): { from: string; to: string } {
  const today = dubaiToday();
  const preset = f.preset || (f.from || f.to ? "custom" : "7d");
  switch (preset) {
    case "today": return { from: today, to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "month": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": {
      const ok = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
      return { from: ok(f.from), to: ok(f.to) };
    }
    default: return { from: addDays(today, -6), to: today };
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function searchFilter(search: string): Promise<Record<string, unknown> | null> {
  const q = search.trim().slice(0, 80);
  if (!q) return null;
  const or: Record<string, unknown>[] = [{ leadName: { $regex: escape(q), $options: "i" } }];
  const digits = q.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length >= 3) or.push({ number: { $regex: digits } });
  // The lead's name as it is now (a lead renamed since the call).
  const leads = await Lead.find({ name: { $regex: escape(q), $options: "i" } }).select("_id").limit(1000).lean();
  if (leads.length) or.push({ lead: { $in: leads.map((l) => l._id) } });
  return { $or: or };
}

const count = (status: string) => ({ $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] } });
const statGroup = {
  calls: { $sum: 1 },
  incoming: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] } },
  outgoing: { $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] } },
  connected: count("answered"),
  missed: count("missed"),
  notAnswered: count("no_answer"),
  talkSeconds: { $sum: { $ifNull: ["$talkSeconds", 0] } },
  recorded: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$recordingIds", []] } }, 0] }, 1, 0] } },
};

export interface CallStats {
  total: number; incoming: number; outgoing: number; connected: number; missed: number; notAnswered: number;
  talkSeconds: number; averageTalkSeconds: number; recorded: number;
}

function statsOf(g?: Record<string, number> | null): CallStats {
  const connected = g?.connected ?? 0;
  const talkSeconds = g?.talkSeconds ?? 0;
  return {
    total: g?.calls ?? 0,
    incoming: g?.incoming ?? 0,
    outgoing: g?.outgoing ?? 0,
    connected,
    missed: g?.missed ?? 0,
    notAnswered: g?.notAnswered ?? 0,
    talkSeconds,
    averageTalkSeconds: connected ? Math.round(talkSeconds / connected) : 0,
    recorded: g?.recorded ?? 0,
  };
}

type CallDoc = ILeadCall & { _id: Types.ObjectId; lead: { _id: Types.ObjectId; name?: string; phone?: string } | Types.ObjectId | null };

function row(c: CallDoc) {
  const lead = c.lead && typeof c.lead === "object" && "name" in c.lead ? c.lead : null;
  const userId = c.user ? String(c.user) : "";
  return {
    id: String(c._id),
    startedAt: c.startedAt,
    direction: c.direction,
    status: c.status,
    talkSeconds: c.talkSeconds ?? 0,
    ringSeconds: c.ringSeconds ?? 0,
    number: c.number ?? "",
    extension: c.extension ?? "",
    agentName: c.agentName ?? "",
    userId,
    userName: c.userName ?? "",
    person: personKey(userId, c.extension ?? ""),
    leadId: lead ? String(lead._id) : String(c.lead ?? ""),
    leadName: lead?.name ?? c.leadName ?? "",
    leadPhone: lead?.phone ?? "",
    recordings: recordingCount(c),
    reason: c.reason ?? "",
  };
}

async function threecxStatus(viewer: Viewer) {
  const s = await getCallSettings();
  return {
    connected: threecxConfigured(),
    updatedAt: s.lastOkAt ?? null,
    firstImportDone: !!s.backfilledAt,
    running: !!(s.lockUntil && new Date(s.lockUntil).getTime() > Date.now()),
    backfillDays: BACKFILL_DAYS,
    // What went wrong, for the Super Admin only.
    error: isSuperAdmin(viewer.role) ? s.lastError ?? null : null,
  };
}

export class LeadCallService {
  /**
   * The Calls page: one page of calls (newest first unless sorted otherwise), the totals over every matching call,
   * and a row per person over every matching call bar the person filter (so the table still lists everyone).
   */
  async list(viewer: Viewer, f: CallFilters, opts: { maxLimit?: number } = {}) {
    const scope = await scopeOf(viewer);
    const and: Record<string, unknown>[] = [];
    const inScope = await scopeFilter(scope);
    if (inScope) and.push(inScope);
    const period = periodOf(f);
    const range = dubaiDayRange(period.from, period.to) ?? {};
    if (Object.keys(range).length) and.push({ startedAt: range });
    if (f.direction === "in" || f.direction === "out") and.push({ direction: f.direction });
    const status = RESULT[String(f.result ?? "")];
    if (status) and.push({ status });
    const search = await searchFilter(String(f.search ?? ""));
    if (search) and.push(search);
    const base = and.length ? { $and: and } : {};

    const grouped = await LeadCall.aggregate<{ _id: { u: Types.ObjectId | null; x: string }; userName: string; agentName: string } & Record<string, number>>([
      { $match: base },
      { $group: { _id: { u: { $ifNull: ["$user", null] }, x: { $ifNull: ["$extension", ""] } }, userName: { $first: "$userName" }, agentName: { $first: "$agentName" }, ...statGroup } },
    ] as PipelineStage[]);
    const KEYS = ["calls", "incoming", "outgoing", "connected", "missed", "notAnswered", "talkSeconds", "recorded"] as const;
    type Totals = Record<(typeof KEYS)[number], number>;
    const zero = (): Totals => ({ calls: 0, incoming: 0, outgoing: 0, connected: 0, missed: 0, notAnswered: 0, talkSeconds: 0, recorded: 0 });
    const people = new Map<string, { key: string; userId: string; extension: string; name: string; totals: Totals }>();
    for (const g of grouped) {
      const userId = g._id.u ? String(g._id.u) : "";
      const key = personKey(userId, g._id.x);
      const p = people.get(key) ?? {
        key,
        userId,
        extension: g._id.x,
        name: g.userName || g.agentName || (g._id.x ? `Ext ${g._id.x}` : "Nobody — not answered"),
        totals: zero(),
      };
      for (const k of KEYS) p.totals[k] += g[k] ?? 0;
      people.set(key, p);
    }

    const person = String(f.person ?? "").slice(0, 80);
    const onePerson = person ? personFilter(person) : null;
    const match = onePerson ? { $and: [...and, onePerson] } : base;
    const sum = zero();
    for (const p of onePerson ? [people.get(person)].filter(Boolean) : [...people.values()]) {
      for (const k of KEYS) sum[k] += p!.totals[k];
    }
    const stats = statsOf(sum);

    const page = Math.max(1, parseInt(String(f.page ?? "1"), 10) || 1);
    const limit = Math.min(opts.maxLimit ?? 200, Math.max(1, parseInt(String(f.limit ?? "50"), 10) || 50));
    const sortField = SORT[String(f.sort ?? "date")] ?? "startedAt";
    const dir = f.order === "asc" ? 1 : -1;
    const sort: Record<string, 1 | -1> = sortField === "startedAt" ? { startedAt: dir, _id: dir } : { [sortField]: dir, startedAt: -1, _id: -1 };
    const docs = await LeadCall.find(match).sort(sort).skip((page - 1) * limit).limit(limit).populate("lead", "name phone").lean<CallDoc[]>();

    return {
      calls: docs.map(row),
      pagination: buildPagination(stats.total, page, limit),
      stats,
      people: [...people.values()]
        .map(({ totals, ...p }) => ({ ...p, ...statsOf(totals) }))
        .sort((a, b) => b.total - a.total),
      period,
      threecx: await threecxStatus(viewer),
      canSync: isSuperAdmin(viewer.role),
    };
  }

  /**
   * A lead's calls (its page's Calls section): all of them when the lead is one the viewer's lead list shows,
   * otherwise only those they took themselves. Newest first, at most 500, with totals.
   */
  async forLead(viewer: Viewer, leadId: string) {
    if (!Types.ObjectId.isValid(leadId)) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    const lead = oid(leadId);
    if (!(await Lead.exists({ _id: lead }))) throw Object.assign(new Error("Lead not found"), { statusCode: 404 });
    const scope = await scopeOf(viewer);
    const filter: Record<string, unknown> = { lead };
    if (!scope.everyone && !(await leadInScope(scope, lead))) filter.user = scope.me;
    const [g] = await LeadCall.aggregate<Record<string, number>>([{ $match: filter }, { $group: { _id: null, ...statGroup } }] as PipelineStage[]);
    const docs = await LeadCall.find(filter).sort({ startedAt: -1, _id: -1 }).limit(500).populate("lead", "name phone").lean<CallDoc[]>();
    return { calls: docs.map(row), stats: statsOf(g), threecx: await threecxStatus(viewer) };
  }
}

export const leadCallService = new LeadCallService();
