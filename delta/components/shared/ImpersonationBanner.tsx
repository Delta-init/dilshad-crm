"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Eye, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listItemVariants } from "@/lib/animations";
import { endViewAs, getViewAs, type ViewAsInfo } from "@/lib/impersonation";

/** "29:05" — whole seconds left, never below zero. */
function timeLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The bar across the top while a super admin views the CRM as someone else:
 * who, that changes are made as them, the time left, and the way back. When the time
 * is up it takes them back on its own.
 */
export function ImpersonationBanner() {
  const [info, setInfo] = useState<ViewAsInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Client only: the server render has no localStorage.
  useEffect(() => {
    setInfo(getViewAs());
  }, []);

  useEffect(() => {
    if (!info) return;
    const endsAt = new Date(info.endsAt).getTime();
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= endsAt) endViewAs({ tellServer: false });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [info]);

  if (!info) return null;

  return (
    <motion.div
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      role="status"
      className="mx-1 mt-1 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-100"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Eye className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 truncate">
          Viewing as <strong className="font-semibold">{info.name}</strong>
          <span className="hidden text-amber-900/70 dark:text-amber-100/70 sm:inline"> ({info.email})</span>
        </span>
        {/* Not view only since 2026-10-30: what is done here is done as them, and recorded as done by you */}
        <span className="rounded-md bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium" title="Changes are made as them — and recorded as made by you using View as">Acting as them</span>
        <span className="text-xs tabular-nums text-amber-900/70 dark:text-amber-100/70">
          {timeLeft(new Date(info.endsAt).getTime() - now)} left
        </span>
      </div>
      <motion.div whileTap={{ scale: 0.97 }}>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 border-amber-500/50 bg-transparent text-amber-900 hover:bg-amber-500/20 hover:text-amber-900 dark:text-amber-100 dark:hover:text-amber-100"
          onClick={() => endViewAs()}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Back to my account
        </Button>
      </motion.div>
    </motion.div>
  );
}
