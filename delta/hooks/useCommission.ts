"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";
import type {
  CommissionEarnings,
  CommissionPlanView,
  CommissionPreview,
  CommissionRole,
  CoursePlan,
  PayView,
  SlabRow,
  Slabs,
} from "@/types/commission";

const COMMISSION_KEY = ["commission"] as const;

function errMsg(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** The plan: every course's row, the Sales Manager, excluded logins, and what needs fixing. */
export const useCommissionPlan = () =>
  useQuery({
    queryKey: [...COMMISSION_KEY, "plan"],
    queryFn: async () => {
      const response = await api.get<ApiResponse<CommissionPlanView>>("/commission/plan");
      return response.data.data!;
    },
  });

/** A month ("YYYY-MM") of commission, as far as the viewer may see it. */
export const useCommissionEarnings = (month: string) =>
  useQuery({
    queryKey: [...COMMISSION_KEY, "earnings", month],
    queryFn: async () => {
      const response = await api.get<ApiResponse<CommissionEarnings>>("/commission/earnings", {
        params: { month },
      });
      return response.data.data!;
    },
  });

/**
 * A month's salary and commission on the slabs: the viewer's own, and
 * everyone's for a Super Admin. Off until there's a month to ask about.
 */
export const usePay = (month: string | null) =>
  useQuery({
    queryKey: [...COMMISSION_KEY, "pay", month],
    queryFn: async () => {
      const response = await api.get<ApiResponse<PayView>>("/commission/pay", { params: { month } });
      return response.data.data!;
    },
    enabled: Boolean(month),
    staleTime: 60_000,
    retry: 1,
  });

/**
 * What a sale would earn its closer — for the closing dialog. Nothing is saved;
 * off until there is a course to ask about.
 */
export const useCommissionPreview = (input: { course?: string | null; team?: string | null; closer?: string | null; mentor?: string | null }) =>
  useQuery({
    queryKey: [...COMMISSION_KEY, "preview", input.course, input.team, input.closer, input.mentor ?? ""],
    queryFn: async () => {
      const params: Record<string, string> = { course: input.course! };
      if (input.team) params.team = input.team;
      if (input.closer) params.closer = input.closer;
      // The mentor picked as "Meeting done by" (2026-11-18), by email: the meeting fee comes off the lines.
      if (input.mentor) params.mentor = input.mentor;
      const response = await api.get<ApiResponse<CommissionPreview>>("/commission/preview", { params });
      return response.data.data!;
    },
    enabled: Boolean(input.course),
    staleTime: 60_000,
    retry: false,
  });

// ─── Mutations (Super Admin) ──────────────────────────────────────────────────

export const useUpdateCoursePlan = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ courseId, plan }: { courseId: string; plan: CoursePlan }) => {
      const response = await api.put<ApiResponse<{ _id: string; commission: CoursePlan }>>(
        `/commission/plan/${courseId}`,
        plan,
      );
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMISSION_KEY });
      // Course cards show the plan too.
      queryClient.invalidateQueries({ queryKey: ["courses"] });
      toast.success("Commission plan saved");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Couldn't save the commission plan")),
  });
};

/** One role's salary slab, in force from this month on. */
export const useUpdateSlab = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ role, rows }: { role: CommissionRole; rows: SlabRow[] }) => {
      const response = await api.put<ApiResponse<{ slabs: Slabs; from: string | null }>>(
        `/commission/slabs/${role}`,
        { rows },
      );
      return response.data.data!;
    },
    onSuccess: () => {
      // The plan shows the slabs; everyone's pay follows them.
      queryClient.invalidateQueries({ queryKey: COMMISSION_KEY });
      toast.success("Salary slab saved");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Couldn't save the salary slab")),
  });
};

export const useUpdateCommissionSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { salesManager?: string | null; excludedUsers?: string[] }) => {
      const response = await api.put<ApiResponse<CommissionPlanView>>("/commission/settings", data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COMMISSION_KEY });
      toast.success("Commission settings saved");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Couldn't save the commission settings")),
  });
};
