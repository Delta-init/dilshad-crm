import { Types } from "mongoose";
import { Lead } from "../../models/Lead.js";

/*
 * Numbers → leads, for WhatsApp (2026-10-27). A number matches on its last 9 digits — "+971 50 123 4567",
 * "0501234567" and "971501234567" are one person — as the Sales CRM's 3CX calls and repeat-lead check match them.
 * WhatsApp's own copy, so it works the same in every sales CRM whatever else that CRM has.
 */

/** The last 9 digits of a number; "" when it has fewer than 7. */
export function phoneKey(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^00/, "");
  return d.length >= 7 ? d.slice(-9) : "";
}

/** Every number in a lead's phone field ("+971 50 … / 055 …" holds two). */
export function phoneKeys(raw: unknown): string[] {
  return [...new Set(String(raw ?? "").split(/[\n\r/,;|]+| - /).map(phoneKey).filter(Boolean))];
}

/** Every lead's number(s) → the lead. Several leads with one number: the one not marked "repeated", then the newest. */
export async function leadsByPhone(): Promise<Map<string, Types.ObjectId>> {
  const best = new Map<string, { id: Types.ObjectId; rank: [number, string] }>();
  const cursor = Lead.find({ phone: { $nin: [null, ""] } }).select("phone status")
    .lean<{ _id: Types.ObjectId; phone?: string; status?: string }>().cursor();
  for await (const l of cursor) {
    const rank: [number, string] = [l.status === "repeated" ? 0 : 1, String(l._id)];
    for (const k of phoneKeys(l.phone)) {
      const had = best.get(k);
      if (had && (had.rank[0] > rank[0] || (had.rank[0] === rank[0] && had.rank[1] > rank[1]))) continue;
      best.set(k, { id: l._id, rank });
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.id]));
}
