"use client";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ReferenceArea, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis,
} from "recharts";
import { ArrowRight, RefreshCw, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/shared/ListStates";
import { DayRangeFilter } from "@/components/inactive-leads/DayRangeFilter";
import { useLeadWorkflow, useLeadWorkflowLeads } from "@/hooks/useInactiveLeads";
import { STATUS_META, type LeadStatus } from "@/lib/statusConfig";
import { cn, gstTodayISO } from "@/lib/utils";
import type { FilterTeam, LeadWorkflow, WorkflowCounts } from "@/types/inactiveLeads";

/*
 * Inactive Leads → Workflow, as the Sales CRM's (brought here 2026-10-17; this CRM keeps no breaks) (the user, 2026-10-17: "a map of the workflow — how
 * many leads came today, how many moved, how many with which status, by team
 * and by each employee"): the leads that came in over some days and where each
 * went, as a map, then when they came, their statuses now, each team and each
 * employee, and who lost leads to whom.
 */

const ALL = "all";
const STAGE = {
  worked: "#10b981",
  fresh: "#94a3b8",
  inactive: "#f43f5e",
  unassigned: "#64748b",
  lost: "#f59e0b",
};
const statusLabel = (s: string) => STATUS_META[s as LeadStatus]?.label ?? s.replace(/_/g, " ");
const statusColor = (s: string) => STATUS_META[s as LeadStatus]?.chartColor ?? "#64748b";
const pctOf = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const breakWords = (m: number) => (!m ? "—" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim());
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function LeadWorkflowView({ teams }: { teams: FilterTeam[] }) {
  const today = gstTodayISO();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [teamId, setTeamId] = useState(ALL);
  const [personId, setPersonId] = useState(ALL);
  const filters = {
    from: from || undefined, to: to || undefined,
    teamId: teamId === ALL ? undefined : teamId,
    personId: personId === ALL ? undefined : personId,
  };
  const { data, isLoading, isFetching, error, refetch } = useLeadWorkflow(filters);
  // The box clicked, and the leads behind it — with the same filters as the map.
  const [pick, setPick] = useState<BoxPick | null>(null);
  const boxLeads = useLeadWorkflowLeads({ ...filters, box: pick?.box, status: pick?.status }, !!pick);

  // The employee picker keeps everyone from the last look without one picked.
  const [peopleOptions, setPeopleOptions] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (data && personId === ALL) setPeopleOptions([...data.people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name })));
  }, [data, personId]);
  const personName = peopleOptions.find((p) => p.id === personId)?.name;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DayRangeFilter className="w-full sm:w-auto" label="Came in" from={from} to={to} onChange={(f, t) => { setFrom(f || today); setTo(t || f || today); }} />
        <Select value={teamId} onValueChange={(v) => { setTeamId(v); setPersonId(ALL); }}>
          <SelectTrigger className="h-9 min-w-0 grow basis-[calc(50%-0.25rem)] sm:grow-0 sm:basis-auto sm:w-44" aria-label="Team">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All teams</SelectItem>
            {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger className="h-9 min-w-0 grow basis-[calc(50%-0.25rem)] sm:grow-0 sm:basis-auto sm:w-48" aria-label="Employee">
            <SelectValue placeholder="Every employee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every employee</SelectItem>
            {peopleOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {(teamId !== ALL || personId !== ALL || from !== today || to !== today) && (
          <Button variant="ghost" size="sm" className="h-9 gap-1 text-muted-foreground" onClick={() => { setFrom(today); setTo(today); setTeamId(ALL); setPersonId(ALL); }}>
            <X className="h-3.5 w-3.5" /> Back to today
          </Button>
        )}
        <Button variant="ghost" size="icon" className="ml-auto h-9 w-9" onClick={() => refetch()} aria-label="Refresh">
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4"><Skeleton className="h-96 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : error || !data ? (
        <Card className="border-border/50"><CardContent className="p-0">
          <ErrorState onRetry={() => refetch()} />
        </CardContent></Card>
      ) : (
        <LeadWorkflowBody data={data} personName={personName} onPerson={(id) => setPersonId(id)} onBox={setPick} />
      )}
      <WorkflowBreakdown pick={pick} data={boxLeads.data} loading={boxLeads.isLoading} error={boxLeads.isError} onRetry={() => boxLeads.refetch()}
        onClose={() => setPick(null)} leadHref={(id) => `/leads/${id}`} />
    </div>
  );
}

