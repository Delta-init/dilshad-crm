"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, PhoneCall, PhoneOff, Smartphone, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CloseLeadDialog } from "@/components/students/CloseLeadDialog";
import { LOST_REASONS } from "@/components/leads/LostReasonModal";
import { useLead } from "@/hooks/useLeads";
import { useClickToCall, type MyCallState, type PlacedCall } from "@/hooks/useCalls";
import { useAuthStore } from "@/lib/store/authStore";
import { LEAD_STATUSES, STATUS_META, type LeadStatus } from "@/lib/statusConfig";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";

/* ────────────────────────────────────────────────────────────────────────────
   Call, then say how it went — CS Portal's call flow
   (frontend/src/components/followups/CallFlow.jsx there), for leads; the
   Draw CRM's, brought here 2026-10-14. One set of dialogs for the whole app,
   mounted by the dashboard layout; every Call button (ClickToCall) goes
   through it.

     1. Call pressed: "3CX call" (when 3CX is connected and the caller's
        extension is known) — 3CX rings their own 3CX app / web client, they
        answer, and 3CX dials the lead — or "Phone call" (tel:).
     2. A 3CX call: the call window follows it from 3CX (ringing, calling,
        connected with a timer, ended) and can hang up.
     3. After the call (it ended, "Log call" pressed, or a phone call chosen):
        "How did the call go?" — connected yes / no, the lead's next status
        with what this CRM asks for it (Follow Up: what happened, and the next
        follow-up if any — picked again on a lead already in Follow Up, one
        more follow-up; Meeting Scheduled: when; Call Back: a reminder if
        wanted; Lost: one of its reasons and notes; Closed through the
        enrolment dialog; any other status as it is), and notes, saved as a
        lead note (with its activity). It can be put aside ("Later"): the pending one is
        kept in this tab (sessionStorage, 30 minutes) and opens again after a
        reload. Only for calls started here, and only for someone who may edit
        leads.

   The counts on the lead (calls / connected / not connected) come from 3CX by
   themselves; nothing here counts.
──────────────────────────────────────────────────────────────────────────── */

export interface CallTarget {
  leadId?:   string;
  leadName?: string;
  phone:     string;
}

interface PendingLog {
  at:        number;
  leadId:    string;
  leadName:  string;
  phone:     string;
  via:       "3cx" | "phone";
  /** What the 3CX call window saw: true connected, false ended unconnected, null not known. */
  connected: boolean | null;
}

const PENDING = "remotecrm.pendingCallLog";
const PENDING_FOR_MS = 30 * 60_000;
const keepPending = (p: PendingLog) => { try { sessionStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* the popup still opens now */ } };
const readPending = (): PendingLog | null => {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING) || "null") as PendingLog | null;
    return p && p.leadId && Date.now() - p.at < PENDING_FOR_MS ? p : null;
  } catch { return null; }
};
const dropPending = () => { try { sessionStorage.removeItem(PENDING); } catch { /* nothing kept */ } };

/** The digits (and a leading +) of the first number written in a phone field. */
export function dialOf(raw: string): string {
  const first = String(raw ?? "").split(/[\n\r/,;|]+| - /).map((x) => x.trim()).find((x) => x.replace(/\D/g, "").length >= 7) ?? "";
  return first.replace(/[^\d+]/g, "");
}

/** The server's message — for a refused form, its first reason ("Follow-up note cannot exceed…"), not "Validation failed". */
const errText = (e: unknown, fallback: string) => {
  const data = (e as { response?: { data?: { message?: string; errors?: unknown } } })?.response?.data;
  const errors = data?.errors;
  const reasons = Array.isArray(errors) ? errors : errors && typeof errors === "object" ? Object.values(errors).flat() : [];
  const first = reasons.find((r): r is string => typeof r === "string" && r.trim() !== "");
  return data?.message === "Validation failed" && first ? first : data?.message ?? fallback;
};
const firstName = (name?: string) => String(name || "").trim().split(/\s+/)[0] || "the lead";
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

interface CallFlowValue {
  /** A Call button was pressed: ask how to call. */
  chooseCall: (target: CallTarget) => void;
}

const CallFlowContext = createContext<CallFlowValue | null>(null);
export const useCallFlow = () => useContext(CallFlowContext);

