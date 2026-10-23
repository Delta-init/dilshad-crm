import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import type { ApiResponse } from "@/types";

/*
 * Repeat leads (the user, 2026-10-23): a number the CRM already has, in again from the ads, goes to its team leader
 * first; they verify it and give it to the same person or another in the team. A team leader sees their teams',
 * a Super Admin and the Sales Manager everyone's.
 */

const KEY = ["repeat-leads"] as const;
type Person = { id: string; name: string };

export interface RepeatLead {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: string;
  repeatCount: number;
  owner: Person | null;
  team: Person | null;
  repeat: {
    waiting: boolean;
    at: string;
    teamId: string | null;
    previousOwner: Person | null;
    previousStatus: string | null;
    alreadyClient: boolean;
    source: string | null;
    campaign: string | null;
    decidedBy: Person | null;
    decidedAt: string | null;
    givenTo: Person | null;
  };
}

export interface RepeatLeadList {
  scope: "all" | "team";
  teams: Array<{ id: string; name: string; people: Array<Person & { leader: boolean }> }>;
  leads: RepeatLead[];
}

export function useRepeatLeads(state: "waiting" | "done" | "all") {
  return useQuery({
    queryKey: [...KEY, state],
    queryFn: async () => (await api.get<ApiResponse<RepeatLeadList>>("/leads/repeats", { params: { state } })).data.data as RepeatLeadList,
    retry: false,
  });
}

/** How many wait for this person — null when repeats aren't theirs (no menu item). */
export function useRepeatLeadCount() {
  return useQuery({
    queryKey: [...KEY, "count"],
    queryFn: async () => (await api.get<ApiResponse<{ count: number | null }>>("/leads/repeats/count")).data.data?.count ?? null,
    refetchInterval: 2 * 60_000,
    staleTime: 60_000,
  });
}

export function useGiveRepeatLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, userId }: { leadId: string; userId: string }) =>
      (await api.post<ApiResponse<{ givenTo: Person }>>(`/leads/${leadId}/repeat/give`, { userId })).data.data,
    onSuccess: (d) => {
      toast.success(`Verified — given to ${d?.givenTo.name ?? "them"}`);
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || "Could not give it out");
    },
  });
}
