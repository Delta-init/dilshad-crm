import type { NextFunction, Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Lead } from "../models/Lead.js";
import { LeadSourceTeam, sourceKey } from "../models/LeadSourceTeam.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";

/*
 * Lead sources → teams (the owner, 2026-11-03): for each source, the teams its automatic split may give leads to. A
 * source with no teams set goes to every team with auto-assign on (leadService.autoAssignLeads). Super Admin.
 */

/** GET /teams/source-rules — every source the CRM has seen (and how many leads), the teams set for it, and the teams. */
export async function getSourceRules(_req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const [seen, rules, teams] = await Promise.all([
      Lead.aggregate<{ _id: string; n: number }>([
        { $match: { source: { $nin: [null, ""] } } },
        { $group: { _id: { $trim: { input: "$source" } }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 300 },
      ]),
      LeadSourceTeam.find().lean(),
      Team.find().select("name status settings.autoAssign").sort({ name: 1 }).lean<{ _id: Types.ObjectId; name: string; status: string; settings?: { autoAssign?: boolean } }[]>(),
    ]);
    // One row per source, whatever its case; the leads' own spelling (the commonest) shown.
    const rows = new Map<string, { source: string; leads: number; teams: string[]; updatedByName: string; updatedAt: Date | null }>();
    for (const s of seen) {
      const k = sourceKey(s._id);
      const row = rows.get(k);
      if (row) row.leads += s.n;
      else rows.set(k, { source: s._id.trim(), leads: s.n, teams: [], updatedByName: "", updatedAt: null });
    }
    for (const r of rules) {
      const row = rows.get(r.key) ?? { source: r.source, leads: 0, teams: [], updatedByName: "", updatedAt: null };
      rows.set(r.key, { ...row, teams: (r.teams ?? []).map(String), updatedByName: r.updatedByName ?? "", updatedAt: r.updatedAt ?? null });
    }
    sendSuccess(res, "Lead sources", {
      sources: [...rows.values()],
      teams: teams.map((t) => ({ id: String(t._id), name: t.name, active: t.status === "active", autoAssign: !!t.settings?.autoAssign })),
    });
  } catch (err) { next(err); }
}

const putSchema = z.object({
  source: z.string().trim().min(1).max(100),
  teams: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(20),
});

/** PUT /teams/source-rules { source, teams } — the teams this source's leads are split to; [] = back to the default. */
export async function putSourceRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, "A source and its teams are required", 400, parsed.error.flatten().fieldErrors); return; }
    const { source, teams } = parsed.data;
    const ids = [...new Set(teams)].map((t) => new Types.ObjectId(t));
    if (ids.length && (await Team.countDocuments({ _id: { $in: ids } })) !== ids.length) { sendError(res, "No such team", 404); return; }
    const me = await User.findById(req.user!.userId).select("name").lean<{ name?: string } | null>();
    const key = sourceKey(source);
    if (!ids.length) await LeadSourceTeam.deleteOne({ key });
    else await LeadSourceTeam.updateOne({ key }, { $set: { key, source, teams: ids, updatedByName: String(me?.name ?? "") } }, { upsert: true });
    console.log(`[lead-sources] "${source}" → ${ids.length ? ids.map(String).join(", ") : "every team with auto-assign on"} (by ${me?.name ?? req.user!.userId})`);
    sendSuccess(res, ids.length ? "Saved" : "Back to every team with auto-assign on", { source, teams: ids.map(String) });
  } catch (err) { next(err); }
}