export function CallFlowProvider({ children }: { children: React.ReactNode }) {
  useAuthStore((s) => s.user);   // re-check when the signed-in user changes
  const canLog = useAuthStore((s) => s.hasPermission)("leads", "edit");
  const [choice, setChoice] = useState<CallTarget | null>(null);
  const [live, setLive] = useState<(PlacedCall & { phone: string }) | null>(null);
  const [pending, setPending] = useState<PendingLog | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);   // a lead whose enrolment dialog is open

  // Back after a reload: the call still to log opens again.
  useEffect(() => {
    const p = readPending();
    if (p) { setPending(p); setLogOpen(true); }
  }, []);

  const startLog = useCallback((p: PendingLog, open: boolean) => {
    if (!canLog) return;
    keepPending(p);
    setPending(p);
    setLogOpen(open);
  }, [canLog]);

  /** The 3CX call ended, or Log call was pressed: its popup. */
  const logLive = useCallback((connected: boolean | null) => {
    const c = live;
    setLive(null);
    if (!c) return;
    const p = readPending() ?? { at: Date.now(), leadId: c.leadId, leadName: c.leadName, phone: c.phone, via: "3cx" as const, connected: null };
    startLog({ ...p, connected }, true);
  }, [live, startLog]);

  const chooseCall = useCallback((t: CallTarget) => setChoice(t), []);
  const value = useMemo(() => ({ chooseCall }), [chooseCall]);

  return (
    <CallFlowContext.Provider value={value}>
      {children}

      <CallChoiceDialog
        target={choice}
        onClose={() => setChoice(null)}
        onPhone={() => {
          const t = choice;
          setChoice(null);
          if (t?.leadId) startLog({ at: Date.now(), leadId: t.leadId, leadName: t.leadName ?? "", phone: t.phone, via: "phone", connected: null }, true);
        }}
        onStarted={(call) => {
          const t = choice;
          setChoice(null);
          if (!t?.leadId) return;
          setLive({ ...call, phone: t.phone });
          // Kept from the start: a reload during the call still brings back its log.
          startLog({ at: Date.now(), leadId: t.leadId, leadName: t.leadName || call.leadName, phone: t.phone, via: "3cx", connected: null }, false);
        }}
      />

      <CallWindow
        call={live}
        onClose={() => setLive(null)}
        onLog={logLive}
      />

      {pending && logOpen && (
        <AfterCallDialog
          key={`${pending.leadId}-${pending.at}`}
          pending={pending}
          onLater={() => setLogOpen(false)}
          onSaved={(closeNext) => {
            dropPending();
            setPending(null);
            setLogOpen(false);
            if (closeNext) setClosing(pending.leadId);
          }}
        />
      )}

      {/* Put aside: a small reminder that brings the popup back. */}
      {pending && !logOpen && !live && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 shadow-lg">
          <button type="button" onClick={() => setLogOpen(true)} className="flex items-center gap-2 text-xs font-medium text-foreground">
            <StickyNote className="h-3.5 w-3.5 text-primary" />
            Log your call with {pending.leadName || "the lead"}
          </button>
          <button
            type="button"
            title="Don't log this call"
            onClick={() => { dropPending(); setPending(null); }}
            className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {closing && <CloseAfterCall leadId={closing} onDone={() => setClosing(null)} />}
    </CallFlowContext.Provider>
  );
}

/* ── 1. How to call ─────────────────────────────────────────────────────── */

const OPTION = "flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors";

