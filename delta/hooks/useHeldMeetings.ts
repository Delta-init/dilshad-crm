"use client";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";
import type { HeldMeeting } from "@/types/student";

/**
 * The close form's "Meeting done by" (2026-11-18): the meetings with a mentor that the person closing — and the lead's
 * owner — booked and that have been held, the last 60 days, the client's first. Read from the LMS through this CRM;
 * nothing is written.
 */
export const useHeldMeetings = (leadId: string | null | undefined, enabled = true) =>
  useQuery({
    queryKey: ["mentors", "held-meetings", leadId ?? ""],
    queryFn: async () => {
      const response = await api.get<ApiResponse<{ meetings: HeldMeeting[] }>>("/mentors/held-meetings", {
        params: { leadId },
      });
      return response.data.data?.meetings ?? [];
    },
    enabled: enabled && Boolean(leadId),
    staleTime: 60_000,
    retry: 1,
  });
