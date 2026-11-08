"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BookmarkCheck, KeyRound, Loader2, Lock, MessageCircle, Repeat, Save, Sparkles, Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { listItemVariants } from "@/lib/animations";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { errMsg, useSaveTeamWhatsApp, useTeamWhatsApp, type WAFirstReplyItem, type WAFollowupStep, type WAKeywordRule, type WASavedGroup } from "@/hooks/useWhatsApp";
import { FirstReplyEditor, KeywordRepliesEditor, SavedGroupsEditor, StepsEditor } from "@/components/whatsapp/MessageEditors";

/*
 * A team's WhatsApp (the owner, 2026-11-08: "by the team, on the team's page"): its automatic follow-ups — on or off,
 * how many a day from each person's WhatsApp, the steps — and its first reply. Its leader or a Super Admin changes
 * them; its people see them. Sent from each person's own linked WhatsApp: follow-ups to the team's leads, the first
 * reply to anyone writing to someone in the team for the first time. And its saved messages, in groups (2026-11-08),
 * sent by hand from any chat.
 */

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", on ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/50")} />{label} {on ? "on" : "off"}
    </motion.span>
  );
}

export function TeamWhatsAppTab({ teamId }: { teamId: string }) {
  const { data, isLoading, isError, error } = useTeamWhatsApp(teamId);
  const save = useSaveTeamWhatsApp();
  const [enabled, setEnabled] = useState(false);
  const [limit, setLimit] = useState(60);
  const [steps, setSteps] = useState<WAFollowupStep[]>([]);
  const [frOn, setFrOn] = useState(false);
  const [frItems, setFrItems] = useState<WAFirstReplyItem[]>([]);
  const [groups, setGroups] = useState<WASavedGroup[]>([]);
  const [kwOn, setKwOn] = useState(false);
  const [rules, setRules] = useState<WAKeywordRule[]>([]);
  const load = () => {
    if (!data) return;
    setEnabled(data.enabled); setLimit(data.dailyLimit); setSteps(data.steps);
    setFrOn(data.firstReply.enabled); setFrItems(data.firstReply.items); setGroups(data.savedGroups ?? []);
    setKwOn(data.keywordReplies?.enabled ?? false); setRules(data.keywordReplies?.rules ?? []);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [data]);

  // Changed since it was loaded: the save bar shows.
  const dirty = useMemo(() => !!data && JSON.stringify({ enabled, limit, steps, frOn, frItems, groups, kwOn, rules })
    !== JSON.stringify({ enabled: data.enabled, limit: data.dailyLimit, steps: data.steps, frOn: data.firstReply.enabled, frItems: data.firstReply.items, groups: data.savedGroups ?? [],
      kwOn: data.keywordReplies?.enabled ?? false, rules: data.keywordReplies?.rules ?? [] }),
  [data, enabled, limit, steps, frOn, frItems, groups, kwOn, rules]);

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (isError || !data) return <p className="py-16 text-center text-sm text-muted-foreground">{errMsg(error, "Couldn't load this team's WhatsApp settings")}</p>;
  const canEdit = data.canEdit;

  const submit = async () => {
    if (frOn && !frItems.length) { toast.error("Add what the first reply sends, or switch it off"); return; }
    try {
      if (groups.some((g) => !g.name.trim())) { toast.error("Give every saved-messages group a name"); return; }
      if (rules.some((x) => !x.keywords.length || !x.reply)) { toast.error("Each keyword reply needs a word and a saved message"); return; }
      const r = await save.mutateAsync({ teamId, enabled, dailyLimit: limit, steps, firstReply: { enabled: frOn, items: frItems }, savedGroups: groups, keywordReplies: { enabled: kwOn, rules } });
      toast.success(`Saved — follow-ups ${r.enabled ? "on" : "off"}, first reply ${r.firstReply.enabled ? "on" : "off"} for ${data.team.name}`);
    } catch (e) { toast.error(errMsg(e, "Not saved")); }
  };

  return (
    <div className="space-y-4 pb-20">
      {/* Where it stands */}
      <motion.div variants={listItemVariants} initial="hidden" animate="visible">
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className="rounded-lg bg-primary/10 p-2"><MessageCircle className="h-5 w-5 text-primary" /></span>
              <div>
                <p className="font-semibold">{data.team.name}&apos;s WhatsApp</p>
                <p className="text-xs text-muted-foreground">
                  Sent from each person&apos;s own linked WhatsApp. Use <code>{"{name}"}</code> for the client&apos;s first name and <code>{"{salesperson}"}</code> for yours.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip on={data.enabled} label="Follow-ups" />
              <Chip on={data.firstReply.enabled} label="First reply" />
              <Chip on={!!data.keywordReplies?.enabled} label="Keyword replies" />
            </div>
          </CardContent>
          {(!canEdit || !data.saved || data.updatedByName) && (
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              {!canEdit && <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />Only the team&apos;s leader or a Super Admin changes these.</span>}
              {!data.saved && <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3" />Not set up yet — nothing goes out. The steps below are a suggestion.</span>}
              {data.updatedByName && <span>Last saved by {data.updatedByName}{data.updatedAt ? `, ${fmtWhen(data.updatedAt)}` : ""}</span>}
            </div>
          )}
        </Card>
      </motion.div>

      <fieldset disabled={!canEdit || save.isPending} className="space-y-4 disabled:opacity-90">
        {/* Follow-ups */}
        <motion.div variants={listItemVariants} initial="hidden" animate="visible">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-3 text-base">
                <span className="flex items-center gap-2"><Repeat className="h-4 w-4 text-primary" />Automatic follow-ups</span>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Send automatic follow-ups" />
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                When one of the team&apos;s leads doesn&apos;t answer, the salesperson&apos;s WhatsApp follows up step by step, inside the working hours.
                It stops when they answer, are Closed, Lost or Repeated, or someone presses Stop on the lead; writing to them again starts it over.
                {data.enabled && data.startedAt ? ` On since ${fmtWhen(data.startedAt)} — only chats written in since then.` : " Switched on, only chats written in from then on."}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Label htmlFor={`wa-limit-${teamId}`} className="text-sm">At most</Label>
                <Input id={`wa-limit-${teamId}`} type="number" min={1} max={300} className="h-8 w-20" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
                <span className="text-sm text-muted-foreground">a day from each person&apos;s WhatsApp (one every 1–2 minutes)</span>
              </div>
              <StepsEditor steps={steps} setSteps={setSteps} />
            </CardContent>
          </Card>
        </motion.div>

        {/* First reply */}
        <motion.div variants={listItemVariants} initial="hidden" animate="visible">
          <FirstReplyEditor id={`wa-fr-${teamId}`} on={frOn} setOn={setFrOn} items={frItems} setItems={setFrItems}
            help={`When someone messages the WhatsApp of someone in ${data.team.name} for the first time ever, these go out a minute later, in order — unless someone answered them first.`} />
        </motion.div>
        {/* Saved messages, in groups */}
        <motion.div variants={listItemVariants} initial="hidden" animate="visible">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><BookmarkCheck className="h-4 w-4 text-primary" />Saved messages</CardTitle>
              <p className="text-xs text-muted-foreground">
                Ready answers for the team, in groups. Anyone in {data.team.name} sends one — or a whole group, in order — from a chat&apos;s bookmark button, any time.
              </p>
            </CardHeader>
            <CardContent><SavedGroupsEditor groups={groups} setGroups={setGroups} /></CardContent>
          </Card>
        </motion.div>

        {/* Keyword replies */}
        <motion.div variants={listItemVariants} initial="hidden" animate="visible">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4 text-primary" />Keyword replies</CardTitle>
            </CardHeader>
            <CardContent><KeywordRepliesEditor on={kwOn} setOn={setKwOn} rules={rules} setRules={setRules} groups={groups} /></CardContent>
          </Card>
        </motion.div>
      </fieldset>

      {/* Save bar — when something changed */}
      {canEdit && dirty && (
        <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
          className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
          <span className="text-sm font-medium">Unsaved changes</span>
          <div className="flex gap-2">
            <motion.div whileTap={{ scale: 0.97 }}>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={load} disabled={save.isPending}><Undo2 className="h-3.5 w-3.5" />Discard</Button>
            </motion.div>
            <motion.div whileTap={{ scale: 0.97 }}>
              <Button size="sm" className="gap-1.5" onClick={submit} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save
              </Button>
            </motion.div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
