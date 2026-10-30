"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";

/*
 * WhatsApp (the user, 2026-10-27: "the CS Portal's WhatsApp — we need it here also"): each person links their
 * own WhatsApp with a QR and chats with their leads; a team leader reads their team's chats, the Sales Manager and a
 * Super Admin everyone's. The API is /whatsapp (backend/src/routes/whatsappRoutes.ts).
 */

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

export interface WAMedia { type: string; mime: string; fileName: string; size: number; url: string }
export interface WAMessage {
  id: string; direction: "in" | "out"; body: string; at: string; senderName: string; sentByName: string; media: WAMedia | null;
  /** Sent by the CRM on its own — an automatic follow-up, its step. */
  auto?: { kind?: "followup" | "first_reply"; step: number; of: number } | null;
  /** Sent by a person: forwarded from another chat (2026-10-28). */
  forwarded?: boolean;
  /** Sent by a person from the saved messages — which one. */
  saved?: { kind?: "followup" | "first_reply"; step: number } | null;
  /** Only on this screen, before the server has it: on its way, or it didn't go (and why). */
  pending?: "sending" | "failed";
  failedReason?: string;
}
export interface WALead { id: string; name: string; status: string; owner: string }
export interface WAChat {
  chat: string; phone: string; name: string; whatsappName: string; lead: WALead | null;
  last: { body: string; at: string; direction: "in" | "out"; media: string | null }; unread: number; count: number;
  /** A student — marked so, or enrolled (2026-10-30): no automatic messages. */
  student?: "marked" | "enrolled" | null;
}
export interface WAOwner { id: string; name: string; team: string; status: WAStatus; phone: string; messages: number }
export interface WAStatusAnswer { enabled: boolean; canLink: boolean; me: { id: string; name: string; status: WAStatus; phone: string; qr: string }; owners: WAOwner[] }
/** Where a lead's automatic follow-ups stand (api services/whatsapp/followups.ts). */
export interface WAFollowup {
  on: boolean;
  state: "off" | "ended" | "student" | "no_chat" | "replied" | "before" | "stopped" | "done" | "waiting";
  step?: number; of?: number; nextAt?: string; sent?: number; byName?: string; ownerName?: string; linked?: boolean;
}
/** `url`: to look at or listen to it (Settings only, a short-lived link). */
export interface WAFollowupStep { waitMinutes: number; text: string; file: { file: string; name: string; mime: string; size: number; url?: string } | null }
export interface WAFirstReplyItem { text: string; file: WAFollowupStep["file"]; voice: boolean }
export interface WAFollowupSettings {
  enabled: boolean; startedAt: string | null; teams: string[]; dailyLimit: number; steps: WAFollowupStep[];
  firstReply: { enabled: boolean; startedAt: string | null; items: WAFirstReplyItem[] };
  updatedByName: string; updatedAt: string | null; allTeams: { id: string; name: string }[];
}
export interface WARecentFollowup {
  id: string; at: string; body: string; step: number; of: number; ownerId: string; ownerName: string; chat: string; phone: string; lead: WALead | null;
}
export interface WALeadCard {
  followup?: WAFollowup;
  numbers: string[]; canSend: boolean; canLink: boolean; linked: boolean; me: string;
  threads: { ownerId: string; ownerName: string; chat: string; phone: string; messages: WAMessage[] }[];
}
export interface WALeadOption { id: string; name: string; phone: string; status: string }

const data = <T,>(r: { data: { data: T } }) => r.data.data;
export function errMsg(e: unknown, fallback: string) {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
}

export function useWhatsAppStatus(enabled = true) {
  return useQuery({
    queryKey: ["whatsapp", "status"],
    queryFn: async () => data<WAStatusAnswer>(await api.get("/whatsapp/status")),
    enabled,
    // Quickly while a QR is waiting to be scanned.
    refetchInterval: (q) => (["connecting", "qr_ready"].includes(q.state.data?.me?.status ?? "") ? 2000 : 15000),
  });
}

export function useWhatsAppChats(ownerId: string) {
  return useQuery({
    queryKey: ["whatsapp", "chats", ownerId],
    queryFn: async () => data<{ ownerId: string; canSend: boolean; chats: WAChat[] }>(await api.get("/whatsapp/chats", { params: { ownerId } })),
    enabled: !!ownerId,
    // A new message refreshes these at once over the socket (whatsapp_message); this is only the fallback.
    refetchInterval: 30_000,
  });
}

