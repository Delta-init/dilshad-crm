// ─── Permissions ──────────────────────────────────────────────────────────────
export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve" | "export";

export interface ModulePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  export: boolean;
}

export const CRM_MODULES = [
  "dashboard",
  "users",
  "roles",
  "leads",
  "teams",
  "courses",
  "reminders",
  "reports",
  "settings",
  "tracker",
  /*
   * "students" was missing here — the backend has always checked it on the
   * student list, My Enrolments and Daily Closings, but this list never
   * carried it, so the Edit Role screen never rendered a row for it and no
   * role but Super Admin could ever be granted access. Restored, and split
   * into three: a role granted its own sales should not have to also be
   * granted the whole student list, which one shared module could never do.
   */
  "students",
  "enrolments",
  "closings",
  /* Rows added 2026-10-07 for screens that had none — see OPEN_BY_DEFAULT. */
  "mentors",
  "commission",
  "leaderboard",
  "pay",
  "calendar",
  "activity",
  "inactive-leads",
  /* Balance payments (2026-10-13): part-paid closes and the next payment, for finance to approve. Open by default. */
  "balancePayments",
  // The 3CX calls with leads (2026-10-14): view the Calls page, export its CSV.
  "calls",
] as const;

export type CrmModule = (typeof CRM_MODULES)[number];

export const MODULE_LABELS: Record<CrmModule, string> = {
  dashboard: "Dashboard",
  users: "Users",
  roles: "Roles & Permissions",
  leads: "Leads",
  teams: "Teams",
  courses: "Courses",
  reminders: "Reminders",
  reports: "Reports",
  settings: "Settings",
  tracker: "Daily Tracker",
  students: "Students",
  enrolments: "My Enrolments",
  closings: "Daily Closings",
  mentors: "Mentors (booking)",
  commission: "Commission",
  leaderboard: "Leaderboard",
  pay: "My Pay",
  calendar: "Calendar",
  activity: "Activity",
  "inactive-leads": "Inactive Leads",
  balancePayments: "Balance payments",
  calls: "Calls (3CX)",
};



export type PermissionsMap = Partial<Record<CrmModule, ModulePermissions>>;

const NONE: ModulePermissions = { view: false, create: false, edit: false, delete: false, approve: false, export: false };

/**
 * Screens that were open to everyone before they had a row on the Roles screen
 * (2026-10-07). A role that has never been given a value for one keeps that
 * access — the same default the server holds — so nothing disappears until
 * someone unticks the box.
 */
export const OPEN_BY_DEFAULT: Partial<Record<CrmModule, Partial<ModulePermissions>>> = {
  mentors: { view: true, create: true, edit: true, delete: true },
  commission: { view: true },
  leaderboard: { view: true },
  pay: { view: true },
  calendar: { view: true },
  balancePayments: { view: true, create: true },
  // Open to everyone; the server shows each person their own calls, their team's, or everyone's.
  calls: { view: true, export: true },
};

/** A role's permissions on one module — what it was given, or the module's default. */
export function modulePermissions(perms: PermissionsMap | undefined, mod: CrmModule): ModulePermissions {
  return perms?.[mod] ?? { ...NONE, ...OPEN_BY_DEFAULT[mod] };
}

// ─── Role ─────────────────────────────────────────────────────────────────────
export interface Role {
  _id: string;
  roleName: string;
  description?: string;
  permissions: PermissionsMap;
  isSystemRole: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RoleSimple = Pick<Role, "_id" | "roleName" | "description" | "isSystemRole">;

// ─── User ─────────────────────────────────────────────────────────────────────
export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role | string;
  designation?: string;
  extension?: string | null;   // 3CX phone extension e.g. "101"
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface AuthUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  designation?: string;
  extension?: string | null;
  status: "active" | "inactive";
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// ─── API ──────────────────────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}
