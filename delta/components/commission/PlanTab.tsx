"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, CheckCircle2, Hourglass, Info, Loader2, Save, UserCog, UserX, UsersRound, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  useCommissionPlan, useUpdateCommissionSettings, useUpdateCoursePlan,
} from "@/hooks/useCommission";
import { aed, TL_PAID, TL_RULE, uaeDate, usd } from "@/lib/commission";
import type { CommissionPlanView, CoursePlan } from "@/types/commission";
import { SlabsCard } from "@/components/commission/SlabsCard";

/** The plan: what each course pays, who the Sales Manager is, and what needs fixing. */
export function PlanTab() {
  const { data, isLoading, isError } = useCommissionPlan();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Couldn&apos;t load the commission plan.
      </div>
    );
  }

  const view = data.view ?? "all";
  return (
    <div className="flex flex-col gap-5">
      {view === "all" ? <HowItsPaid /> : <YourPlanNote plan={data} />}
      <PlanTable plan={data} />
      <SlabsCard plan={data} />
      {view === "all" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SalesManagerCard plan={data} />
          <ExcludedCard plan={data} />
        </div>
      )}
      {TL_PAID && view === "all" && <TeamsCard plan={data} />}
      {view === "team" && <MyTeamsCard plan={data} />}
      {data.seesHeld && <OnHoldCard plan={data} />}
    </div>
  );
}

const RULES = {
  zero_if_sm: [
    "Every sale finance approves pays its closer (Sales Staff), their team's leader (TL) and the Sales Manager (SM).",
    "A TL or the Sales Manager who closes a sale also earns the Sales Staff amount.",
    "On a team the Sales Manager leads, the TL amount is 0. He's paid as SM.",
  ],
  always: [
    "Every sale finance approves pays its closer (Sales Staff), their team's leader (TL) and the Sales Manager (SM).",
    "A TL or the Sales Manager who closes a sale also earns the Sales Staff amount.",
    "When the Sales Manager leads the team, he earns both the TL and the SM amounts.",
  ],
  never: [
    "Every sale finance approves pays its closer (Sales Staff) and the Sales Manager (SM). There's no TL commission.",
    "The Sales Manager who closes a sale also earns the Sales Staff amount.",
  ],
} as const;


/** For a team leader or a salesperson: whose plan this is, instead of the full rules (2026-10-23). */
function YourPlanNote({ plan }: { plan: CommissionPlanView }) {
  const team = plan.view === "team";
  const names = plan.teams.map((t) => t.name).join(", ");
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Info className="h-4 w-4 text-primary" /> {team ? `${names || "Your team"}'s plan` : "Your plan"}
      </p>
      <ul className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        {team ? (
          <li>{TL_PAID ? "What each course pays the Sales Staff who closes it in your team, and you as its leader." : "What each course pays the Sales Staff who closes it in your team."}</li>
        ) : (
          <li>What each course pays you when you close a sale.</li>
        )}
        <li>A sale counts once every step after the close is done — finance approved, LMS account, CS, onboarded, and the MT5 bonus approved (or no bonus promised).</li>
        <li>Each sale keeps the amounts of the day it counted.</li>
      </ul>
    </motion.div>
  );
}

