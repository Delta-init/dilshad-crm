"use client";

import { useMemo, useState } from "react";
import { BookmarkCheck, Check, FileText, Image as ImageIcon, Layers, Loader2, Mic, Music, Search, Send, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  errMsg, useWhatsAppChats, useWhatsAppForward, useWhatsAppSavedMessages, useWhatsAppSendSaved,
  type WAMessage, type WASavedMessage,
} from "@/hooks/useWhatsApp";
import { WA_GREEN } from "./waUi";

/* ────────────────────────────────────────────────────────────────────────────
   Forward, and the saved messages sent by hand (the owner, 2026-10-28).
   Both send from your own WhatsApp, as a person — never automatically.
──────────────────────────────────────────────────────────────────────────── */

const MAX_FORWARD = 10;
const preview = (m: WAMessage) => (m.media && /^(📷|🎥|🎵|🎤|🔖|📄) /.test(m.body) ? m.body : m.body || "File");

/**
 * Forward a message: pick up to 10 of your own chats (search by name, lead or number), or type a number, and it goes
 * from your WhatsApp to each — a photo or file with its caption, a voice note as a voice note.
 */
export function ForwardDialog({ message, myId, onClose }: { message: WAMessage | null; myId: string; onClose: () => void }) {
  const { data } = useWhatsAppChats(message ? myId : "");
  const forward = useWhatsAppForward();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const chats = useMemo(() => data?.chats ?? [], [data]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? chats.filter((c) => [c.name, c.whatsappName, c.phone, c.lead?.name].some((v) => String(v || "").toLowerCase().includes(needle)))
    : chats;
  const typedNumber = q.replace(/[^\d+]/g, "").replace(/^\+/, "");
  const canAddNumber = typedNumber.length >= 9 && !chats.some((c) => c.phone && c.phone.slice(-9) === typedNumber.slice(-9));
  const toggle = (chat: string) =>
    setPicked((p) => (p.includes(chat) ? p.filter((x) => x !== chat) : p.length >= MAX_FORWARD ? p : [...p, chat]));
  const close = () => { setPicked([]); setQ(""); onClose(); };
  const send = () => {
    if (!message || !picked.length) return;
    forward.mutate({ messageId: message.id, chats: picked }, {
      onSuccess: (r) => {
        const failed = r.results.filter((x) => !x.ok);
        const sent = r.results.length - failed.length;
        if (failed.length) toast.error(`Forwarded to ${sent}; not to ${failed.length}: ${failed[0]!.error ?? "failed"}`);
        else toast.success(`Forwarded to ${sent} chat${sent === 1 ? "" : "s"}`);
        close();
      },
      onError: (e) => toast.error(errMsg(e, "Not forwarded")),
    });
  };
  const nameOf = (chat: string) => {
    const c = chats.find((x) => x.chat === chat);
    return c ? c.lead?.name || c.name : `+${chat}`;
  };

  return (
    <Dialog open={!!message} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Forward</DialogTitle>
          <DialogDescription className="line-clamp-2 break-words">“{message ? preview(message) : ""}” — sent from your WhatsApp, up to {MAX_FORWARD} chats.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your chats, or type a number" className="pl-8" />
        </div>
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {picked.map((c) => (
              <button key={c} type="button" onClick={() => toggle(c)} className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900/50 dark:text-emerald-100">
                {nameOf(c)} ×
              </button>
            ))}
          </div>
        )}
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border">
          {canAddNumber && (
            <button type="button" onClick={() => { toggle(typedNumber); setQ(""); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
              <Send className="h-4 w-4 text-muted-foreground" /> Send to +{typedNumber}
            </button>
          )}
          {shown.length === 0 && !canAddNumber && <p className="p-4 text-center text-sm text-muted-foreground">No chats match</p>}
          {shown.map((c) => {
            const on = picked.includes(c.chat);
            return (
              <button key={c.chat} type="button" onClick={() => toggle(c.chat)} disabled={!on && picked.length >= MAX_FORWARD}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50", on && "bg-emerald-50 dark:bg-emerald-950/40")}>
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/40")}>
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.lead?.name || c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.phone ? `+${c.phone}` : c.chat}{c.lead ? " · lead" : ""}</span>
                </span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={forward.isPending}>Cancel</Button>
          <Button onClick={send} disabled={!picked.length || forward.isPending} className="gap-1.5 text-white" style={{ backgroundColor: WA_GREEN }}>
            {forward.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Forward{picked.length ? ` to ${picked.length}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The icon for a saved part's file: a voice note, audio (incl. "AUDIO-….m4a.mp4"), a photo, a video, else a document. */
function FileIcon({ m }: { m: WASavedMessage }) {
  if (!m.file) return null;
  const mime = m.file.mime || "";
  const name = m.file.name.toLowerCase();
  if (m.voice) return <Mic className="h-3 w-3" />;
  if (mime.startsWith("audio/") || /\.(m4a|mp3|ogg|opus|wav|aac)(\.mp4)?$/.test(name)) return <Music className="h-3 w-3" />;
  if (mime.startsWith("image/")) return <ImageIcon className="h-3 w-3" />;
  if (mime.startsWith("video/")) return <Video className="h-3 w-3" />;
  return <FileText className="h-3 w-3" />;
}

/**
 * The saved messages, grouped (the owner, 2026-10-28): the first reply — the whole of it at once, or one part — and
 * each follow-up step; picked, it is sent to this chat now with {name} filled in. A person's message: the automatic
 * follow-ups carry on as if it was typed.
 */
export function SavedMessagesButton({ chat, disabled = false, onSent }: { chat: string; disabled?: boolean; onSent?: (chat: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data: list, isLoading } = useWhatsAppSavedMessages(open);
  const send = useWhatsAppSendSaved();
  const [sending, setSending] = useState("");
  const pick = (id: string, label: string) => {
    setSending(id);
    send.mutate({ chat, id }, {
      onSuccess: (r) => { toast.success(`Sent: ${label}`); setOpen(false); onSent?.(r.chat); },
      onError: (e) => toast.error(errMsg(e, "Not sent")),
      onSettled: () => setSending(""),
    });
  };
  const first = (list ?? []).filter((m) => m.kind === "first_reply");
  const steps = (list ?? []).filter((m) => m.kind === "followup");
  const row = (m: WASavedMessage, label: string) => (
    <button key={m.id} type="button" onClick={() => pick(m.id, m.label)} disabled={!!sending}
      className="block w-full border-b py-2 pl-5 pr-3 text-left last:border-0 hover:bg-muted disabled:opacity-60">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        {sending === m.id && <Loader2 className="h-3 w-3 animate-spin" />}
        {label}
        <FileIcon m={m} />
      </span>
      {m.text && <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap text-sm">{m.text}</span>}
      {m.file && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{m.voice ? "Voice note" : m.file.name}</span>}
    </button>
  );
  const heading = (text: string) => <p className="sticky top-0 z-10 border-b bg-muted px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{text}</p>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" disabled={disabled} aria-label="Saved messages" title="Send a saved message (first reply or a follow-up)">
          <BookmarkCheck className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0">
        <p className="border-b px-3 py-2 text-xs font-semibold">Saved messages · sent now from your WhatsApp</p>
        <div className="max-h-96 overflow-y-auto">
          {isLoading && <p className="p-4 text-center text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && !list?.length && <p className="p-4 text-center text-sm text-muted-foreground">No saved messages yet — a Super Admin sets them in WhatsApp follow-ups.</p>}
          {first.length > 0 && (
            <>
              {heading("First reply")}
              {/* The whole of it, in order, a few seconds apart — as the automatic first reply goes */}
              {first.length > 1 && (
                <button type="button" onClick={() => pick("first_reply:all", "the whole first reply")} disabled={!!sending}
                  className="flex w-full items-center gap-2 border-b bg-emerald-50 px-3 py-2.5 text-left text-sm font-semibold hover:bg-emerald-100 disabled:opacity-60 dark:bg-emerald-950/40 dark:hover:bg-emerald-950/70">
                  {sending === "first_reply:all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />}
                  <span className="flex-1">Send the whole first reply <span className="font-normal text-muted-foreground">· all {first.length} parts, in order</span></span>
                </button>
              )}
              {first.map((m) => row(m, first.length > 1 ? `Part ${m.step} of ${first.length}` : "First reply"))}
            </>
          )}
          {steps.length > 0 && (
            <>
              {heading("Follow-ups")}
              {steps.map((m) => row(m, m.label.replace(/^Follow-up /, "Step ")))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
