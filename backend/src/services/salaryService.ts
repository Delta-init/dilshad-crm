import { Types } from "mongoose";
import { CommissionSale } from "../models/CommissionSale.js";
import { FinanceHandover } from "../models/FinanceHandover.js";
import { Student } from "../models/Student.js";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { COUNT_FROM, commissionScope, feeOf, idOf, monthRange, owedShareOf, partOf, shareBetween, isSuperAdmin, loadConfig, slabsForScope, uaeMonthOf } from "./commissionService.js";
import { slabsFor, TL_SLAB } from "./salarySlabs.js";
import type { CommissionSaleState, IRole, ISlabRow, ISlabs, SlabRole } from "../types/index.js";
import { fetchCommissionPayouts, type CommissionPayout } from "./financeClient.js";

/*
 * A month's salary and commission on the salary slabs (the user, 2026-10-05,
 * this Sales CRM only).
 *
 *   - what a target counts: the money received in the month on each sale
 *     finance has approved and not voided — a sale's balance paid next month
 *     counts next month, money received before October never (the user,
 *     2026-10-31: "that month collected payment only count");
 *   - Sales Staff count the sales they closed; a Team Leader their team's sales,
 *     their own closes in it included; the Sales Manager every sale in the CRM,
 *     shared logins' included. A shared login's sale counts for nobody else;
 *   - one slab a person: the Sales Manager is on the SM slab even on the team
 *     he leads, a team leader on the TL slab;
 *   - the level is the highest whose target the month's sales reach, the base
 *     below the first;
 *   - pay = the level's salary + the commission earned that month × its
 *     percent. The commission is every line the person earned, in any role, on
 *     the month's counted sales — so a team leader's own closes are in it.
 *
 * Worked out when asked, from the records the commission sweep keeps; nothing
 * is stored. A month's figures move while its sales are still approved,
 * counted or voided.
 */

/** The first month on the slabs: commission counts sales closed from 1 October 2026. */
export const PAY_FROM_MONTH = uaeMonthOf(COUNT_FROM);

const round2 = (n: number) => Math.round(n * 100) / 100;

type Level = ISlabRow & { index: number };

export interface PayRow {
  user: string;
  name: string;
  role: SlabRole;
  /** The teams a team leader's target counts. */
  teams: string[];
  /** Finance-approved sales the target counts: how many, what is collected on them, and their full fees. */
  sales: { count: number; value: number; fee: number };
  /** Closed this month, not approved by finance yet: they count once it does. */
  awaitingFinance: { count: number; value: number };
  level: Level;
  /** The next level that pays differently, and how much more it takes; null at the top. */
  next: (Level & { more: number }) | null;
  salary: number;
  percent: number;
  /** Where finance stands on the month's commission: approved by a manager, then paid (2026-10-21); null when neither. */
  payout?: CommissionPayout | null;
  commission: {
    /** Earned on sales counted this month, in every role — on what is collected. */
    earned: number;
    /** The rest of those lines: earned as their balance payments are approved. */
    balance: number;
    payable: number;
    /** Sales still finishing their steps: their commission is added once they're counted. */
    notCountedYet: number;
  };
  total: number;
}

/** The level a month's sales reach on a slab, and the next one that pays differently. */
export function levelOf(rows: ISlabRow[], value: number): { level: Level; next: PayRow["next"] } {
  let i = 0;
  for (let k = 0; k < rows.length; k++) if (rows[k]!.target <= value) i = k;
  const level = { ...rows[i]!, index: i };
  let j = i + 1;
  while (j < rows.length && rows[j]!.salary === level.salary && rows[j]!.percent === level.percent) j++;
  const n = rows[j];
  return { level, next: n ? { ...n, index: j, more: round2(n.target - value) } : null };
}

type Fact = {
  closer: string;
  team: string;
  fee: number;
  /** The fee received in this month: what a target counts. */
  collected: number;
  /** Closed in this month (not only paid in it). */
  inMonth: boolean;
  approved: boolean;
  state: CommissionSaleState;
  lines: { user: string; amount: number; balance: number }[];
};

type TeamLite = { _id: Types.ObjectId; name: string; status?: string; leaders?: unknown[]; members?: unknown[] };

