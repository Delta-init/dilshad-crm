"use client";

import { motion } from "framer-motion";
import {
  CircleCheck, CircleHelp, CircleMinus, CircleX, Clock, Gift, GraduationCap, Headset, Receipt, UserCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrolmentStep } from "@/hooks/useEnrolments";

/* ─────────────────────────────────────────────────────────────────────────────
   An enrolment's five steps after the close (the user, 2026-10-04): finance
   approved → LMS account → CS assigned → onboarded → MT5 bonus approved. Green
   done, yellow waiting, red stopped; grey when not known yet, or not needed (a
   course CS Portal doesn't take). Commission counts once finance has
   approved — the first step (2026-10-26); the others are shown, not waited on.
   The server works the steps out (backend/src/services/enrolmentSteps.ts);
   this only draws them — a strip on each My Enrolments card, and the full list
   on the enrolment's own page.
───────────────────────────────────────────────────────────────────────────── */

const STEP_ICON = { finance: Receipt, lms: GraduationCap, cs: Headset, onboarded: UserCheck, bonus: Gift } as const;
const STATE_ICON = { done: CircleCheck, waiting: Clock, failed: CircleX, unknown: CircleHelp, skipped: CircleMinus } as const;

// Readable on the light theme's white cards as well as the dark one's.
const TONE = {
  done: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
  waiting: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  unknown: "border-border/60 bg-muted/40 text-muted-foreground",
  skipped: "border-border/60 bg-muted/30 text-muted-foreground",
} as const;
const LINE = {
  done: "bg-green-500/50",
  waiting: "bg-amber-500/40",
  failed: "bg-red-500/50",
  unknown: "bg-border",
  skipped: "bg-border",
} as const;
const STATE_TEXT = { done: "Done", waiting: "Waiting", failed: "Stopped", unknown: "Not known yet", skipped: "Not needed" } as const;

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("en-AE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" })
    : "";

/** The five steps in a row — for a My Enrolments card. Each step's detail is on hover. */
export function EnrolmentStepsStrip({ steps }: { steps?: EnrolmentStep[] }) {
  if (!steps?.length) return null;
  return (
    <div className="mt-3 border-t border-border/40 pt-2.5">
      <div className="flex flex-wrap items-center gap-y-1.5">
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.key];
          return (
            <div key={s.key} className="flex items-center">
              {i > 0 && <span className={cn("mx-1 hidden h-px w-4 sm:block", LINE[steps[i - 1]!.state])} aria-hidden />}
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: i * 0.04 }}
                title={[s.label, STATE_TEXT[s.state], s.detail, s.by ? `by ${s.by}` : "", when(s.at)].filter(Boolean).join(" · ")}
                className={cn("mr-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium sm:mr-0", TONE[s.state])}
              >
                <Icon className="h-3 w-3" />
                {s.label}
              </motion.span>
            </div>
          );
        })}
      </div>
      <StepsSummary steps={steps} />
    </div>
  );
}

/** One line under the strip: what it waits on, or that every step is done. */
function StepsSummary({ steps }: { steps: EnrolmentStep[] }) {
  const open = steps.find((s) => s.state !== "done" && s.state !== "skipped");
  if (!open) {
    return <p className="mt-1.5 text-[11px] text-green-700 dark:text-green-400">Every step done — this sale counts for commission.</p>;
  }
  // Commission counts at finance's approval (2026-10-26): once that step is done, say so beside what is still open.
  const counts = steps.some((s) => s.key === "finance" && s.state === "done");
  const tone = open.state === "failed" ? "text-red-700 dark:text-red-400" : open.state === "waiting" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
  return (
    <p className={cn("mt-1.5 text-[11px]", tone)}>
      {open.state === "failed" ? "Stopped at" : "Next step"}: {open.label}{open.detail ? ` — ${open.detail}` : ""}
      {counts && <span className="text-green-700 dark:text-green-400"> · counts for commission</span>}
    </p>
  );
}

/** The five steps, one under another, with what each says and who did it when — for the enrolment's own page. */
export function EnrolmentStepsList({ steps }: { steps?: EnrolmentStep[] }) {
  if (!steps?.length) return <p className="text-sm text-muted-foreground">Not known yet.</p>;
  return (
    <ol className="relative space-y-3">
      {steps.map((s, i) => {
        const Icon = STEP_ICON[s.key];
        const StateIcon = STATE_ICON[s.state];
        return (
          <motion.li
            key={s.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="relative flex gap-3"
          >
            {i < steps.length - 1 && <span className={cn("absolute left-[15px] top-8 h-[calc(100%-12px)] w-px", LINE[s.state])} aria-hidden />}
            <span className={cn("z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", TONE[s.state])}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{i + 1}. {s.label}</p>
                <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", TONE[s.state])}>
                  <StateIcon className="h-3 w-3" />
                  {STATE_TEXT[s.state]}
                </span>
              </div>
              {s.detail && <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>}
              {(s.by || s.at) && (
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                  {[s.by ? `By ${s.by}` : "", when(s.at)].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}
