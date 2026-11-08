"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Mic, Paperclip, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { errMsg, useUploadFollowupFile, type WAFirstReplyItem, type WAFollowupStep } from "@/hooks/useWhatsApp";

/*
 * The WhatsApp message editors (2026-10-27 → 2026-11-08): the follow-up steps (each so long after the one before, its
 * words and a file) and the first reply (its switch and its parts — words, a link, a brochure, audio as voice notes),
 * each file played back here. Used on a team's WhatsApp tab (components/teams/TeamWhatsAppTab.tsx).
 */

type Unit = "hours" | "days";
const unitOf = (m: number): Unit => (m % 1440 === 0 ? "days" : "hours");
const amountOf = (m: number) => (unitOf(m) === "days" ? m / 1440 : Math.round((m / 60) * 10) / 10);
const minutesOf = (amount: number, unit: Unit) => Math.round(amount * (unit === "days" ? 1440 : 60));

export function StepFile({ step, onChange, label = "Add a photo, video or PDF" }: { step: { file: WAFollowupStep["file"] }; onChange: (f: WAFollowupStep["file"]) => void; label?: string }) {
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

export function FilePreview({ url, mime, name }: { url: string; mime: string; name: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <p className="text-xs italic text-muted-foreground">Couldn&apos;t load it — reload the page</p>;
  if (mime.startsWith("audio/")) return <audio src={url} controls preload="metadata" onError={() => setBroken(true)} className="h-9 w-72 max-w-full" />;
  if (mime.startsWith("video/")) return <video src={url} controls preload="metadata" onError={() => setBroken(true)} className="max-h-48 max-w-xs rounded-md" />;
  // eslint-disable-next-line @next/next/no-img-element
  if (mime.startsWith("image/")) return <img src={url} alt={name} onError={() => setBroken(true)} className="max-h-32 max-w-xs rounded-md object-contain" />;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open {name || "the file"}</a>;
}

/** The follow-up steps, edited. */
export function StepsEditor({ steps, setSteps }: { steps: WAFollowupStep[]; setSteps: (f: (s: WAFollowupStep[]) => WAFollowupStep[]) => void }) {
  const setStep = (i: number, patch: Partial<WAFollowupStep>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
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
  );
}

/** The first reply — its switch and its parts, edited. */
export function FirstReplyEditor({ id, on, setOn, items, setItems, help }: {
  id: string; on: boolean; setOn: (v: boolean) => void; items: WAFirstReplyItem[];
  setItems: (f: (s: WAFirstReplyItem[]) => WAFirstReplyItem[]) => void; help: string;
}) {
  const setItem = (i: number, patch: Partial<WAFirstReplyItem>) => setItems((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const moveItem = (i: number, by: number) => setItems((s) => { const n = [...s]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n; });
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor={id} className="text-sm">First reply</Label>
          <p className="text-xs text-muted-foreground">
            {help} Any hour. A WhatsApp voice recording (.opus / .ogg) can go as a voice note; other audio — M4A (also &quot;….m4a.mp4&quot;), MP3 — goes as ordinary audio.
          </p>
        </div>
        <Switch id={id} checked={on} onCheckedChange={setOn} />
      </div>
      {items.map((it, i) => (
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
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={i === items.length - 1} aria-label="Move down" onClick={() => moveItem(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove part ${i + 1}`} onClick={() => setItems((x) => x.filter((_, k) => k !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </span>
          </div>
          <Textarea rows={2} maxLength={1000} value={it.text} placeholder={it.file ? "Words with it (optional)" : "Words — a link, a greeting…"} onChange={(e) => setItem(i, { text: e.target.value })} />
          <StepFile step={it} label="Add audio, a brochure, a photo or a video" onChange={(file) => setItem(i, { file, voice: /^audio\/(ogg|webm)/.test(file?.mime ?? "") })} />
        </div>
      ))}
      {items.length < 6 && (
        <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setItems((x) => [...x, { text: "", file: null, voice: false }])}>
          <Plus className="h-3.5 w-3.5" />Add a part
        </Button>
      )}
    </div>
  );
}