/** A team leader's own teams, with who is in them. */
function MyTeamsCard({ plan }: { plan: CommissionPlanView }) {
  return (
    <Card icon={UsersRound} title={plan.teams.length === 1 ? "Your team" : "Your teams"}>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {plan.teams.map((t) => (
          <div key={t._id} className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            <p className="text-sm font-medium text-foreground">{t.name}</p>
            <p className="text-xs text-muted-foreground">
              {(t.members ?? []).map((m) => m.name).join(", ") || "No members"}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function HowItsPaid() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Info className="h-4 w-4 text-primary" /> How it&apos;s paid
      </p>
      <ul className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        {RULES[TL_RULE].map((rule) => <li key={rule}>{rule}</li>)}
        <li>A sale counts once every step after the close is done — finance approved, LMS account, CS, onboarded, and the MT5 bonus approved by a broker admin (or no bonus promised).</li>
        <li>Each sale keeps the amounts of the day it counted. Changing them here only affects sales that count later.</li>
      </ul>
    </motion.div>
  );
}

// ─── The plan, a card per course ──────────────────────────────────────────────

const ALL_FIELDS = [
  { key: "creditUsd", label: "MT5 credit (USD)", money: usd },
  { key: "sales", label: "Sales Staff (AED)", money: aed },
  { key: "tl", label: "Team Leader (AED)", money: aed },
  { key: "sm", label: "Sales Manager (AED)", money: aed },
] as const;
// Where no TL is paid there is nothing to set for one.
const FIELDS = ALL_FIELDS.filter((f) => TL_PAID || f.key !== "tl");

function PlanTable({ plan }: { plan: CommissionPlanView }) {
  return (
    <div className="divide-y divide-border/40 rounded-xl border border-border/50 bg-card">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <p className="text-sm font-semibold text-foreground">Plan per course</p>
        <p className="text-[11px] text-muted-foreground">
          {plan.canEdit ? "Edit a course's amounts, then save it" : "Read only — the plan is not edited here"}
        </p>
      </div>
      {plan.courses.map((c, i) => (
        <PlanRow key={c._id} course={c} canEdit={plan.canEdit} index={i} />
      ))}
    </div>
  );
}

type Draft = Record<keyof CoursePlan, string>;
const draftOf = (p: Partial<CoursePlan>): Draft => ({
  sales: String(p.sales ?? 0), tl: String(p.tl ?? 0), sm: String(p.sm ?? 0), creditUsd: String(p.creditUsd ?? 0),
});

function PlanRow({ course, canEdit, index }: {
  course: CommissionPlanView["courses"][number]; canEdit: boolean; index: number;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(course.commission));
  const save = useUpdateCoursePlan();
  // A save, or somebody else's, comes back as the row's new plan. Keyed on the
  // values, not the object: a refetch with nothing changed must not wipe what
  // is being typed.
  const saved = JSON.stringify(course.commission);
  useEffect(() => setDraft(draftOf(course.commission)), [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
  const values: CoursePlan = {
    sales: num(draft.sales), tl: num(draft.tl), sm: num(draft.sm), creditUsd: num(draft.creditUsd),
  };
  const invalid = Object.values(values).some((v) => !Number.isFinite(v) || v < 0);
  const dirty = (Object.keys(draft) as (keyof CoursePlan)[]).some((k) => values[k] !== course.commission[k]);
  const shown = canEdit ? values : course.commission;
  // Only the rates sent for this viewer: a salesperson's own, a team leader's own and their team's (2026-10-23).
  const fields = FIELDS.filter((f) => f.key in course.commission);
  const perSale = (shown.sales ?? 0) + (TL_PAID ? (shown.tl ?? 0) : 0) + (shown.sm ?? 0);
  const perSaleLabel = !("sm" in course.commission) ? (TL_PAID && "tl" in course.commission ? "sales + TL per sale" : "you earn per sale") : "paid per sale";
  const inactive = course.status === "inactive";

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className={cn("px-4 py-3", inactive && "opacity-60")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{course.name}</p>
          <p className="text-xs text-muted-foreground">
            Fee {aed(course.amount)}{inactive ? " · Inactive" : ""}
          </p>
        </div>
        <div className="text-right">
          <p className={cn("text-sm font-semibold tabular-nums", perSale && !invalid ? "text-primary" : "text-muted-foreground")}>
            {perSale && !invalid ? aed(perSale) : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">{perSaleLabel}</p>
        </div>
      </div>

      <div className={cn("mt-2.5 grid grid-cols-2 gap-2", fields.length >= 4 ? "sm:grid-cols-4" : fields.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {fields.map((f) => (
          <label key={f.key} className="block space-y-1">
            <span className="text-[11px] text-muted-foreground">{f.label}</span>
            {canEdit ? (
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                className={cn("h-8 text-sm tabular-nums", invalid && Number(draft[f.key]) < 0 && "border-red-500")}
              />
            ) : (
              <p className="text-sm tabular-nums text-foreground">
                {course.commission[f.key] ? f.money(course.commission[f.key]!) : <span className="text-muted-foreground/60">—</span>}
              </p>
            )}
          </label>
        ))}
      </div>

      {canEdit && dirty && (
        <div className="mt-2.5 flex items-center justify-end gap-2">
          {invalid && <p className="mr-auto text-[11px] text-red-600 dark:text-red-400">Amounts can&apos;t be negative.</p>}
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setDraft(draftOf(course.commission))}>
              Cancel
            </Button>
          </motion.div>
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              disabled={invalid || save.isPending}
              onClick={() => save.mutate({ courseId: course._id, plan: values })}
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Sales Manager and excluded logins ────────────────────────────────────────

function SalesManagerCard({ plan }: { plan: CommissionPlanView }) {
  const update = useUpdateCommissionSettings();
  const active = plan.users.filter((u) => u.status === "active");
  return (
    <Card icon={UserCog} title="Sales Manager">
      <p className="text-xs text-muted-foreground">
        Earns the SM amount on every approved sale. Sales wait while nobody is set.
      </p>
      {plan.canEdit ? (
        <Select
          value={plan.salesManager?._id ?? ""}
          onValueChange={(v) => update.mutate({ salesManager: v })}
          disabled={update.isPending}
        >
          <SelectTrigger className="mt-3 h-9">
            <SelectValue placeholder="Pick the Sales Manager" />
          </SelectTrigger>
          <SelectContent>
            {active.map((u) => (
              <SelectItem key={u._id} value={u._id}>{u.name} · {u.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="mt-3 text-sm font-medium text-foreground">
          {plan.salesManager?.name ?? <span className="text-amber-700 dark:text-amber-400">Not set</span>}
        </p>
      )}
    </Card>
  );
}

function ExcludedCard({ plan }: { plan: CommissionPlanView }) {
  const update = useUpdateCommissionSettings();
  const excludedIds = plan.excludedUsers.map((u) => u._id);
  const addable = plan.users.filter((u) => !excludedIds.includes(u._id));
  return (
    <Card icon={UserX} title="Excluded logins">
      <p className="text-xs text-muted-foreground">
        Shared logins. A sale closed under one earns nobody commission.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {plan.excludedUsers.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
        {plan.excludedUsers.map((u) => (
          <motion.span
            key={u._id}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs"
          >
            {u.name}
            {plan.canEdit && (
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Stop excluding ${u.name}`}
                disabled={update.isPending}
                onClick={() => update.mutate({ excludedUsers: excludedIds.filter((id) => id !== u._id) })}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </motion.span>
        ))}
      </div>
      {plan.canEdit && (
        <Select value="" onValueChange={(v) => update.mutate({ excludedUsers: [...excludedIds, v] })} disabled={update.isPending}>
          <SelectTrigger className="mt-3 h-9">
            <SelectValue placeholder="Exclude another login" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((u) => (
              <SelectItem key={u._id} value={u._id}>{u.name} · {u.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Card>
  );
}

// ─── What needs fixing ────────────────────────────────────────────────────────

function TeamsCard({ plan }: { plan: CommissionPlanView }) {
  const problems = plan.teams.filter((t) => t.problem);
  return (
    <Card icon={UsersRound} title="Team leaders">
      <p className="text-xs text-muted-foreground">
        Each team needs exactly one leader. A team with none, or two, holds its sales until it&apos;s fixed on the Teams page.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {plan.teams.map((t) => (
          <div
            key={t._id}
            className={cn(
              "rounded-lg border px-3 py-2",
              t.problem ? "border-amber-500/30 bg-amber-500/5" : "border-border/50 bg-muted/20",
            )}
          >
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {t.problem
                ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />}
              {t.name}
            </p>
            <p className={cn("text-xs", t.problem ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
              {t.problem
                ? `${t.problem}${t.leaders.length ? `: ${t.leaders.map((l) => l.name).join(", ")}` : ""}`
                : `TL: ${t.leaders[0]?.name}${t.leaders[0]?._id === plan.salesManager?._id ? " (Sales Manager, TL paid 0)" : ""}`}
            </p>
          </div>
        ))}
      </div>
      {problems.length === 0 && plan.teams.length > 0 && (
        <p className="mt-2 text-[11px] text-green-700 dark:text-green-400">Every team has one leader.</p>
      )}
    </Card>
  );
}

function OnHoldCard({ plan }: { plan: CommissionPlanView }) {
  return (
    <Card icon={Hourglass} title={`Sales on hold · ${plan.waiting.length}`}>
      {plan.waiting.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing is on hold.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Approved, but who earns them isn&apos;t settled yet. Each one is counted on its own once the reason is fixed.
          </p>
          {plan.waiting.map((w) => (
            <div key={w._id} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <p className="text-sm font-medium text-foreground">
                {w.studentName}
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {w.courseName || "No course"} · {w.closerName || "no closer"} · {uaeDate(w.saleDate)}
                </span>
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">{w.reason}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Card({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border/50 bg-card p-4"
    >
      <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        {title}
      </p>
      {children}
    </motion.div>
  );
}
