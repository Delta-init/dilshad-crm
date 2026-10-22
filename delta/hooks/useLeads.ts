"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";
import type { Lead, LeadFilters, LeadStats, UploadLeadsResult, AutoAssignResult } from "@/types/lead";
import type { CreateLeadFormValues, UpdateLeadFormValues } from "@/lib/validations/leadSchema";

const LEADS_KEY = ["leads"] as const;

// ─── Helper ───────────────────────────────────────────────────────────────────
function errMsg(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const useLeads = (filters?: LeadFilters) => {
  return useQuery({
    queryKey: [...LEADS_KEY, filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters?.page)       params.page       = String(filters.page);
      if (filters?.limit)      params.limit      = String(filters.limit);
      if (filters?.status)     params.status     = filters.status;
      if (filters?.assignedTo) params.assignedTo = filters.assignedTo;
      if (filters?.team)       params.team       = filters.team;
      if (filters?.reporter)   params.reporter   = filters.reporter;
      if (filters?.search)     params.search     = filters.search;
      if (filters?.course)     params.course     = filters.course;
      if (filters?.dateFrom)   params.dateFrom   = filters.dateFrom;
      if (filters?.dateTo)     params.dateTo     = filters.dateTo;
      if (filters?.sortBy)     params.sortBy     = filters.sortBy;
      if (filters?.sortOrder)  params.sortOrder  = filters.sortOrder;
      if (filters?.source)     params.source     = filters.source;
      // These were on LeadFilters but never sent, so the backend could not have
      // acted on them even once it started reading them.
      if (filters?.lostReason)    params.lostReason    = filters.lostReason;
      if (filters?.campaignId)    params.campaignId    = filters.campaignId;
      if (filters?.splitFrom)  params.splitFrom  = filters.splitFrom;
      if (filters?.splitTo)    params.splitTo    = filters.splitTo;
      if (filters?.demoScheduled) params.demoScheduled = filters.demoScheduled;
      if (filters?.demoAttended)  params.demoAttended  = filters.demoAttended;
      if (filters?.followupFrom)  params.followupFrom  = filters.followupFrom;
      if (filters?.followupTo)    params.followupTo    = filters.followupTo;
      const response = await api.get<ApiResponse<Lead[]>>("/leads", { params });
      return { data: response.data.data ?? [], pagination: response.data.pagination };
    },
  });
};

export const useLeadSources = () => {
  return useQuery({
    queryKey: ["lead-sources"],
    queryFn: async () => {
      const response = await api.get<ApiResponse<string[]>>("/leads/sources");
      return response.data.data ?? [];
    },
    staleTime: 5 * 60 * 1000, // cache for 5 min
  });
};

/** Full detail — includes notes[] and activityLogs[] populated */
export const useLead = (id: string) => {
  return useQuery({
    queryKey: [...LEADS_KEY, id],
    queryFn: async () => {
      const response = await api.get<ApiResponse<Lead>>(`/leads/${id}`);
      return response.data.data!;
    },
    enabled: !!id,
  });
};

export const useUserLeads = (userId: string, filters?: LeadFilters) => {
  return useQuery({
    queryKey: [...LEADS_KEY, "user", userId, filters],
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
      const response = await api.get<ApiResponse<Lead[]>>(`/users/${userId}/leads`, { params });
      return { data: response.data.data ?? [], pagination: response.data.pagination };
    },
    enabled: !!userId,
  });
};

export const useUserLeadStats = (userId: string) => {
  return useQuery({
    queryKey: [...LEADS_KEY, "stats", userId],
    queryFn: async () => {
      const response = await api.get<ApiResponse<LeadStats>>(`/users/${userId}/lead-stats`);
      return response.data.data!;
    },
    enabled: !!userId,
  });
};

export type RevenuePeriod = "today" | "week" | "month" | "year" | "custom" | "all";

export interface UserRevenueData {
  totalRevenue: number;
  paymentCount: number;
  leadCount: number;
  period: string;
  dateFrom: string;
  dateTo: string;
}

export const useUserRevenue = (
  userId: string,
  period: RevenuePeriod,
  from?: string,
  to?: string,
) => {
  return useQuery({
    queryKey: [...LEADS_KEY, "revenue", userId, period, from, to],
    queryFn: async () => {
      const params: Record<string, string> = { period };
      if (period === "custom" && from && to) {
        params.from = from;
        params.to   = to;
      }
      const response = await api.get<ApiResponse<UserRevenueData>>(
        `/users/${userId}/revenue`,
        { params },
      );
      return response.data.data!;
    },
    enabled: !!userId,
  });
};

