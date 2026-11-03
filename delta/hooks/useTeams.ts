"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse, PaginationMeta } from "@/types";
import type { Lead, LeadFilters } from "@/types/lead";
import type { LeadStatus } from "@/lib/statusConfig";
import type {
  Team, TeamFilters, TeamMemberStat, TeamAutoAssignResult,
  TeamDashboard, TeamLog, TeamUpdateItem, TeamReminderItem, TeamSettings,
} from "@/types/team";
import type {
  RevenuePeriod,
  TeamRevenueOverview,
  TeamRevenueTimelineReport,
} from "@/types/reports";

const TEAMS_KEY = ["teams"] as const;

function errMsg(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns the team the currently-authenticated user belongs to
 * (as leader or member). Returns null if not in any team.
 */
export const useMyTeam = () => {
  return useQuery({
    queryKey: [...TEAMS_KEY, "mine"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<Team | null>>("/teams/mine");
      return res.data.data ?? null;
    },
    staleTime: 60_000,
  });
};

export const useTeams = (filters?: TeamFilters, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, filters],
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters?.page)   params.page   = String(filters.page);
      if (filters?.limit)  params.limit  = String(filters.limit);
      if (filters?.status) params.status = filters.status;
      if (filters?.search) params.search = filters.search;
      const res = await api.get<ApiResponse<Team[]>>("/teams", { params });
      return { data: res.data.data ?? [], pagination: res.data.pagination };
    },
  });
};

export const useTeam = (id: string) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, id],
    queryFn: async () => {
      const res = await api.get<ApiResponse<Team>>(`/teams/${id}`);
      return res.data.data!;
    },
    enabled: !!id,
  });
};

export const useTeamLeads = (teamId: string, filters?: LeadFilters & { unassignedOnly?: boolean }) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "leads", filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters?.page)           params.page           = String(filters.page);
      if (filters?.limit)          params.limit          = String(filters.limit);
      if (filters?.status)         params.status         = filters.status;
      if (filters?.assignedTo)     params.assignedTo     = filters.assignedTo;
      if (filters?.reporter)       params.reporter       = filters.reporter;
      if (filters?.search)         params.search         = filters.search;
      if (filters?.dateFrom)       params.dateFrom       = filters.dateFrom;
      if (filters?.dateTo)         params.dateTo         = filters.dateTo;
      if (filters?.splitFrom)      params.splitFrom      = filters.splitFrom;
      if (filters?.splitTo)        params.splitTo        = filters.splitTo;
      if (filters?.course)         params.course         = filters.course;
      if (filters?.unassignedOnly) params.unassignedOnly = "true";
      const res = await api.get<ApiResponse<Lead[]>>(`/teams/${teamId}/leads`, { params });
      return { data: res.data.data ?? [], pagination: res.data.pagination };
    },
    enabled: !!teamId,
  });
};

export const useTeamMemberStats = (teamId: string) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "member-stats"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<TeamMemberStat[]>>(`/teams/${teamId}/member-stats`);
      return res.data.data ?? [];
    },
    enabled: !!teamId,
  });
};

/**
 * One member's row in the team Report: `total` leads, and a count for each lead status. A count can be missing
 * (an API that predates the status) — `total` still includes those leads.
 */
export interface TeamMemberSplitItem extends Partial<Record<LeadStatus, number>> {
  userId: string;
  name: string;
  email: string;
  designation?: string;
  rank: number;
  total: number;
  revenue: number;
  conversionRate: number;
}

export const useTeamMemberSplit = (teamId: string, dateFrom: string, dateTo: string) => {
  return useQuery<TeamMemberSplitItem[]>({
    queryKey: [...TEAMS_KEY, teamId, "member-split", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const res = await api.get<ApiResponse<TeamMemberSplitItem[]>>(
        `/teams/${teamId}/member-split?${params}`,
      );
      return res.data.data ?? [];
    },
    enabled: !!teamId,
    staleTime: 60_000,
  });
};

