import type { CommissionRole, CommissionSaleState } from "@/types/commission";

/*
 * Commission is set and paid in AED, and the MT5 credit is in USD, whatever
 * currency the rest of the screen is showing — so these say so outright
 * rather than borrowing the display currency's symbol.
 */
export const aed = (n: number) => `AED ${n.toLocaleString("en-AE", { maximumFractionDigits: 2 })}`;

/**
 * Commission in rupees (the user, 2026-11-13: "INR payment only gets commission in INR"): the part of a sale the
 * client paid in rupees earns the course's own rupee amount from Root's plan — shown beside the AED part, never
 * added to it. Whole rupees, as they are paid.
 */
export const inr = (n: number) => `INR ${Math.round(n).toLocaleString("en-IN")}`;
/** An AED figure with its rupee part after it when there is one: "AED 172.50 + INR 1,250". */
export const aedPlusInr = (aedAmount: number, inrAmount?: number | null) =>
  inrAmount && inrAmount > 0 ? (aedAmount > 0 ? `${aed(aedAmount)} + ${inr(inrAmount)}` : inr(inrAmount)) : aed(aedAmount);
export const usd = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USD`;
/** A target on a slab's bar, short: 15K, 132K, 1.2M. */
export const aedShort = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}K` : String(n);

/**
 * How this CRM pays a team's leader — the backend's TL_RULE, which this must
 * match. The one line that differs between the three sales CRMs:
 *   "zero_if_sm"  TL paid, except 0 on a team the Sales Manager leads (Sales CRM)
 *   "always"      TL paid, to the Sales Manager too when he leads (Remote CRM)
 *   "never"       no TL commission at all (Draw)
 */
export type TlRule = "zero_if_sm" | "always" | "never";
export const TL_RULE: TlRule = "always";
export const TL_PAID = (TL_RULE as TlRule) !== "never";

export const ROLE_LABEL: Record<CommissionRole, string> = {
  sales: "Sales Staff",
  tl: "Team Leader",
  sm: "Sales Manager",
};

export const ROLE_SHORT: Record<CommissionRole, string> = { sales: "Sales", tl: "TL", sm: "SM" };

export const STATE_LABEL: Record<CommissionSaleState, string> = {
  progress: "In progress",
  counted: "Counted",
  waiting: "On hold",
  excluded: "Excluded",
  reversed: "Reversed",
};

/** UAE has no daylight saving, so its month is UTC + 4 hours. */
export function uaeMonth(d = new Date()): string {
  return new Date(d.getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** This month and the eleven before it, newest first, as "YYYY-MM". */
export function recentMonths(count = 12): string[] {
  const [y, m] = uaeMonth().split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * The first month on the salary slabs — commission counts sales closed from
 * 1 October 2026 (the backend's COUNT_FROM).
 */
export const PAY_FROM_MONTH = "2026-10";

/** The months there's pay to show, newest first: this month back to PAY_FROM_MONTH. */
export function payMonths(): string[] {
  return recentMonths(36).filter((m) => m >= PAY_FROM_MONTH);
}

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function uaeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Dubai",
  });
}
