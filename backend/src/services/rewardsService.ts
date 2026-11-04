import axios from "axios";
import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { Lead } from "../models/Lead.js";
import { CommissionSettings } from "../models/CommissionSettings.js";
import { COUNTED_PAYMENT } from "../utils/countedPayments.js";
import { bangaloreLeadsUnion } from "../utils/bangaloreRevenue.js";
import { dubaiMonthRange } from "./leaderboardService.js";

/*
 * Gift rewards (the user, 2026-11-04): a salesperson who closes AED 50,000 in a month takes home a gift worth up to
 * AED 2,000; a team leader whose whole team (the leader included) closes AED 100,000, gifts worth up to AED 3,000. One
 * gift a person a month, chosen from a shelf after a spin of the wheel for fun.
 *
 * What a person closed is counted here as the leaderboard counts revenue: payments dated in the Dubai month on the
 * leads they hold, a Bangalore enrolment's rupees in AED. Root keeps the targets, the gifts with their photos and the
 * gifts chosen (its Rewards page), reached the way the daily tracker reaches it: ROOT_ERP_API_URL, with ROOT_ORG_SECRET
 * proving which CRM is asking. Sales Managers, super admins, the logins the commission plan leaves out and anybody in
 * no active team are left out.
 */

const ROOT_TIMEOUT_MS = 10_000;
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

function root(): { base: string; secret: string } {
  const base = process.env.ROOT_ERP_API_URL;
  const secret = process.env.ROOT_ORG_SECRET;
  if (!base || !secret) throw fail("This CRM isn't linked to Root, so there are no gift rewards to show.", 503);
  return { base: base.replace(/\/+$/, ""), secret };
}

async function ask<T>(method: "GET" | "POST", path: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const { base, secret } = root();
  try {
    const { data } = await axios.request({
      method, url: `${base}/api/v1/service/rewards${path}`, params: opts.params, data: opts.body,
      headers: { "x-org-secret": secret }, timeout: ROOT_TIMEOUT_MS,
    });
    return data.data as T;
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const said = axios.isAxiosError(err) ? (err.response?.data as { message?: string } | undefined)?.message : undefined;
    // Root's own refusals (already chosen, not reached, gone from the shelf) are passed on as they are.
    if (status && status >= 400 && status < 500 && said) throw fail(said, status);
    throw fail(`Root couldn't be asked about gift rewards${status ? ` (${status})` : ""}. Try again in a minute.`, 502);
  }
}

interface RootGift { id: string; name: string; category: string; valueAed: number; photoVersion: number }
interface RootClaim { id: string; giftId: string; giftName: string; giftValueAed: number; status: string; createdAt: string; role: string }
interface RootRewards {
  month: string;
  settings: { enabled: boolean; salesTargetAed: number; salesGiftAed: number; tlTargetAed: number; tlGiftAed: number; inrPerAed: number };
  gifts: RootGift[];
  claim: RootClaim | null;
}

type Tier = { role: "sales" | "tl"; name: string; teamName: string; people: Types.ObjectId[] };

/** Who this person is for rewards: a team leader (their teams, all of them), a salesperson (themselves), or nobody. */
async function tierOf(userId: string): Promise<Tier | null> {
  if (!Types.ObjectId.isValid(userId)) return null;
  const id = new Types.ObjectId(userId);
  const [user, settings] = await Promise.all([
    User.findById(id).select("name status role").populate("role", "roleName isSystemRole")
      .lean<{ name?: string; status?: string; role?: { roleName?: string; isSystemRole?: boolean } | null } | null>(),
    CommissionSettings.findOne().select("salesManager excludedUsers")
      .lean<{ salesManager?: Types.ObjectId | null; excludedUsers?: Types.ObjectId[] } | null>(),
  ]);
  if (!user || user.status !== "active") return null;
  if (user.role?.isSystemRole && user.role.roleName === "Super Admin") return null;
  if (settings?.salesManager && id.equals(settings.salesManager)) return null;
  if ((settings?.excludedUsers ?? []).some((x) => id.equals(x))) return null;

  const led = await Team.find({ status: "active", leaders: id }).select("name leaders members")
    .lean<{ name: string; leaders?: Types.ObjectId[]; members?: Types.ObjectId[] }[]>();
  if (led.length) {
    const people = new Map<string, Types.ObjectId>();
    for (const t of led) for (const p of [...(t.leaders ?? []), ...(t.members ?? [])]) people.set(String(p), p);
    return { role: "tl", name: user.name ?? "", teamName: led.map((t) => t.name).join(", "), people: [...people.values()] };
  }
  const member = await Team.find({ status: "active", members: id }).select("name").lean<{ name: string }[]>();
  if (!member.length) return null;
  return { role: "sales", name: user.name ?? "", teamName: member.map((t) => t.name).join(", "), people: [id] };
}