// ─── Mutations ────────────────────────────────────────────────────────────────

export type TeamFormData = {
  name: string;
  description?: string;
  leaders?: string[];
  members?: string[];
  status?: "active" | "inactive";
};

export const useCreateTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: TeamFormData) => {
      const res = await api.post<ApiResponse<Team>>("/teams", data);
      return res.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      toast.success("Team created successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to create team")),
  });
};

export const useUpdateTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<TeamFormData> }) => {
      const res = await api.put<ApiResponse<Team>>(`/teams/${id}`, data);
      return res.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, vars.id] });
      toast.success("Team updated successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to update team")),
  });
};

export const useDeleteTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/teams/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      toast.success("Team deleted successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to delete team")),
  });
};

export const useAutoAssignTeamLeads = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (leadIds?: string[]) => {
      const res = await api.post<ApiResponse<TeamAutoAssignResult>>(
        `/teams/${teamId}/auto-assign`,
        { leadIds },
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`Auto-assigned ${data.assigned} lead(s) to team members`);
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to auto-assign leads")),
  });
};

// Alias used by team detail page
export const useTransferLead = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, newTeamId }: { leadId: string; newTeamId: string }) => {
      const res = await api.patch<ApiResponse<unknown>>(`/leads/${leadId}/transfer`, { teamId: newTeamId });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead transferred to new team");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to transfer lead")),
  });
};

export const useAssignLeadToMember = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, memberId }: { leadId: string; memberId: string }) => {
      const res = await api.patch<ApiResponse<unknown>>(
        `/teams/${teamId}/leads/${leadId}/assign`,
        { memberId },
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Lead assigned to member");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to assign lead")),
  });
};

// ─── Bulk Team-Lead Mutations ─────────────────────────────────────────────────

export const useBulkAssignTeamLeadsToMember = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadIds, memberId }: { leadIds: string[]; memberId: string }) => {
      const res = await api.patch<ApiResponse<{ updated: number }>>(
        `/teams/${teamId}/leads/bulk/assign`,
        { leadIds, memberId },
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`${data.updated} lead(s) assigned to member`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to assign leads")),
  });
};

export const useBulkTransferTeamLeads = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadIds, newTeamId }: { leadIds: string[]; newTeamId: string }) => {
      const res = await api.patch<ApiResponse<{ updated: number }>>(
        `/teams/${teamId}/leads/bulk/transfer`,
        { leadIds, newTeamId },
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`${data.updated} lead(s) transferred`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to transfer leads")),
  });
};

export const useBulkUpdateTeamLeadsStatus = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadIds, status }: { leadIds: string[]; status: string }) => {
      const res = await api.patch<ApiResponse<{ updated: number }>>(
        `/teams/${teamId}/leads/bulk/status`,
        { leadIds, status },
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: TEAMS_KEY });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      toast.success(`${data.updated} lead(s) status updated`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to update status")),
  });
};

export const useTeamDashboard = (teamId: string, dateFrom?: string, dateTo?: string) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "dashboard", dateFrom, dateTo],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo)   params.dateTo   = dateTo;
      const res = await api.get<ApiResponse<TeamDashboard>>(`/teams/${teamId}/dashboard`, { params });
      return res.data.data!;
    },
    enabled: !!teamId,
  });
};

export const useTeamLogs = (teamId: string, page = 1) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "logs", page],
    queryFn: async () => {
      const res = await api.get<ApiResponse<TeamLog[]>>(
        `/teams/${teamId}/logs`,
        { params: { page: String(page), limit: "20" } },
      );
      return { data: res.data.data ?? [], pagination: res.data.pagination };
    },
    enabled: !!teamId,
  });
};

// ─── Team Updates (combined activity feed + chat) ────────────────────────────

export interface TeamUpdatesFilters {
  page?:     number;
  dateFrom?: string;
  dateTo?:   string;
  memberId?: string;
  search?:   string;
  action?:   string;
}