// ─── Lead Mutations ───────────────────────────────────────────────────────────

export const useCreateLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateLeadFormValues) => {
      const response = await api.post<ApiResponse<Lead>>("/leads", data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      toast.success("Lead created successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to create lead")),
  });
};

export const useUpdateLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateLeadFormValues }) => {
      const response = await api.put<ApiResponse<Lead>>(`/leads/${id}`, data);
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Lead updated successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to update lead")),
  });
};

export const useUpdateLeadStatus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, lostReason, lostNotes, followUpNote, followUpAt, nextFollowUpAt, meetingAt, meetingNote }: {
      id: string; status: Lead["status"]; lostReason?: string; lostNotes?: string;
      followUpNote?: string; followUpAt?: string; nextFollowUpAt?: string;
      /** Required for meeting_scheduled — the meeting time (ISO); the server makes it a reminder */
      meetingAt?: string; meetingNote?: string;
    }) => {
      const response = await api.patch<ApiResponse<Lead>>(`/leads/${id}/status`, { status, lostReason, lostNotes, followUpNote, followUpAt, nextFollowUpAt, meetingAt, meetingNote });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Status updated");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to update status")),
  });
};

export const useAssignLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) => {
      const response = await api.patch<ApiResponse<Lead>>(`/leads/${id}/assign`, { userId });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.id] });
      toast.success("Lead assigned successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to assign lead")),
  });
};

