import { Types } from "mongoose";
import { LeadCall } from "../models/LeadCall.js";
import { User } from "../models/User.js";
import type { IRole } from "../types/index.js";
import { leadCallService, type CallFilters } from "./leadCallService.js";
import { LINK_TTL_S, recordingPath, recordingSource } from "./callSyncService.js";

/*
 * 3CX calls for the Root portal (2026-10-14): Root's "3CX calls" page and the
 * calls on its Pending page, every portal side by side. Root asks with its
 * portal secret (routes/portalRoutes.ts) and sees every call, as a Super Admin
 * does here — the same filters, totals and per-person table as this CRM's own
 * Calls page (leadCallService.list), in the shape every portal answers Root
 * with, and each person's email so Root can put one person's calls together
 * across portals. Read only.
 *
 * A recording plays the way it does here: a link signed by this server for 10
 * minutes (recordingPath), which Root hands to the browser.
 */

/** Root reads as a Super Admin reads: every call. */
const ROOT: { userId: string; role: IRole } = {
  userId: "root-portal",
  role: { isSystemRole: true, roleName: "Super Admin" } as unknown as IRole,
};

const FILTER_KEYS = ["from", "to", "direction", "result", "person", "search", "sort", "order", "page", "limit"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObjectId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);

type Stats = { total: number; incoming: number; outgoing: number; connected: number; missed: number; notAnswered: number; talkSeconds: number; averageTalkSeconds: number; recorded: number };
/** In the shape every portal answers Root with. */
const totals = (s: Stats) => ({
  calls: s.total, outgoing: s.outgoing, incoming: s.incoming, connected: s.connected, missed: s.missed,
  notAnswered: s.notAnswered, talkSeconds: s.talkSeconds, recorded: s.recorded, avgTalkSeconds: s.averageTalkSeconds,
});

export class CallFilterError extends Error {}

/** GET /service/calls — from/to are Dubai days (YYYY-MM-DD); `list=0` for the totals and people only. */
export async function callsForPortal(query: Record<string, unknown>) {
  const f: CallFilters = {};
  for (const k of FILTER_KEYS) if (typeof query[k] === "string") f[k] = String(query[k]).slice(0, 100);
  if ((f.from && !DAY.test(f.from)) || (f.to && !DAY.test(f.to))) throw new CallFilterError("from / to must be dates (YYYY-MM-DD)");
  if (f.from && f.to && f.from > f.to) throw new CallFilterError("from is after to");
  if (f.from || f.to) f.preset = "custom";
  const wantList = query.list !== "0";
  const limit = wantList ? Math.min(1000, Math.max(1, Number(f.limit) || 50)) : 1;
  const r = await leadCallService.list(ROOT, { ...f, limit: String(limit) }, { maxLimit: 1000 });
  const ids = [...new Set([...r.people.map((p) => p.userId), ...r.calls.map((c) => c.userId)].filter(isObjectId))];
  const users = ids.length
    ? await User.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).select("email").lean<{ _id: Types.ObjectId; email?: string }[]>()
    : [];
  const emailOf = new Map(users.map((u) => [String(u._id), String(u.email ?? "").toLowerCase()]));
  return {
    stats: totals(r.stats),
    people: r.people.map((p) => ({
      key: p.key, userId: p.userId, extension: p.extension, name: p.name, email: emailOf.get(p.userId) ?? "",
      ...totals(p),
    })),
    calls: wantList
      ? r.calls.map((c) => ({
          id: c.id, startedAt: c.startedAt, direction: c.direction, status: c.status, talkSeconds: c.talkSeconds,
          ringSeconds: c.ringSeconds, number: c.number, extension: c.extension, agentName: c.agentName, userId: c.userId,
          userName: c.userName, userEmail: emailOf.get(c.userId) ?? "", person: c.person, contact: c.leadName,
          contactKind: "lead", recordings: c.recordings,
        }))
      : [],
    total: r.pagination.total,
    page: r.pagination.page,
    limit: wantList ? limit : 0,
  };
}

/** GET /service/calls/:id/recording-link?index= — the path on this server a browser plays it from (10 minutes); null if none. */
export async function recordingLinkForPortal(id: string, indexRaw: unknown): Promise<{ path: string; expiresIn: number } | null | "bad"> {
  if (!isObjectId(id)) return "bad";
  const index = /^\d{1,2}$/.test(String(indexRaw ?? "0")) ? Number(indexRaw ?? 0) : -1;
  if (index < 0) return "bad";
  const call = await LeadCall.findById(id).lean<{ _id: Types.ObjectId; recordingIds?: number[]; recordingUrl?: string }>();
  if (!call || !recordingSource(call, index)) return null;
  return { path: recordingPath(String(call._id), index, ROOT.userId), expiresIn: LINK_TTL_S };
}
