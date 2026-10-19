"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell, Clock, CalendarClock, Check, Pencil, Trash2, AlarmClock,
  AlertCircle, CheckCircle2, Timer, ChevronDown, ChevronUp,
  Plus, ExternalLink, Loader2, RefreshCw, X, Users, UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  useMyReminders, useUpdateReminder, useDeleteReminder,
  useTeamReminderOptions, useTeamReminders, type TeamReminder,
} from "@/hooks/useReminders";
import { FollowupsSection } from "@/components/reminders/FollowupsSection";
import type { ReminderWithLead } from "@/types/lead";

// ── Types & helpers ───────────────────────────────────────────────────────────

type ReminderState = "overdue" | "soon" | "today" | "upcoming" | "done";

function getReminderState(remindAt: string, isDone: boolean): ReminderState {
  if (isDone) return "done";
  const diff = new Date(remindAt).getTime() - Date.now();
  if (diff < 0) return "overdue";
  if (diff <= 30 * 60 * 1000) return "soon";
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  if (new Date(remindAt) <= endOfDay) return "today";
  return "upcoming";
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " GST";
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const abs  = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const hrs  = Math.floor(abs / 3600000);
  const days = Math.floor(abs / 86400000);
  const suf  = diff > 0 ? "ago" : "from now";
  if (mins < 1)  return diff > 0 ? "just now" : "in <1 min";
  if (mins < 60) return `${mins}m ${suf}`;
  if (hrs < 24)  return `${hrs}h ${suf}`;
  return `${days}d ${suf}`;
}

function toDatetimeLocal(iso: string): string {
  return new Date(iso)
    .toLocaleString("sv-SE", { timeZone: "Asia/Dubai" })
    .slice(0, 16)
    .replace(" ", "T");
}

function nowIST(): string {
  return toDatetimeLocal(new Date().toISOString());
}

// ── State config ──────────────────────────────────────────────────────────────

