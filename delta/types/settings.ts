/** Which events also go by email; the in-app notice and the push always go. */
export type EmailEventKey = "inactiveLeads" | "idleAlerts" | "meetings";

/** The CRM's settings document (GET /settings/app). Limits are in minutes. */
export interface AppSettings {
  key: "app";
  /** enabledAt: when automatic moves were last switched on (set by the server) — only leads assigned since then move on their own. */
  inactiveLeads: { autoReassign: boolean; limitMinutes: number; enabledAt: string | null };
  idleAlerts: { enabled: boolean; limitMinutes: number; notifyTeamLeaders: boolean };
  /**
   * The rate a Bangalore enrolment's rupees count in the leaderboard, Sales TV and reports at: 1 AED = this many
   * rupees. Absent from a server older than 2026-10-28.
   */
  bangaloreRevenue?: { inrPerAed: number };
  workingHours: { timezone: string; days: number[]; start: string; end: string };
  email: Record<EmailEventKey, boolean>;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Whether the backend has a mailbox — never its credentials. */
export interface MailStatus {
  configured: boolean;
  from: string;
}

export interface AppSettingsResponse {
  settings: AppSettings;
  mail: MailStatus;
}

/** A partial update: send only the groups that changed. */
export type AppSettingsUpdate = Partial<{
  inactiveLeads: Partial<Omit<AppSettings["inactiveLeads"], "enabledAt">>;
  idleAlerts: Partial<AppSettings["idleAlerts"]>;
  workingHours: Partial<AppSettings["workingHours"]>;
  email: Partial<AppSettings["email"]>;
  bangaloreRevenue: Partial<NonNullable<AppSettings["bangaloreRevenue"]>>;
}>;

export interface TestEmailResult {
  sent: boolean;
  reason?: string;
  to: string;
}
