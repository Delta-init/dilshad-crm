import { Team } from "../models/Team.js";
import { CommissionSettings } from "../models/CommissionSettings.js";
import type { Leaderboard } from "./leaderboardService.js";

/*
 * Who a salesperson's leaderboard leaves out (the user, 2026-10-28: "when a BDE looks, exclude the team leaders and
 * the sales manager"): the leaders of active teams and the commission plan's Sales Manager. A Super Admin, the Sales
 * Manager and a team leader still see the whole board. Nothing is counted differently — the rows are only not shown,
 * and the ranks are numbered again without them. The open TV board (/public/leaderboard) is not this: it is shown
 * whole.
 */

type Viewer = { userId: string; role?: { isSystemRole?: boolean; roleName?: string } | null };

/** The people this viewer's board leaves out — none for a Super Admin, the Sales Manager or a team leader. */
export async function hiddenFromViewer(viewer: Viewer): Promise<Set<string>> {
  if (viewer.role?.isSystemRole && viewer.role.roleName === "Super Admin") return new Set();
  const [teams, settings] = await Promise.all([
    Team.find({ status: { $ne: "inactive" } }).select("leaders").lean<Array<{ leaders?: unknown[] }>>(),
    CommissionSettings.findOne().select("salesManager").lean<{ salesManager?: unknown } | null>(),
  ]);
  const bosses = new Set<string>();
  for (const t of teams) for (const l of t.leaders ?? []) if (l) bosses.add(String(l));
  if (settings?.salesManager) bosses.add(String(settings.salesManager));
  return bosses.has(viewer.userId) ? new Set() : bosses;
}

/** The board without those people, ranked 1, 2, 3… again in the same order. */
export function withoutHidden(board: Leaderboard, hidden: Set<string>): Leaderboard {
  if (!hidden.size) return board;
  return { ...board, rows: board.rows.filter((r) => !hidden.has(r.userId)).map((r, i) => ({ ...r, rank: i + 1 })) };
}
