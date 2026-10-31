import { Types } from "mongoose";
import { CommissionSettings } from "../models/CommissionSettings.js";
import type { ISalarySlabsVersion, ISlabRow, ISlabs, SlabRole } from "../types/index.js";
import { fromRoot, rootSlabs } from "./rootCommission.js";

/*
 * The salary slabs (the user, 2026-10-07: "Commission & Salary Slab — Sales
 * Staff" and "Team Draw — Maneesh as Sales Manager"; the same sheet the Remote
 * CRM uses for dilshad). One ladder per role: the month's approved sales reach
 * a level, and the level pays a salary plus a percent of the commission earned
 * that month. The first row of each is the base, at target 0 — what a month
 * below the first level pays (Sales Staff 2,000 at 0%, as E; the Sales Manager
 * 5,000 at 50%, as at 120,000).
 *
 * Two slabs here, not the Sales CRM's three: no Team Leader slab — a team
 * leader is paid on the Sales Staff slab, on their own sales (TL_SLAB).
 *
 * Kept as versions: a change is in force from the month it was made in (UAE)
 * until the next one, so changing the slabs in November leaves October's pay
 * as it was. With none saved, the sheet below.
 */

/** Whether team leaders have a slab of their own. Not in this CRM: they are on the Sales Staff slab. */
export const TL_SLAB = false;

export const SLAB_ROLES: readonly SlabRole[] = TL_SLAB ? ["sales", "tl", "sm"] : ["sales", "sm"];

/** The owner's sheet, as given. */
export const DEFAULT_SLABS: ISlabs = {
  sales: [
    { name: "Base", target: 0, salary: 2000, percent: 0 },
    { name: "E", target: 10_000, salary: 2000, percent: 0 },
    { name: "D", target: 15_000, salary: 2500, percent: 50 },
    { name: "C", target: 22_000, salary: 3000, percent: 100 },
    { name: "B", target: 26_000, salary: 3500, percent: 100 },
    { name: "A", target: 32_000, salary: 4000, percent: 100 },
  ],
  // Unused here (TL_SLAB is off) — kept so the slab shape is the Sales CRM's.
  tl: [{ name: "Base", target: 0, salary: 2000, percent: 0 }],
  sm: [
    { name: "Base", target: 0, salary: 5000, percent: 50 },
    { name: "Level 1", target: 120_000, salary: 5000, percent: 50 },
    { name: "Level 2", target: 154_000, salary: 10_000, percent: 100 },
  ],
};

const rowsOf = (rows: ISlabRow[] | undefined): ISlabRow[] =>
  (rows ?? []).map((r) => ({ name: r.name, target: r.target, salary: r.salary, percent: r.percent }));

/**
 * The slabs in force in a month ("YYYY-MM" — they sort as strings) and the
 * month they were set in; null when they are still the sheet's.
 */
export function slabsIn(
  versions: ISalarySlabsVersion[] | undefined,
  month: string,
): { slabs: ISlabs; from: string | null } {
  const v = (versions ?? [])
    .filter((x) => x.from <= month)
    .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0];
  const slabs = {} as ISlabs;
  for (const role of SLAB_ROLES) {
    const saved = rowsOf(v?.[role]);
    slabs[role] = saved.length ? saved : rowsOf(DEFAULT_SLABS[role]);
  }
  return { slabs, from: v?.from ?? null };
}

export async function slabsFor(month: string) {
  // Root's slabs for the month while commission comes from Root (2026-11-01).
  if (fromRoot()) return rootSlabs(month);
  const s = await CommissionSettings.findOne({ key: "default" }).select("salarySlabs").lean();
  return slabsIn(s?.salarySlabs as ISalarySlabsVersion[] | undefined, month);
}

/** What is wrong with a role's rows, or null: a base at 0 first, then targets rising. */
export function slabProblem(rows: ISlabRow[]): string | null {
  if (!rows.length) return "A slab needs at least its base row";
  if (rows[0]!.target !== 0) return "The first row is the base: its target must be 0";
  for (let i = 1; i < rows.length; i++) {
    if (!(rows[i]!.target > rows[i - 1]!.target)) {
      return `Each level's target must be higher than the one before (row ${i + 1})`;
    }
  }
  return null;
}

/**
 * One role's slab changed, in force from `month` (this month, UAE) on. The
 * other roles' slabs are carried into the new version as they stand.
 */
export async function saveSlab(role: SlabRole, rows: ISlabRow[], userId: string, month: string) {
  const s = await CommissionSettings.findOne({ key: "default" }).select("salarySlabs").lean();
  const versions = (s?.salarySlabs ?? []) as ISalarySlabsVersion[];
  const { slabs } = slabsIn(versions, month);
  const next: ISalarySlabsVersion = {
    from: month,
    ...slabs,
    [role]: rowsOf(rows),
    updatedAt: new Date(),
    updatedBy: new Types.ObjectId(userId),
  };
  const kept = versions.filter((v) => v.from !== month);
  await CommissionSettings.updateOne(
    { key: "default" },
    {
      $set: { salarySlabs: [...kept, next].sort((a, b) => (a.from < b.from ? -1 : 1)) },
      $setOnInsert: { key: "default" },
    },
    { upsert: true },
  );
  return slabsFor(month);
}
