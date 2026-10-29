"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, MessageCircle, Mic, Paperclip, Plus, Save, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store/authStore";
import {
  errMsg, useSaveWhatsAppFollowupSettings, useUploadFollowupFile, useWhatsAppFollowupSettings, type WAFirstReplyItem, type WAFollowupStep,
} from "@/hooks/useWhatsApp";

/*
 * Automatic WhatsApp follow-ups (2026-10-27, as loop2.ai's) — for a Super Admin: a lead someone wrote to on WhatsApp
 * who doesn't answer is followed up from that person's own linked WhatsApp, step by step, each so long after the one
 * before, inside the working hours; it stops when they answer, are Closed / Lost / Repeated, or someone presses Stop on
 * the lead. Only the teams ticked here, and no more than the daily limit per person. (api services/whatsapp/followups.ts)
 *
 * The first reply (2026-10-28): to someone's first message ever, a minute on unless a person answered — the parts here
 * in order (words, a link, a brochure, audio as voice notes), from the same teams' WhatsApps, at any hour.
 */

type Unit = "hours" | "days";
const unitOf = (m: number): Unit => (m % 1440 === 0 ? "days" : "hours");
const amountOf = (m: number) => (unitOf(m) === "days" ? m / 1440 : Math.round((m / 60) * 10) / 10);
const minutesOf = (amount: number, unit: Unit) => Math.round(amount * (unit === "days" ? 1440 : 60));

