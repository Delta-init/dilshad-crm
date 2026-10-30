"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Plus, Save, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUpdateSlab } from "@/hooks/useCommission";
import { aed, monthLabel, ROLE_LABEL } from "@/lib/commission";
import type { CommissionPlanView, CommissionRole, SlabRow } from "@/types/commission";

/*
 * The salary slabs on the Plan tab: one ladder per role — the monthly sales a
 * level starts at, its salary, and the share of commission it pays. A Super
 * Admin edits them; a change holds from this month on, earlier months keep
 * theirs. The first row is the base, below the first level.
 */

/** Sales Staff (team leaders too, on their own sales) and the Sales Manager. */
const ROLES: CommissionRole[] = ["sales", "sm"];

const BASIS: Record<CommissionRole, string> = {
  sales: "Counts their own approved sales — team leaders too",
  tl: "Counts their team's approved sales",
  sm: "Counts every approved sale in the CRM",
};

export function SlabsCard({ plan }: { plan: CommissionPlanView }) {
  if (!plan.slabs) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border/50 bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Wallet className="h-4 w-4" />
          </span>
          Salary slabs
        </p>
        <p className="text-[11px] text-muted-foreground">
          {plan.canEdit && plan.slabsMonth
            ? `A change holds from ${monthLabel(plan.slabsMonth)} on — earlier months keep theirs`
            : "Read only — the slabs are not edited here"}
          {plan.slabsFrom ? ` · last changed for ${monthLabel(plan.slabsFrom)}` : ""}
        </p>
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-2 2xl:grid-cols-3">
        {/* Only the roles this viewer may see are sent (2026-10-23). */}
        {ROLES.filter((role) => plan.slabs![role]).map((role) => (
          <SlabEditor key={role} role={role} rows={plan.slabs![role]!} canEdit={plan.canEdit} />
        ))}
      </div>
      <p className="border-t border-border/40 px-4 py-2.5 text-[11px] text-muted-foreground">
        Pay = the level&apos;s salary + the month&apos;s commission × its share. The target counts the course fee of sales finance approved, in the month they were closed — a part-paid one in the month it&apos;s paid in full.
      </p>
    </motion.div>
  );
}

type Draft = { name: string; target: string; salary: string; percent: string };
const draftOf = (rows: SlabRow[]): Draft[] =>
  rows.map((r) => ({ name: r.name, target: String(r.target), salary: String(r.salary), percent: String(r.percent) }));
const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

/** What's wrong with the rows as typed, or null. The server checks the same. */
function problemOf(rows: SlabRow[]): string | null {
  if (rows.some((r) => !r.name.trim())) return "Name every level.";
  if (rows.some((r) => [r.target, r.salary, r.percent].some((v) => !Number.isFinite(v) || v < 0))) return "Fill every amount — none negative.";
  if (rows.some((r) => r.percent > 100)) return "A share can't be over 100%.";
  for (let i = 1; i < rows.length; i++) {
    if (!(rows[i]!.target > rows[i - 1]!.target)) return `Each level must start higher than the one above it (row ${i + 1}).`;
  }
  return null;
}

function SlabEditor({ role, rows, canEdit }: { role: CommissionRole; rows: SlabRow[]; canEdit: boolean }) {
  const [draft, setDraft] = useState<Draft[]>(() => draftOf(rows));
  const save = useUpdateSlab();
  // A save, or somebody else's, comes back as the new rows. Keyed on the
  // values: a refetch with nothing changed must not wipe what is being typed.
  const saved = JSON.stringify(rows);
  useEffect(() => setDraft(draftOf(rows)), [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const values: SlabRow[] = draft.map((d, i) => ({
    name: d.name.trim(),
    target: i === 0 ? 0 : num(d.target),
    salary: num(d.salary),
    percent: num(d.percent),
  }));
  const problem = problemOf(values);
  const dirty = JSON.stringify(values) !== saved;
  const set = (i: number, key: keyof Draft, v: string) =>
    setDraft((rs) => rs.map((r, k) => (k === i ? { ...r, [key]: v } : r)));

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 p-3">
      <p className="text-sm font-semibold text-foreground">{ROLE_LABEL[role]}</p>
      <p className="mb-2 text-[11px] text-muted-foreground">{BASIS[role]}</p>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_20px] items-center gap-x-1.5 gap-y-1.5">
        <span className="text-[10px] text-muted-foreground">Level</span>
        <span className="text-[10px] text-muted-foreground">Sales from (AED)</span>
        <span className="text-[10px] text-muted-foreground">Salary (AED)</span>
        <span className="text-[10px] text-muted-foreground">Share %</span>
        <span />
        {draft.map((d, i) =>
          canEdit ? (
            <SlabInputs key={i} draft={d} base={i === 0} onChange={(k, v) => set(i, k, v)} onRemove={() => setDraft((rs) => rs.filter((_, k) => k !== i))} />
          ) : (
            <ReadRow key={i} row={rows[i]!} base={i === 0} />
          ),
        )}
      </div>

      {canEdit && (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
          {problem && dirty && <p className="mr-auto text-[11px] text-red-600 dark:text-red-400">{problem}</p>}
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              disabled={draft.length >= 12}
              onClick={() => setDraft((rs) => [...rs, { name: "", target: "", salary: "", percent: "" }])}
            >
              <Plus className="h-3.5 w-3.5" /> Level
            </Button>
          </motion.div>
          {dirty && (
            <>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDraft(draftOf(rows))}>
                  Cancel
                </Button>
              </motion.div>
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button
                  size="sm"
                  className="h-7 gap-1 px-2.5 text-xs"
                  disabled={Boolean(problem) || save.isPending}
                  onClick={() => save.mutate({ role, rows: values })}
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </Button>
              </motion.div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SlabInputs({ draft, base, onChange, onRemove }: {
  draft: Draft; base: boolean; onChange: (key: keyof Draft, v: string) => void; onRemove: () => void;
}) {
  const cls = "h-8 px-2 text-xs tabular-nums";
  return (
    <>
      <Input value={draft.name} maxLength={20} onChange={(e) => onChange("name", e.target.value)} className={cls} aria-label="Level name" />
      {base ? (
        <span className="px-2 text-xs text-muted-foreground">Base (0)</span>
      ) : (
        <Input type="number" min="0" step="1" inputMode="decimal" value={draft.target} onChange={(e) => onChange("target", e.target.value)} className={cls} aria-label="Sales from" />
      )}
      <Input type="number" min="0" step="1" inputMode="decimal" value={draft.salary} onChange={(e) => onChange("salary", e.target.value)} className={cls} aria-label="Salary" />
      <Input type="number" min="0" max="100" step="1" inputMode="decimal" value={draft.percent} onChange={(e) => onChange("percent", e.target.value)} className={cls} aria-label="Share of commission" />
      {base ? (
        <span />
      ) : (
        <button type="button" onClick={onRemove} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Remove this level">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </>
  );
}

function ReadRow({ row, base }: { row: SlabRow; base: boolean }) {
  return (
    <>
      <span className="truncate text-xs font-medium text-foreground">{row.name}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{base ? "Below the first" : aed(row.target)}</span>
      <span className="text-xs tabular-nums text-foreground">{aed(row.salary)}</span>
      <span className="text-xs tabular-nums text-foreground">{row.percent}%</span>
      <span />
    </>
  );
}
