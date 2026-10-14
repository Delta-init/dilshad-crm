import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM, e.g. 09:00");

/**
 * Time zones by name, as the Settings page offers them: "Asia/Dubai", not "asia/dubai" or "+04:00" (which the
 * runtime may accept, and the page then can't show). Matched without regard to case, stored as listed.
 */
const ZONE_NAMES = new Map<string, string>(
  [...Intl.supportedValuesOf("timeZone"), "UTC", "Asia/Dubai", "Asia/Kolkata", "Asia/Riyadh", "Europe/London"].map((z) => [z.toLowerCase(), z])
);
const zoneName = (tz: string): string | null => {
  const name = ZONE_NAMES.get(tz.trim().toLowerCase());
  if (!name) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return name;
  } catch {
    return null;
  }
};

/**
 * A partial update of the CRM's settings: send only what changed.
 * Limits are in minutes — the page converts from hours and minutes.
 */
export const updateAppSettingsSchema = z
  .object({
    inactiveLeads: z
      .object({
        autoReassign: z.boolean().optional(),
        limitMinutes: z.number().int().min(5, "At least 5 minutes").max(7 * 24 * 60, "At most 7 days").optional(),
      })
      .strict()
      .optional(),
    idleAlerts: z
      .object({
        enabled: z.boolean().optional(),
        limitMinutes: z.number().int().min(5, "At least 5 minutes").max(24 * 60, "At most 24 hours").optional(),
        notifyTeamLeaders: z.boolean().optional(),
      })
      .strict()
      .optional(),
    workingHours: z
      .object({
        timezone: z
          .string()
          .transform((tz, ctx) => {
            const name = zoneName(tz);
            if (!name) ctx.addIssue({ code: "custom", message: "Unknown time zone" });
            return name ?? tz;
          })
          .optional(),
        // A day sent twice counts once — before the at-most-7 check.
        days: z
          .preprocess(
            (v) => (Array.isArray(v) ? [...new Set(v)] : v),
            z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one working day").max(7)
          )
          .optional(),
        start: hhmm.optional(),
        end: hhmm.optional(),
      })
      .strict()
      .optional(),
    email: z
      .object({
        inactiveLeads: z.boolean().optional(),
        idleAlerts: z.boolean().optional(),
        meetings: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsSchema>;