/** Every sale closed in the month, or paid on in it, and not voided, as the slabs count it. */
async function monthFacts(month: string, activeTeams: TeamLite[]): Promise<Fact[]> {
  const { from, to } = monthRange(month);
  const sales = await CommissionSale.find({
    state: { $ne: "reversed" },
    $or: [{ month }, { collections: { $elemMatch: { paidAt: { $gte: from, $lte: to } } } }],
  })
    .select("student closer team state lines fee saleDate month paidShare owedShare collections")
    .lean();
  if (!sales.length) return [];
  const ids = sales.map((s) => s.student);
  const [handovers, students] = await Promise.all([
    FinanceHandover.find({ studentId: { $in: ids } }).select("studentId approvalState").lean(),
    Student.find({ _id: { $in: ids } }).select("team assignedTo totalFee").lean(),
  ]);
  const approvedInFinance = new Set(
    handovers
      .filter((h) => h.approvalState === "approved" || h.approvalState === "not_required")
      .map((h) => String(h.studentId)),
  );
  const studentOf = new Map(students.map((s) => [String(s._id), s]));
  const inTeam = (t: TeamLite, user: string) => [...(t.leaders ?? []), ...(t.members ?? [])].some((u) => idOf(u) === user);

  return sales.map((s) => {
    const student = studentOf.get(String(s.student));
    const closer = idOf(s.closer) || idOf(student?.assignedTo);
    // The sale's team as commission resolves it: its own, else the closer's one team.
    let team = idOf(s.team) || idOf(student?.team);
    if (!team && closer) {
      const theirs = activeTeams.filter((t) => inTeam(t, closer));
      if (theirs.length === 1) team = String(theirs[0]!._id);
    }
    const fee = typeof s.fee === "number" ? s.fee : feeOf(null, student?.totalFee);
    const share = shareBetween(s, from, to);
    const owed = owedShareOf(s);
    return {
      closer,
      team,
      fee,
      collected: round2(fee * share),
      inMonth: s.month === month,
      // Counted and held sales were decided after finance approved them.
      approved: s.state === "counted" || s.state === "waiting" || approvedInFinance.has(String(s.student)),
      state: s.state,
      lines: s.state === "counted"
        ? s.lines.map((l) => ({ user: idOf(l.user), amount: partOf(l.amount, share), balance: partOf(l.amount, owed) }))
        : [],
    };
  });
}

