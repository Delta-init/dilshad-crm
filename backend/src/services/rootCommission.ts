import axios from "axios";
import { Types } from "mongoose";
import { CommissionSettings } from "../models/CommissionSettings.js";
import { Course } from "../models/Course.js";
import type { CommissionRole, ICommissionLine, ISlabRow, ISlabs } from "../types/index.js";

/*
 * Commission worked out by Root (the user, 2026-11-01: "one plan, in Root, one logic for every portal"; "Root works
 * out every figure"). Root keeps this CRM's commission plan and works out, from it and this CRM's data, who earns
 * what on a sale and a month's My Pay. With COMMISSION_FROM_ROOT on, this CRM asks Root for both instead of working
 * them out itself, and every few minutes copies Root's plan into its own settings (course amounts, the Sales Manager,
 * the logins that earn nothing) so the Plan tab, the leaderboard and everything else that reads them follow Root.
 *
 * Off (the default), nothing here is used and the CRM counts with its own plan as before. Root is reached the way the
 * daily tracker reaches it: ROOT_ERP_API_URL, with ROOT_ORG_SECRET proving which CRM is asking.
 */

/**
 * Which CRM this is, as Root names it. A plan Root answers for another CRM is refused, never used or copied in (the
 * user, 2026-11-01: the Remote CRM, given the Sales CRM's secret, was sent the Sales CRM's plan and figures and copied
 * its Sales Manager and excluded logins into its own settings).
 */
export const PORTAL = "remote";

/** Whether this CRM takes its commission figures from Root. */
export const fromRoot = (): boolean => /^(on|true|1|yes)$/i.test(process.env.COMMISSION_FROM_ROOT ?? "");

function root(): { base: string; secret: string } {
  const base = process.env.ROOT_ERP_API_URL;
  const secret = process.env.ROOT_ORG_SECRET;
  if (!base || !secret) throw Object.assign(new Error("Commission is set to come from Root, but ROOT_ERP_API_URL and ROOT_ORG_SECRET are not set"), { statusCode: 503 });
  return { base: base.replace(/\/+$/, ""), secret };
}

/** Root's answer, or an error saying Root couldn't give it (502/503 to whoever asked). */
async function ask<T>(method: "GET" | "POST", path: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const { base, secret } = root();
  try {
    const { data } = await axios.request({
      method, url: `${base}/api/v1/service/commission${path}`, params: opts.params, data: opts.body,
      headers: { "x-org-secret": secret }, timeout: 15_000,
    });
    return data.data as T;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const said = axios.isAxiosError(err) ? (err.response?.data as { message?: string } | undefined)?.message : undefined;
    throw Object.assign(new Error(`Root couldn't work out the commission${said ? `: ${said}` : status ? ` (${status})` : " — it can't be reached"}`), { statusCode: status === 409 ? 503 : 502 });
  }
}

export interface RootPlan {
  portal: string;
  tlRule: string;
  tlSlab: boolean;
  tlPaidOnOwnClose: boolean;
  salesManager: { id: string; name: string } | null;
  excluded: Array<{ id: string; name: string }>;
  courses: Array<{ courseId: string; name: string; sales: number; tl: number; sm: number; creditUsd: number }>;
  month: string;
  slabsFrom: string;
  slabs: Record<"sales" | "tl" | "sm", ISlabRow[]>;
}

/** The plan as Root keeps it, with a month's slabs — a few seconds at a time, as a page asks it more than once. */
const planCache = new Map<string, { at: number; plan: RootPlan }>();
export async function rootPlan(month: string): Promise<RootPlan> {
  const hit = planCache.get(month);
  if (hit && Date.now() - hit.at < 30_000) return hit.plan;
  const plan = await ask<RootPlan>("GET", "/plan", { params: { month } });
  if (plan.portal !== PORTAL) {
    throw Object.assign(
      new Error(`Root answered for the ${plan.portal} CRM, not this one (${PORTAL}) — ROOT_ORG_SECRET here must be Root's ${PORTAL.toUpperCase()}_SSO_SECRET. Nothing was used.`),
      { statusCode: 502 },
    );
  }
  planCache.set(month, { at: Date.now(), plan });
  return plan;
}

/** Test hook: Root's plan asked afresh next time. */
export function forgetRootPlan(): void {
  planCache.clear();
}

/** This month in UAE time, YYYY-MM. */
const thisMonth = () => new Date(Date.now() + 4 * 60 * 60_000).toISOString().slice(0, 7);
/** Root is answering for this CRM: checked on the plan (kept 30 s) before anything else is asked or used. */
const ensurePortal = () => rootPlan(thisMonth());

/** The slabs of a month from Root, as slabsFor gives them: `from` null while they are the built-in ones. */
export async function rootSlabs(month: string): Promise<{ slabs: ISlabs; from: string | null }> {
  const p = await rootPlan(month);
  // A CRM whose team leaders are on the Sales Staff slab has no TL slab to show (Draw, Remote).
  const { tl, ...rest } = p.slabs;
  const slabs = (p.tlSlab ? p.slabs : rest) as ISlabs;
  void tl;
  return { slabs, from: p.slabsFrom && p.slabsFrom !== "2000-01" ? p.slabsFrom : null };
}

