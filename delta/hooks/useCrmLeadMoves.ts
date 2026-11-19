"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";

/* Moving leads to another sales CRM — Sales, Draw, Remote (2026-11-19). /crm-lead-moves. */

export type MoveMode = "person" | "team" | "split";
export interface MoveTargetPerson { id: string; name: string; leader: boolean }
export interface MoveTargetTeam { id: string; name: string; people: MoveTargetPerson[] }
export interface MoveTarget { code: string; name: string; ready: boolean; missing: string[]; error?: string; teams: MoveTargetTeam[] }
export interface MoveInput { leadIds?: string[]; fromUserId?: string; to: string; mode: MoveMode; teamId?: string | null; userId?: string | null }
export interface MoveResult {
  moved: { leadId: string; name: string; moveId: string; toLeadId: string; outcome: "created" | "repeat"; holder: string }[];
  refused: { leadId: string; name: string; reason: string }[];
}
export interface MovedOut {
  id: string; name: string; phone: string; status: string; ownerName: string; to: string; toName: string;
  outcome: "created" | "repeat"; holder: string; byName: string; at: string; undoneAt: string | null; canUndo: boolean;
}
export interface MovedLead {
  _id: string; to: string; toName: string; outcome: string; holder: string; byName: string; ownerName: string; at: string;
  undoneAt: string | null; canUndo: boolean;
  lead: {
    name: string; phone: string; email?: string; source?: string; status: string; campaign?: string;
    notes?: { content: string; createdAt?: string }[];
    activityLogs?: { action: string; description: string; createdAt?: string }[];
  };
}

export const moveError = (e: unknown, fallback = "Something went wrong") =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const KEY = ["crm-lead-moves"] as const;

/** Super Admins, the Sales Manager, team leaders — the server says (false until the server has it). */
export const useMayMoveToCrm = () =>
  useQuery({
    queryKey: [...KEY, "may"],
    queryFn: async () => {
      try {
        return !!(await api.get<ApiResponse<{ may: boolean }>>("/crm-lead-moves/may")).data.data?.may;
      } catch {
        return false;
      }
    },
    staleTime: 5 * 60_000,
  });

export const useMoveTargets = (enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, "targets"],
    queryFn: async () => (await api.get<ApiResponse<MoveTarget[]>>("/crm-lead-moves/targets")).data.data as MoveTarget[],
    enabled,
    staleTime: 60_000,
    retry: false,
  });

export const useMovedOut = (enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, "list"],
    queryFn: async () => (await api.get<ApiResponse<MovedOut[]>>("/crm-lead-moves", { params: { limit: 200 } })).data.data as MovedOut[],
    enabled,
  });

export const useMovedLead = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, "lead", id],
    queryFn: async () => (await api.get<ApiResponse<MovedLead>>(`/crm-lead-moves/${id}`)).data.data as MovedLead,
    enabled: enabled && !!id,
    retry: false,
  });

export const useMoveToCrm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MoveInput) => (await api.post<ApiResponse<MoveResult>>("/crm-lead-moves", input)).data.data as MoveResult,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead-transfers"] });
    },
  });
};

export const useUndoMoveToCrm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<ApiResponse<{ leadId: string }>>(`/crm-lead-moves/${id}/undo`)).data.data as { leadId: string },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead"] });
    },
  });
};