export function useWhatsAppMessages(ownerId: string, chat: string) {
  return useQuery({
    queryKey: ["whatsapp", "messages", ownerId, chat],
    queryFn: async () => data<{ canSend: boolean; messages: WAMessage[] }>(await api.get("/whatsapp/messages", { params: { ownerId, chat } })),
    enabled: !!ownerId && !!chat,
    refetchInterval: 15_000,
  });
}

/** Your own unread count — the menu's badge. */
export function useWhatsAppUnread(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "unread"],
    queryFn: async () => data<{ unread: number }>(await api.get("/whatsapp/unread")).unread,
    enabled,
    refetchInterval: 60_000,
  });
}

export function useLeadWhatsApp(leadId: string) {
  return useQuery({
    queryKey: ["whatsapp", "lead", leadId],
    queryFn: async () => data<WALeadCard>(await api.get(`/whatsapp/lead/${leadId}`)),
    enabled: !!leadId,
    refetchInterval: 10000,
    retry: false,
  });
}

export function useWhatsAppLeadOptions(search: string, enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "lead-options", search],
    queryFn: async () => data<WALeadOption[]>(await api.get("/whatsapp/lead-options", { params: { search } })),
    enabled,
    staleTime: 30_000,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["whatsapp"] });
}

export function useWhatsAppLink() {
  const refresh = useRefresh();
  return {
    connect: useMutation({ mutationFn: async () => data(await api.post("/whatsapp/connect")), onSuccess: refresh }),
    disconnect: useMutation({ mutationFn: async () => data(await api.post("/whatsapp/disconnect")), onSuccess: refresh }),
  };
}

/**
 * Sending. The lists refresh after it in the background — not awaited (2026-10-29): waiting for every WhatsApp list
 * on the page to load again held the message box for seconds after each message. A send the server never answers is
 * given up after a minute (a file after five).
 */
export function useWhatsAppSend() {
  const refresh = useRefresh();
  const later = () => { void refresh(); };
  return {
    text: useMutation({
      mutationFn: async (v: { chat: string; text: string }) => data<{ chat: string }>(await api.post("/whatsapp/send", v, { timeout: 60_000 })),
      onSuccess: later,
    }),
    file: useMutation({
      mutationFn: async (v: { chat: string; file: File; caption: string; voice?: boolean }) => {
        const form = new FormData();
        form.append("chat", v.chat);
        form.append("caption", v.caption);
        form.append("file", v.file);
        if (v.voice) form.append("voice", "1");
        return data<{ chat: string }>(await api.post("/whatsapp/send-file", form, { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 }));
      },
      onSuccess: later,
    }),
  };
}

/* ── Forward, and the saved messages sent by hand (2026-10-28) ── */

export interface WAForwardResult { chat: string; ok: boolean; error?: string; sentTo?: string }

/** A message sent again from your own WhatsApp to up to 10 of your chats (or numbers). */
export function useWhatsAppForward() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: { messageId: string; chats: string[] }) =>
      data<{ results: WAForwardResult[] }>(await api.post("/whatsapp/forward", v)),
    onSuccess: refresh,
  });
}

/** The Super Admin's first reply (its parts) and follow-up steps, to pick one and send it now. */
export interface WASavedMessage {
  id: string; kind: "first_reply" | "followup"; step: number; label: string; text: string;
  file: { name: string; mime: string } | null; voice: boolean;
}
export function useWhatsAppSavedMessages(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "saved-messages"],
    queryFn: async () => data<WASavedMessage[]>(await api.get("/whatsapp/saved-messages")),
    enabled,
    staleTime: 30_000,
  });
}
export function useWhatsAppSendSaved() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: { chat: string; id: string }) => data<{ chat: string; parts: number }>(await api.post("/whatsapp/send-saved", v)),
    onSuccess: refresh,
  });
}

/* ── Beside a chat: student or not, and the calls (2026-10-30) ── */

