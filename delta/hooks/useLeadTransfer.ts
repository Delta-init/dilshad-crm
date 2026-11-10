"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";

/* Transferring a person's open leads — to one person or split (2026-11-10). /lead-transfers. */

export interface TransferSummary {
  user: { id: string; name: string; email: string; status: string };
  open: number;
  closed: number;
  lost: number;
  byStatus: Record<string, number>;
}
export interface TransferTarget { userId: string; count?: number | null }
export interface TransferPreview {
  from: { id: string; name: string };
  open: number;
  targets: Array<{ userId: string; name: string; count: number; team: { id: string; name: string } | null }>;
  warnings: string[];
}
export interface TransferDone { id: string; from: string; moved: number; targets: Array<{ userId: string; name: string; count: number; team: string }> }
export interface TransferRecord {
  id: string; from: string; by: string; reason: "transfer" | "remove"; moved: number; createdAt: string;
  targets: Array<{ name: string; count: number; team: string }>; undoneAt: string | null; undone: number; mayUndo: boolean;
}

export const transferError = (e: unknown, fallback = "Something went wrong") =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const KEY = ["lead-transfers"] as const;

export const useTransferSummary = (userId: string | null) =>
  useQuery({
    queryKey: [...KEY, "summary", userId],
    queryFn: async () => (await api.get<ApiResponse<TransferSummary>>(`/lead-transfers/users/${userId}`)).data.data as TransferSummary,
    enabled: !!userId,
    staleTime: 0,
  });

export const useTransferPreview = (userId: string | null, targets: TransferTarget[], enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, "preview", userId, targets],
    queryFn: async () => (await api.post<ApiResponse<TransferPreview>>(`/lead-transfers/users/${userId}/preview`, { targets })).data.data as TransferPreview,
    enabled: enabled && !!userId && targets.length > 0,
    retry: false,
  });

export const useRecentTransfers = (enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, "recent"],
    queryFn: async () => (await api.get<ApiResponse<TransferRecord[]>>("/lead-transfers", { params: { limit: 30 } })).data.data as TransferRecord[],
    enabled,
  });

export const useTransferLeads = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; targets: TransferTarget[]; reason?: "transfer" | "remove" }) =>
      (await api.post<ApiResponse<TransferDone>>(`/lead-transfers/users/${input.userId}`, { targets: input.targets, reason: input.reason ?? "transfer" })).data.data as TransferDone,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
};

export const useUndoTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<ApiResponse<{ undone: number; skipped: number }>>(`/lead-transfers/${id}/undo`)).data.data as { undone: number; skipped: number },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
};

/** Whether this person may transfer leads — Super Admins, the Sales Manager, roles that edit users: the server says. */
export const useMayTransfer = () =>
  useQuery({
    queryKey: [...KEY, "may"],
    queryFn: async () => {
      try {
        await api.get("/lead-transfers", { params: { limit: 1 } });
        return true;
      } catch {
        return false;
      }
    },
    staleTime: 5 * 60_000,
  });