export const useTeamUpdates = (teamId: string, filters: TeamUpdatesFilters = {}) => {
  const { page = 1, dateFrom, dateTo, memberId, search, action } = filters;
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "updates", page, dateFrom, dateTo, memberId, search, action],
    queryFn: async () => {
      const params: Record<string, string> = { page: String(page), limit: "30" };
      if (dateFrom)  params.dateFrom  = dateFrom;
      if (dateTo)    params.dateTo    = dateTo;
      if (memberId)  params.memberId  = memberId;
      if (search)    params.search    = search;
      if (action)    params.action    = action;
      const res = await api.get<ApiResponse<TeamUpdateItem[]>>(
        `/teams/${teamId}/updates`,
        { params },
      );
      return { data: res.data.data ?? [], pagination: res.data.pagination };
    },
    enabled: !!teamId,
    refetchInterval: 30_000,
  });
};

export const usePostTeamMessage = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const res = await api.post<ApiResponse<TeamUpdateItem>>(
        `/teams/${teamId}/messages`,
        { content },
      );
      return res.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "updates"] });
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to send message")),
  });
};

// ── Toggle member active/inactive for auto-assignment (team-scoped) ───────────
export const useToggleMemberActive = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (memberId: string) => {
      const res = await api.patch<ApiResponse<{ memberId: string; isActive: boolean }>>(
        `/teams/${teamId}/members/${memberId}/toggle-active`,
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      toast.success(
        data.isActive
          ? "Member activated for auto-assignment"
          : "Member deactivated — won't receive auto-assigned leads",
      );
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "dashboard"] });
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to toggle member status")),
  });
};

// ─── Team Member by ID (for team leaders — no users permission required) ──────

export interface TeamMemberDetail {
  member: {
    _id: string;
    name: string;
    email: string;
    designation: string | null;
    status: string;
    role: { roleName: string } | string | null;
    createdAt: string;
  };
  team: { _id: string; name: string };
  isLeader: boolean;
  stats: {
    total: number;
    assigned: number;
    pending_response: number;
    followup: number;
    closed: number;
    lost: number;
    not_connected: number;
    mia: number;
    repeated: number;
    callback: number;
    cnc: number;
    totalPayments: number;
    closureRate: number;
  };
}

export const useTeamMember = (teamId: string, memberId: string) =>
  useQuery({
    queryKey: [...TEAMS_KEY, teamId, "members", memberId],
    queryFn: async () => {
      const res = await api.get<ApiResponse<TeamMemberDetail>>(
        `/teams/${teamId}/members/${memberId}`,
      );
      return res.data.data!;
    },
    enabled: !!teamId && !!memberId,
  });

export const useTeamMemberLeads = (
  teamId: string,
  memberId: string,
  filters?: { page?: number; limit?: number; status?: string; search?: string; dateFrom?: string; dateTo?: string; splitFrom?: string; splitTo?: string },
) =>
  useQuery({
    queryKey: [...TEAMS_KEY, teamId, "members", memberId, "leads", filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters?.page)     params.page     = String(filters.page);
      if (filters?.limit)    params.limit    = String(filters.limit);
      if (filters?.status)   params.status   = filters.status;
      if (filters?.search)   params.search   = filters.search;
      if (filters?.dateFrom)  params.dateFrom  = filters.dateFrom;
      if (filters?.dateTo)    params.dateTo    = filters.dateTo;
      if (filters?.splitFrom) params.splitFrom = filters.splitFrom;
      if (filters?.splitTo)   params.splitTo   = filters.splitTo;
      const res = await api.get<ApiResponse<Lead[]>>(
        `/teams/${teamId}/members/${memberId}/leads`,
        { params },
      );
      return { data: res.data.data ?? [], pagination: res.data.pagination };
    },
    enabled: !!teamId && !!memberId,
  });

// ── Team Revenue ──────────────────────────────────────────────────────────────

