"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Shuffle, UserRound, Search, Check, MoveRight } from "lucide-react";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useMovePeople, useReassignInactiveLeads } from "@/hooks/useInactiveLeads";
import type { InactiveLead } from "@/types/inactiveLeads";

// ── Types ──────────────────────────────────────────────────────────────────────
interface MoveLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: InactiveLead[];
  onMoved?: () => void;
}

type Mode = "team" | "person";

interface ChoiceProps {
  active: boolean;
  disabled?: boolean;
  icon: React.ElementType;
  title: string;
  hint: string;
  onSelect: () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const panelVariants = {
  hidden: { opacity: 0, y: -6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15 } },
};

// ── Component ──────────────────────────────────────────────────────────────────
/**
 * Moves inactive leads on, by hand: each to the next person in its team by the
 * team's split rule, or all to one person the super admin picks.
 */
export function MoveLeadsDialog({ open, onOpenChange, leads, onMoved }: MoveLeadsDialogProps) {
  const withTeam = leads.filter((l) => l.team).length;
  const [mode, setMode] = useState<Mode>("team");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const reassign = useReassignInactiveLeads();

  // Start fresh each time it opens; with no team to move within, only a person will do.
  useEffect(() => {
    if (!open) return;
    setMode(withTeam > 0 ? "team" : "person");
    setSearch("");
    setQuery("");
    setPersonId(null);
  }, [open, withTeam]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Asked for only while the dialog is open on "A person I choose"; the server sorts by name.
  const { data: peopleData, isLoading: usersLoading, isError: peopleError } = useMovePeople(query, open && mode === "person");
  const people = useMemo(() => peopleData ?? [], [peopleData]);

  const owners = new Set(leads.map((l) => l.owner?.id).filter(Boolean));
  const count = leads.length;
  const names = leads.map((l) => l.name || l.phone);
  const summary = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  const canSubmit = !reassign.isPending && count > 0 && (mode === "team" ? withTeam > 0 : Boolean(personId));

  const submit = () => {
    reassign.mutate(
      { leadIds: leads.map((l) => l.id), ...(mode === "person" && personId ? { to: personId } : {}) },
      {
        onSuccess: (r) => {
          if (r.moved.length) {
            onMoved?.();
            onOpenChange(false);
          }
        },
      }
    );
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-md">
        <ResponsiveDialogHeader>
          <div className="flex items-center gap-3 px-4 sm:px-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <MoveRight className="h-5 w-5 text-primary" />
            </div>
            <ResponsiveDialogTitle>{count === 1 ? "Move this lead" : `Move ${count} leads`}</ResponsiveDialogTitle>
          </div>
          <ResponsiveDialogDescription className="px-4 pt-2 sm:px-0">
            <span className="font-medium text-foreground">{summary}</span>
            {" — "}
            the person who has {count === 1 ? "it" : "them"} now is told, and so is whoever gets {count === 1 ? "it" : "them"}.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-3 px-4 py-2 sm:px-0">
          <Choice
            active={mode === "team"}
            disabled={withTeam === 0}
            icon={Shuffle}
            title="Next in their team"
            hint={
              withTeam === 0
                ? "None of these has a team — pick a person instead."
                : `Each team's own split rule, skipping whoever has ${count === 1 ? "it" : "them"} now and anyone who lost ${count === 1 ? "it" : "them"} before.${withTeam < count ? ` ${count - withTeam} without a team will be skipped.` : ""}`
            }
            onSelect={() => setMode("team")}
          />
          <Choice
            active={mode === "person"}
            icon={UserRound}
            title="A person I choose"
            hint={count === 1 ? "Anyone active, in any team." : "All of them go to the same person."}
            onSelect={() => setMode("person")}
          />

          <AnimatePresence initial={false}>
            {mode === "person" && (
              <motion.div key="people" variants={panelVariants} initial="hidden" animate="visible" exit="exit" className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search people"
                    className="pl-8"
                    aria-label="Search people"
                  />
                </div>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1" role="listbox" aria-label="People">
                  {usersLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading people…
                    </div>
                  ) : peopleError ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">Could not load people — try again.</p>
                  ) : people.length === 0 ? (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {query ? <>Nobody matches “{query}”.</> : "Nobody to move it to."}
                    </p>
                  ) : (
                    people.map((p) => {
                      const selected = personId === p.id;
                      const hasAll = count > 0 && owners.size === 1 && owners.has(p.id);
                      return (
                        <motion.button
                          key={p.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          whileTap={{ scale: 0.97 }}
                          onClick={() => setPersonId(p.id)}
                          disabled={hasAll}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                            selected ? "bg-primary/10 text-primary" : "hover:bg-muted/60"
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {hasAll ? (count === 1 ? "Has it now" : "Has them now") : p.designation || p.email}
                            </span>
                          </span>
                          {selected && <Check className="h-4 w-4 shrink-0" />}
                        </motion.button>
                      );
                    })
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <ResponsiveDialogFooter>
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
              Cancel
            </Button>
          </motion.div>
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button onClick={submit} disabled={!canSubmit} className="w-full gap-1.5 sm:w-auto">
              {reassign.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoveRight className="h-4 w-4" />}
              {count === 1 ? "Move lead" : `Move ${count} leads`}
            </Button>
          </motion.div>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function Choice({ active, disabled, icon: Icon, title, hint, onSelect }: ChoiceProps) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
      )}
    >
      <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </motion.button>
  );
}
