"use client";
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { io as openSocket } from "socket.io-client";
import api from "@/lib/axios";
import { API_URL } from "@/lib/apiUrl";

/**
 * One salesperson's month, as GET /leaderboard ranks it. Today's calls and the leads by status came in 2026-10-15 —
 * optional, so a server not yet updated still shows the rest.
 */
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
  /** Today's (Dubai) calls, the connected ones and talk time. */
  callsToday?: number;
  connectedToday?: number;
  talkSecondsToday?: number;
  /** The leads they hold now, by status; and how many in all. */
  leadCounts?: Record<string, number>;
  totalLeads?: number;
}

/** How the board is ordered: revenue (then closings, follow-ups, calls), calls, or talk time. */
export type LeaderboardRankBy = "revenue" | "calls" | "talk";
export type LeaderboardRank = LeaderboardRankBy;

export const RANK_OPTIONS: { value: LeaderboardRankBy; label: string }[] = [
  { value: "revenue", label: "Revenue" },
  { value: "calls", label: "Calls" },
  { value: "talk", label: "Talk time" },
];

/** Talk-time targets (minutes on 3CX), as on the Bangalore CRM's board — the server's, else these. */
export const DEFAULT_TALK_TARGETS = { dayMinutes: 100, monthMinutes: 1000 };

export interface Leaderboard {
  month: string;
  rankBy: LeaderboardRankBy;
  rows: LeaderboardRow[];
  currentMonth?: boolean;
  targets?: { dayMinutes: number; monthMinutes: number };
  updatedAt?: string;
}

/** "1h 05m" / "4m 12s" / "0s" — a month's talk time, as on the other CRMs' open boards. */
export function fmtTalk(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
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

/**
 * The open board (GET /public/leaderboard — no sign-in), for the public page: plain fetch, so no token or refresh
 * gets involved. Refreshed every 30 s, as the Bangalore CRM's — every minute while the live line is up (it says when
 * to fetch), just in case.
 */
export const usePublicLeaderboard = (month: string, rankBy: LeaderboardRankBy, live = false) =>
  useQuery({
    queryKey: ["public-leaderboard", month, rankBy],
    refetchInterval: live ? 60_000 : 30_000,
    refetchIntervalInBackground: true,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ month, ...(rankBy !== "revenue" ? { rankBy } : {}) });
      const res = await fetch(`${API_URL}/public/leaderboard?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`The leaderboard answered ${res.status}`);
      return ((await res.json()) as { data: Leaderboard }).data;
    },
  });

// Where the socket lives: the API's address without /api/v1 (as lib/socket.ts works it out).
const SOCKET_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:7868/api/v1").replace(/\/api\/v1\/?$/, "");

/** The live line: not up yet, up, or lost after being up (the refresh carries on meanwhile). */
export type LiveState = "connecting" | "live" | "reconnecting";

/**
 * The open board's live line (the TV board, 2026-10-15): the API's /public-leaderboard socket says "changed" — the
 * month and when, nothing more — as a screen joins and whenever the board moves, and the page fetches it at once.
 * Its own connection, no sign-in, never the signed-in socket. The refresh carries on either way. A screen turned away
 * (the API caps how many watch) tries again once a minute.
 */
export function useLeaderboardLive(month: string, onChange: () => void): LiveState {
  const [live, setLive] = useState<LiveState>("connecting");
  const latest = useRef({ month, onChange });
  latest.current = { month, onChange };
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const socket = openSocket(`${SOCKET_ORIGIN}/public-leaderboard`, {
      forceNew: true,
      transports: ["websocket", "polling"],
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
    });
    let wasUp = false;
    socket.on("connect", () => {
      wasUp = true;
      setLive("live");
    });
    socket.on("disconnect", (reason) => {
      setLive("reconnecting");
      // Dropped by the server, the socket won't try again by itself (as lib/socket.ts).
      if (reason === "io server disconnect") {
        clearTimeout(retry);
        retry = setTimeout(() => socket.connect(), 2_000);
      }
    });
    socket.on("connect_error", () => {
      setLive(wasUp ? "reconnecting" : "connecting");
      // Turned away by the server: the socket won't try again by itself.
      if (!socket.active) {
        clearTimeout(retry);
        retry = setTimeout(() => socket.connect(), 60_000);
      }
    });
    socket.on("leaderboard:changed", (said?: { month?: string }) => {
      if (said?.month === latest.current.month) latest.current.onChange();
    });
    return () => {
      clearTimeout(retry);
      socket.disconnect();
    };
  }, []);
  return live;
}
