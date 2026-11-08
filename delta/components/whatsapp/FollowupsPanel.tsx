"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Paperclip, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWhatsAppFollowupSummary } from "@/hooks/useWhatsApp";

/*
 * The automatic follow-ups on the WhatsApp page (2026-10-28: "the follow-up messages setting area also show"): for
 * everyone, whether they are on for your team and what each step says, when. Since 2026-11-08 each team has its own:
 * its leader or a Super Admin changes them on the team's page (Teams → the team → WhatsApp).
 */
const waitText = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : `${Math.round((m / 60) * 10) / 10} hour${m === 60 ? "" : "s"}`);

export function FollowupsPanel() {
  const { data } = useWhatsAppFollowupSummary();
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const state = !data.teamId ? "You're in no team" : data.enabled ? "On for your team" : "Off for your team";
  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        <span className="flex items-center gap-2">
          <Repeat className="h-4 w-4 text-muted-foreground" />Automatic follow-ups
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", data.enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>{state}</span>
        </span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t p-4">
          {data.teamId && (
            <Link href={`/teams/${data.teamId}?tab=whatsapp`} className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              {data.canEdit ? "Change your team's follow-ups and first reply" : "See your team's WhatsApp settings"} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
          {(

            <div className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">
                When a lead doesn&apos;t answer your WhatsApp message, your linked WhatsApp follows up on its own, inside working hours — at most {data.dailyLimit} a day.
                It stops when they answer, are Closed, Lost or Repeated, or you press Stop on the lead. Your team&apos;s leader or a Super Admin changes these.
              </p>
              {data.myTeams.length > 0 && <p className="text-xs">Your team{data.myTeams.length > 1 ? "s" : ""}: {data.myTeams.map((t) => `${t.name} (${t.on ? "on" : "off"})`).join(", ")}</p>}
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
