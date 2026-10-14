"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";

export interface CallLog {
  id:           string;
  startTime:    string;
  duration:     number;       // seconds
  direction:    "inbound" | "outbound";
  status:       string;
  callerNumber: string;
  calleeNumber: string;
  agentName:    string | null;
  recordingUrl: string | null;
}

export interface RecentCallLog {
  _id:           string;
  leadId:        { _id: string; name: string; phone: string } | null;
  contactName:   string | null;
  phoneNumber:   string;
  callType:      "Inbound" | "Outbound" | "Missed" | "Notanswered";
  callDirection: "inbound" | "outbound";
  callDuration:  number;
  callDate:      string;
  recordingUrl:  string | null;
  agentExtension: string | null;
  agentName:     string | null;
  initiatedBy:   { _id: string; name: string } | null;
  source:        string;
  qcStatus:      "pending" | "reviewed" | "flagged";
  qcRating:      number | null;
  qcNotes:       string | null;
  qcReviewedBy:  { _id: string; name: string } | null;
  qcReviewedAt:  string | null;
}

interface CallsResponse {
  calls: CallLog[];
  phone: string;
  total: number;
  hint?: string;
}

export const useLeadCalls = (leadId: string, enabled = true) =>
  useQuery({
    queryKey: ["calls", leadId],
    queryFn: async () => {
      const res = await api.get<ApiResponse<CallsResponse>>(`/calls/lead/${leadId}`);
      return res.data.data ?? { calls: [], phone: "", total: 0 };
    },
    enabled: !!leadId && enabled,
    staleTime: 60_000,   // cache 1 min — call logs don't change that fast
    refetchOnWindowFocus: false,
  });

interface RecentCallsResponse {
  calls: RecentCallLog[];
  total: number;
}

export interface RecentCallsFilters {
  limit?:     number;
  direction?: "inbound" | "outbound" | "all";
  callType?:  string;
  agent?:     string;
}

export const useRecentCalls = (filters: RecentCallsFilters = {}) =>
  useQuery({
    queryKey: ["calls", "recent", filters],
    queryFn: async () => {
      const params: Record<string, string> = {
        limit: String(filters.limit ?? 100),
      };
      const res = await api.get<ApiResponse<RecentCallsResponse>>("/calls/recent", { params });
      return res.data.data ?? { calls: [], total: 0 };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

interface QcQueueResponse {
  calls: RecentCallLog[];
  total: number;
  page:  number;
  limit: number;
}

export const useQcQueue = (status: "pending" | "reviewed" | "flagged" | "all" = "pending") =>
  useQuery({
    queryKey: ["calls", "qc-queue", status],
    queryFn: async () => {
      const res = await api.get<ApiResponse<QcQueueResponse>>("/calls/qc-queue", {
        params: { status, limit: 100 },
      });
      return res.data.data ?? { calls: [], total: 0, page: 1, limit: 100 };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

export interface QcUpdatePayload {
  callId:    string;
  qcRating?: number;
  qcNotes?:  string;
  qcStatus?: "pending" | "reviewed" | "flagged";
}

export const useUpdateQc = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ callId, ...data }: QcUpdatePayload) =>
      api.put(`/calls/${callId}/qc`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calls", "qc-queue"] });
      qc.invalidateQueries({ queryKey: ["calls", "recent"] });
    },
  });
};

export const useCallById = (callId: string | null) =>
  useQuery({
    queryKey: ["calls", "detail", callId],
    queryFn: async () => {
      const res = await api.get<ApiResponse<RecentCallLog>>(`/calls/${callId}`);
      return res.data.data ?? null;
    },
    enabled: !!callId,
    staleTime: 60_000,
  });

/** Format seconds → "2m 34s" or "45s" */
export function fmtDuration(seconds: number): string {
  if (!seconds || seconds < 1) return "0s";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Format ISO to readable date+time GST (AED, UTC+4) */
export function fmtCallTime(iso: string): string {
  return new Date(iso).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   3CX calls with leads (2026-10-14) — synced from 3CX's call log every minute
   (backend services/callSyncService.ts). The Calls page and a lead's Calls
   section read only these; the call_logs above stay for QC and old pages.
──────────────────────────────────────────────────────────────────────────── */

export type CallResultStatus = "answered" | "missed" | "no_answer";

export interface ThreecxCall {
  id:          string;
  startedAt:   string;
  direction:   "in" | "out";
  status:      CallResultStatus;
  talkSeconds: number;
  ringSeconds: number;
  number:      string;
  extension:   string;
  agentName:   string;
  userId:      string;
  userName:    string;
  /** u:<userId>, x:<extension>, or "-" (nobody took it) — the person filter's value. */
  person:      string;
  leadId:      string;
  leadName:    string;
  leadPhone:   string;
  recordings:  number;
  reason:      string;
}

export interface CallStats {
  total: number; incoming: number; outgoing: number; connected: number; missed: number; notAnswered: number;
  talkSeconds: number; averageTalkSeconds: number; recorded: number;
}

export interface CallPersonRow extends CallStats {
  key: string; userId: string; extension: string; name: string;
}

export interface ThreecxStatus {
  connected: boolean;
  updatedAt: string | null;
  firstImportDone: boolean;
  running: boolean;
  backfillDays: number;
  error: { at: string; message: string } | null;
}

export interface CallLogFilters {
  preset?:    "today" | "7d" | "30d" | "month" | "custom";
  from?:      string;
  to?:        string;
  direction?: "in" | "out" | "";
  result?:    "connected" | "missed" | "not_answered" | "";
  person?:    string;
  search?:    string;
  sort?:      "date" | "talk" | "ring";
  order?:     "asc" | "desc";
  page?:      number;
  limit?:     number;
}

export interface CallLogResponse {
  calls:      ThreecxCall[];
  pagination: { total: number; page: number; limit: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean };
  stats:      CallStats;
  people:     CallPersonRow[];
  period:     { from: string; to: string };
  threecx:    ThreecxStatus;
  canSync:    boolean;
}

function callLogParams(f: CallLogFilters): Record<string, string> {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== null) p[k] = String(v);
  if (f.preset && f.preset !== "custom") { delete p.from; delete p.to; }
  return p;
}

export const useCallLog = (filters: CallLogFilters) =>
  useQuery({
    queryKey: ["calls", "log", filters],
    queryFn: async () => {
      const res = await api.get<ApiResponse<CallLogResponse>>("/calls/log", { params: callLogParams(filters) });
      return res.data.data!;
    },
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });

/** Every matching call (up to 5,000) for the CSV. */
export async function fetchCallLogForExport(filters: CallLogFilters): Promise<ThreecxCall[]> {
  const res = await api.get<ApiResponse<CallLogResponse>>("/calls/log", {
    params: { ...callLogParams(filters), page: "1", limit: "5000", export: "1" },
  });
  return res.data.data?.calls ?? [];
}

export const useLeadCallLog = (leadId: string) =>
  useQuery({
    queryKey: ["calls", "log", "lead", leadId],
    queryFn: async () => {
      const res = await api.get<ApiResponse<{ calls: ThreecxCall[]; stats: CallStats; threecx: ThreecxStatus }>>(`/calls/log/lead/${leadId}`);
      return res.data.data!;
    },
    enabled: !!leadId,
    refetchInterval: 60_000,
  });

/** A 10-minute link to play recording `index` of a call (played through the backend, never from 3CX directly). */
export async function getRecordingLink(callId: string, index: number): Promise<string> {
  const res = await api.get<ApiResponse<{ url: string; expiresIn: number }>>(`/calls/log/${callId}/recording-link`, { params: { index } });
  return res.data.data!.url;
}

/** Super Admin: fetch new calls from 3CX now. */
export const useSyncCallsNow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<ApiResponse<{ inserted?: number; started?: boolean }>>("/calls/log/sync")).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calls", "log"] }),
  });
};

