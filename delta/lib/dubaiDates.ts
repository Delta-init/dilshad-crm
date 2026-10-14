import { dayKey } from "./zonedTime";

/** The CRM's calendar: Dubai (UTC+4, no daylight saving). */
export const DUBAI_TZ = "Asia/Dubai";

/** A day — today unless given — as "YYYY-MM-DD" on the Dubai calendar. */
export const dubaiDate = (at: Date = new Date()): string => dayKey(at, DUBAI_TZ);
