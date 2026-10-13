import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import type { ApiResponse } from "@/types";
import type { StoredReceipt } from "@/types/student";

/*
 * Balance payments (the user, 2026-10-13): the part-paid courses this CRM
 * closed — your own, your teams' as a team leader, everyone's for the Sales
 * Manager — with what finance says is paid, left and next due, and the next
 * payment recorded here with its receipt for finance to approve.
 */

const KEY = ["balance-payments"] as const;

export type DueState = "overdue" | "due_soon" | "later" | "none";

/** A balance payment recorded here, as finance answers for it. */
export interface RecordedPayment {
  externalId: string;
  amountMinor: number;
  currency: string;
  method: string;
  paidOn: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  decidedAt?: string;
  decidedBy?: string;
  receiptNumber?: string;
}

export interface BalanceRow {
  studentId: string;
  name: string;
  phone: string;
  email: string;
  enrollmentNumber: string;
  course: string;
  academy: string;
  closedBy: { id: string; name: string };
  team: string;
  enrolledOn: string | null;
  invoice: {
    number: string;
    approval: string;
    status: string;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    nextDueOn: string;
    payments: { amountMinor: number; paidOn: string; method: string; receiptNumber?: string }[];
  } | null;
  dueState: DueState;
  balancePayments: RecordedPayment[];
  waitingMinor: number;
  canRecord: boolean;
  whyNot: string;
}

export interface BalanceList {
  rows: BalanceRow[];
  reachable: boolean;
  counts: {
    owing: number;
    overdue: number;
    dueSoon: number;
    waiting: number;
    paidOff: number;
    left: { currency: string; balanceMinor: number }[];
  };
}

export function useBalancePayments(filters: { state: string; search: string; mine: boolean }) {
  return useQuery({
    queryKey: [...KEY, filters],
    queryFn: async () => {
      const params = new URLSearchParams({ state: filters.state });
      if (filters.search.trim()) params.set("search", filters.search.trim());
      if (filters.mine) params.set("mine", "true");
      const res = await api.get<ApiResponse<BalanceList>>(`/balance-payments?${params}`);
      return res.data.data!;
    },
    placeholderData: (prev) => prev,
  });
}

/** The sidebar's number: overdue or due within 3 days. */
export function useBalanceDueCount(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "count"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<{ due: number }>>("/balance-payments/count");
      return res.data.data?.due ?? 0;
    },
    enabled,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

export async function uploadBalanceReceipt(studentId: string, file: File): Promise<StoredReceipt> {
  const body = new FormData();
  body.append("file", file);
  const res = await api.post<{ success: boolean; data: StoredReceipt }>(
    `/balance-payments/${studentId}/receipt`,
    body,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return res.data.data;
}

export interface RecordInput {
  /** The dialog's own id for this payment: saving twice is one payment. */
  key: string;
  amount: number;
  method: string;
  paidOn: string;
  receipt: StoredReceipt;
  note?: string;
}

export function useRecordBalancePayment(studentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordInput) => {
      const res = await api.post<ApiResponse<RecordedPayment>>(`/balance-payments/${studentId}`, input);
      return res.data.data!;
    },
    onSuccess: () => {
      toast.success("Sent to finance — it shows as pending until accounts approve it");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? "Could not send the payment to finance");
    },
  });
}

/** Minor units as money in that currency: "AED 1,250.50", "₹12,000". */
export function fmtMinor(minor: number, currency: string): string {
  const n = (Number(minor) || 0) / 100;
  if (currency === "INR") return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return `${currency || "AED"} ${n.toLocaleString("en-AE", { maximumFractionDigits: 2 })}`;
}