function StepFile({ step, onChange, label = "Add a photo, video or PDF" }: { step: { file: WAFollowupStep["file"] }; onChange: (f: WAFollowupStep["file"]) => void; label?: string }) {
  const upload = useUploadFollowupFile();
  const input = useRef<HTMLInputElement>(null);
  if (step.file) {
    const mime = step.file.mime || "";
    return (
      <div className="space-y-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
          <Paperclip className="h-3.5 w-3.5" />{step.file.name || "File"}
          {/* What it goes as on WhatsApp */}
          <span className="text-muted-foreground">· {mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "photo" : "document"}</span>
          <button type="button" aria-label="Remove the file" onClick={() => onChange(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
        </span>
        {/* Listen to it, or look at it, here (2026-10-29) — a file just uploaded has no link until Save */}
        {step.file.url && <FilePreview url={step.file.url} mime={mime} name={step.file.name} />}
      </div>
    );
  }
  return (
    <>
      <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,audio/*,.opus,.ogg,.m4a,application/pdf"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > 25 * 1024 * 1024) { toast.error("Files up to 25 MB"); return; }
          try { onChange(await upload.mutateAsync(f)); } catch (err) { toast.error(errMsg(err, "Not uploaded")); }
        }} />
      <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={upload.isPending} onClick={() => input.current?.click()}>
        {upload.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}{label}
      </Button>
    </>
  );
}

function FilePreview({ url, mime, name }: { url: string; mime: string; name: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <p className="text-xs italic text-muted-foreground">Couldn&apos;t load it — reopen Settings</p>;
  if (mime.startsWith("audio/")) return <audio src={url} controls preload="metadata" onError={() => setBroken(true)} className="h-9 w-72 max-w-full" />;
  if (mime.startsWith("video/")) return <video src={url} controls preload="metadata" onError={() => setBroken(true)} className="max-h-48 max-w-xs rounded-md" />;
  // eslint-disable-next-line @next/next/no-img-element
  if (mime.startsWith("image/")) return <img src={url} alt={name} onError={() => setBroken(true)} className="max-h-32 max-w-xs rounded-md object-contain" />;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open {name || "the file"}</a>;
}

export function WhatsAppFollowupsCard() {
  const user = useAuthStore((s) => s.user);
  // The signed-in user comes from localStorage: decide only once in the browser, so the server's HTML matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isSuperAdmin = mounted && !!user?.role?.isSystemRole && user.role.roleName === "Super Admin";
  const { data, isLoading } = useWhatsAppFollowupSettings(isSuperAdmin);
  const save = useSaveWhatsAppFollowupSettings();

  const [enabled, setEnabled] = useState(false);
  const [teams, setTeams] = useState<string[]>([]);
  const [limit, setLimit] = useState(60);
  const [steps, setSteps] = useState<WAFollowupStep[]>([]);
  const [frOn, setFrOn] = useState(false);
  const [frItems, setFrItems] = useState<WAFirstReplyItem[]>([]);
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled); setTeams(data.teams); setLimit(data.dailyLimit); setSteps(data.steps);
    setFrOn(data.firstReply?.enabled ?? false); setFrItems(data.firstReply?.items ?? []);
  }, [data]);

  if (!isSuperAdmin) return null;
  const setStep = (i: number, patch: Partial<WAFollowupStep>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setItem = (i: number, patch: Partial<WAFirstReplyItem>) => setFrItems((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const moveItem = (i: number, by: number) => setFrItems((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n; });

  const submit = async () => {
    if ((enabled || frOn) && !teams.length) { toast.error("Tick at least one team, or switch it off"); return; }
    if (frOn && !frItems.length) { toast.error("Add what the first reply sends, or switch it off"); return; }
    try {
      await save.mutateAsync({ enabled, teams, dailyLimit: limit, steps, firstReply: { enabled: frOn, items: frItems } });
      toast.success(enabled ? "Saved — follow-ups are on for the teams ticked" : "Saved — follow-ups are off");
    } catch (e) { toast.error(errMsg(e, "Not saved")); }
  };

  return (
    <Card className="border-border/50 bg-card/80">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircle className="h-4 w-4 text-primary" />
          WhatsApp follow-ups
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          When a lead doesn&apos;t answer a WhatsApp message, their salesperson&apos;s own linked WhatsApp follows up on its own, step by step,
          inside the working hours. It stops when they answer, are Closed, Lost or Repeated, or someone presses Stop on the lead;
          writing to them again starts it over. Use <code>{"{name}"}</code> for the lead&apos;s first name and <code>{"{salesperson}"}</code> for the salesperson&apos;s.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !data ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="wa-fu-on" className="text-sm">Send automatic follow-ups</Label>
                <p className="text-xs text-muted-foreground">
                  {data.enabled && data.startedAt ? `On since ${new Date(data.startedAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} — only chats written in since then.` : "Switched on, it follows up only chats written in from then on."}
                </p>
              </div>
              <Switch id="wa-fu-on" checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Teams</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {data.allTeams.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={teams.includes(t.id)} onCheckedChange={(c) => setTeams((s) => (c ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
                    {t.name}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="wa-fu-limit" className="text-sm">At most</Label>
              <Input id="wa-fu-limit" type="number" min={1} max={300} className="h-8 w-20" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              <span className="text-sm text-muted-foreground">a day from each person&apos;s WhatsApp (one every 1–2 minutes)</span>
            </div>

            <div className="space-y-3">
              <Label className="text-sm">Steps</Label>
              {steps.map((s, i) => (
                <div key={i} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">Step {i + 1}</span>
                    <span className="text-muted-foreground">— wait</span>
                    <Input type="number" min={0.5} step={0.5} className="h-8 w-20" value={amountOf(s.waitMinutes)}
                      onChange={(e) => setStep(i, { waitMinutes: minutesOf(Number(e.target.value), unitOf(s.waitMinutes)) })} />
                    <Select value={unitOf(s.waitMinutes)} onValueChange={(u) => setStep(i, { waitMinutes: minutesOf(amountOf(s.waitMinutes), u as Unit) })}>
                      <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="hours">hours</SelectItem><SelectItem value="days">days</SelectItem></SelectContent>
                    </Select>
                    <span className="text-muted-foreground">after {i === 0 ? "the last message" : `step ${i}`}</span>
                    {steps.length > 1 && (
                      <Button type="button" size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove step ${i + 1}`}
                        onClick={() => setSteps((x) => x.filter((_, k) => k !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                  <Textarea rows={2} maxLength={1000} value={s.text} onChange={(e) => setStep(i, { text: e.target.value })} />
                  <StepFile step={s} onChange={(file) => setStep(i, { file })} />
                </div>
              ))}
              {steps.length < 8 && (
                <Button type="button" size="sm" variant="outline" className="gap-1.5"
                  onClick={() => setSteps((x) => [...x, { waitMinutes: 7 * 1440, text: "", file: null }])}>
                  <Plus className="h-3.5 w-3.5" />Add a step
                </Button>
              )}
            </div>

            <div className="space-y-3 rounded-lg border border-dashed p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="wa-fr-on" className="text-sm">First reply</Label>
                  <p className="text-xs text-muted-foreground">
                    When someone messages a WhatsApp of a team ticked above for the first time ever, these go out a minute later, in order — unless
                    someone answered them first. Any hour. A WhatsApp voice recording (.opus / .ogg) can go as a voice note; other audio — M4A (also "….m4a.mp4"), MP3 — goes as ordinary audio.
                  </p>
                </div>
                <Switch id="wa-fr-on" checked={frOn} onCheckedChange={setFrOn} />
              </div>
              {frItems.map((it, i) => (
                <div key={i} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">Part {i + 1}</span>
                    {/^audio\/(ogg|webm)/.test(it.file?.mime ?? "") && (
                      <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox checked={it.voice} onCheckedChange={(c) => setItem(i, { voice: c === true })} /><Mic className="h-3.5 w-3.5" />as a voice note
                      </label>
                    )}
                    <span className="ml-auto flex gap-1">
                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={i === 0} aria-label="Move up" onClick={() => moveItem(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={i === frItems.length - 1} aria-label="Move down" onClick={() => moveItem(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove part ${i + 1}`} onClick={() => setFrItems((x) => x.filter((_, k) => k !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </span>
                  </div>
                  <Textarea rows={2} maxLength={1000} value={it.text} placeholder={it.file ? "Words with it (optional)" : "Words — a link, a greeting…"} onChange={(e) => setItem(i, { text: e.target.value })} />
                  <StepFile step={it} label="Add audio, a brochure, a photo or a video" onChange={(file) => setItem(i, { file, voice: /^audio\/(ogg|webm)/.test(file?.mime ?? "") })} />
                </div>
              ))}
              {frItems.length < 6 && (
                <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setFrItems((x) => [...x, { text: "", file: null, voice: false }])}>
                  <Plus className="h-3.5 w-3.5" />Add a part
                </Button>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{data.updatedByName ? `Last saved by ${data.updatedByName}` : ""}</p>
              <Button onClick={submit} disabled={save.isPending} className="gap-2">
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
