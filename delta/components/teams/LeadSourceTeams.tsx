"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Route, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { listItemVariants } from "@/lib/animations";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useLeadSourceRules, useSetLeadSourceRule } from "@/hooks/useTeams";

/**
 * Lead sources → teams (the owner, 2026-11-03): for each source, the teams its automatic split may give leads to —
 * sheet leads, the website form, repeats and the Auto-assign button. A source with no team picked goes to every team
 * with auto-assign on. Teams picked by hand (Split, an upload's teams) are not affected. Super Admin only.
 */
export function LeadSourceTeams() {
  const { data, isLoading, isError } = useLeadSourceRules();
  const save = useSetLeadSourceRule();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const teams = useMemo(() => (data?.teams ?? []).filter((t) => t.active), [data]);
  const defaults = teams.filter((t) => t.autoAssign).map((t) => t.name);
  const rows = (data?.sources ?? []).filter((r) => r.source.toLowerCase().includes(q.trim().toLowerCase()));

  const toggle = (source: string, current: string[], teamId: string, teamName: string) => {
    const next = current.includes(teamId) ? current.filter((t) => t !== teamId) : [...current, teamId];
    setBusy(`${source}|${teamId}`);
    save.mutate({ source, teams: next }, {
      onSuccess: () => toast.success(next.length ? `${source}: ${current.includes(teamId) ? "not to" : "to"} ${teamName}` : `${source}: back to every team with auto-assign on`),
      onSettled: () => setBusy(""),
    });
  };

  return (
    <motion.div variants={listItemVariants} initial="hidden" animate="visible">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="rounded-md bg-primary/10 p-1.5"><Route className="h-4 w-4 text-primary" /></span>
            Lead sources → teams
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pick the teams each source&apos;s new leads are split to. A source with no team picked goes to every team with
            auto-assign on{defaults.length ? ` (${defaults.join(", ")})` : ""}. Splitting by hand isn&apos;t affected.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sources…" className="pl-9" />
          </div>
          {isLoading && <p className="py-6 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading sources…</p>}
          {isError && <p className="py-6 text-center text-sm text-destructive">Couldn&apos;t load the sources — reload the page.</p>}
          {!isLoading && !isError && rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{q ? "No source matches" : "No lead sources yet"}</p>}
          <div className="divide-y rounded-lg border">
            {rows.map((r) => (
              <div key={r.source} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.source}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.leads.toLocaleString()} lead{r.leads === 1 ? "" : "s"}
                    {r.teams.length ? (r.updatedByName ? ` · set by ${r.updatedByName}` : "") : " · every team with auto-assign on"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {teams.map((t) => {
                    const on = r.teams.includes(t.id);
                    const spinning = busy === `${r.source}|${t.id}`;
                    return (
                      <motion.button key={t.id} type="button" whileTap={{ scale: 0.97 }} disabled={!!busy}
                        onClick={() => toggle(r.source, r.teams, t.id, t.name)}
                        title={t.autoAssign ? "" : "Auto-assign is off in this team: its leads wait there to be given out"}
                        className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60",
                          on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                        {spinning && <Loader2 className="h-3 w-3 animate-spin" />}
                        {t.name}
                        {!t.autoAssign && <span className="text-[10px] opacity-70">(auto off)</span>}
                      </motion.button>
                    );
                  })}
                  {!r.teams.length && <Badge variant="outline" className="text-[11px]">Default</Badge>}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