export const useTeamRevenue = (teamId: string, dateFrom: string, dateTo: string) =>
  useQuery<TeamRevenueOverview>({
    queryKey: [...TEAMS_KEY, teamId, "revenue", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const res = await api.get<ApiResponse<TeamRevenueOverview>>(
        `/teams/${teamId}/revenue?${params}`,
      );
      return res.data.data!;
    },
    enabled: !!teamId,
    staleTime: 60_000,
  });

export const useTeamRevenueTimeline = (
  teamId: string,
  period: RevenuePeriod,
  dateFrom: string,
  dateTo: string,
) =>
  useQuery<TeamRevenueTimelineReport>({
    queryKey: [...TEAMS_KEY, teamId, "revenue", "timeline", period, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const res = await api.get<ApiResponse<TeamRevenueTimelineReport>>(
        `/teams/${teamId}/revenue/timeline?${params}`,
      );
      return res.data.data!;
    },
    enabled: !!teamId,
    staleTime: 60_000,
  });

// ── Team Reminders ────────────────────────────────────────────────────────────

export interface TeamRemindersFilters {
  memberId?: string;
  isDone?: "true" | "false" | "";
  search?: string;
  page?: number;
  limit?: number;
}

export const useTeamReminders = (teamId: string, filters: TeamRemindersFilters = {}) =>
  useQuery({
    queryKey: [...TEAMS_KEY, teamId, "reminders", filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters.memberId)            params.memberId = filters.memberId;
      if (filters.isDone !== undefined && filters.isDone !== "") params.isDone = filters.isDone;
      if (filters.search)              params.search   = filters.search;
      if (filters.page)                params.page     = String(filters.page);
      if (filters.limit)               params.limit    = String(filters.limit);

      // Backend returns { reminders: TeamReminderItem[], pagination: {...} } inside data
      const res = await api.get<ApiResponse<{ reminders: TeamReminderItem[]; pagination: PaginationMeta }>>(
        `/teams/${teamId}/reminders`,
        { params },
      );

      // sendSuccess wraps the service return as res.data.data = { reminders, pagination }
      const payload = res.data.data as unknown as
        | { reminders?: TeamReminderItem[]; pagination?: PaginationMeta }
        | TeamReminderItem[]
        | undefined;

      const reminders: TeamReminderItem[] = Array.isArray(payload)
        ? payload
        : (payload as { reminders?: TeamReminderItem[] })?.reminders ?? [];

      const pagination = Array.isArray(payload)
        ? res.data.pagination
        : (payload as { pagination?: PaginationMeta })?.pagination ?? res.data.pagination;

      return { data: reminders, pagination };
    },
    enabled: !!teamId,
    staleTime: 30_000,
  });

// ─── Team Settings ────────────────────────────────────────────────────────────
export const useTeamSettings = (teamId: string) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "settings"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<TeamSettings>>(`/teams/${teamId}/settings`);
      return res.data.data as TeamSettings;
    },
    enabled: !!teamId,
    staleTime: 30_000,
  });
};

export const useUpdateTeamSettings = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: {
      autoAssign: boolean;
      splitMode: "round_robin" | "equal_load";
      includedMembers: string[];
      splitTime?: string | null;
      splitStrategy?: "scheduled" | "live";
      roundRobinStartDate?: string | null;
      slaMinutes?: number | null;
      sourceExclusions?: Record<string, string[]>;
    }) => {
      const res = await api.patch<ApiResponse<TeamSettings>>(`/teams/${teamId}/settings`, settings);
      return res.data.data as TeamSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "settings"] });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      toast.success("Team settings saved");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to save settings";
      toast.error(msg);
    },
  });
};

export const useToggleMemberAbsentToday = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, absent }: { memberId: string; absent: boolean }) => {
      const res = await api.patch<ApiResponse<{ memberId: string; absent: boolean }>>(
        `/teams/${teamId}/members/${memberId}/absent-today`,
        { absent },
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      toast.success(data.absent ? "Member marked absent today" : "Member marked present");
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "dashboard"] });
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to update absence")),
  });
};

