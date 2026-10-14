"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse, PaginationMeta } from "@/types";
import type {
  FilterTeam,
  InactiveLeadFilters,
  InactiveLeadsResponse,
  LeadMoveEntry,
  LeadMoveFilters,
  MovePerson,
  ReassignRequest,
  ReassignResult,
} from "@/types/inactiveLeads";

export const INACTIVE_LEADS_KEY = ["inactive-leads"] as const;

function errMsg(error: unknown, fallback: string) {
  return (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
}

/** Drops empty filters so the query string only carries what is set. */
function params<T extends object>(filters: T): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== "" && v !== null)
  ) as Record<string, string | number>;
}

/** Leads nobody acted on in time. Refreshes every minute — the list changes as the clock runs. */
export const useInactiveLeads = (filters: InactiveLeadFilters, enabled = true) =>
  useQuery({
    queryKey: [...INACTIVE_LEADS_KEY, "list", filters],
    enabled,
    queryFn: async () => {
      const res = await api.get<ApiResponse<InactiveLeadsResponse>>("/inactive-leads", { params: params(filters) });
      return { ...res.data.data!, pagination: res.data.pagination as PaginationMeta };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

/** The log of leads moved on for inactivity, newest first. */
export const useLeadMoves = (filters: LeadMoveFilters, enabled = true) =>
  useQuery({
    queryKey: [...INACTIVE_LEADS_KEY, "moves", filters],
    enabled,
    queryFn: async () => {
      const res = await api.get<ApiResponse<LeadMoveEntry[]>>("/inactive-leads/moves", { params: params(filters) });
      return { items: res.data.data ?? [], pagination: res.data.pagination as PaginationMeta };
    },
    placeholderData: keepPreviousData,
  });

/** A server not yet updated has no lists of its own (404): the older lists stand in until it is. */
const notThereYet = (error: unknown) => (error as { response?: { status?: number } })?.response?.status === 404;

/** Every active team, for the page's team filter — the page's own list, so it needs no Teams permission. */
export const useInactiveLeadTeams = (enabled = true) =>
  useQuery({
    queryKey: [...INACTIVE_LEADS_KEY, "teams"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FilterTeam[]> => {
      try {
        return (await api.get<ApiResponse<FilterTeam[]>>("/inactive-leads/teams")).data.data ?? [];
      } catch (error) {
        if (!notThereYet(error)) throw error;
        const res = await api.get<ApiResponse<Array<{ _id: string; name: string }>>>("/teams", { params: { status: "active", limit: "100" } });
        return (res.data.data ?? []).map((t) => ({ id: t._id, name: t.name }));
      }
    },
  });

/** Who a lead can be moved to by hand, by name — the Move dialog's own list, so it needs no Users permission. */
export const useMovePeople = (search: string, enabled = true) =>
  useQuery({
    queryKey: [...INACTIVE_LEADS_KEY, "people", search],
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<MovePerson[]> => {
      try {
        return (await api.get<ApiResponse<MovePerson[]>>("/inactive-leads/people", { params: search ? { search } : {} })).data.data ?? [];
      } catch (error) {
        if (!notThereYet(error)) throw error;
        const res = await api.get<ApiResponse<Array<{ _id: string; name: string; email: string; designation?: string | null }>>>("/users", {
          params: { status: "active", limit: "100", ...(search ? { search } : {}) },
        });
        return (res.data.data ?? [])
          .map((u) => ({ id: u._id, name: u.name, email: u.email, designation: u.designation ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
    },
  });

export const useReassignInactiveLeads = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ReassignRequest) =>
      (await api.post<ApiResponse<ReassignResult>>("/inactive-leads/reassign", body)).data.data!,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: INACTIVE_LEADS_KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
      const moved = r.moved.length;
      const skipped = r.skipped.length;
      if (moved && !skipped) {
        toast.success(moved === 1 ? `Moved to ${r.moved[0].to.name}` : `Moved ${moved} leads`);
      } else if (moved && skipped) {
        toast.warning(`Moved ${moved}, skipped ${skipped}`, { description: r.skipped[0].reason });
      } else {
        toast.error(skipped === 1 ? r.skipped[0].reason : `None moved — ${r.skipped[0]?.reason ?? "nothing to move"}`);
      }
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Could not move the leads")),
  });
};
