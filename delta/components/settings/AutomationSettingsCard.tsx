"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { Zap, Timer, Coffee, Clock, Mail, Loader2, Send, Save, Info, ArrowRight, IndianRupee } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store/authStore";
import { useAppSettings, useSendTestEmail, useUpdateAppSettings } from "@/hooks/useAppSettings";
import type { AppSettings, EmailEventKey } from "@/types/settings";

// ── Types ──────────────────────────────────────────────────────────────────────
/** What the page edits — enabledAt is the server's to set. */
type Draft = Pick<AppSettings, "idleAlerts" | "workingHours" | "email" | "bangaloreRevenue"> & {
  inactiveLeads: Omit<AppSettings["inactiveLeads"], "enabledAt">;
};

interface DurationInputProps {
  id: string;
  minutes: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  maxHours: number;
}

interface SectionProps {
  icon: React.ElementType;
  title: string;
  description: string;
  comingNext?: boolean;
  children: React.ReactNode;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_ZONES = [
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Riyadh", label: "Riyadh (AST)" },
  { value: "Europe/London", label: "London" },
  { value: "UTC", label: "UTC" },
];
const EMAIL_EVENTS: { key: EmailEventKey; label: string; hint: string }[] = [
  { key: "inactiveLeads", label: "Inactive leads", hint: "When a lead is moved on, to the person who lost it, the one who got it, and the super admins" },
  { key: "idleAlerts", label: "Idle alerts", hint: "When someone logged in has gone quiet in working hours" },
  { key: "meetings", label: "Meetings", hint: "Invites, changes, cancellations and reminders" },
];

const sectionVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const draftOf = (s: AppSettings): Draft => ({
  inactiveLeads: { autoReassign: s.inactiveLeads.autoReassign, limitMinutes: s.inactiveLeads.limitMinutes },
  idleAlerts: { ...s.idleAlerts },
  // Only from a server that has it — an older one would refuse the field.
  ...(s.bangaloreRevenue ? { bangaloreRevenue: { ...s.bangaloreRevenue } } : {}),
  workingHours: { ...s.workingHours, days: [...s.workingHours.days] },
  email: { ...s.email },
});

// ── Component ──────────────────────────────────────────────────────────────────
/**
 * "Automation & alerts" on the Settings page: when the CRM steps in on its own.
 *
 * Everything that acts on real leads or people ships switched off. Only those
 * who may edit settings can change anything; everyone else who can open the
 * page sees the values read-only.
 */
export function AutomationSettingsCard() {
  const canEdit = useAuthStore((s) => s.hasPermission("settings", "edit"));
  const { data, isLoading, error } = useAppSettings();
  const save = useUpdateAppSettings();
  const testEmail = useSendTestEmail();

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (data) setDraft(draftOf(data.settings));
  }, [data]);

  const dirty = useMemo(
    () => Boolean(data && draft && JSON.stringify(draftOf(data.settings)) !== JSON.stringify(draft)),
    [data, draft]
  );

  const problems = useMemo(() => {
    if (!draft) return [];
    const p: string[] = [];
    if (draft.inactiveLeads.limitMinutes < 5) p.push("The inactive-lead limit must be at least 5 minutes.");
    if (draft.inactiveLeads.limitMinutes > 7 * 24 * 60) p.push("The inactive-lead limit can be at most 7 days.");
    const rate = draft.bangaloreRevenue?.inrPerAed;
    if (rate !== undefined && !(rate >= 1 && rate <= 1000)) p.push("The Bangalore rate must be between ₹1 and ₹1,000 for 1 AED.");
    if (draft.idleAlerts.limitMinutes < 5) p.push("The idle limit must be at least 5 minutes.");
    if (draft.idleAlerts.limitMinutes > 24 * 60) p.push("The idle limit can be at most 24 hours.");
    if (!draft.workingHours.days.length) p.push("Pick at least one working day.");
    if (minutesOf(draft.workingHours.end) <= minutesOf(draft.workingHours.start)) p.push("Working hours must end after they start.");
    return p;
  }, [draft]);

  if (isLoading || (!draft && !error)) {
    return (
      <Card className="border-border/50 bg-card/80">
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (error || !draft || !data) {
    return (
      <Card className="border-border/50 bg-card/80">
        <CardContent className="p-6 text-sm text-muted-foreground">Could not load the automation settings.</CardContent>
      </Card>
    );
  }

  const set = <K extends keyof Draft>(group: K, patch: Partial<Draft[K]>) =>
    setDraft((d) => (d ? { ...d, [group]: { ...d[group], ...patch } } : d));

  const toggleDay = (day: number) =>
    set("workingHours", {
      days: draft.workingHours.days.includes(day)
        ? draft.workingHours.days.filter((d) => d !== day)
        : [...draft.workingHours.days, day].sort((a, b) => a - b),
    });

  return (
    <Card className="border-border/50 bg-card/80">
      <CardHeader className="pb-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          Automation & alerts
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          When the CRM steps in on its own. Anything that acts on real leads or people stays off until you switch it on.
        </p>
        {!canEdit && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" /> Only a super admin can change these.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ── Inactive leads ── */}
        <Section
          icon={Timer}
          title="Inactive leads"
          description="A lead counts as acted on when its owner changes the status, adds a note, logs a follow-up or a call, or sets a reminder. The clock only runs in working hours."
        >
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="auto-reassign" className="text-sm">Move leads nobody acted on to the next team member</Label>
            <Switch
              id="auto-reassign"
              checked={draft.inactiveLeads.autoReassign}
              onCheckedChange={(v) => set("inactiveLeads", { autoReassign: v })}
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Counts as inactive after</span>
            <DurationInput
              id="inactive-limit"
              minutes={draft.inactiveLeads.limitMinutes}
              onChange={(m) => set("inactiveLeads", { limitMinutes: m })}
              disabled={!canEdit}
              maxHours={168}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {data.settings.inactiveLeads.autoReassign && data.settings.inactiveLeads.enabledAt
                ? `Moving leads assigned since ${new Date(data.settings.inactiveLeads.enabledAt).toLocaleString("en-GB", {
                    timeZone: data.settings.workingHours.timezone,
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}. Older ones are moved by hand.`
                : "Switched on, it only moves leads assigned from then on — older ones are moved by hand."}
            </span>
            <Link href="/inactive-leads" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              See inactive leads <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </Section>

        {/* ── Idle alerts ── */}
        <Section
          icon={Coffee}
          title="Idle alerts"
          description="Alert the employee and the super admins when someone who used the app today, and hasn't signed out, has done nothing in it for a while during working hours. One alert per quiet stretch; super admins aren't tracked."
        >
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="idle-enabled" className="text-sm">Send idle alerts</Label>
            <Switch
              id="idle-enabled"
              checked={draft.idleAlerts.enabled}
              onCheckedChange={(v) => set("idleAlerts", { enabled: v })}
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">After no activity for</span>
            <DurationInput
              id="idle-limit"
              minutes={draft.idleAlerts.limitMinutes}
              onChange={(m) => set("idleAlerts", { limitMinutes: m })}
              disabled={!canEdit}
              maxHours={24}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={draft.idleAlerts.notifyTeamLeaders}
              onCheckedChange={(v) => set("idleAlerts", { notifyTeamLeaders: v === true })}
              disabled={!canEdit}
            />
            Also alert the person&apos;s team leaders
          </label>
          <div className="flex justify-end text-xs">
            <Link href="/activity" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              See who&apos;s active <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </Section>

        {/* ── Bangalore money in revenue ── */}
        {draft.bangaloreRevenue && (
          <Section
            icon={IndianRupee}
            title="Bangalore enrolments in revenue"
            description="A close for the Bangalore academy is paid in rupees. The leaderboard, the Sales TV, the reports and team pages count it in AED at this rate (AED cash taken at the close counts as its AED). Changing it re-counts every month; nothing stored changes, and finance is not affected."
          >
            <label className="space-y-1">
              <span className="text-sm text-muted-foreground">1 AED = ₹</span>
              <Input
                id="bangalore-rate"
                type="number"
                min={1}
                max={1000}
                step={0.01}
                inputMode="decimal"
                value={draft.bangaloreRevenue.inrPerAed}
                onChange={(e) => set("bangaloreRevenue", { inrPerAed: e.target.value === "" ? 0 : Number(e.target.value) })}
                disabled={!canEdit}
                className="h-9 max-w-[12rem] tabular-nums"
              />
            </label>
          </Section>
        )}

        {/* ── Working hours ── */}
        <Section icon={Clock} title="Working hours" description="Both clocks above only run inside these hours, in this time zone.">
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((label, day) => {
              const on = draft.workingHours.days.includes(day);
              return (
                <motion.button
                  key={label}
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={() => toggleDay(day)}
                  disabled={!canEdit}
                  aria-pressed={on}
                  className={cn(
                    "h-8 min-w-[3rem] rounded-full border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="time"
              aria-label="Start"
              value={draft.workingHours.start}
              onChange={(e) => set("workingHours", { start: e.target.value })}
              disabled={!canEdit}
              className="w-32"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="time"
              aria-label="End"
              value={draft.workingHours.end}
              onChange={(e) => set("workingHours", { end: e.target.value })}
              disabled={!canEdit}
              className="w-32"
            />
            <Select
              value={draft.workingHours.timezone}
              onValueChange={(v) => set("workingHours", { timezone: v })}
              disabled={!canEdit}
            >
              <SelectTrigger className="w-44" aria-label="Time zone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_ZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Section>

        {/* ── Email ── */}
        <Section icon={Mail} title="Email" description="In-app notifications and phone pushes always go. Choose which events also send an email.">
          <div className="space-y-3">
            {EMAIL_EVENTS.map((e) => (
              <div key={e.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm">{e.label}</p>
                  <p className="text-xs text-muted-foreground">{e.hint}</p>
                </div>
                <Switch
                  checked={draft.email[e.key]}
                  onCheckedChange={(v) => set("email", { [e.key]: v } as Partial<Draft["email"]>)}
                  disabled={!canEdit}
                  aria-label={`Email for ${e.label}`}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}>
                <Badge variant={data.mail.configured ? "success" : "warning"}>
                  {data.mail.configured ? "Mailbox connected" : "No mailbox yet"}
                </Badge>
              </motion.span>
              <span className="text-muted-foreground">
                {data.mail.configured
                  ? `Sending as ${data.mail.from}`
                  : "Emails are only written to the server log until SMTP settings are added to the backend .env."}
              </span>
            </div>
            {canEdit && (
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button size="sm" variant="outline" onClick={() => testEmail.mutate()} disabled={testEmail.isPending} className="gap-1.5">
                  {testEmail.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send me a test email
                </Button>
              </motion.div>
            )}
          </div>
        </Section>

        {/* ── Save ── */}
        {canEdit && (
          <div className="flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <AnimatePresence>
              {problems.length > 0 && (
                <motion.ul
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="space-y-0.5 text-xs text-destructive"
                  role="alert"
                >
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </motion.ul>
              )}
            </AnimatePresence>
            <div className="flex gap-2 sm:ml-auto">
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button variant="ghost" size="sm" disabled={!dirty || save.isPending} onClick={() => setDraft(draftOf(data.settings))}>
                  Discard
                </Button>
              </motion.div>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button size="sm" className="gap-1.5" disabled={!dirty || problems.length > 0 || save.isPending} onClick={() => save.mutate(draft)}>
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save changes
                </Button>
              </motion.div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function Section({ icon: Icon, title, description, comingNext, children }: SectionProps) {
  return (
    <motion.section variants={sectionVariants} initial="hidden" animate="visible" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {comingNext && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}>
                <Badge variant="secondary" className="text-[10px]">Coming next</Badge>
              </motion.span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-3 pl-11">{children}</div>
    </motion.section>
  );
}

/** Hours and minutes, stored as minutes. */
function DurationInput({ id, minutes, onChange, disabled, maxHours }: DurationInputProps) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 0), max) : 0);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={`${id}-hours`}
        type="number"
        inputMode="numeric"
        min={0}
        max={maxHours}
        value={hours}
        onChange={(e) => onChange(clamp(Number(e.target.value), maxHours) * 60 + mins)}
        disabled={disabled}
        className="w-20"
        aria-label="Hours"
      />
      <span className="text-sm text-muted-foreground">h</span>
      <Input
        id={`${id}-minutes`}
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        value={mins}
        onChange={(e) => onChange(hours * 60 + clamp(Number(e.target.value), 59))}
        disabled={disabled}
        className="w-20"
        aria-label="Minutes"
      />
      <span className="text-sm text-muted-foreground">min</span>
    </div>
  );
}
