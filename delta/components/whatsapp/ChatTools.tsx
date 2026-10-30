"use client";

import { useState } from "react";
import { GraduationCap, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { getRecordingLink } from "@/hooks/useCalls";
import { errMsg, useWhatsAppChatExtras, useWhatsAppChatTools, type WAChatCall } from "@/hooks/useWhatsApp";

/* ────────────────────────────────────────────────────────────────────────────
   Beside a WhatsApp chat (the owner, 2026-10-30): whether the person is a
   student — no automatic first reply or follow-ups go to a student — and their
   calls, with a call logged by hand (it counts like a call from the Call button).
──────────────────────────────────────────────────────────────────────────── */

const fmtTalk = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The badge in the chat list: a student. */
export function StudentBadge({ how }: { how?: "marked" | "enrolled" | null }) {
  if (!how) return null;
  return (
    <span title={how === "enrolled" ? "Enrolled" : "Marked a student"} className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
      <GraduationCap className="h-3 w-3" />Student
    </span>
  );
}

/** The chat header's tools: Student, Log a call, Calls (n). */
export function ChatTools({ ownerId, chat }: { ownerId: string; chat: string }) {
  const { data } = useWhatsAppChatExtras(ownerId, chat);
  const tools = useWhatsAppChatTools();
  const [callsOpen, setCallsOpen] = useState(false);
  if (!data) return null;
  const s = data.student;

  const toggleStudent = async () => {
    try {
      await tools.student.mutateAsync({ chat, student: !(s.how === "marked") });
      toast.success(s.how === "marked" ? "Not a student any more — automatic messages can go again" : "Marked a student — no automatic first reply or follow-ups");
    } catch (e) { toast.error(errMsg(e, "Not changed")); }
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* Student: marked here, or enrolled (then always) */}
      {s.how === "enrolled" ? (
        <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400" title="Enrolled — a student, no automatic messages">
          <GraduationCap className="h-3.5 w-3.5" />Student
        </Badge>
      ) : data.canEdit ? (
        <Button variant="outline" size="sm" disabled={tools.student.isPending} onClick={() => void toggleStudent()}
          className={cn("h-8 gap-1", s.student && "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}
          title={s.student ? `Marked a student${s.byName ? ` by ${s.byName}` : ""} — click to undo` : "Mark a student: no automatic first reply or follow-ups"}>
          {tools.student.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GraduationCap className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{s.student ? "Student ✓" : "Student?"}</span>
        </Button>
      ) : s.student ? (
        <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"><GraduationCap className="h-3.5 w-3.5" />Student</Badge>
      ) : null}

      {data.canEdit && <LogCallButton chat={chat} />}

      <Button variant="ghost" size="sm" className="h-8 gap-1 px-2" onClick={() => setCallsOpen(true)} title="Their calls">
        <Phone className="h-3.5 w-3.5" />{data.calls.total}
      </Button>
      <CallsDialog open={callsOpen} onOpenChange={setCallsOpen} calls={data.calls} />
    </div>
  );
}

/** Log a call by hand: answered or not, and a note. Counts like a call made from the CRM. */
function LogCallButton({ chat }: { chat: string }) {
  const tools = useWhatsAppChatTools();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const log = async (answered: boolean) => {
    try {
      await tools.logCall.mutateAsync({ chat, answered, note: note.trim() || undefined });
      toast.success(answered ? "Call logged — answered" : "Call logged — no answer");
      setNote(""); setOpen(false);
    } catch (e) { toast.error(errMsg(e, "Not logged")); }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1" title="Log a call you made to them (counts as a call)">
          <PhoneOutgoing className="h-3.5 w-3.5" /><span className="hidden sm:inline">Log call</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <p className="text-xs font-semibold">Log a call you made · now</p>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} placeholder="Note (optional) — what was said" className="text-sm" />
        <div className="flex gap-2">
          <Button size="sm" className="flex-1 gap-1 bg-emerald-600 text-white hover:bg-emerald-700" disabled={tools.logCall.isPending} onClick={() => void log(true)}>
            {tools.logCall.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneOutgoing className="h-3.5 w-3.5" />}Answered
          </Button>
          <Button size="sm" variant="outline" className="flex-1 gap-1" disabled={tools.logCall.isPending} onClick={() => void log(false)}>
            <PhoneMissed className="h-3.5 w-3.5" />No answer
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Their calls: 3CX's (with recordings), the Call button's, and those logged by hand. */
function CallsDialog({ open, onOpenChange, calls }: { open: boolean; onOpenChange: (o: boolean) => void; calls: { calls: WAChatCall[]; total: number; logged: number; answered: number } }) {
  const tools = useWhatsAppChatTools();
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const play = async (c: WAChatCall) => {
    try { setPlaying({ id: c.id, url: await getRecordingLink(c.id, 0) }); } catch (e) { toast.error(errMsg(e, "No recording")); }
  };
  const remove = async (c: WAChatCall) => {
    try { await tools.deleteCall.mutateAsync(c.id); toast.success("Logged call taken off"); } catch (e) { toast.error(errMsg(e, "Not taken off")); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Calls · {calls.total}</DialogTitle>
          <DialogDescription>{calls.answered} answered{calls.logged ? ` · ${calls.logged} logged by hand` : ""} — 3CX, the Call button, and calls logged here</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {calls.calls.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No calls yet</p>}
          {calls.calls.map((c) => (
            <div key={`${c.kind}-${c.id}`} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                {c.direction === "in" ? <PhoneIncoming className="h-4 w-4 text-blue-500" /> : c.answered ? <PhoneOutgoing className="h-4 w-4 text-emerald-500" /> : <PhoneMissed className="h-4 w-4 text-orange-500" />}
                <span className="font-medium">{c.direction === "in" ? "Incoming" : "Outgoing"} · {c.answered ? "answered" : c.status === "missed" ? "missed" : "no answer"}</span>
                {c.answered && c.talkSeconds > 0 && <span className="text-xs text-muted-foreground">{fmtTalk(c.talkSeconds)}</span>}
                <span className="ml-auto text-xs text-muted-foreground">{when(c.at)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{c.by || "—"}</span>
                <span>· {c.kind === "logged" ? "logged by hand" : c.kind === "click" ? "Call button" : "3CX"}</span>
                {c.recordings > 0 && (
                  <button type="button" onClick={() => void play(c)} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"><Play className="h-3 w-3" />Recording</button>
                )}
                {c.canDelete && (
                  <button type="button" onClick={() => void remove(c)} className="ml-auto inline-flex items-center gap-1 text-rose-600 hover:underline" title="Take this logged call off (Super Admin)"><Trash2 className="h-3 w-3" />Take off</button>
                )}
              </div>
              {c.note && <p className="mt-1 whitespace-pre-wrap text-xs">{c.note}</p>}
              {playing?.id === c.id && <audio src={playing.url} controls autoPlay className="mt-1.5 h-9 w-full" />}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
