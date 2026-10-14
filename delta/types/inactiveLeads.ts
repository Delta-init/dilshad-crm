import type { LeadStatus } from "@/types/lead";
import type { AppSettings } from "@/types/settings";

/** What the automatic mover will do with a lead on the list. */
export type AutoMoveState =
  | "due" //           moves at the next check in working hours
  | "off" //           automatic moves are switched off
  | "before_switch" // assigned before they were switched on — move it by hand
  | "stuck" //         nobody left in the team to take it
  | "no_team"; //      it has no team to move within

export interface PersonRef {
  id: string;
  name: string;
}

/** GET /inactive-leads — one lead whose owner has not acted on it within the limit. */
export interface InactiveLead {
  id: string;
  name: string;
  phone: string;
  source: string | null;
  status: LeadStatus;
  team: { id: string; name: string } | null;
  owner: { id: string; name: string; email: string; active: boolean } | null;
  assignedAt: string;
  /** Working minutes since it was assigned. */
  waitingMinutes: number;
  moves: number;
  /** Everyone who lost it before — automatic moves never send it back to them. */
  lostBy: PersonRef[];
  autoMove: AutoMoveState;
}

export interface InactiveRule {
  limitMinutes: number;
  autoReassign: boolean;
  enabledAt: string | null;
  workingHours: AppSettings["workingHours"];
  inWorkingHours: boolean;
}

export interface InactiveLeadSummary {
  total: number;
  stuck: number;
  movedToday: number;
  /** More than the server lists at once — the oldest are shown. */
  capped: boolean;
}

export interface InactiveLeadsResponse {
  items: InactiveLead[];
  summary: InactiveLeadSummary;
  rule: InactiveRule;
}

export interface InactiveLeadFilters {
  page?: number;
  limit?: number;
  teamId?: string;
  ownerId?: string;
  search?: string;
}

/** GET /inactive-leads/teams — the page's team filter. */
export interface FilterTeam {
  id: string;
  name: string;
}

/** GET /inactive-leads/people — someone a lead can be moved to by hand. */
export interface MovePerson {
  id: string;
  name: string;
  email: string;
  designation: string | null;
}

/** GET /inactive-leads/moves — one lead moved on for inactivity. */
export interface LeadMoveEntry {
  id: string;
  lead: { id: string; name: string };
  team: { id: string; name: string } | null;
  from: PersonRef | null;
  to: PersonRef | null;
  kind: "automatic" | "manual";
  /** Who moved it by hand; null when the CRM did. */
  by: PersonRef | null;
  inactiveMinutes: number;
  createdAt: string;
}

export interface LeadMoveFilters {
  page?: number;
  limit?: number;
  kind?: "automatic" | "manual";
  teamId?: string;
}

/** POST /inactive-leads/reassign — no `to`: each lead goes to the next person in its team. */
export interface ReassignRequest {
  leadIds: string[];
  to?: string;
}

export interface ReassignResult {
  moved: Array<{ leadId: string; leadName: string; from: PersonRef; to: PersonRef }>;
  skipped: Array<{ leadId: string; leadName: string; reason: string }>;
}