/** Everyone on the slabs in a month, with what the month pays them. */
export async function payRows(month: string, slabs: ISlabs): Promise<PayRow[]> {
  const config = await loadConfig();
  const sm = idOf(config.salesManager);
  const excluded = config.excluded;
  const teams = (await Team.find({}).select("name status leaders members").lean()) as unknown as TeamLite[];
  const active = teams.filter((t) => t.status === "active");
  const facts = await monthFacts(month, active);

  /*
   * Who is on the slabs: the Sales Manager, everyone in an active team, and
   * anyone with a sale or commission this month (somebody who left a team
   * mid-month still has their month). Never a shared login.
   */
  const ids = new Set<string>();
  if (sm) ids.add(sm);
  for (const t of active) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) ids.add(idOf(u));
  for (const f of facts) {
    if (f.closer) ids.add(f.closer);
    for (const l of f.lines) ids.add(l.user);
  }
  for (const x of excluded) ids.delete(x);
  ids.delete("");
  const users = await User.find({ _id: { $in: [...ids].filter((id) => Types.ObjectId.isValid(id)) } })
    .select("name status")
    .lean();

  const ledTeams = (user: string) => teams.filter((t) => (t.leaders ?? []).some((l) => idOf(l) === user));
  const rank: Record<SlabRole, number> = { sm: 0, tl: 1, sales: 2 };
  const rows: PayRow[] = [];

  for (const u of users) {
    const user = String(u._id);
    const led = ledTeams(user);
    const role: SlabRole = user === sm ? "sm" : TL_SLAB && led.some((t) => t.status === "active") ? "tl" : "sales";
    const ledIds = new Set(led.map((t) => String(t._id)));
    const counts = (f: Fact) =>
      role === "sm" ? true : role === "tl" ? ledIds.has(f.team) && !excluded.has(f.closer) : f.closer === user;

    const mine = facts.filter(counts);
    const approved = mine.filter((f) => f.approved && (f.inMonth || f.collected > 0));
    const awaiting = mine.filter((f) => !f.approved && f.inMonth);
    const earned = round2(facts.reduce((sum, f) => sum + f.lines.filter((l) => l.user === user).reduce((s, l) => s + l.amount, 0), 0));
    const balance = round2(facts.reduce((sum, f) => sum + f.lines.filter((l) => l.user === user).reduce((s, l) => s + l.balance, 0), 0));
    // Nothing this month, and no longer here: not on the list.
    if (u.status !== "active" && !mine.length && !earned) continue;

    const value = round2(approved.reduce((s, f) => s + f.collected, 0));
    const { level, next } = levelOf(slabs[role], value);
    const payable = round2((earned * level.percent) / 100);
    rows.push({
      user,
      name: u.name ?? "",
      role,
      teams: role === "tl" ? led.filter((t) => t.status === "active").map((t) => t.name) : [],
      sales: { count: approved.length, value, fee: round2(approved.reduce((s, f) => s + f.fee, 0)) },
      awaitingFinance: { count: awaiting.length, value: round2(awaiting.reduce((s, f) => s + f.fee, 0)) },
      level,
      next,
      salary: level.salary,
      percent: level.percent,
      commission: {
        earned,
        balance,
        payable,
        notCountedYet: mine.filter((f) => f.inMonth && (f.state === "progress" || f.state === "waiting")).length,
      },
      total: round2(level.salary + payable),
    });
  }

  return rows.sort((a, b) => rank[a.role] - rank[b.role] || b.total - a.total || a.name.localeCompare(b.name));
}

/** Finance's payouts for a month, a minute at a time — My Pay is opened often; null when finance can't be asked. */
const payoutCache = new Map<string, { at: number; rows: CommissionPayout[] | null }>();
async function payoutsFor(month: string): Promise<CommissionPayout[] | null> {
  const hit = payoutCache.get(month);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  let rows: CommissionPayout[] | null;
  try {
    rows = await fetchCommissionPayouts(month);
  } catch {
    rows = null;
  }
  payoutCache.set(month, { at: Date.now(), rows });
  return rows;
}

export class SalaryService {
  /**
   * A month's pay as the viewer may see it: their own, and — for a Super
   * Admin or the Sales Manager (the user, 2026-10-05: "abrar also see everyone
   * pay") — everyone's. Team leaders see their own only. The slabs of that
   * month come with it.
   */
  async getPay(viewer: { userId: string; role?: IRole }, month: string) {
    const { slabs, from } = await slabsFor(month);
    const payouts = await payoutsFor(month);
    const byUser = new Map((payouts ?? []).map((p) => [p.userId, p]));
    const rows = (await payRows(month, slabs)).map((r) => ({ ...r, payout: byUser.get(r.user) ?? null }));
    const me = rows.find((r) => r.user === viewer.userId) ?? null;
    // Everyone's pay: Super Admins and the Sales Manager. A team leader: their own active teams' people (the user,
    // 2026-10-23 — they used to see only their own). Others: their own.
    const scope = await commissionScope(viewer);
    const everyone = scope.all || me?.role === "sm";
    const team = !everyone && scope.ledTeamIds.length > 0;
    const people = everyone ? rows : team ? rows.filter((r) => scope.teamPeople.has(r.user)) : null;
    return {
      month,
      view: everyone ? "all" : team ? "team" : "own",
      slabs: everyone ? slabs : slabsForScope(slabs as unknown as Record<string, unknown>, scope),
      slabsFrom: from,
      /** False when finance couldn't be asked: the payouts aren't shown, not "none". */
      payoutsKnown: payouts !== null,
      me,
      people,
      totals: people
        ? {
            people: people.length,
            salary: round2(people.reduce((s, r) => s + r.salary, 0)),
            payable: round2(people.reduce((s, r) => s + r.commission.payable, 0)),
            total: round2(people.reduce((s, r) => s + r.total, 0)),
          }
        : null,
    };
  }
}