/** The map and the charts for one answer — also what Root shows for this CRM. */
export function LeadWorkflowBody({ data, personName, onPerson, onBox }: { data: LeadWorkflow; personName?: string; onPerson?: (id: string) => void; onBox?: (pick: BoxPick) => void }) {
  const t = data.totals;
  // A CRM that keeps no breaks (Draw, Remote) says so: no break box or columns for it.
  const breaks = data.rule.breaks !== false;
  const days = data.period.from === data.period.to ? dayLabel(data.period.from) : `${dayLabel(data.period.from)} – ${dayLabel(data.period.to)}`;
  return (
    <div className="space-y-4">
      <WorkflowMap totals={t} statuses={data.statuses} onBox={onBox} breaks={breaks} title={`${personName ? `${personName}'s leads` : "Leads"} that came in · ${days}`}
        note={`Inactive = no action from the owner within ${data.rule.limitMinutes} min of the ${breaks ? "moving" : "working"} hours (${data.rule.hours.start}–${data.rule.hours.end})${breaks ? ", breaks and calls not counted" : ", calls not counted"}. ${t.moves} moves in all.`} />
      <div className="grid gap-4 lg:grid-cols-3">
        <TimelineCard data={data} />
        <StatusCard data={data} />
      </div>
      <TeamsCard data={data} breaks={breaks} />
      <PeopleCard data={data} onPerson={onPerson} breaks={breaks} />
      <MovesCard data={data} />
    </div>
  );
}

function Box({ n, label, of, tone, className, onOpen }: { n: number; label: string; of?: number; tone: "base" | "good" | "bad" | "muted"; className?: string; onOpen?: () => void }) {
  // A box opens the leads behind it (2026-10-19), when the page can show them.
  const Tag = onOpen ? motion.button : motion.div;
  return (
    <Tag initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": `${n} ${label} — see the leads` } : {})}
      className={cn("block w-full rounded-xl border px-3 py-2.5 text-center", onOpen && "cursor-pointer transition hover:ring-2 hover:ring-primary/40", className,
        tone === "good" && "border-emerald-500/30 bg-emerald-500/10",
        tone === "bad" && "border-rose-500/30 bg-rose-500/10",
        tone === "muted" && "border-border/60 bg-muted/40",
        tone === "base" && "border-border/60 bg-card")}>
      <p className={cn("text-xl font-bold tabular-nums", tone === "good" && "text-emerald-600 dark:text-emerald-400", tone === "bad" && "text-rose-600 dark:text-rose-400")}>{n.toLocaleString("en-US")}</p>
      <p className="text-xs text-muted-foreground">{label}{of !== undefined ? ` · ${pctOf(n, of)}` : ""}</p>
    </Tag>
  );
}
const Down = () => <div className="mx-auto h-4 w-px bg-border" aria-hidden />;

/** Came in → assigned → worked / within the limit / went inactive → how the inactive ones ended → their statuses now. */
export function WorkflowMap({ totals: t, statuses, title, note, breaks = true, onBox }: { totals: WorkflowCounts; statuses: LeadWorkflow["statuses"]; title: string; note: string; breaks?: boolean; onBox?: (pick: BoxPick) => void }) {
  const total = statuses.reduce((n, s) => n + s.count, 0);
  const pick = (box: string, label: string) => (onBox ? () => onBox({ box, label }) : undefined);
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-0">
        <Box n={t.came} label="came in" onOpen={pick("came", "Came in")} tone="base" className="mx-auto max-w-[14rem]" />
        <Down />
        <div className="grid grid-cols-2 gap-3 sm:mx-auto sm:max-w-xl">
          <Box n={t.assigned} label="assigned" onOpen={pick("assigned", "Assigned")} of={t.came} tone="base" />
          <Box n={t.unassigned} label="not assigned yet" onOpen={pick("unassigned", "Not assigned yet")} of={t.came} tone="muted" />
        </div>
        <Down />
        <div className="grid grid-cols-3 gap-3 sm:mx-auto sm:max-w-3xl">
          <Box n={t.worked} label="worked by the owner" onOpen={pick("worked", "Worked by the owner")} of={t.assigned} tone="good" />
          <Box n={t.fresh} label="within the limit" onOpen={pick("fresh", "Within the limit")} of={t.assigned} tone="muted" />
          <Box n={t.inactive} label="went inactive" onOpen={pick("inactive", "Went inactive")} of={t.assigned} tone="bad" />
        </div>
        <Down />
        <div className={cn("grid grid-cols-2 gap-3", breaks ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
          <Box n={t.movedAuto} label="moved automatically" onOpen={pick("moved_auto", "Moved automatically")} tone="bad" />
          <Box n={t.movedHand} label="moved by hand" onOpen={pick("moved_hand", "Moved by hand")} tone="bad" />
          {breaks && <Box n={t.onBreak} label="owner on a break" onOpen={pick("on_break", "Owner on a break")} tone="bad" />}
          <Box n={t.nobodyLeft} label="nobody left to take" onOpen={pick("nobody_left", "Nobody left to take")} tone="bad" />
          <Box n={t.waiting} label="still waiting" onOpen={pick("waiting", "Still waiting")} tone="bad" />
        </div>
        <Down />
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Where they stand now</p>
          {total === 0 ? <p className="text-xs text-muted-foreground">No leads came in.</p> : (
            <>
              <div className="flex h-7 w-full overflow-hidden rounded-lg">
                {statuses.map((s) => (
                  <button key={s.status} type="button" disabled={!onBox} onClick={() => onBox?.({ box: "status", status: s.status, label: statusLabel(s.status) })}
                    title={`${statusLabel(s.status)}: ${s.count}`} aria-label={`${statusLabel(s.status)}: ${s.count} — see the leads`}
                    className={cn("h-full", onBox && "cursor-pointer hover:opacity-80")} style={{ width: `${(s.count / total) * 100}%`, background: statusColor(s.status) }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {statuses.map((s) => (
                  <button key={s.status} type="button" disabled={!onBox} onClick={() => onBox?.({ box: "status", status: s.status, label: statusLabel(s.status) })}
                    className={cn("flex items-center gap-1.5 text-xs", onBox && "cursor-pointer hover:underline")}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: statusColor(s.status) }} />
                    {statusLabel(s.status)} <span className="font-semibold tabular-nums">{s.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <p className="pt-3 text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

const tooltip = (
  <RechartsTooltip
    cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
    content={({ active, payload, label }) => {
      if (!active || !payload?.length) return null;
      return (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
          {label !== undefined && <p className="mb-1 font-semibold">{String(label)}</p>}
          {payload.map((p) => <p key={String(p.dataKey)} style={{ color: p.color }}>{p.name}: {p.value}</p>)}
        </div>
      );
    }}
  />
);

function TimelineCard({ data }: { data: LeadWorkflow }) {
  const hour = data.timeline.unit === "hour";
  const rows = data.timeline.rows.map((r) => ({ ...r, label: hour ? `${r.key}:00` : dayLabel(r.key) }));
  const startH = Number(data.rule.hours.start.slice(0, 2)), endH = Number(data.rule.hours.end.slice(0, 2));
  return (
    <Card className="border-border/50 lg:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">When they came in{hour ? " — by hour (GST)" : " — by day"}</CardTitle>
        {hour && <p className="text-xs text-muted-foreground">Shaded: the moving hours, {data.rule.hours.start}–{data.rule.hours.end}.</p>}
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} margin={{ left: -20, right: 4, top: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.4} />
            {hour && <ReferenceArea x1={`${String(startH).padStart(2, "0")}:00`} x2={`${String(Math.max(startH, endH - (data.rule.hours.end.endsWith(":00") ? 1 : 0))).padStart(2, "0")}:00`} fill="#6366f1" fillOpacity={0.08} />}
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={hour ? 2 : "preserveStartEnd"} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            {tooltip}
            <Bar dataKey="came" name="Came in" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function StatusCard({ data }: { data: LeadWorkflow }) {
  const pie = data.statuses.map((s) => ({ name: statusLabel(s.status), value: s.count, color: statusColor(s.status) }));
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Status now</CardTitle></CardHeader>
      <CardContent>
        {pie.length === 0 ? <p className="py-16 text-center text-xs text-muted-foreground">No leads came in.</p> : (
          <>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={pie} cx="50%" cy="50%" innerRadius={45} outerRadius={72} paddingAngle={2} dataKey="value">
                  {pie.map((e) => <Cell key={e.name} fill={e.color} strokeWidth={0} />)}
                </Pie>
                {tooltip}
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              {pie.map((s) => (
                <span key={s.name} className="flex items-center gap-1.5 truncate text-xs">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="truncate">{s.name}</span><span className="ml-auto font-semibold tabular-nums">{s.value}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TeamsCard({ data, breaks }: { data: LeadWorkflow; breaks: boolean }) {
  const rows = data.teams.map((t) => ({ name: t.name, worked: t.worked, fresh: t.fresh, inactive: t.inactive, unassigned: t.unassigned }));
  if (!rows.length) return null;
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">By team</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 40 + 40)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 10, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.4} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
            {tooltip}
            <Bar dataKey="worked" name="Worked" stackId="a" fill={STAGE.worked} maxBarSize={22} />
            <Bar dataKey="fresh" name="Within the limit" stackId="a" fill={STAGE.fresh} maxBarSize={22} />
            <Bar dataKey="inactive" name="Went inactive" stackId="a" fill={STAGE.inactive} maxBarSize={22} />
            <Bar dataKey="unassigned" name="Not assigned" stackId="a" fill={STAGE.unassigned} radius={[0, 4, 4, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
        <Legend items={[["Worked", STAGE.worked], ["Within the limit", STAGE.fresh], ["Went inactive", STAGE.inactive], ["Not assigned", STAGE.unassigned]]} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b border-border/40 text-left text-xs text-muted-foreground">
              {["Team", "Came in", "Worked", "Within limit", "Went inactive", "Moved auto", "By hand", ...(breaks ? ["On a break"] : []), "Nobody left", "Not assigned"].map((h, i) => <th key={h} className={cn("pb-2 pr-3 font-medium", i && "text-right")}>{h}</th>)}
            </tr></thead>
            <tbody>
              {data.teams.map((t) => (
                <tr key={t.id ?? "none"} className="border-b border-border/20 last:border-0">
                  <td className="py-2 pr-3 font-medium">{t.name}</td>
                  {[t.came, t.worked, t.fresh, t.inactive, t.movedAuto, t.movedHand, ...(breaks ? [t.onBreak] : []), t.nobodyLeft, t.unassigned].map((v, i) => (
                    <td key={i} className={cn("py-2 pr-3 text-right tabular-nums", !v && "text-muted-foreground/50", i === 3 && v > 0 && "text-rose-500")}>{v || "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function PeopleCard({ data, onPerson, breaks }: { data: LeadWorkflow; onPerson?: (id: string) => void; breaks: boolean }) {
  const rows = useMemo(() => data.people.map((p) => ({ name: p.name, worked: p.worked, fresh: p.fresh, inactive: p.inactiveNow, lost: p.lost })), [data.people]);
  if (!rows.length) return null;
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">By employee</CardTitle>
        <p className="text-xs text-muted-foreground">Everyone who held one of these leads — theirs now, or moved from or to them.{onPerson ? " Pick a name to see only their leads." : ""}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 32 + 40)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 10, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.4} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
            {tooltip}
            <Bar dataKey="worked" name="Worked" stackId="a" fill={STAGE.worked} maxBarSize={18} />
            <Bar dataKey="fresh" name="Within the limit" stackId="a" fill={STAGE.fresh} maxBarSize={18} />
            <Bar dataKey="inactive" name="Inactive with them now" stackId="a" fill={STAGE.inactive} maxBarSize={18} />
            <Bar dataKey="lost" name="Moved away from them" stackId="a" fill={STAGE.lost} radius={[0, 4, 4, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
        <Legend items={[["Worked", STAGE.worked], ["Within the limit", STAGE.fresh], ["Inactive with them now", STAGE.inactive], ["Moved away from them", STAGE.lost]]} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="border-b border-border/40 text-left text-xs text-muted-foreground">
              {["Employee", "Held", "Theirs now", "Worked", "Within limit", "Inactive now", "Moved away", "Got from moves", ...(breaks ? ["On a break"] : []), "Status of theirs now"].map((h, i, all) => (
                <th key={h} className={cn("pb-2 pr-3 font-medium", i > 0 && i < all.length - 1 && "text-right")}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.id} className="border-b border-border/20 align-top last:border-0">
                  <td className="py-2 pr-3">
                    {onPerson ? <button type="button" onClick={() => onPerson(p.id)} className="text-left font-medium hover:text-primary hover:underline">{p.name}</button> : <span className="font-medium">{p.name}</span>}
                    <div className="text-xs text-muted-foreground">{p.team ?? "No team"}{p.active ? "" : " · deactivated"}</div>
                  </td>
                  {[p.held, p.now, p.worked, p.fresh, p.inactiveNow, p.lost, p.got].map((v, i) => (
                    <td key={i} className={cn("py-2 pr-3 text-right tabular-nums", !v && "text-muted-foreground/50", (i === 4 || i === 5) && v > 0 && "text-rose-500")}>{v || "—"}</td>
                  ))}
                  {breaks && <td className="py-2 pr-3 text-right tabular-nums">{breakWords(p.breakMinutes)}</td>}
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(p.statuses).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                        <span key={s} className="rounded-full border px-1.5 py-0.5 text-[11px]" style={{ borderColor: statusColor(s), color: statusColor(s) }}>{statusLabel(s)} {n}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function MovesCard({ data }: { data: LeadWorkflow }) {
  if (!data.movesMap.length) return null;
  const max = Math.max(...data.movesMap.map((m) => m.count));
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Who lost leads to whom</CardTitle></CardHeader>
      <CardContent className="space-y-1.5">
        {data.movesMap.map((m) => (
          <div key={`${m.from.id}-${m.to.id}`} className="flex items-center gap-3 text-sm">
            <span className="w-32 truncate text-right font-medium sm:w-40">{m.from.name}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="w-32 truncate font-medium sm:w-40">{m.to.name}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-rose-500/70" style={{ width: `${Math.max(4, (m.count / max) * 100)}%` }} />
            </span>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{m.count} · {m.automatic} auto</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Legend({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{label}
        </span>
      ))}
    </div>
  );
}

// ─── The leads behind a box (the user, 2026-10-19: "click a card and see its breakdown") ─────────────────────────────

/** A box of the map, or one status in "where they stand now". */
export interface BoxPick { box: string; label: string; status?: string }
export interface WorkflowLeadRow {
  id: string; name: string; phone: string; source: string; status: string; stage: string;
  owner: { id: string; name: string } | null; team: { id: string; name: string } | null;
  cameIn: string; assignedAt: string | null;
  move: { from: { id: string; name: string }; to: { id: string; name: string }; at: string; kind: "automatic" | "manual"; times: number } | null;
  waitedMinutes: number | null;
  breakSince: string | null;
}
export interface WorkflowLeads {
  box: string; status: string | null; total: number; capped: boolean; rows: WorkflowLeadRow[];
  byOwner: Array<{ id: string | null; name: string; count: number }>;
  byTeam: Array<{ id: string | null; name: string; count: number }>;
}

const gstWhen = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—");
const waited = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`);

/** The breakdown window: the leads behind the box picked, and how many each owner and team holds. */
export function WorkflowBreakdown({ pick, data, loading, error, onRetry, onClose, leadHref }: {
  pick: BoxPick | null; data?: WorkflowLeads; loading: boolean; error: boolean; onRetry: () => void; onClose: () => void;
  /** Where a lead opens ("" or null: not a link). */
  leadHref: (id: string) => string | null;
}) {
  const [tab, setTab] = useState<"list" | "owner" | "team">("list");
  return (
    <Dialog open={!!pick} onOpenChange={(open) => { if (!open) { onClose(); setTab("list"); } }}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{pick?.label}{data ? ` · ${data.total.toLocaleString("en-US")} lead${data.total === 1 ? "" : "s"}` : ""}</DialogTitle>
          <DialogDescription>The leads behind this box, newest first — with the same dates, team and employee as the map.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5" role="tablist">
          {([["list", "List"], ["owner", "By owner"], ["team", "By team"]] as const).map(([k, l]) => (
            <Button key={k} size="sm" role="tab" aria-selected={tab === k} variant={tab === k ? "default" : "outline"} onClick={() => setTab(k)}>{l}</Button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? <Skeleton className="h-64 w-full" /> : error || !data ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Could not load these leads. <Button variant="link" size="sm" onClick={onRetry}>Try again</Button>
            </div>
          ) : data.total === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No leads here.</p> : tab === "list" ? (
            <>
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 bg-background"><tr className="border-b border-border/40 text-left text-xs text-muted-foreground">
                  {["Lead", "Owner", "Status", "Came in · assigned", "Detail"].map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>
                  {data.rows.map((r) => {
                    const href = leadHref(r.id);
                    return (
                      <tr key={r.id} className="border-b border-border/20 align-top last:border-0">
                        <td className="py-2 pr-3">
                          {href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="font-medium hover:text-primary hover:underline">{r.name || "Unnamed lead"}</a>
                            : <span className="font-medium">{r.name || "Unnamed lead"}</span>}
                          <div className="text-xs text-muted-foreground">{r.phone}{r.source ? ` · ${r.source}` : ""}</div>
                        </td>
                        <td className="py-2 pr-3">{r.owner?.name ?? <span className="text-muted-foreground">Not assigned</span>}<div className="text-xs text-muted-foreground">{r.team?.name ?? "No team"}</div></td>
                        <td className="py-2 pr-3"><span className="rounded-full border px-1.5 py-0.5 text-[11px]" style={{ borderColor: statusColor(r.status), color: statusColor(r.status) }}>{statusLabel(r.status)}</span></td>
                        <td className="py-2 pr-3 text-xs">{gstWhen(r.cameIn)}<div className="text-muted-foreground">{r.assignedAt ? `assigned ${gstWhen(r.assignedAt)}` : "—"}</div></td>
                        <td className="py-2 pr-3 text-xs">
                          {r.move ? <div>{r.move.from.name} → {r.move.to.name}<div className="text-muted-foreground">{r.move.kind === "automatic" ? "automatically" : "by hand"} · {gstWhen(r.move.at)}{r.move.times > 1 ? ` · moved ${r.move.times}×` : ""}</div></div> : null}
                          {r.waitedMinutes != null ? <div className="text-rose-500">waited {waited(r.waitedMinutes)}</div> : null}
                          {r.breakSince ? <div className="text-muted-foreground">on a break since {gstWhen(r.breakSince)}</div> : null}
                          {!r.move && r.waitedMinutes == null && !r.breakSince ? <span className="text-muted-foreground/60">—</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.capped && <p className="pt-2 text-xs text-muted-foreground">Showing the newest {data.rows.length.toLocaleString("en-US")} of {data.total.toLocaleString("en-US")} — the By owner and By team tabs count them all.</p>}
            </>
          ) : (
            <div className="space-y-1.5">
              {(tab === "owner" ? data.byOwner : data.byTeam).map((x) => {
                const max = Math.max(...(tab === "owner" ? data.byOwner : data.byTeam).map((y) => y.count));
                return (
                  <div key={x.id ?? x.name} className="flex items-center gap-3 text-sm">
                    <span className="w-44 shrink-0 truncate font-medium">{x.name}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (x.count / max) * 100)}%` }} /></span>
                    <span className="w-24 shrink-0 text-right tabular-nums">{x.count} <span className="text-xs text-muted-foreground">{pctOf(x.count, data.total)}</span></span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