function CallChoiceDialog({ target, onClose, onPhone, onStarted }: {
  target: CallTarget | null;
  onClose: () => void;
  onPhone: () => void;
  onStarted: (call: PlacedCall) => void;
}) {
  const { data: c2c } = useClickToCall(!!target);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; webClientUrl?: string } | null>(null);
  useEffect(() => { setBusy(false); setProblem(null); }, [target]);
  const dial = dialOf(target?.phone ?? "");
  const can3cx = !!c2c?.enabled && !!target?.leadId;

  // The old click log (call_logs) — kept as it was; never stops a call.
  const logClick = () => {
    void api.post(`/calls/click?phone_number=${encodeURIComponent(target?.phone ?? "")}${target?.leadId ? `&lead_id=${target.leadId}` : ""}`).catch(() => null);
  };

  const call3cx = async () => {
    if (!target?.leadId) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.post<ApiResponse<PlacedCall>>("/calls/3cx/call", { leadId: target.leadId, dial });
      logClick();
      onStarted(res.data.data!);
    } catch (e) {
      const data = (e as { response?: { data?: { message?: string; errors?: { webClientUrl?: string } } } })?.response?.data;
      setProblem({ text: data?.message ?? "3CX could not place the call", webClientUrl: data?.errors?.webClientUrl });
    } finally {
      setBusy(false);
    }
  };

  const why3cxOff = !target?.leadId ? "Only for a lead's number"
    : !c2c ? "Checking 3CX…"
    : !c2c.connected ? "3CX is not connected on the server"
    : "No 3CX extension on your account — an admin adds it on the Users screen";

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Call {target?.leadName || target?.phone}</DialogTitle>
          <DialogDescription>{target?.phone}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <button
            type="button"
            disabled={!can3cx || busy}
            onClick={call3cx}
            className={`${OPTION} ${can3cx ? "border-emerald-500/40 hover:bg-emerald-500/10" : "cursor-not-allowed border-border opacity-60"}`}
          >
            {busy ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-emerald-500" /> : <PhoneCall className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />}
            <span>
              <span className="block font-semibold text-foreground">3CX call</span>
              <span className="block text-sm text-muted-foreground">
                {can3cx
                  ? `3CX rings your 3CX app or web client (extension ${c2c!.extension}) — answer it, then ${firstName(target?.leadName)} is dialled. The call shows here too.`
                  : why3cxOff}
              </span>
            </span>
          </button>
          <a
            href={`tel:${dial}`}
            onClick={() => { logClick(); setTimeout(onPhone, 0); }}   // the browser follows the link before this closes
            className={`${OPTION} border-border hover:bg-muted/50`}
          >
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <span>
              <span className="block font-semibold text-foreground">Phone call</span>
              <span className="block text-sm text-muted-foreground">Opens your phone app to dial {dial || target?.phone}</span>
            </span>
          </a>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(target?.phone ?? ""); toast.success("Phone number copied"); }}
            className="flex w-full items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3 w-3" /> Copy number
          </button>
          {problem && (
            <p className="text-sm text-red-400">
              {problem.text}
              {problem.webClientUrl && (
                <> — <a href={problem.webClientUrl} target="_blank" rel="noreferrer" className="underline">open the 3CX web client</a></>
              )}
            </p>
          )}
          {can3cx && c2c?.webClientUrl && !problem && (
            <a href={c2c.webClientUrl} target="_blank" rel="noreferrer" className="block text-center text-xs font-medium text-emerald-500 underline">
              Open the 3CX web client
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── 2. The call window ─────────────────────────────────────────────────── */

/**
 * A 3CX call as 3CX has it, every 2 seconds — ringing your app, calling the lead, connected (with a timer), ended —
 * with Hang up and Log call. Closing it does not end the call. Once the call has ended, the "How did it go?" popup
 * opens by itself.
 */
function CallWindow({ call, onClose, onLog }: {
  call: (PlacedCall & { phone: string }) | null;
  onClose: () => void;
  onLog: (connected: boolean | null) => void;
}) {
  const [state, setState] = useState<MyCallState | null>(null);
  const [ended, setEnded] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const [hanging, setHanging] = useState(false);
  const [, setTick] = useState(0);
  const seen = useRef(false);
  const started = useRef(0);

  useEffect(() => {   // a new call: start over
    setState(null); setEnded(false); setConnectedAt(null); setProblem(""); setHanging(false);
    seen.current = false;
    started.current = Date.now();
  }, [call]);

  useEffect(() => {   // follow it until it ends
    if (!call || ended) return undefined;
    let gone = false;
    const look = async () => {
      try {
        const res = await api.get<ApiResponse<MyCallState>>("/calls/3cx/state", { params: { callId: call.callId ?? "", dial: call.dial } });
        if (gone) return;
        const s = res.data.data ?? null;
        setState(s);
        setProblem("");
        if (s?.participant) {
          seen.current = true;
          if (s.participant.stage === "connected") setConnectedAt((at) => at ?? Date.now());
        } else if (seen.current || Date.now() - started.current > 60_000) {
          setEnded(true);
        }
      } catch (e) {
        if (!gone) setProblem(errText(e, "Could not read the call from 3CX"));
      }
    };
    void look();
    const id = setInterval(look, 2000);
    return () => { gone = true; clearInterval(id); };
  }, [call, ended]);

  useEffect(() => {   // the talk timer
    if (!connectedAt || ended) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [connectedAt, ended]);

  // Ended: straight on to "How did the call go?", after a moment to read "Call ended".
  useEffect(() => {
    if (!ended || !call) return undefined;
    const id = setTimeout(() => onLog(connectedAt ? true : seen.current ? false : null), 1200);
    return () => clearTimeout(id);
  }, [ended, call, connectedAt, onLog]);

  const hangUp = async () => {
    if (!state?.participant?.id) return;
    setHanging(true);
    try {
      await api.post("/calls/3cx/hang-up", { participantId: state.participant.id });
      setEnded(true);
    } catch (e) {
      setProblem(errText(e, "Could not hang up"));
    } finally {
      setHanging(false);
    }
  };

  const stage = state?.participant?.stage;
  const where = call?.device || "3CX app";
  const name = firstName(call?.leadName);
  const line = ended ? (connectedAt ? "Call ended" : "The call ended before it connected")
    : !state?.participant ? `Ringing your ${where}…`
    : stage === "connected" ? `Connected · ${clock(Date.now() - (connectedAt ?? Date.now()))}`
    : stage === "calling" ? `Calling ${name}…`
    : stage === "ringing" ? `Ringing your ${where}…`
    : state.participant.status;
  // 3CX's "Dialing" covers both steps — your app ringing, then the lead's phone — so say what has to happen.
  const hint = connectedAt ? ""
    : !ended ? `Answer 3CX's call in your ${where} — then ${name}'s phone rings.`
    : `If 3CX's call didn't reach your ${where}, open it, let it use the microphone and call again — or use Phone call.`;

  return (
    <Dialog open={!!call} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader className="items-center text-center sm:text-center">
          <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${ended ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-500"}`}>
            {ended ? <PhoneOff className="h-6 w-6" /> : <PhoneCall className={`h-6 w-6 ${connectedAt ? "" : "animate-pulse"}`} />}
          </div>
          <DialogTitle>{call?.leadName || call?.dial}</DialogTitle>
          <DialogDescription>{call?.dial} · from your extension {call?.extension}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-center">
          <p className={`text-lg font-semibold ${ended ? "text-muted-foreground" : "text-emerald-500"}`}>{line}</p>
          {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
          {state?.participant?.status && !ended && (
            <p className="text-xs text-muted-foreground/70">3CX: {state.participant.status}{state.participant.party ? ` · ${state.participant.party}` : ""}</p>
          )}
          {!ended && <p className="text-xs text-muted-foreground/70">The call is on your 3CX app — closing this window does not end it.</p>}
          {problem && <p className="text-xs text-red-400">{problem}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-center">
          {!ended && (
            <Button variant="destructive" onClick={hangUp} disabled={hanging || !state?.participant?.id}>
              {hanging ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />} Hang up
            </Button>
          )}
          <Button variant={ended ? "default" : "outline"} onClick={() => onLog(connectedAt ? true : ended && seen.current ? false : null)}>Log call</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── 3. How did the call go? ────────────────────────────────────────────── */

const KEEP = "__keep__";
/**
 * Statuses that ask for a date and time (GST). Follow Up and Meeting Scheduled
 * send it with the status change, as the CRM's own forms do — the server turns
 * it into the reminder; Call Back's is a reminder of its own, as Add Reminder makes.
 */
const ASKS_WHEN: Partial<Record<LeadStatus, { required: boolean; label: string; hint: string }>> = {
  followup:          { required: false, label: "Next follow-up (optional)", hint: "You'll be reminded at this time, as Follow Up's own form does." },
  meeting_scheduled: { required: true,  label: "Meeting on *",              hint: "Becomes the meeting's reminder, as Meeting Scheduled does." },
  callback:          { required: false, label: "Call back on (optional)",   hint: "Saved as a reminder on the lead, as Add Reminder does." },
};
/** Statuses the CRM takes only with notes: what happened (Follow Up), why it was lost (Lost). */
const NEEDS_NOTES: Partial<Record<LeadStatus, string>> = {
  followup: "Write what happened on the call — Follow Up needs it.",
  lost:     "Write a note on why — Lost needs it.",
};

/** A datetime-local value typed in GST. */
const gst = (v: string) => new Date(`${v}:00+04:00`);
/** "2026-10-14T15:00" (GST) → "14 Oct, 3:00 PM". */
const fmtLocal = (v: string) =>
  gst(v).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
/** Now, as a datetime-local value in GST — the earliest a reminder may be. */
const nowGst = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Dubai" }).slice(0, 16).replace(" ", "T");

function AfterCallDialog({ pending, onLater, onSaved }: {
  pending: PendingLog;
  onLater: () => void;
  /** Saved; `closeNext` — Closed was picked: the enrolment dialog opens next. */
  onSaved: (closeNext: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: lead } = useLead(pending.leadId);
  // A reminder of its own (Call Back's, another follow-up's) needs Reminders; the status change makes Follow Up's
  // and Meeting Scheduled's itself.
  const canRemind = useAuthStore((s) => s.hasPermission)("reminders", "edit");
  const [connected, setConnected] = useState<boolean | null>(pending.connected);
  const [status, setStatus] = useState<string>(KEEP);
  const [remindAt, setRemindAt] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // The lead's status when Save was first pressed, and the requests that have gone through since: pressed again after
  // a part-way failure, Save sends only what is still missing — a status is not changed twice, a reminder or a
  // follow-up not added twice (after the first try the lead shows the status that try set).
  const sent = useRef<{ before: LeadStatus | undefined; done: Set<string> } | null>(null);

  const next = status === KEEP ? null : (status as LeadStatus);
  const current = lead?.status;
  const again = next === "followup" && current === "followup";
  const when = next && !(next === "callback" && !canRemind) ? ASKS_WHEN[next] : undefined;
  const whenHint = again && !canRemind ? "Kept as the lead's next follow-up." : when?.hint;
  // Follow Up can be picked again on a lead already in it: one more follow-up, not a status change.
  const choices = LEAD_STATUSES.filter((s) => s !== current || s === "followup");

  const save = async () => {
    setProblem("");
    const text = notes.trim();
    if (connected === null) { setProblem("Did the call connect?"); return; }
    if (next === "lost" && !lostReason) { setProblem("Why was the lead lost? Pick a reason."); return; }
    const notesNeeded = next ? NEEDS_NOTES[next] : undefined;
    if (notesNeeded && !text) { setProblem(notesNeeded); return; }
    if (when?.required && !remindAt) { setProblem("When is the meeting? Pick a date and time."); return; }
    if (when && remindAt && gst(remindAt).getTime() < Date.now() - 60_000) { setProblem("That time has already passed — pick a later one."); return; }
    setBusy(true);
    const id = pending.leadId;
    const at = when && remindAt ? gst(remindAt).toISOString() : undefined;
    const tries = (sent.current ??= { before: current, done: new Set<string>() });
    const followUpAgain = next === "followup" && tries.before === "followup";
    const reason = LOST_REASONS.find((r) => r.value === lostReason)?.label;
    const summary = [
      `Call ${pending.via === "3cx" ? "through 3CX" : "by phone"} — ${connected ? "connected" : "not connected"}`,
      next ? `${next === "closed" ? "closing" : STATUS_META[next].label}${at ? `, ${fmtLocal(remindAt)} GST` : ""}` : "",
    ].filter(Boolean).join(" · ");
    const content = [summary, next === "lost" && reason ? `Lost — reason: ${reason}` : "", text]
      .filter(Boolean).join("\n").slice(0, 2000);
    const now = new Date().toISOString();

    // In order, each named so a second Save skips what went through.
    const steps: { key: string; send: () => Promise<unknown> }[] = [];
    // A reminder first: a time it refuses stops here, with nothing else saved.
    if (next === "callback" && at) {
      steps.push({ key: `reminder:callback:${at}`, send: () => api.post(`/leads/${id}/reminders`, { title: "Call back", note: text.slice(0, 1000) || undefined, remindAt: at }) });
    }
    if (followUpAgain) {
      // Already in Follow Up: another entry in its follow-up history, as Log Follow-up does,
      // and the reminder the status change would have made.
      if (at && canRemind) {
        steps.push({ key: `reminder:followup:${at}`, send: () => api.post(`/leads/${id}/reminders`, { title: "Follow-up due", note: text.slice(0, 200), remindAt: at }) });
      }
      steps.push({ key: `followup:${at ?? ""}`, send: () => api.post(`/leads/${id}/followups`, { note: text.slice(0, 1000), followedUpAt: now, nextFollowUpAt: at ?? null }) });
    } else if (next && next !== "closed" && next !== tries.before) {
      // Closed waits for the enrolment (CloseLeadDialog), as everywhere else. A follow-up's note: at most 1,000
      // characters, as the follow-up history keeps them (the lead note below keeps all of it).
      steps.push({
        key: `status:${next}`,
        send: () => api.patch(`/leads/${id}/status`, {
          status: next,
          ...(next === "followup" ? { followUpNote: text.slice(0, 1000), followUpAt: now, nextFollowUpAt: at } : {}),
          ...(next === "meeting_scheduled" ? { meetingAt: at, meetingNote: text.slice(0, 500) || undefined } : {}),
          ...(next === "lost" ? { lostReason, lostNotes: text.slice(0, 500) } : {}),
        }),
      });
    }
    steps.push({ key: "note", send: () => api.post(`/leads/${id}/notes`, { content }) });

    try {
      for (const step of steps) {
        if (tries.done.has(step.key)) continue;
        await step.send();
        tries.done.add(step.key);
      }
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["reminders"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      toast.success(next === "closed" ? "Call logged — now the enrolment" : "Call logged");
      onSaved(next === "closed");
    } catch (e) {
      setProblem(errText(e, "Could not save — try again"));
      qc.invalidateQueries({ queryKey: ["leads"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onLater(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>How did the call go?</DialogTitle>
          <DialogDescription>
            {pending.leadName || lead?.name || "The lead"} · {pending.phone}
            {current ? ` · now ${STATUS_META[current]?.label ?? current}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Did it connect?</Label>
            <div className="grid grid-cols-2 gap-2">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  onClick={() => setConnected(v)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${connected === v
                    ? v ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500" : "border-orange-500/60 bg-orange-500/15 text-orange-400"
                    : "border-border text-muted-foreground hover:bg-muted/50"}`}
                >
                  {v ? "Yes, we talked" : "No, not connected"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Lead status</Label>
            <Select value={status} onValueChange={(v) => { setStatus(v); setProblem(""); }}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP} className="text-sm">Keep as it is{current ? ` (${STATUS_META[current]?.label ?? current})` : ""}</SelectItem>
                {choices.map((s) => (
                  <SelectItem key={s} value={s} className="text-sm">
                    {STATUS_META[s].label}{s === current ? " — log another follow-up" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {when && (
            <div className="space-y-1.5">
              <Label className="text-xs">{when.label} — GST</Label>
              <Input type="datetime-local" value={remindAt} min={nowGst()} onChange={(e) => setRemindAt(e.target.value)} className="h-9 [color-scheme:dark]" />
              <p className="text-[11px] text-muted-foreground">{whenHint}</p>
            </div>
          )}
          {next === "lost" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Why lost? *</Label>
              <Select value={lostReason} onValueChange={(v) => { setLostReason(v); setProblem(""); }}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Pick a reason" /></SelectTrigger>
                <SelectContent>
                  {LOST_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value} className="text-sm">{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {next === "closed" && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              Saving opens the enrolment form. The lead closes only when the enrolment is saved, as everywhere else.
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">
              {next === "followup" ? "What happened on the call? *" : next === "lost" ? "Notes *" : "Notes"}
            </Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1500} placeholder="What did they say?" className="min-h-[80px] resize-none text-sm" />
            <p className="text-[11px] text-muted-foreground">
              Saved as a note on the lead, with what you picked above{next === "followup" ? " — and in its follow-up history" : ""}.
            </p>
          </div>

          {problem && <p className="text-sm text-red-400">{problem}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onLater} disabled={busy}>Later</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {next === "closed" ? "Save and enrol" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Closed picked after a call: the lead's enrolment dialog; the status changes only once it is saved. */
function CloseAfterCall({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: lead } = useLead(leadId);
  if (!lead) return null;
  return (
    <CloseLeadDialog
      key={lead._id}
      lead={lead}
      onClose={onDone}
      onClosed={async () => {
        onDone();
        if (lead.status === "closed") return;
        try {
          await api.patch(`/leads/${lead._id}/status`, { status: "closed" });
          toast.success("Status updated");
        } catch (e) {
          toast.error(errText(e, "Failed to update status"));
        }
        qc.invalidateQueries({ queryKey: ["leads"] });
        qc.invalidateQueries({ queryKey: ["teams"] });
      }}
    />
  );
}