/** `…Inr` (2026-11-13): the course's rupee amounts, what the part of a sale paid in rupees pays; absent from a Root before them. */
type Amounts = { sales: number; tl: number; sm: number; creditUsd: number; salesInr?: number; tlInr?: number; smInr?: number };
export interface RootResolved {
  state: "counted" | "waiting" | "excluded";
  reason: string;
  team: Types.ObjectId | null;
  teamName: string;
  lines: ICommissionLine[];
  /** The amounts Root used: the course's row in its plan, or the held ones it was given. */
  plan: Amounts;
}

/** A held sale's amounts as sent to Root: plain numbers, its rupee amounts only where it was held with any. */
function heldAmounts(a: Amounts): Amounts {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const inr = { salesInr: n(a.salesInr), tlInr: n(a.tlInr), smInr: n(a.smInr) };
  return { sales: n(a.sales), tl: n(a.tl), sm: n(a.sm), creditUsd: n(a.creditUsd), ...(inr.salesInr + inr.tlInr + inr.smInr > 0 ? inr : {}) };
}

/**
 * Who earns what on a sale, as Root works it out: from the course's row (a bundle's courses added up), or at the
 * amounts a held sale was held at.
 */
export async function rootResolve(input: { closer: string; team: string; course?: string; courses?: string[]; amounts?: Amounts }): Promise<RootResolved> {
  await ensurePortal();
  const r = await ask<{
    state: RootResolved["state"]; reason: string; team: string | null; teamName: string; plan: Amounts;
    lines: Array<{ role: CommissionRole; user: string; userName: string; amount: number; amountInr?: number; note?: string }>;
  }>("POST", "/resolve", {
    body: {
      closer: input.closer || null, team: input.team || null, course: input.course || null,
      ...(input.courses?.length ? { courses: input.courses } : {}), ...(input.amounts ? { amounts: heldAmounts(input.amounts) } : {}),
    },
  });
  const rupees = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    state: r.state,
    reason: r.reason,
    team: r.team && Types.ObjectId.isValid(r.team) ? new Types.ObjectId(r.team) : null,
    teamName: r.teamName,
    // The rupee amount only where the course has one: a line without it is paid in AED whatever the client paid in.
    lines: r.lines.map((l) => ({
      role: l.role, user: new Types.ObjectId(l.user), userName: l.userName, amount: l.amount,
      ...(rupees(l.amountInr) ? { amountInr: rupees(l.amountInr) } : {}), ...(l.note ? { note: l.note } : {}),
    })),
    plan: {
      sales: r.plan.sales, tl: r.plan.tl, sm: r.plan.sm, creditUsd: r.plan.creditUsd,
      ...(rupees(r.plan.salesInr) + rupees(r.plan.tlInr) + rupees(r.plan.smInr) > 0
        ? { salesInr: rupees(r.plan.salesInr), tlInr: rupees(r.plan.tlInr), smInr: rupees(r.plan.smInr) } : {}),
    },
  };
}

/** A month's My Pay as Root works it out — the same rows payRows gives. */
export async function rootPayRows<T>(month: string): Promise<T[]> {
  await ensurePortal();
  return (await ask<{ people: T[] }>("GET", "/pay", { params: { month } })).people;
}

/**
 * Root's plan copied into this CRM's own settings — every few minutes while COMMISSION_FROM_ROOT is on: each course's
 * amounts, the Sales Manager, the logins that earn nothing. What reads them here (the Plan tab, the leaderboard, who
 * sees everyone's pay, the timed jobs) then follows Root. Only what differs is written. Returns what changed.
 */
export async function mirrorRootPlan(month: string): Promise<string[]> {
  planCache.delete(month);
  const p = await rootPlan(month);
  const changed: string[] = [];
  const ids = (list: Array<{ id: string }>) => list.map((x) => x.id).filter((id) => Types.ObjectId.isValid(id));
  const settings = await CommissionSettings.findOne({ key: "default" }).select("salesManager excludedUsers").lean();
  const sm = p.salesManager && Types.ObjectId.isValid(p.salesManager.id) ? p.salesManager.id : null;
  const excluded = ids(p.excluded);
  const nowSm = settings?.salesManager ? String(settings.salesManager) : null;
  const nowExcluded = ((settings?.excludedUsers ?? []) as unknown[]).map(String);
  if (sm !== nowSm || JSON.stringify([...excluded].sort()) !== JSON.stringify([...nowExcluded].sort())) {
    await CommissionSettings.updateOne(
      { key: "default" },
      { $set: { salesManager: sm ? new Types.ObjectId(sm) : null, excludedUsers: excluded.map((id) => new Types.ObjectId(id)) }, $setOnInsert: { key: "default" } },
      { upsert: true },
    );
    changed.push("the Sales Manager and the logins that earn nothing");
  }
  for (const c of p.courses) {
    if (!Types.ObjectId.isValid(c.courseId)) continue;
    const course = await Course.findById(c.courseId).select("name commission").lean();
    if (!course) continue;
    const now = (course.commission ?? {}) as Partial<Amounts>;
    if ((now.sales ?? 0) === c.sales && (now.tl ?? 0) === c.tl && (now.sm ?? 0) === c.sm && (now.creditUsd ?? 0) === c.creditUsd) continue;
    await Course.updateOne(
      { _id: course._id },
      { $set: { "commission.sales": c.sales, "commission.tl": c.tl, "commission.sm": c.sm, "commission.creditUsd": c.creditUsd, "commission.updatedAt": new Date() } },
    );
    changed.push(String(course.name ?? c.courseId));
  }
  return changed;
}