const STATE_CFG: Record<ReminderState, {
  label: string; Icon: React.ElementType;
  card: string; badge: string; iconCls: string; dot: string;
}> = {
  overdue:  { label: "Overdue",   Icon: AlertCircle,   card: "border-red-500/40 bg-red-500/5",      badge: "bg-red-500/15 text-red-400 border-red-500/30",      iconCls: "text-red-400",             dot: "bg-red-400"    },
  soon:     { label: "Due Soon",  Icon: Timer,         card: "border-amber-500/40 bg-amber-500/5",  badge: "bg-amber-500/15 text-amber-400 border-amber-500/30", iconCls: "text-amber-400",           dot: "bg-amber-400"  },
  today:    { label: "Today",     Icon: Clock,         card: "border-blue-500/30 bg-blue-500/5",    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",    iconCls: "text-blue-400",            dot: "bg-blue-400"   },
  upcoming: { label: "Upcoming",  Icon: CalendarClock, card: "border-border bg-card",               badge: "bg-muted text-muted-foreground border-border",       iconCls: "text-muted-foreground",    dot: "bg-neutral-400"  },
  done:     { label: "Done",      Icon: CheckCircle2,  card: "border-border/40 bg-muted/30",        badge: "bg-green-500/15 text-green-400 border-green-500/30", iconCls: "text-green-400",           dot: "bg-green-400"  },
};

const GROUP_ORDER: ReminderState[] = ["overdue", "soon", "today", "upcoming", "done"];

// ── Edit form ─────────────────────────────────────────────────────────────────

function EditForm({
  reminder, onSave, onCancel, saving,
}: {
  reminder: ReminderWithLead;
  onSave: (d: { title?: string; note?: string; remindAt: string }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [title,     setTitle]     = useState(reminder.title ?? "");
  const [note,      setNote]      = useState(reminder.note  ?? "");
  const [remindAt,  setRemindAt]  = useState(toDatetimeLocal(reminder.remindAt));
  const [timeError, setTimeError] = useState("");

  function handleSave() {
    const pickedIST = new Date(`${remindAt}:00+04:00`);
    if (isNaN(pickedIST.getTime())) { setTimeError("Invalid date/time"); return; }
    if (pickedIST.getTime() <= Date.now() - 60_000) { setTimeError("Please choose a future time (GST)"); return; }
    setTimeError("");
    onSave({ title: title || undefined, note: note || undefined, remindAt: pickedIST.toISOString() });
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="mt-3 space-y-2.5 pt-3 border-t border-border/50">
        <Input
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 text-sm"
        />
        <Textarea
          placeholder="Notes (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="text-sm resize-none min-h-[60px]"
          rows={2}
        />
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <AlarmClock className="h-3 w-3" /> Remind at
            <span className="ml-auto text-[10px] text-muted-foreground/60">GST (UTC+4)</span>
          </p>
          <Input
            type="datetime-local"
            value={remindAt}
            min={nowIST()}
            onChange={(e) => { setRemindAt(e.target.value); setTimeError(""); }}
            className="h-8 text-sm"
          />
          {timeError && <p className="text-xs text-red-400">{timeError}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            size="sm"
            disabled={!remindAt || saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Reminder card ─────────────────────────────────────────────────────────────

function ReminderCard({
  reminder, editingId, onEditToggle, onRequestDelete, readOnly = false,
}: {
  reminder: ReminderWithLead;
  editingId: string | null;
  onEditToggle: (id: string | null) => void;
  onRequestDelete: (id: string, leadId: string) => void;
  /** Someone else's reminder (Team / All reminders): shown with who set it, no actions. */
  readOnly?: boolean;
}) {
  const state  = getReminderState(reminder.remindAt, reminder.isDone);
  const cfg    = STATE_CFG[state];
  const { Icon } = cfg;

  const updateMut = useUpdateReminder(reminder.lead._id);
  const isEditing = editingId === reminder._id;
  const setBy     = (reminder as Partial<TeamReminder>).owner?.name;
  const assignee  = reminder.lead.assignedTo && typeof reminder.lead.assignedTo === "object" ? reminder.lead.assignedTo.name : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      className={cn("rounded-2xl border p-4 transition-colors", cfg.card)}
    >
      <div className="flex items-start gap-3">
        {/* Icon bubble */}
        <div className="mt-0.5 rounded-lg bg-background/60 p-1.5 border border-border/50 shrink-0">
          <Icon className={cn("h-4 w-4", cfg.iconCls)} />
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* Lead name link */}
          <Link
            href={`/leads/${reminder.lead._id}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-0.5 group"
          >
            <span className="truncate max-w-[180px] font-medium">{reminder.lead.name}</span>
            <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-70 transition-opacity" />
          </Link>
          {readOnly && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5 flex-wrap">
              <UserRound className="h-3 w-3" />
              <span>Set by <span className="font-semibold text-foreground">{setBy ?? "Unknown"}</span></span>
              {assignee && assignee !== setBy && <span className="text-muted-foreground/70">· lead with {assignee}</span>}
            </p>
          )}

          {reminder.title ? (
            <p className={cn(
              "text-sm font-semibold leading-snug",
              reminder.isDone && "line-through text-muted-foreground",
            )}>
              {reminder.title}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground italic">No title</p>
          )}

          {reminder.note && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{reminder.note}</p>
          )}

          {/* Time + badge */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
              cfg.badge,
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
              {cfg.label}
            </span>
            <span className="text-xs text-muted-foreground">{formatTime(reminder.remindAt)}</span>
            {!reminder.isDone && (
              <span className="text-[10px] text-muted-foreground/70 italic">
                ({formatRelative(reminder.remindAt)})
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        {!readOnly && <div className="flex items-center gap-0.5 shrink-0">
          {updateMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-1.5" />
          ) : (
            <>
              <Button
                variant="ghost" size="icon"
                className={cn(
                  "h-7 w-7",
                  reminder.isDone
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-green-400 hover:text-green-300 hover:bg-green-500/10",
                )}
                title={reminder.isDone ? "Mark undone" : "Mark done"}
                onClick={() => updateMut.mutate({ reminderId: reminder._id, data: { isDone: !reminder.isDone } })}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="Edit"
                onClick={() => onEditToggle(isEditing ? null : reminder._id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                title="Delete"
                onClick={() => onRequestDelete(reminder._id, reminder.lead._id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>}
      </div>

      {/* Inline edit form */}
      <AnimatePresence>
        {isEditing && (
          <EditForm
            reminder={reminder}
            onSave={(d) =>
              updateMut.mutate(
                { reminderId: reminder._id, data: d },
                { onSuccess: () => onEditToggle(null) },
              )
            }
            onCancel={() => onEditToggle(null)}
            saving={updateMut.isPending}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Group section ─────────────────────────────────────────────────────────────

function GroupSection({
  state, items, editingId, onEditToggle, onRequestDelete, readOnly = false,
}: {
  state: ReminderState;
  items: ReminderWithLead[];
  editingId: string | null;
  onEditToggle: (id: string | null) => void;
  onRequestDelete: (id: string, leadId: string) => void;
  readOnly?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(state === "done");
  const cfg = STATE_CFG[state];
  const { Icon } = cfg;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      {/* Section header row */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2.5 group focus:outline-none"
      >
        <Icon className={cn("h-4 w-4 shrink-0", cfg.iconCls)} />
        <span className="text-sm font-bold text-foreground">{cfg.label}</span>
        <span className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold",
          cfg.badge,
        )}>
          {items.length}
        </span>
        <div className="flex-1 h-px bg-border/50" />
        {collapsed
          ? <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          : <ChevronUp   className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
        }
      </button>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {items.map((r) => (
                  <ReminderCard
                    key={r._id}
                    reminder={r}
                    editingId={editingId}
                    onEditToggle={onEditToggle}
                    onRequestDelete={onRequestDelete}
                    readOnly={readOnly}
                  />
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// ── Delete dialog ─────────────────────────────────────────────────────────────

function DeleteDialog({
  open, onClose, leadId, reminderId, onDeleted,
}: {
  open: boolean; onClose: () => void;
  leadId: string; reminderId: string; onDeleted: () => void;
}) {
  const del = useDeleteReminder(leadId);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete reminder?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90"
            onClick={() => del.mutate(reminderId, { onSuccess: onDeleted })}
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Main page content ─────────────────────────────────────────────────────────

function RemindersPageContent() {
  const sp     = useSearchParams();
  const router = useRouter();

  const [editingId,    setEditingId]    = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; leadId: string } | null>(null);
  const [filter,       setFilter]       = useState<"all" | "active" | "done">(() => (sp.get("filter") as "all" | "active" | "done") ?? "active");

  // Other people's reminders (2026-10-19): a Super Admin / the Sales Manager sees everyone's, a team leader their
  // teams' — only after clicking the button, and view only.
  const [view,       setView]       = useState<"mine" | "team">("mine");
  const [teamPerson, setTeamPerson] = useState("");
  const [teamTeam,   setTeamTeam]   = useState("");
  const { data: teamOptions } = useTeamReminderOptions();
  const teamScope = teamOptions?.scope ?? null;
  const inTeam    = view === "team" && !!teamScope;

  const mine = useMyReminders();
  const team = useTeamReminders({ person: teamPerson || undefined, team: teamTeam || undefined, state: filter }, inTeam);
  const { isLoading, refetch, isFetching } = inTeam ? team : mine;
  const all: ReminderWithLead[] = useMemo(
    () => (inTeam ? team.data?.items ?? [] : mine.data ?? []),
    [inTeam, team.data, mine.data],
  );
  const teamLabel = teamScope === "all" ? "All reminders" : "Team reminders";

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== "active") params.set("filter", filter);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [filter]);

  const filtered = useMemo(() => {
    if (filter === "active") return all.filter((r) => !r.isDone);
    if (filter === "done")   return all.filter((r) => r.isDone);
    return all;
  }, [all, filter]);

  const grouped = useMemo(() => {
    const map: Partial<Record<ReminderState, ReminderWithLead[]>> = {};
    for (const r of filtered) {
      const s = getReminderState(r.remindAt, r.isDone);
      (map[s] ??= []).push(r);
    }
    return map;
  }, [filtered]);

  const activeCount  = all.filter((r) => !r.isDone).length;
  const overdueCount = all.filter((r) => !r.isDone && getReminderState(r.remindAt, false) === "overdue").length;

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-10">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 shrink-0">
            <Bell className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">{inTeam ? teamLabel : "Reminders"}</h1>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-sm text-muted-foreground">
                {activeCount} active reminder{activeCount !== 1 && "s"}
              </span>
              {overdueCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-400 border border-red-500/30">
                  <AlertCircle className="h-3 w-3" />
                  {overdueCount} overdue
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {teamScope && (
            <Button
              variant={inTeam ? "default" : "outline"} size="sm" className="gap-1.5 h-9"
              onClick={() => { setView(inTeam ? "mine" : "team"); setEditingId(null); }}
            >
              {inTeam ? <><UserRound className="h-3.5 w-3.5" /> My reminders</> : <><Users className="h-3.5 w-3.5" /> {teamLabel}</>}
            </Button>
          )}
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-9 w-32 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="sm" className="gap-1.5 h-9"
            onClick={() => refetch()} disabled={isFetching}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </motion.div>

      {/* ── Team / All reminders filters ───────────────────────────────────── */}
      {inTeam && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3">
          <span className="text-xs text-muted-foreground mr-1">
            {teamScope === "all" ? "Everyone's reminders" : "Your teams' reminders"} · view only
          </span>
          {(teamOptions?.teams.length ?? 0) > 1 && (
            <Select value={teamTeam || "any"} onValueChange={(v) => { setTeamTeam(v === "any" ? "" : v); setTeamPerson(""); }}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder="Team" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">All teams</SelectItem>
                {teamOptions!.teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Select value={teamPerson || "any"} onValueChange={(v) => setTeamPerson(v === "any" ? "" : v)}>
            <SelectTrigger className="h-8 w-48 text-xs"><SelectValue placeholder="Person" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Everyone</SelectItem>
              {(teamOptions?.people ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {team.data?.capped && (
            <span className="text-[11px] text-amber-400">Showing the first 1,000 — pick a team or a person to see the rest</span>
          )}
        </div>
      )}

      {/* ── Follow-ups due (the leads' follow-up dates, 2026-10-20) ─────────── */}
      {!inTeam && filter !== "done" && !isLoading && <FollowupsSection reminders={all} />}

      {/* ── Stats strip ────────────────────────────────────────────────────── */}
      {!isLoading && all.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 sm:grid-cols-4 gap-3"
        >
          {(["overdue", "soon", "today", "upcoming"] as const).map((s) => {
            const cnt = all.filter((r) => !r.isDone && getReminderState(r.remindAt, false) === s).length;
            const cfg = STATE_CFG[s];
            const { Icon } = cfg;
            return (
              <div
                key={s}
                onClick={() => setFilter("active")}
                className={cn(
                  "rounded-xl border p-3 flex items-center gap-2.5 cursor-pointer transition-colors hover:bg-accent/30",
                  cnt > 0 ? cfg.card : "border-border/40 bg-muted/20 opacity-50",
                )}
              >
                <Icon className={cn("h-5 w-5 shrink-0", cnt > 0 ? cfg.iconCls : "text-muted-foreground")} />
                <div>
                  <p className="text-lg font-bold leading-none">{cnt}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{cfg.label}</p>
                </div>
              </div>
            );
          })}
        </motion.div>
      )}

      {/* ── Loading ────────────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* ── Empty — no reminders at all ────────────────────────────────────── */}
      {!isLoading && all.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-5 py-24 text-center"
        >
          <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-muted/60 to-muted/20 border border-border/50">
            <Bell className="h-10 w-10 text-muted-foreground/30" />
            <div className="absolute -top-1 -right-1 h-6 w-6 flex items-center justify-center rounded-full bg-primary/10 border border-primary/20">
              <Plus className="h-3.5 w-3.5 text-primary" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-lg font-semibold text-foreground">{inTeam ? "No reminders here" : "No reminders yet"}</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              {inTeam ? "Nobody in this view has a reminder for this filter" : "Open a lead and set a reminder so you never miss a follow-up"}
            </p>
          </div>
          <Link href="/leads">
            <Button variant="outline" className="gap-2 h-9">
              <Plus className="h-4 w-4" /> Browse Leads
            </Button>
          </Link>
        </motion.div>
      )}

      {/* ── Empty filtered ─────────────────────────────────────────────────── */}
      {!isLoading && all.length > 0 && Object.keys(grouped).length === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-3 py-16 text-center"
        >
          <CheckCircle2 className="h-12 w-12 text-green-400/40" />
          <p className="text-sm text-muted-foreground">No {filter} reminders</p>
          {filter !== "all" && (
            <Button variant="ghost" size="sm" onClick={() => setFilter("all")} className="gap-1.5">
              <X className="h-3.5 w-3.5" /> Show all
            </Button>
          )}
        </motion.div>
      )}

      {/* ── Grouped reminder list ──────────────────────────────────────────── */}
      {!isLoading && Object.keys(grouped).length > 0 && (
        <div className="space-y-8">
          {GROUP_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0).map((state) => (
            <GroupSection
              key={state}
              state={state}
              items={grouped[state]!}
              editingId={editingId}
              onEditToggle={setEditingId}
              onRequestDelete={(id, leadId) => setDeleteTarget({ id, leadId })}
              readOnly={inTeam}
            />
          ))}
        </div>
      )}

      {/* ── Delete confirm ─────────────────────────────────────────────────── */}
      <DeleteDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        leadId={deleteTarget?.leadId ?? ""}
        reminderId={deleteTarget?.id ?? ""}
        onDeleted={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default function RemindersPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <RemindersPageContent />
    </Suspense>
  );
}
