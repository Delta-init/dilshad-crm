"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { RecordInput, RecordedPayment } from "@/hooks/useBalancePayments";
import type { StoredReceipt } from "@/types/student";

function errMsg(e: unknown, fallback: string) {
  return (
    (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
  );
}

export const useAddPayment = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { amount: number; note?: string; paidAt: string; method?: string; receipt?: StoredReceipt | null }) => {
      const res = await api.post(`/leads/${leadId}/payments`, data);
      return res.data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Payment recorded");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Failed to add payment")),
  });
};

export const useUpdatePayment = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      paymentId,
      data,
    }: {
      paymentId: string;
      data: { amount?: number; note?: string; paidAt?: string; method?: string; receipt?: StoredReceipt };
    }) => {
      const res = await api.put(`/leads/${leadId}/payments/${paymentId}`, data);
      return res.data.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Payment updated");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Failed to update payment")),
  });
};

export const useDeletePayment = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      await api.delete(`/leads/${leadId}/payments/${paymentId}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Payment removed");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Failed to delete payment")),
  });
};

/*
 * A closed lead's payments go to finance (2026-10-23): a payment added on the lead after the close never reached the
 * invoice, the LMS or CS Portal. Once the close is in finance, a payment is sent with its receipt as a balance
 * payment; one added before this shows "Not sent to finance", with a Send to finance button.
 */

export type LeadPaymentState = "with_close" | "sent" | "not_sent";

export interface LeadFinanceLink {
  inFinance: boolean;
  studentId: string | null;
  reachable: boolean;
  invoice: { number: string; approval: string; status: string; currency: string; totalMinor: number; paidMinor: number; balanceMinor: number } | null;
  waitingMinor: number;
  canRecord: boolean;
  whyNot: string;
  payments: { id: string; state: LeadPaymentState; financeStatus?: "pending" | "approved" | "rejected"; reason?: string; receiptNumber?: string }[];
}

export const useLeadPaymentFinance = (leadId: string, enabled = true) =>
  useQuery({
    queryKey: ["leads", leadId, "payments-finance"],
    queryFn: async () => (await api.get<{ data: LeadFinanceLink }>(`/leads/${leadId}/payments/finance`)).data.data,
    enabled: enabled && !!leadId,
    staleTime: 30_000,
  });

export const useSendLeadPayment = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordInput & { paymentId?: string }) =>
      (await api.post<{ data: RecordedPayment }>(`/leads/${leadId}/payments/finance`, input)).data.data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      qc.invalidateQueries({ queryKey: ["balance-payments"] });
      toast.success("Sent to finance — it shows as pending until accounts approve it");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Could not send the payment to finance")),
  });
};