/** One step of Test connection, passed or not, and what it found. */
export interface ThreecxTestStep { name: string; ok: boolean; detail: string }
export interface ThreecxTestResult { ok: boolean; steps: ThreecxTestStep[]; sample?: unknown[]; parsed?: unknown[] }

/** Super Admin: the 3CX connection step by step (POST /calls/log/test), as in Tetra Commission. Changes nothing in 3CX. */
export async function testThreecx(): Promise<ThreecxTestResult> {
  const res = await api.post<ApiResponse<ThreecxTestResult>>("/calls/log/test");
  return res.data.data ?? { ok: false, steps: [{ name: "Test", ok: false, detail: res.data.message || "No answer from the server" }] };
}

/* ── The Call button through 3CX (2026-10-14) ─────────────────────────────── */

/** Whether this person's Call buttons can place a 3CX call (3CX connected and their extension known). */
export interface ClickToCallInfo {
  enabled:      boolean;
  connected:    boolean;
  extension:    string;
  webClientUrl: string;
}

export const useClickToCall = (enabled = true) =>
  useQuery({
    queryKey: ["calls", "click-to-call"],
    queryFn: async () => {
      const res = await api.get<ApiResponse<ClickToCallInfo>>("/calls/click-to-call");
      return res.data.data ?? { enabled: false, connected: false, extension: "", webClientUrl: "" };
    },
    enabled,
    staleTime: 5 * 60_000,
  });

/** A 3CX call just placed: what the call window follows. */
export interface PlacedCall {
  extension:     string;
  dial:          string;
  device:        string;
  leadId:        string;
  leadName:      string;
  callId:        number | null;
  participantId: number | null;
}

/** The caller's own call on their extension, as 3CX has it now (null = not there: not started, or ended). */
export interface MyCallState {
  extension: string;
  devices:   string[];
  participant: {
    id:     number | null;
    status: string;
    stage:  "ringing" | "calling" | "connected" | "other";
    callId: number | null;
    party:  string;
  } | null;
}