export const useDeleteLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { await api.delete(`/leads/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      toast.success("Lead deleted successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to delete lead")),
  });
};

export const useUploadLeads = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      teamIds,
      memberOverrides,
    }: {
      file: File;
      teamIds?: string[];
      memberOverrides?: Record<string, string[]>;
    }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (teamIds !== undefined) {
        formData.append("teamIds", JSON.stringify(teamIds));
      }
      if (memberOverrides !== undefined) {
        formData.append("memberOverrides", JSON.stringify(memberOverrides));
      }
      const response = await api.post<ApiResponse<UploadLeadsResult>>("/leads/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      toast.success(`Upload complete: ${data.created} leads created`);
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to upload leads")),
  });
};

export const useUploadLegacyLeads = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      assignedTo,
      sourceOverride,
    }: {
      file: File;
      assignedTo?: string;
      sourceOverride?: string;
    }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (assignedTo) formData.append("assignedTo", assignedTo);
      if (sourceOverride) formData.append("sourceOverride", sourceOverride);
      const response = await api.post<ApiResponse<{
        summary: { total: number; created: number; duplicate: number; invalid: number; assigned: number };
        results: Array<{ index: number; status: string; leadId?: string; phone?: string; reason?: string }>;
      }>>("/leads/upload/legacy", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      toast.success(`Import complete: ${data.summary.created} leads created`);
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to import leads")),
  });
};

export const useAutoAssignLeads = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (leadIds?: string[]) => {
      const response = await api.post<ApiResponse<AutoAssignResult>>("/leads/auto-assign", { leadIds });
      return response.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      toast.success(`Auto-assigned ${data.assigned} leads`);
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to auto-assign leads")),
  });
};

// ─── Team Assignment Mutations ────────────────────────────────────────────────

export const useAssignLeadToTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, teamId }: { id: string; teamId: string }) => {
      const response = await api.patch<ApiResponse<Lead>>(`/leads/${id}/team`, { teamId });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Lead assigned to team");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to assign to team")),
  });
};

export const useTransferLeadToTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, teamId }: { id: string; teamId: string }) => {
      const response = await api.patch<ApiResponse<Lead>>(`/leads/${id}/transfer`, { teamId });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success("Lead transferred to new team");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to transfer lead")),
  });
};

// ─── Bulk Mutations ───────────────────────────────────────────────────────────

export const useBulkUpdateLeadStatus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadIds, status, lostReason, lostNotes, followUpNote, followUpAt, nextFollowUpAt }: {
      leadIds: string[]; status: string; lostReason?: string; lostNotes?: string;
      followUpNote?: string; followUpAt?: string; nextFollowUpAt?: string;
    }) => {
      const res = await api.patch<ApiResponse<{ updated: number }>>("/leads/bulk/status", { leadIds, status, lostReason, lostNotes, followUpNote, followUpAt, nextFollowUpAt });
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success(`${data.updated} lead(s) status updated`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to update status")),
  });
};

export const useBulkDeleteLeads = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (leadIds: string[]) => {
      const res = await api.delete<ApiResponse<{ deleted: number }>>("/leads/bulk", { data: { leadIds } });
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success(`${data.deleted} lead(s) deleted`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to delete leads")),
  });
};

export const useBulkAssignLeadsToTeam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadIds, teamId }: { leadIds: string[]; teamId: string }) => {
      const res = await api.patch<ApiResponse<{ updated: number }>>("/leads/bulk/team", { leadIds, teamId });
      return res.data.data!;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      toast.success(`${data.updated} lead(s) assigned to team`);
    },
    onError: (err: unknown) => toast.error(errMsg(err, "Failed to assign leads to team")),
  });
};

// ─── Note Mutations ───────────────────────────────────────────────────────────

export const useAddLeadNote = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, content }: { leadId: string; content: string }) => {
      const response = await api.post<ApiResponse<Lead>>(`/leads/${leadId}/notes`, { content });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.leadId] });
      toast.success("Note added");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to add note")),
  });
};

export const useUpdateLeadNote = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, noteId, content }: { leadId: string; noteId: string; content: string }) => {
      const response = await api.put<ApiResponse<Lead>>(`/leads/${leadId}/notes/${noteId}`, { content });
      return response.data.data!;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.leadId] });
      toast.success("Note updated");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to update note")),
  });
};

export const useDeleteLeadNote = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, noteId }: { leadId: string; noteId: string }) => {
      await api.delete(`/leads/${leadId}/notes/${noteId}`);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, vars.leadId] });
      toast.success("Note deleted");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to delete note")),
  });
};



// ── Follow-Up hooks ───────────────────────────────────────────────────────────

export interface FollowUpEntry {
  _id: string;
  note?: string;
  followedUpAt: string;
  followedUpBy: { _id: string; name: string; email: string };
  nextFollowUpAt?: string | null;
  createdAt: string;
}

export interface FollowUpsData {
  followUps: FollowUpEntry[];
  nextFollowUpAt: string | null;
  total: number;
}

export const useFollowUps = (leadId: string) => {
  return useQuery<FollowUpsData>({
    queryKey: ["leads", leadId, "followups"],
    queryFn: async () => {
      const { data } = await api.get<{ data: FollowUpsData }>(`/leads/${leadId}/followups`);
      return data.data;
    },
    enabled: !!leadId,
    staleTime: 30_000,
  });
};

export const useAddFollowUp = (leadId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      note?: string;
      followedUpAt?: string;
      nextFollowUpAt?: string | null;
    }) => {
      const { data } = await api.post(`/leads/${leadId}/followups`, payload);
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leads", leadId, "followups"] });
      queryClient.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Follow-up logged");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to log follow-up";
      toast.error(msg);
    },
  });
};

/** Change the next follow-up date (2026-10-22); the API moves its "Follow-up due" reminder with it. */
export const useChangeFollowUpDate = (leadId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { nextFollowUpAt: string; note?: string }) => {
      const { data } = await api.patch(`/leads/${leadId}/followup-date`, payload);
      return data.data as { nextFollowUpAt: string; previous: string | null };
    },
    onSuccess: () => {
      // The lead, its follow-ups, Today's Follow-ups — and the reminder that moved.
      queryClient.invalidateQueries({ queryKey: LEADS_KEY });
      queryClient.invalidateQueries({ queryKey: ["reminders"] });
      toast.success("Follow-up date changed");
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Couldn't change the follow-up date";
      toast.error(msg);
    },
  });
};

// ─── Today's follow-ups (daily dashboard pop-up) ──────────────────────────────

export interface TodayFollowupLead {
  _id: string;
  name: string;
  phone?: string;
  status: string;
  source?: string;
  nextFollowUpAt: string | null;
  missedFollowUpWarnedAt?: string | null;
  lastFollowupDate?: string | null;
}

export const useMyTodayFollowups = () => {
  return useQuery({
    queryKey: [...LEADS_KEY, "followups", "mine", "today"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<TodayFollowupLead[]>>("/leads/followups/mine/today");
      return res.data.data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
};