/** What these people closed in the month, in AED, as the leaderboard counts revenue. */
export async function closedBy(people: Types.ObjectId[], month: string): Promise<number> {
  const range = dubaiMonthRange(month);
  const inMonth = { $gte: range.from, $lt: range.to };
  const [row] = await Lead.aggregate<{ n: number }>([
    ...(await bangaloreLeadsUnion()),
    { $match: { assignedTo: { $in: people }, "payments.paidAt": inMonth } },
    { $unwind: "$payments" },
    { $match: COUNTED_PAYMENT },
    { $match: { "payments.paidAt": inMonth } },
    { $group: { _id: null, n: { $sum: "$payments.amount" } } },
  ]);
  return Math.round((row?.n ?? 0) * 100) / 100;
}

export interface MyRewards {
  /** False: no pop-up for this person (not in a sales team, a Sales Manager, rewards switched off). */
  eligible: boolean;
  month?: string;
  daysLeft?: number;
  role?: "sales" | "tl";
  teamName?: string;
  currency?: "AED";
  closed?: number;
  target?: number;
  giftValue?: number;
  reached?: boolean;
  gifts?: Array<{ id: string; name: string; category: string; valueAed: number; photo: string | null }>;
  claim?: { giftId: string; giftName: string; giftValueAed: number; status: string; createdAt: string } | null;
}

export async function myRewards(userId: string): Promise<MyRewards> {
  const tier = await tierOf(userId);
  if (!tier) return { eligible: false };
  const r = await ask<RootRewards>("GET", "", { params: { userId } });
  if (!r.settings.enabled) return { eligible: false };
  const closed = await closedBy(tier.people, r.month);
  const target = tier.role === "tl" ? r.settings.tlTargetAed : r.settings.salesTargetAed;
  const giftValue = tier.role === "tl" ? r.settings.tlGiftAed : r.settings.salesGiftAed;
  const range = dubaiMonthRange(r.month);
  return {
    eligible: true,
    month: r.month,
    daysLeft: Math.max(0, Math.ceil((range.to.getTime() - Date.now()) / 86_400_000)),
    role: tier.role,
    teamName: tier.teamName,
    currency: "AED",
    closed,
    target,
    giftValue,
    reached: closed >= target,
    gifts: r.gifts
      .filter((g) => g.valueAed <= giftValue)
      .map((g) => ({ id: g.id, name: g.name, category: g.category, valueAed: g.valueAed, photo: g.photoVersion ? `rewards/photos/${g.id}?v=${g.photoVersion}` : null })),
    claim: r.claim
      ? { giftId: r.claim.giftId, giftName: r.claim.giftName, giftValueAed: r.claim.giftValueAed, status: r.claim.status, createdAt: r.claim.createdAt }
      : null,
  };
}

/** A gift chosen: counted again here, then sent to Root, which holds it to the targets and to one gift a month. */
export async function chooseGift(userId: string, giftId: string, viewingAs: boolean): Promise<NonNullable<MyRewards["claim"]>> {
  if (viewingAs) throw fail("You're viewing the CRM as somebody else: only they can choose their gift.", 403);
  if (!/^[a-f0-9]{24}$/i.test(giftId)) throw fail("Choose a gift from the shelf", 400);
  const mine = await myRewards(userId);
  if (!mine.eligible) throw fail("Gift rewards aren't open to you.", 403);
  if (mine.claim) throw fail(`You've already chosen ${mine.claim.giftName} this month.`, 409);
  if (!mine.reached) throw fail("Reach this month's target first.", 409);
  if (!mine.gifts!.some((g) => g.id === giftId)) throw fail("That gift isn't on your shelf.", 409);
  const tier = (await tierOf(userId))!;
  const c = await ask<RootClaim>("POST", "/claims", {
    body: {
      month: mine.month, userId, userName: tier.name, role: mine.role, teamName: mine.teamName,
      achievedAed: mine.closed, achieved: mine.closed, currency: "AED", giftId,
    },
  });
  return { giftId: c.giftId, giftName: c.giftName, giftValueAed: c.giftValueAed, status: c.status, createdAt: c.createdAt };
}

/** A gift's photo, from Root's open link, kept here a while so a pop-up opening doesn't go to Root for each one. */
const photos = new Map<string, { type: string; body: Buffer }>();
const PHOTOS_KEPT = 80;

export async function giftPhoto(id: string, version: string): Promise<{ type: string; body: Buffer } | null> {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const key = `${id}:${version.slice(0, 12)}`;
  const hit = photos.get(key);
  if (hit) return hit;
  const { base } = root();
  const res = await axios.get<ArrayBuffer>(`${base}/api/v1/public/rewards/photos/${id}`, {
    responseType: "arraybuffer", timeout: ROOT_TIMEOUT_MS, validateStatus: (s) => s === 200 || s === 404,
  });
  if (res.status === 404) return null;
  const photo = { type: String(res.headers["content-type"] ?? "image/jpeg"), body: Buffer.from(res.data) };
  if (photos.size >= PHOTOS_KEPT) photos.delete(photos.keys().next().value!);
  photos.set(key, photo);
  return photo;
}
