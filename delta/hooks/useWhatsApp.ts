"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";

/*
 * WhatsApp (the user, 2026-10-27: "the commission portal's WhatsApp — we need it here also"): each person links their
 * own WhatsApp with a QR and chats with their leads; a team leader reads their team's chats, the Sales Manager and a
 * Super Admin everyone's. The API is /whatsapp (backend/src/routes/whatsappRoutes.ts).
 */

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "connected";

export interface WAMedia { type: string; mime: string; fileName: string; size: number; url: string }
export interface WAMessage {
  id: string; direction: "in" | "out"; body: string; at: string; senderName: string; sentByName: string; media: WAMedia | null;
  /** Sent by the CRM on its own — an automatic follow-up, its step. */
  auto?: { step: number; of: number } | null;
}
export interface WALead { id: string; name: string; status: string; owner: string }
export interface WAChat {
  chat: string; phone: string; name: string; whatsappName: string; lead: WALead | null;
  last: { body: string; at: string; direction: "in" | "out"; media: string | null }; unread: number; count: number;
}
export interface WAOwner { id: string; name: string; team: string; status: WAStatus; phone: string; messages: number }
export interface WAStatusAnswer { enabled: boolean; canLink: boolean; me: { id: string; name: string; status: WAStatus; phone: string; qr: string }; owners: WAOwner[] }
/** Where a lead's automatic follow-ups stand (api services/whatsapp/followups.ts). */
export interface WAFollowup {
  on: boolean;
  state: "off" | "ended" | "no_chat" | "replied" | "before" | "stopped" | "done" | "waiting";
  step?: number; of?: number; nextAt?: string; sent?: number; byName?: string; ownerName?: string; linked?: boolean;
}
export interface WAFollowupStep { waitMinutes: number; text: string; file: { file: string; name: string; mime: string; size: number } | null }
export interface WAFollowupSettings {
  enabled: boolean; startedAt: string | null; teams: string[]; dailyLimit: number; steps: WAFollowupStep[];
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
    refetchInterval: 5000,
  });
}

export function useWhatsAppMessages(ownerId: string, chat: string) {
  return useQuery({
    queryKey: ["whatsapp", "messages", ownerId, chat],
    queryFn: async () => data<{ canSend: boolean; messages: WAMessage[] }>(await api.get("/whatsapp/messages", { params: { ownerId, chat } })),
    enabled: !!ownerId && !!chat,
    refetchInterval: 3000,
  });
}

/** Your own unread count — the menu's badge. */
export function useWhatsAppUnread(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "unread"],
    queryFn: async () => data<{ unread: number }>(await api.get("/whatsapp/unread")).unread,
    enabled,
    refetchInterval: 20000,
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

export function useWhatsAppSend() {
  const refresh = useRefresh();
  return {
    text: useMutation({
      mutationFn: async (v: { chat: string; text: string }) => data<{ chat: string }>(await api.post("/whatsapp/send", v)),
      onSuccess: refresh,
    }),
    file: useMutation({
      mutationFn: async (v: { chat: string; file: File; caption: string; voice?: boolean }) => {
        const form = new FormData();
        form.append("chat", v.chat);
        form.append("caption", v.caption);
        form.append("file", v.file);
        if (v.voice) form.append("voice", "1");
        return data<{ chat: string }>(await api.post("/whatsapp/send-file", form, { headers: { "Content-Type": "multipart/form-data" } }));
      },
      onSuccess: refresh,
    }),
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
    mutationFn: async (v: Pick<WAFollowupSettings, "enabled" | "teams" | "dailyLimit" | "steps">) => data<WAFollowupSettings>(await api.put("/whatsapp/followups/settings", v)),
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
