"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Coffee, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BREAK_KINDS, breakLabel } from "@/lib/breaks";
import { useMyBreak, useSetBreak } from "@/hooks/useBreak";

/**
 * "Take break" in the header, as the Sales CRM has it (brought here 2026-10-20):
 * while on a break the inactive-lead clock stops for your leads and none of
 * them is moved on. Taking one asks what it's for — meeting, lunch, tea or
 * washroom; every kind counts the same. Shows how long the break has run; one
 * click ends it. A break ends with the GST day too.
 */
export function BreakButton() {
  const { data } = useMyBreak();
  const { mutate, isPending } = useSetBreak();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!data?.onBreak) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [data?.onBreak]);

  const onBreak = !!data?.onBreak;
  const mins = onBreak && data?.since ? Math.max(0, Math.floor((now - new Date(data.since).getTime()) / 60_000)) : 0;
  const length = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  const kind = BREAK_KINDS.find((k) => k.value === data?.kind);

  const button = (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onBreak ? () => mutate({ on: false }) : undefined}
      disabled={isPending || !data}
      title={onBreak ? "End your break — your leads’ inactive clock runs again" : "Take a break — your leads don’t go inactive or move until you end it"}
      aria-label={onBreak ? `${breakLabel(data?.kind)}, ${length} — end it` : "Take break"}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-60",
        onBreak
          ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
          : "border-border text-muted-foreground hover:text-foreground dark:bg-muted/40",
      )}
    >
      {isPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : onBreak && kind ? (
        <span className="text-sm leading-none" aria-hidden>{kind.emoji}</span>
      ) : (
        <Coffee className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">{onBreak ? `${breakLabel(data?.kind)} · ${length} — End` : "Take break"}</span>
    </motion.button>
  );

  // On a break: one click ends it. Not on one: ask what it's for first.
  if (onBreak) return button;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <p className="px-1.5 pb-1.5 pt-0.5 text-xs font-medium text-muted-foreground">What&apos;s the break for?</p>
        <div className="grid grid-cols-2 gap-1.5">
          {BREAK_KINDS.map((k) => (
            <motion.button
              key={k.value}
              type="button"
              whileTap={{ scale: 0.97 }}
              disabled={isPending}
              onClick={() => mutate({ on: true, kind: k.value }, { onSuccess: () => setOpen(false) })}
              className="flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-card px-2 py-2.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <span className="text-lg leading-none" aria-hidden>{k.emoji}</span>
              {k.label}
            </motion.button>
          ))}
        </div>
        <p className="px-1.5 pt-2 text-[11px] leading-snug text-muted-foreground">Your leads don&apos;t go inactive or move on until you end it.</p>
      </PopoverContent>
    </Popover>
  );
}
