"use client";

import { useState } from "react";
import { ChevronDown, Paperclip, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { WhatsAppFollowupsCard } from "@/components/settings/WhatsAppFollowupsCard";
import { useWhatsAppFollowupSummary } from "@/hooks/useWhatsApp";

/*
 * The automatic follow-ups on the WhatsApp page (2026-10-28: "the follow-up messages setting area also show"): for
 * everyone, whether they are on for your team and what each step says, when; a Super Admin edits them right here (the
 * same card as Settings → WhatsApp follow-ups).
 */
const waitText = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : `${Math.round((m / 60) * 10) / 10} hour${m === 60 ? "" : "s"}`);

export function FollowupsPanel() {
  const { data } = useWhatsAppFollowupSummary();
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const forMe = data.myTeams.some((t) => t.on);
  const state = !data.enabled ? "Off" : forMe ? "On for your team" : data.myTeams.length ? "On — not for your team" : "On";
  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        <span className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" />Automatic follow-ups
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", data.enabled && (forMe || data.canEdit) ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>{state}</span>
        </span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t p-4">
          {data.canEdit ? (
            <WhatsAppFollowupsCard />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                When a lead doesn&apos;t answer your WhatsApp message, your linked WhatsApp follows up on its own, inside working hours — at most {data.dailyLimit} a day.
                It stops when they answer, are Closed, Lost or Repeated, or you press Stop on the lead. Only a Super Admin changes these.
              </p>
              {data.myTeams.length > 0 && <p className="text-xs">Your team{data.myTeams.length > 1 ? "s" : ""}: {data.myTeams.map((t) => `${t.name} (${t.on && data.enabled ? "on" : "off"})`).join(", ")}</p>}
              <ol className="space-y-2">
                {data.steps.map((s, i) => (
                  <li key={i} className="rounded-lg border p-3">
                    <p className="text-xs font-semibold text-muted-foreground">Step {i + 1} — {waitText(s.waitMinutes)} after {i === 0 ? "the last message" : `step ${i}`}</p>
                    <p className="mt-1 whitespace-pre-wrap">{s.text}</p>
                    {s.fileName && <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="h-3 w-3" />{s.fileName}</p>}
                  </li>
                ))}
              </ol>
              {data.firstReply && (
                <div className="space-y-1 rounded-lg border border-dashed p-3">
                  <p className="text-xs font-semibold text-muted-foreground">First reply — {data.firstReply.enabled ? "on" : "off"}: to someone&apos;s first message, a minute later unless you answered</p>
                  {data.firstReply.items.map((x, i) => (
                    <p key={i} className="text-sm">{i + 1}. {x.fileName ? `${x.voice ? "🎤 " : "📎 "}${x.fileName}${x.text ? ` — ${x.text}` : ""}` : x.text}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
