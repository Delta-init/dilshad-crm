"use client";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/axios";

/** One salesperson's month, as GET /leaderboard ranks it. */
export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  revenue: number;
  closings: number;
  followUps: number;
  /** From 3CX (lead_calls, since 2026-10-14): their calls with leads in the month, the connected ones, talk time. */
  calls: number;
  connected: number;
  talkSeconds: number;
}

/** How the board is ordered: revenue (then closings, follow-ups, calls), calls, or talk time. */
export type LeaderboardRankBy = "revenue" | "calls" | "talk";

export interface Leaderboard {
  month: string;
  rankBy: LeaderboardRankBy;
  rows: LeaderboardRow[];
}

/** The month's leaderboard (YYYY-MM, Dubai months); this month when none is given; by revenue unless told. */
export const useLeaderboard = (month?: string, rankBy: LeaderboardRankBy = "revenue") =>
  useQuery({
    queryKey: ["leaderboard", month ?? "current", rankBy],
    queryFn: async () => {
      const res = await api.get<{ data: Leaderboard }>("/leaderboard", { params: { ...(month ? { month } : {}), rankBy } });
      return res.data.data;
    },
  });
