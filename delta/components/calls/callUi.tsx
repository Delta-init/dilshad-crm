"use client";

import { useState } from "react";
import {
  AlertTriangle, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Play, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DUBAI_TZ } from "@/lib/dubaiDates";
import { getRecordingLink, type ThreecxCall, type ThreecxStatus } from "@/hooks/useCalls";

/* ────────────────────────────────────────────────────────────────────────────
   How a 3CX call shows on the Calls page and a lead's Calls section: its
   result, who took it, how long, its recording, and whether 3CX is syncing.
   (Tetra Commission's components/calls/callUi.jsx, for leads.)
──────────────────────────────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");

/** 125 → "2:05", 3725 → "1:02:05". */
export function fmtClockDuration(s: number): string {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(n % 60)}` : `${m}:${pad(n % 60)}`;
}

/** A total: "3h 12m", "45m", "30s". */
export function fmtTalkTotal(s: number): string {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${n}s`;
}

/** When, on Dubai time. */
export function fmtWhen(iso?: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("en-GB", { timeZone: DUBAI_TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "—";
}

export function fmtClock(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: DUBAI_TZ, hour: "2-digit", minute: "2-digit" }) : "";
}

export const RESULTS: Record<ThreecxCall["status"], { label: string; badge: string; icon: string }> = {
  answered:  { label: "Connected",    badge: "text-green-500 bg-green-500/10 border-green-500/20",    icon: "text-green-500" },
  missed:    { label: "Missed",       badge: "text-red-500 bg-red-500/10 border-red-500/20",          icon: "text-red-500" },
  no_answer: { label: "Not answered", badge: "text-orange-500 bg-orange-500/10 border-orange-500/20", icon: "text-orange-500" },
};

/** In or out, and what happened: connected; missed (they called, nobody answered); not answered (we called). */
export function CallResult({ call }: { call: Pick<ThreecxCall, "status" | "direction"> }) {
  const r = RESULTS[call.status] ?? RESULTS.answered;
  const Icon = call.status === "missed" ? PhoneMissed : call.status === "no_answer" ? PhoneOff : call.direction === "in" ? PhoneIncoming : PhoneOutgoing;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Icon className={cn("h-3.5 w-3.5 shrink-0", r.icon)} />
      <span className="w-14 text-xs text-muted-foreground">{call.direction === "in" ? "Incoming" : "Outgoing"}</span>
      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", r.badge)}>{r.label}</span>
    </span>
  );
}

/** Who took or made the call: the CRM user with that 3CX extension, else 3CX's name for it. */
export function CallPerson({ call }: { call: Pick<ThreecxCall, "userName" | "agentName" | "extension"> }) {
  const name = call.userName || call.agentName;
  if (!name && !call.extension) return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="whitespace-nowrap">
      <div className="text-xs text-foreground">{name || `Ext ${call.extension}`}</div>
      {call.extension && name && <div className="text-[11px] text-muted-foreground">Ext {call.extension}</div>}
    </div>
  );
}

/**
 * A call's recording: asks the server for a 10-minute link, then plays it in the browser — streamed from 3CX
 * through the backend, never stored here. Several parts (a transferred call): one button each.
 */
export function RecordingPlayer({ call }: { call: Pick<ThreecxCall, "id" | "recordings"> }) {
  const [playing, setPlaying] = useState<{ index: number; url: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!call.recordings) return <span className="text-[11px] text-muted-foreground/40">—</span>;

  const open = async (index: number) => {
    setBusy(index);
    setErr(null);
    try {
      setPlaying({ index, url: await getRecordingLink(call.id, index) });
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setErr(msg || "Could not open the recording");
    } finally {
      setBusy(null);
    }
  };
  const parts = Array.from({ length: call.recordings }, (_, i) => i);

  return (
    <div className="flex flex-col items-start gap-1.5" onClick={(e) => e.stopPropagation()}>
      {playing && (
        <audio
          key={playing.url}
          src={playing.url}
          controls
          autoPlay
          controlsList="nodownload"
          className="h-9 w-64 max-w-full"
          onError={() => { setPlaying(null); setErr("Could not play it — the link may have expired. Play again."); }}
        />
      )}
      {(!playing || parts.length > 1) && (
        <div className="flex flex-wrap gap-1">
          {parts.map((i) => (
            <button
              key={i}
              type="button"
              disabled={busy !== null}
              onClick={() => open(i)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                playing?.index === i ? "border-primary/40 bg-primary/20 text-primary" : "border-primary/20 bg-primary/10 text-primary hover:bg-primary/20",
              )}
            >
              {busy === i ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {parts.length > 1 ? `Part ${i + 1}` : "Play"}
            </button>
          ))}
        </div>
      )}
      {err && <span className="max-w-[16rem] text-[11px] text-destructive">{err}</span>}
    </div>
  );
}

/** Whether calls are coming in from 3CX, in a line. What went wrong shows to the Super Admin only (the server sends it to them alone). */
export function SyncNote({ threecx }: { threecx?: ThreecxStatus | null }) {
  if (!threecx) return null;
  const box = (cls: string, Icon: React.ElementType, children: React.ReactNode, spin = false) => (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", cls)}>
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", spin && "animate-spin")} /> <span>{children}</span>
    </div>
  );
  if (!threecx.connected) {
    return box("border-amber-500/20 bg-amber-500/10 text-amber-500", AlertTriangle, "3CX not connected — call history from 3CX is not switched on on this server.");
  }
  if (!threecx.firstImportDone) {
    return threecx.running
      ? box("border-sky-500/20 bg-sky-500/10 text-sky-500", RefreshCw, `Fetching the last ${threecx.backfillDays} days of calls from 3CX — they appear here as they come in.`, true)
      : box("border-sky-500/20 bg-sky-500/10 text-sky-500", Phone, "Waiting for the first import from 3CX (it starts a couple of minutes after the server does).");
  }
  if (threecx.error) {
    return box("border-destructive/20 bg-destructive/10 text-destructive", AlertTriangle, `The last sync with 3CX failed at ${fmtClock(threecx.error.at)}: ${threecx.error.message}`);
  }
  return <p className="text-[11px] text-muted-foreground">Last synced {fmtClock(threecx.updatedAt)} · from 3CX every minute</p>;
}
