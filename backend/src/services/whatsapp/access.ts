import { Types } from "mongoose";
import { Team } from "../../models/Team.js";
import { CommissionSettings } from "../../models/CommissionSettings.js";
import type { IRole } from "../../types/index.js";

/*
 * Who reads whose WhatsApp, and which leads a chat may be linked to (2026-10-27, as in the Sales CRM) — the lines the
 * leads follow: a Super Admin and the Sales Manager, everyone's; a team leader, their active teams' people and their own; anyone else, their own.
 * Only the owner sends from their WhatsApp.
 */

export type Viewer = { userId: string; role?: IRole | null };

const idOf = (v: unknown): string => {
  if (!v) return "";
  if (typeof v === "object" && "_id" in (v as Record<string, unknown>)) return String((v as { _id: unknown })._id);
  return String(v);
};
const isSuperAdmin = (role?: IRole | null) => Boolean(role?.isSystemRole && role.roleName === "Super Admin");

async function ledTeams(userId: string) {
  return Team.find({ status: "active", leaders: new Types.ObjectId(userId) }).select("_id members leaders").lean();
}

async function seesAll(viewer: Viewer): Promise<boolean> {
  if (isSuperAdmin(viewer.role)) return true;
  const s = await CommissionSettings.findOne({ key: "default" }).select("salesManager").lean<{ salesManager?: unknown } | null>();
  return idOf(s?.salesManager) === viewer.userId;
}

/** Whose WhatsApp chats the viewer may read — null: everyone's. */
export async function readableOwners(viewer: Viewer): Promise<Set<string> | null> {
  if (await seesAll(viewer)) return null;
  const led = await ledTeams(viewer.userId);
  return new Set([viewer.userId, ...led.flatMap((t) => [...(t.members ?? []), ...(t.leaders ?? [])].map(idOf))]);
}

/** The leads the viewer may link a chat to, or make one for: a Lead filter. */
export async function leadScope(viewer: Viewer): Promise<Record<string, unknown>> {
  if (await seesAll(viewer)) return {};
  const me = new Types.ObjectId(viewer.userId);
  const led = await ledTeams(viewer.userId);
  if (!led.length) return { assignedTo: me };
  const members = led.flatMap((t) => [...(t.members ?? []), ...(t.leaders ?? [])].map((u) => new Types.ObjectId(idOf(u))));
  return { $or: [{ assignedTo: me }, { team: { $in: led.map((t) => t._id) } }, { team: null, assignedTo: { $in: members } }] };
}

/** Whether the viewer's role may do `action` on WhatsApp (a Super Admin may do anything). */
export function canWhatsApp(viewer: Viewer, action: "view" | "create"): boolean {
  if (isSuperAdmin(viewer.role)) return true;
  return (viewer.role?.permissions as Record<string, Record<string, boolean> | undefined> | undefined)?.whatsapp?.[action] === true;
}
