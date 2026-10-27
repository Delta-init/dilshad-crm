"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, Link2, Loader2, Maximize2, MessageCircle, Minimize2, Plus, Search, Smartphone, Unlink, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Composer, shortTime, Thread, WA_GREEN } from "@/components/whatsapp/waUi";
import {
  errMsg, useWhatsAppChatActions, useWhatsAppChats, useWhatsAppLeadOptions, useWhatsAppLink, useWhatsAppMessages, useWhatsAppSend,
  useWhatsAppStatus, type WAChat, type WALeadOption, type WAStatusAnswer,
} from "@/hooks/useWhatsApp";
import { RecentFollowups } from "@/components/whatsapp/RecentFollowups";

/* ────────────────────────────────────────────────────────────────────────────
   WhatsApp (2026-10-27, as in Tetra Commission): each person links their own
   WhatsApp here (a QR, as WhatsApp Web) and chats with their leads; a team
   leader, the Sales Manager or a Super Admin picks one of their people and
   reads theirs. backend/src/routes/whatsappRoutes.ts.
──────────────────────────────────────────────────────────────────────────── */

const fmtPhone = (p: string) => (p ? `+${p}` : "");
const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  connected: { label: "Linked", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500", dot: "bg-emerald-500" },
  qr_ready: { label: "Scan the QR", cls: "border-amber-500/40 bg-amber-500/10 text-amber-500", dot: "bg-amber-500" },
  connecting: { label: "Starting…", cls: "border-sky-500/40 bg-sky-500/10 text-sky-500", dot: "bg-sky-500" },
  disconnected: { label: "Not linked", cls: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};
/** A number as WhatsApp wants it — as toIntl() in the API: local UAE (5x…, 05x…) and Indian mobiles get their country code. */
function toIntl(raw: string) {
  let d = String(raw || "").replace(/\D/g, "").replace(/^00/, "");
  if (/^05\d{8}$/.test(d)) d = `971${d.slice(1)}`;
  else if (/^5\d{8}$/.test(d)) d = `971${d}`;
  else if (/^[6-9]\d{9}$/.test(d)) d = `91${d}`;
  return d;
}
const numbersOf = (phone: string) => Array.from(new Set(String(phone || "").split(/[\n\r/,;|]+| - /).map(toIntl).filter((x) => x.length >= 9)));

function LinkPanel({ me }: { me: WAStatusAnswer["me"] }) {
  const { connect, disconnect } = useWhatsAppLink();
  const busy = connect.isPending || disconnect.isPending;
  const s = STATUS[me.status] ?? STATUS.disconnected!;
  const run = (m: typeof connect) => m.mutate(undefined, { onError: (e) => toast.error(errMsg(e, "WhatsApp did not answer")) });
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border/50 bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex flex-1 items-start gap-3">
        <div className="rounded-full p-2" style={{ backgroundColor: `${WA_GREEN}22` }}><Smartphone className="h-5 w-5" style={{ color: WA_GREEN }} /></div>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">Your WhatsApp</p>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", s.cls)}>{s.label}</span>
            {me.status === "connected" && <span className="text-sm text-muted-foreground">{fmtPhone(me.phone)}</span>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {me.status === "connected"
              ? "Messages to and from your leads show here and on their pages. Your phone stays your WhatsApp — this is one of its linked devices."
              : me.status === "qr_ready"
                ? "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code."
                : "Link your own WhatsApp to chat with your leads from the CRM — normal one-to-one messages."}
          </p>
        </div>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {me.status === "qr_ready" && me.qr && <img src={me.qr} alt="WhatsApp QR code" className="h-48 w-48 self-center rounded-lg border bg-white p-1" />}
      {me.status === "connecting" && <Loader2 className="h-6 w-6 animate-spin self-center text-sky-500" />}
      <div className="flex gap-2 self-center">
        {me.status === "connected"
          ? <Button variant="outline" disabled={busy} onClick={() => confirm("Unlink your WhatsApp from the CRM? Your chats so far stay here.") && run(disconnect)}><Unlink className="mr-1 h-4 w-4" />Unlink</Button>
          : me.status === "disconnected"
            ? <Button disabled={busy} className="text-white" style={{ backgroundColor: WA_GREEN }} onClick={() => run(connect)}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Smartphone className="mr-1 h-4 w-4" />}Link WhatsApp</Button>
            : <Button variant="ghost" disabled={busy} onClick={() => run(disconnect)}>Cancel</Button>}
      </div>
    </div>
  );
}