export const useRedistributeToday = (teamId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<ApiResponse<{ redistributed: number; absentMembers: number; presentMembers: number }>>(
        `/teams/${teamId}/redistribute-today`,
      );
      return res.data.data!;
    },
    onSuccess: (data) => {
      toast.success(`${data.redistributed} lead${data.redistributed === 1 ? "" : "s"} redistributed to ${data.presentMembers} present member${data.presentMembers === 1 ? "" : "s"}`);
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId] });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "leads"] });
      queryClient.invalidateQueries({ queryKey: [...TEAMS_KEY, teamId, "dashboard"] });
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to redistribute leads")),
  });
};

// ─── Upcoming Batch ───────────────────────────────────────────────────────────

export interface UpcomingBatchLead {
  _id: string;
  name: string;
  phone?: string;
  email?: string;
  source?: string;
  status: string;
  createdAt: string;
}

export interface UpcomingBatchMemberPreview {
  memberId: string;
  memberName: string;
  leadsToReceive: number;
  currentLoad: number;
}

export interface UpcomingBatchData {
  totalUnassigned: number;
  splitTime: string | null;
  nextSplitAt: string | null;
  autoAssign: boolean;
  splitMode: "round_robin" | "equal_load";
  splitStrategy?: "scheduled" | "live";
  unassignedLeads: UpcomingBatchLead[];
  previewDistribution: UpcomingBatchMemberPreview[];
  sourceExclusions?: Record<string, string[]>; // userId → sources never auto-assigned to them
}

export const useUpcomingBatch = (teamId: string, enabled = true) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "upcoming-batch"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<UpcomingBatchData>>(`/teams/${teamId}/upcoming-batch`);
      return res.data.data as UpcomingBatchData;
    },
    enabled: !!teamId && enabled,
    refetchInterval: 30_000,   // auto-refresh every 30s
    staleTime: 15_000,
  });
};

// ─── Daily Source Split (actual per-day assignments) ─────────────────────────

export interface DailySplitSourceCount {
  source: string;
  count: number;
}

export interface DailySplitMember {
  memberId: string;
  memberName: string;
  designation?: string;
  total: number;
  sources: DailySplitSourceCount[];
}

export interface DailySourceSplitData {
  date: string;
  totalAssigned: number;
  sourceTotals: DailySplitSourceCount[];
  members: DailySplitMember[];
}

export const useTeamDailySourceSplit = (teamId: string, date: string, enabled = true) => {
  return useQuery({
    queryKey: [...TEAMS_KEY, teamId, "daily-source-split", date],
    queryFn: async () => {
      const res = await api.get<ApiResponse<DailySourceSplitData>>(
        `/teams/${teamId}/daily-source-split`,
        { params: { date } },
      );
      return res.data.data as DailySourceSplitData;
    },
    enabled: !!teamId && !!date && enabled,
    staleTime: 30_000,
  });
};

// ─── Lead sources → teams (2026-11-03, Super Admin) ──────────────────────────

export interface LeadSourceRow { source: string; leads: number; teams: string[]; updatedByName: string; updatedAt: string | null }
export interface LeadSourceRules { sources: LeadSourceRow[]; teams: { id: string; name: string; active: boolean; autoAssign: boolean }[] }

/** Every lead source, the teams its automatic split goes to (none: every team with auto-assign on), and the teams. */
export const useLeadSourceRules = (enabled = true) =>
  useQuery({
    queryKey: [...TEAMS_KEY, "source-rules"],
    queryFn: async () => (await api.get<ApiResponse<LeadSourceRules>>("/teams/source-rules")).data.data,
    enabled,
  });

/** The teams one source's leads are split to; [] = back to every team with auto-assign on. */
export const useSetLeadSourceRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { source: string; teams: string[] }) => (await api.put<ApiResponse<{ source: string; teams: string[] }>>("/teams/source-rules", v)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [...TEAMS_KEY, "source-rules"] }),
    onError: (error: unknown) => toast.error(errMsg(error, "Not saved")),
  });
};