export interface WAChatCall {
  id: string; kind: "3cx" | "logged" | "click"; at: string; direction: "in" | "out"; answered: boolean; status: string;
  talkSeconds: number; by: string; note: string; recordings: number; canDelete?: boolean;
}
export interface WAChatExtras {
  student: { student: boolean; how: "marked" | "enrolled" | null; byName: string; at: string | null };
  calls: { calls: WAChatCall[]; total: number; logged: number; answered: number };
  canEdit: boolean;
}
export function useWhatsAppChatExtras(ownerId: string, chat: string) {
  return useQuery({
    queryKey: ["whatsapp", "extras", ownerId, chat],
    queryFn: async () => data<WAChatExtras>(await api.get("/whatsapp/chat-extras", { params: { ownerId, chat } })),
    enabled: !!ownerId && !!chat,
    refetchInterval: 30_000,
  });
}
export function useWhatsAppChatTools() {
  const refresh = useRefresh();
  const later = () => { void refresh(); };
  return {
    student: useMutation({ mutationFn: async (v: { chat: string; student: boolean }) => data(await api.post("/whatsapp/student", v)), onSuccess: later }),
    logCall: useMutation({ mutationFn: async (v: { chat: string; answered: boolean; note?: string }) => data(await api.post("/whatsapp/calls", v)), onSuccess: later }),
    deleteCall: useMutation({ mutationFn: async (id: string) => data(await api.delete(`/whatsapp/calls/${id}`)), onSuccess: later }),
  };
}

/* ── Automatic follow-ups ── */

/** The Super Admin's settings — only asked for when `enabled` (anyone else is refused). */
export function useWhatsAppFollowupSettings(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "followup-settings"],
    queryFn: async () => data<WAFollowupSettings>(await api.get("/whatsapp/followups/settings")),
    enabled,
    retry: false,
  });
}

export function useSaveWhatsAppFollowupSettings() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: Pick<WAFollowupSettings, "enabled" | "teams" | "dailyLimit" | "steps"> & { firstReply?: { enabled: boolean; items: WAFirstReplyItem[] } }) => data<WAFollowupSettings>(await api.put("/whatsapp/followups/settings", v)),
    onSuccess: refresh,
  });
}

export function useUploadFollowupFile() {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return data<NonNullable<WAFollowupStep["file"]>>(await api.post("/whatsapp/followups/file", form, { headers: { "Content-Type": "multipart/form-data" } }));
    },
  });
}

export function useRecentFollowups(enabled = true) {
  return useQuery({
    queryKey: ["whatsapp", "followups-recent"],
    queryFn: async () => data<WARecentFollowup[]>(await api.get("/whatsapp/followups/recent")),
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });
}

/** For anyone with WhatsApp: whether follow-ups are on (for their teams), the steps; a Super Admin may edit. */
export interface WAFollowupSummary {
  enabled: boolean; canEdit: boolean; myTeams: { name: string; on: boolean }[]; dailyLimit: number;
  steps: { waitMinutes: number; text: string; fileName: string }[];
  firstReply?: { enabled: boolean; items: { text: string; fileName: string; voice: boolean }[] };
}
export function useWhatsAppFollowupSummary() {
  return useQuery({
    queryKey: ["whatsapp", "followup-summary"],
    queryFn: async () => data<WAFollowupSummary>(await api.get("/whatsapp/followups/summary")),
    staleTime: 60_000,
    retry: false,
  });
}

/** "Load older messages": asks your phone for the 50 before the oldest kept in this chat; they land a few seconds later. */
export function useFetchOlderMessages() {
  return useMutation({ mutationFn: async (chat: string) => data<{ before: string }>(await api.post("/whatsapp/history", { chat })) });
}

/** "Load older messages for all chats": the phone asked again for each of your chats, in the background. */
export function useFetchOlderForAll() {
  return useMutation({ mutationFn: async () => data<{ chats: number; seconds: number }>(await api.post("/whatsapp/history-all")) });
}

export function useLeadFollowupStop() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: { leadId: string; stop: boolean }) => data(await api.post(`/whatsapp/followups/lead/${v.leadId}/${v.stop ? "stop" : "resume"}`)),
    onSuccess: refresh,
  });
}

export function useWhatsAppChatActions() {
  const refresh = useRefresh();
  return {
    read: useMutation({ mutationFn: async (chat: string) => data(await api.post("/whatsapp/read", { chat })), onSuccess: refresh }),
    link: useMutation({
      mutationFn: async (v: { ownerId: string; chat: string; leadId: string }) => data<{ lead: { id: string; name: string } }>(await api.post("/whatsapp/link", v)),
      onSuccess: refresh,
    }),
    createLead: useMutation({
      mutationFn: async (v: { ownerId: string; chat: string; name?: string }) =>
        data<{ lead: { id: string; name: string }; existed: boolean }>(await api.post("/whatsapp/create-lead", v)),
      onSuccess: refresh,
    }),
  };
}