/** Leads you may link a chat to or message — by name or number, as you type. */
function LeadSearch({ onPick, placeholder }: { onPick: (l: WALeadOption) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const { data: options = [], isFetching } = useWhatsAppLeadOptions(term, term.length >= 2);
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-9 pl-8" />
        {isFetching && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {term.length >= 2 && (
        <div className="max-h-56 overflow-y-auto rounded-md border bg-card">
          {options.length === 0 && !isFetching && <p className="p-2 text-xs text-muted-foreground">No lead of yours matches</p>}
          {options.map((o) => (
            <button key={o.id} type="button" onClick={() => { onPick(o); setQ(""); }} className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted">
              <span className="truncate">{o.name || "No name"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{o.phone}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkLeadDialog({ open, onOpenChange, ownerId, chat }: { open: boolean; onOpenChange: (o: boolean) => void; ownerId: string; chat: WAChat | null }) {
  const { link } = useWhatsAppChatActions();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link this chat to a lead</DialogTitle>
          <DialogDescription>
            {chat?.whatsappName || chat?.name} {chat?.phone ? `(${fmtPhone(chat.phone)})` : ""} — this number is on no lead&apos;s record. Its messages, earlier and later, will show under the lead.
          </DialogDescription>
        </DialogHeader>
        <LeadSearch placeholder="Name or number of the lead…" onPick={(l) => {
          if (!chat) return;
          link.mutate({ ownerId, chat: chat.chat, leadId: l.id }, {
            onSuccess: (r) => { toast.success(`Linked to ${r.lead.name || "the lead"}`); onOpenChange(false); },
            onError: (e) => toast.error(errMsg(e, "Could not link")),
          });
        }} />
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={link.isPending}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppPage() {
  const params = useSearchParams();
  const { data: st, isLoading } = useWhatsAppStatus();
  const [ownerId, setOwnerId] = useState("");
  const [chatId, setChatId] = useState("");
  // A WhatsApp notification opens its chat (/whatsapp?chat=…), also when the page is already open.
  useEffect(() => {
    const c = params.get("chat");
    if (c) { setOwnerId(""); setChatId(c); }
  }, [params]);
  const [q, setQ] = useState("");
  const [newNumber, setNewNumber] = useState<string | null>(null);
  const [draft, setDraft] = useState<WAChat | null>(null);          // a chat started from a lead, before its first message
  const [picking, setPicking] = useState<{ lead: WALeadOption; numbers: string[] } | null>(null);
  const [linking, setLinking] = useState(false);
  // Full screen: the chats and the chat fill the window — the browser's own full screen where it has one; Esc leaves.
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    if (!full) { setFull(true); document.documentElement.requestFullscreen?.().catch(() => {}); }
    else { setFull(false); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
  };
  useEffect(() => {
    if (!full) return undefined;
    const left = () => { if (!document.fullscreenElement) setFull(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", left);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("fullscreenchange", left); window.removeEventListener("keydown", esc); };
  }, [full]);
  useEffect(() => () => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }, []);

  const owners = st?.owners ?? [];
  const viewing = ownerId || (st?.canLink ? st?.me?.id : owners[0]?.id) || "";
  const mine = !!st && viewing === st.me?.id;
  const { data: chatsData } = useWhatsAppChats(viewing);
  const chats = useMemo(() => chatsData?.chats ?? [], [chatsData]);
  const chat: WAChat | null = chats.find((c) => c.chat === chatId) ?? (draft?.chat === chatId ? draft : null)
    ?? (chatId ? { chat: chatId, phone: /^\d+$/.test(chatId) ? chatId : "", name: /^\d+$/.test(chatId) ? `+${chatId}` : chatId, whatsappName: "", lead: null, last: { body: "", at: "", direction: "out", media: null }, unread: 0, count: 0 } : null);
  const { data: thread } = useWhatsAppMessages(viewing, chatId);
  const { read, createLead } = useWhatsAppChatActions();
  const send = useWhatsAppSend();

  /** Their chat if there is one (with the lead, or on one of their numbers), else a new one on their number. */
  const openLead = (l: WALeadOption) => {
    const nums = numbersOf(l.phone);
    const existing = chats.find((c) => c.lead?.id === l.id) ?? chats.find((c) => c.phone && nums.some((n) => n.slice(-9) === c.phone.slice(-9)));
    setPicking(null);
    if (existing) { setChatId(existing.chat); return; }
    if (!nums.length) { toast.error(`No phone number on ${l.name}'s record`); return; }
    if (nums.length > 1) { setPicking({ lead: l, numbers: nums }); return; }
    startDraft(l, nums[0]!);
  };
  const startDraft = (l: WALeadOption, number: string) => {
    setDraft({ chat: number, phone: number, name: l.name, whatsappName: "", lead: { id: l.id, name: l.name, status: l.status, owner: "" }, last: { body: "", at: "", direction: "out", media: null }, unread: 0, count: 0 });
    setChatId(number);
    setPicking(null);
  };

  // Opening your own chat reads it (someone else reading it leaves it unread for its owner).
  useEffect(() => {
    if (mine && chat && chat.unread > 0) read.mutate(chat.chat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, chat?.chat, chat?.unread]);

  const sendText = async (text: string) => {
    if (!chat) return;
    try {
      const r = await send.text.mutateAsync({ chat: chat.chat, text });
      if (r?.chat && r.chat !== chatId) setChatId(r.chat);
    } catch (e) { toast.error(errMsg(e, "Not sent")); throw e; }
  };
  const sendFile = async (file: File, caption: string, voice = false) => {
    if (!chat) return;
    try {
      const r = await send.file.mutateAsync({ chat: chat.chat, file, caption, voice });
      if (r?.chat && r.chat !== chatId) setChatId(r.chat);
    } catch (e) { toast.error(errMsg(e, "Not sent")); throw e; }
  };
  const makeLead = () => {
    if (!chat) return;
    createLead.mutate({ ownerId: viewing, chat: chat.chat }, {
      onSuccess: (r) => toast.success(r.existed ? `Already a lead — linked to ${r.lead.name}` : `Lead created: ${r.lead.name}`),
      onError: (e) => toast.error(errMsg(e, "Could not make a lead")),
    });
  };

  const needle = q.trim().toLowerCase();
  const shown = needle ? chats.filter((c) => [c.name, c.whatsappName, c.phone, c.lead?.name].some((v) => String(v || "").toLowerCase().includes(needle))) : chats;
  const canSend = mine && !!chatsData?.canSend;

  if (isLoading || !st) return <div className="p-8 text-center text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center gap-2">
          <MessageCircle className="h-6 w-6" style={{ color: WA_GREEN }} />
          <h2 className="text-2xl font-bold">WhatsApp</h2>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {st.canLink ? "Chat with your leads from your own WhatsApp." : "The WhatsApp chats of the people you look after — read only; each sends from their own WhatsApp."}
        </p>
      </motion.div>

      {!st.enabled && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-500">WhatsApp is switched off on this server.</div>}
      {st.enabled && st.canLink && <LinkPanel me={st.me} />}

      {owners.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Whose WhatsApp</span>
          <Select value={viewing} onValueChange={(v) => { setOwnerId(v); setChatId(""); }}>
            <SelectTrigger className="w-80"><SelectValue placeholder="Choose someone" /></SelectTrigger>
            <SelectContent>
              {owners.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  <span className="inline-flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", (STATUS[o.status] ?? STATUS.disconnected!).dot)} />
                    {o.name}{o.team ? ` · ${o.team}` : ""}{o.messages ? ` · ${o.messages} messages` : ""}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {viewing && (
        <div className={cn("overflow-hidden rounded-xl border border-border/50 bg-card", full && "fixed inset-0 z-50 !m-0 rounded-none border-0")}>
          <div className={cn("grid grid-cols-1 md:grid-cols-[340px_1fr]", full ? "h-full" : "h-[70vh] min-h-[480px]")}>
            {/* Chats */}
            <div className={cn("min-h-0 flex-col border-r", chat ? "hidden md:flex" : "flex")}>
              <div className="space-y-2 border-b p-3">
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number" className="h-9 pl-8" />
                  </div>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"}>
                    {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                </div>
                {mine && st.canLink && (
                  <>
                    <LeadSearch placeholder="Message a lead…" onPick={openLead} />
                    {picking && (
                      <div className="rounded-md border bg-muted/50 p-2 text-xs">
                        <p className="mb-1.5 text-muted-foreground">{picking.lead.name} has {picking.numbers.length} numbers — which one?</p>
                        <div className="flex flex-wrap gap-1.5">
                          {picking.numbers.map((n) => <Button key={n} size="sm" variant="outline" className="h-7 text-xs" onClick={() => startDraft(picking.lead, n)}>+{n}</Button>)}
                        </div>
                      </div>
                    )}
                    {canSend && (newNumber === null
                      ? <button type="button" className="text-xs text-primary hover:underline" onClick={() => setNewNumber("")}><Plus className="mr-0.5 inline h-3 w-3" />or type a number</button>
                      : (
                        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const d = toIntl(newNumber); if (d.length >= 9) { setChatId(d); setNewNumber(null); } }}>
                          <Input autoFocus value={newNumber} onChange={(e) => setNewNumber(e.target.value)} placeholder="Number with country code" className="h-8" />
                          <Button type="submit" size="sm" className="h-8">Open</Button>
                        </form>
                      ))}
                  </>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {shown.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{chats.length ? "No match" : mine && st.me.status !== "connected" ? "Link your WhatsApp to start" : "No chats yet"}</p>}
                {shown.map((c) => (
                  <button key={c.chat} type="button" onClick={() => setChatId(c.chat)}
                    className={cn("flex w-full items-start gap-3 border-b px-3 py-2.5 text-left hover:bg-muted/60", c.chat === chatId && "bg-emerald-500/10")}>
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">{(c.name || "?").replace(/^\+/, "").charAt(0).toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <span className={cn("shrink-0 text-[11px]", c.unread ? "font-semibold text-emerald-500" : "text-muted-foreground")}>{shortTime(c.last?.at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs text-muted-foreground">{c.last?.direction === "out" ? "✓ " : ""}{c.last?.body}</p>
                        {c.unread > 0 && <span className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-white" style={{ backgroundColor: WA_GREEN }}>{c.unread}</span>}
                      </div>
                      {c.lead
                        ? <p className="truncate text-[11px] text-muted-foreground">Lead · {c.lead.status}{c.phone ? ` · ${fmtPhone(c.phone)}` : ""}</p>
                        : <p className="text-[11px] text-amber-500">Not a lead{c.phone ? ` · ${fmtPhone(c.phone)}` : ""}</p>}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* The chat */}
            <div className={cn("min-h-0 flex-col", chat ? "flex" : "hidden md:flex")}>
              {!chat ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <MessageCircle className="h-10 w-10" style={{ color: WA_GREEN }} />
                  <p className="text-sm">Choose a chat</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 border-b px-3 py-2">
                    <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => setChatId("")} aria-label="Back"><ArrowLeft className="h-4 w-4" /></Button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{chat.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {fmtPhone(chat.phone)}{chat.whatsappName && chat.whatsappName !== chat.name ? ` · on WhatsApp: ${chat.whatsappName}` : ""}
                      </p>
                    </div>
                    {chat.lead && (
                      <Link href={`/leads/${chat.lead.id}`} className="hidden sm:block"><Badge variant="outline" className="hover:bg-muted">Open lead</Badge></Link>
                    )}
                    {!chat.lead && (thread?.messages?.length ?? 0) > 0 && st.canLink && (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setLinking(true)}><Link2 className="mr-1 h-4 w-4" />Link to a lead</Button>
                        <Button variant="outline" size="sm" disabled={createLead.isPending || !chat.phone} onClick={makeLead} title={chat.phone ? "" : "WhatsApp didn't give this chat's number"}>
                          {createLead.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserPlus className="mr-1 h-4 w-4" />}Make a lead
                        </Button>
                      </>
                    )}
                    {/* On a phone the chat list (with its own button) is hidden while a chat is open. */}
                    <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"}>
                      {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                    </Button>
                  </div>
                  <Thread messages={thread?.messages ?? []} className="min-h-0 flex-1" empty={canSend ? "Write the first message" : "No messages yet"} />
                  {canSend
                    ? <Composer onSendText={sendText} onSendFile={sendFile} />
                    : <p className="border-t bg-muted/50 p-3 text-center text-xs text-muted-foreground">{mine ? "Link your WhatsApp to reply" : "Read only — they reply from their own WhatsApp"}</p>}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {owners.length === 0 && !st.canLink && (
        <div className="rounded-xl border border-border/50 bg-card p-6 text-center text-sm text-muted-foreground">Nobody you look after has linked WhatsApp yet.</div>
      )}

      {/* The follow-ups the CRM sent on its own (Settings → WhatsApp follow-ups) */}
      {!full && <RecentFollowups />}

      <LinkLeadDialog open={linking} onOpenChange={setLinking} ownerId={viewing} chat={chat} />
    </div>
  );
}

export default function WhatsAppRoute() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
      <WhatsAppPage />
    </Suspense>
  );
}
