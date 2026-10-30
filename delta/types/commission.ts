/** One course's row of the commission plan: AED per approved sale, by role. */
export interface CoursePlan {
  sales: number;
  tl: number;
  sm: number;
  /** The MT5 credit (USD) the course comes with — shown beside the plan. */
  creditUsd: number;
}

export type CommissionRole = "sales" | "tl" | "sm";

/** progress: its five steps (finance, LMS, CS, onboarded, MT5 bonus) aren't all done yet. */
export type CommissionSaleState = "progress" | "counted" | "waiting" | "excluded" | "reversed";

export interface CommissionPerson {
  _id: string;
  name: string;
  email?: string;
}

export interface CommissionPlanView {
  /**
   * What the viewer may see (2026-10-23): "all" the whole plan; "team" a team
   * leader's own teams, no SM rate; "own" only the Sales Staff rate and slab.
   */
  view?: "all" | "team" | "own";
  /** A Super Admin: may change amounts, the Sales Manager and excluded logins. */
  canEdit: boolean;
  /** A Super Admin sees the sales on hold; nobody edits the plan (2026-10-09). */
  seesHeld?: boolean;
  /** How this CRM pays a team's leader (see lib/commission TL_RULE). */
  tlRule?: "zero_if_sm" | "always" | "never";
  courses: {
    _id: string;
    name: string;
    amount: number;
    status: "active" | "inactive";
    /** Only the rates the viewer may see are sent. */
    commission: Partial<CoursePlan>;
  }[];
  salesManager: CommissionPerson | null;
  excludedUsers: CommissionPerson[];
  teams: {
    _id: string;
    name: string;
    /** A team leader's own team: who is in it. */
    members?: { _id: string; name: string }[];
    leaders: { _id: string; name: string }[];
    /** Why the team holds its sales: "No leader", "2 leaders"; null when it has one. */
    problem: string | null;
  }[];
  /** Sales on hold — Super Admins only. */
  waiting: {
    _id: string;
    studentName: string;
    enrollmentNumber?: string;
    courseName: string;
    closerName: string;
    teamName: string;
    saleDate: string;
    approvedAt: string;
    /** A part-paid sale: when finance had it paid in full — it counts in that month. */
    paidInFullAt?: string;
    reason: string;
  }[];
  /** Everyone, for the pickers — Super Admins only. */
  users: (CommissionPerson & { status: "active" | "inactive" })[];
  /** The salary slabs in force this month, for the roles the viewer may see; absent from a server before them. */
  slabs?: Partial<Slabs>;
  /** The month they were set in — null while they're the owner's sheet. */
  slabsFrom?: string | null;
  /** This month (UAE): a change saved now is in force from it. */
  slabsMonth?: string;
}

// ─── Salary slabs ─────────────────────────────────────────────────────────────

/**
 * One level of a salary slab: reach `target` AED of approved sales in a month
 * and it pays `salary`, plus `percent` of the commission earned. The first
 * row is the base, at target 0.
 */
export interface SlabRow {
  name: string;
  target: number;
  salary: number;
  percent: number;
}

/** This CRM sends no "tl" slab: team leaders are on the Sales Staff one. */
export type Slabs = Record<CommissionRole, SlabRow[]>;

export type SlabLevel = SlabRow & { index: number };

/** A person's month on their slab. */
export interface PayRow {
  user: string;
  name: string;
  role: CommissionRole;
  /** The teams a team leader's target counts. */
  teams: string[];
  /** Finance-approved sales the target counts, and their fees. */
  sales: { count: number; value: number };
  /** Closed this month, not approved by finance yet. */
  awaitingFinance: { count: number; value: number };
  level: SlabLevel;
  /** The next level that pays differently, and how much more it takes; null at the top. */
  next: (SlabLevel & { more: number }) | null;
  salary: number;
  percent: number;
  commission: { earned: number; payable: number; notCountedYet: number };
  total: number;
  /** Where finance stands on the month's commission (2026-10-21); null when neither approved nor paid. */
  payout?: CommissionPayout | null;
}

/** A person's month of commission in finance: a manager approved it, then accounts paid it. */
export interface CommissionPayout {
  userId: string;
  state: "approved" | "paid";
  /** The commission payable, as approved. */
  amount: number;
  currency: string;
  approvedByName: string;
  approvedAt: string;
  paidOn?: string | null;
  paymentMethod?: string | null;
  reference?: string | null;
}

export interface PayView {
  month: string;
  /** "team": a team leader seeing their own teams' people (2026-10-23). */
  view?: "all" | "team" | "own";
  /** The roles the viewer may see. */
  slabs: Partial<Slabs>;
  slabsFrom: string | null;
  /** False when finance couldn't be asked — the payouts are unknown, not "none". */
  payoutsKnown?: boolean;
  /** The viewer's own month; null when they aren't on a slab. */
  me: PayRow | null;
  /** Everyone — a Super Admin and the Sales Manager; a team leader their team's people. */
  people: PayRow[] | null;
  totals: { people: number; salary: number; payable: number; total: number } | null;
}

export interface CommissionLine {
  role: CommissionRole;
  user: string;
  userName: string;
  amount: number;
  note: string;
}

export interface CommissionSale {
  _id: string;
  studentName: string;
  enrollmentNumber: string;
  invoiceNumber: string;
  courseName: string;
  closerName: string;
  teamName: string;
  saleDate: string;
  approvedAt: string;
  /** A part-paid sale: when finance had it paid in full — it counts in that month. */
  paidInFullAt?: string;
  state: CommissionSaleState;
  reason: string;
  /** Only the lines the viewer may see. */
  lines: CommissionLine[];
}

interface Tally {
  count: number;
  amount: number;
}

export interface CommissionEarnings {
  month: string;
  /** What the viewer sees: everything, their teams', or their own. */
  scope: "all" | "team" | "own";
  tlRule?: "zero_if_sm" | "always" | "never";
  people: { _id: string; name: string; sales: Tally; tl: Tally; sm: Tally; total: number }[];
  sales: CommissionSale[];
  totals: { amount: number; counted: number; waiting: number; excluded: number; reversed: number; progress?: number };
}

export interface CommissionPreview {
  courseName: string;
  plan: CoursePlan;
  state: CommissionSaleState;
  reason: string;
  teamName: string;
  closerName: string;
  /** What the closer earns on it, in all their roles. */
  closerTotal: number;
  lines: CommissionLine[];
}
