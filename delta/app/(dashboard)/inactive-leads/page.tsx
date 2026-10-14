"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Hourglass,
  History,
  UserX,
  Search,
  Settings2,
  MoveRight,
  Bot,
  UserRound,
  CircleAlert,
  TimerOff,
  X,
  RefreshCw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/shared/StatCard";
import { Pager } from "@/components/shared/Pager";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/shared/ListStates";
import { listContainerVariants, listItemVariants, pageVariants } from "@/lib/animations";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store/authStore";
import { useTeams } from "@/hooks/useTeams";
import { INACTIVE_LEADS_KEY, useInactiveLeads, useLeadMoves } from "@/hooks/useInactiveLeads";
import { MoveLeadsDialog } from "@/components/inactive-leads/MoveLeadsDialog";
import type { AutoMoveState, InactiveLead, InactiveRule, LeadMoveEntry } from "@/types/inactiveLeads";

// ── Types ──────────────────────────────────────────────────────────────────────
type Tab = "inactive" | "moves";
type BadgeVariant = "default" | "secondary" | "warning" | "success" | "destructive" | "outline";

// ── Constants ──────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;
const ALL = "all";
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_ZONE = "Asia/Dubai";

const AUTO_MOVE: Record<AutoMoveState, { label: string; hint: string; variant: BadgeVariant }> = {
  due: {
    label: "Moves automatically",
    hint: "Goes to the next person in its team at the next check — every minute, in working hours.",
    variant: "default",
  },
  off: { label: "Automatic off", hint: "Automatic moves are off in Settings — move it by hand.", variant: "secondary" },
  before_switch: {
    label: "By hand only",
    hint: "Assigned before automatic moves were switched on, so it is never moved automatically.",
    variant: "secondary",
  },
  stuck: {
    label: "Nobody left",
    hint: "Everyone else in the team has lost it before, is away or is deactivated — pick a person.",
    variant: "warning",
  },
  no_team: { label: "No team", hint: "It is not in a team, so nobody can take it automatically — pick a person.", variant: "warning" },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
/** Working time: "45m", "2h 10m". */
function fmtMinutes(total: number): string {
  const m = Math.max(0, Math.floor(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function fmtDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** [1,2,3,4,5,6] → "Mon–Sat"; [1,3,5] → "Mon, Wed, Fri". */
function daysLabel(days: number[]): string {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  if (sorted.length === 7) return "every day";
  const runs: number[][] = [];
  for (const d of sorted) {
    const run = runs[runs.length - 1];
    if (run && d === run[run.length - 1] + 1) run.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${DAY_NAMES[r[0]]}–${DAY_NAMES[r[r.length - 1]]}` : r.map((d) => DAY_NAMES[d]).join(", ")))
    .join(", ");
}

const zoneLabel = (tz: string) => tz.split("/").pop()?.replace(/_/g, " ") ?? tz;

/** The limit in words: "45 min", "1 h", "2 h 30 min". */
function limitWords(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function ruleSentence(rule: InactiveRule): string {
  const wh = rule.workingHours;
  return `${limitWords(rule.limitMinutes)} of working time (${daysLabel(wh.days)}, ${wh.start}–${wh.end} ${zoneLabel(wh.timezone)})`;
}

/** What the automatic mover will do with a lead, as a row and a card both show it. */
function autoMoveOf(lead: InactiveLead, rule?: InactiveRule) {
  // A state this page doesn't know yet (a newer server) shows as itself rather than breaking the list.
  const auto = AUTO_MOVE[lead.autoMove] ?? { label: String(lead.autoMove || "unknown"), hint: "", variant: "outline" as BadgeVariant };
  const label = lead.autoMove === "due" && rule && !rule.inWorkingHours ? "Moves when work starts" : auto.label;
  const late = lead.waitingMinutes >= (rule?.limitMinutes ?? 45) * 2;
  return { auto, label, late };
}

// ── Page ───────────────────────────────────────────────────────────────────────
/**
 * The super admin's view of leads nobody acted on in time: who has them, how
 * long they have waited, what the automatic mover will do — and moving them
 * on by hand. The Moves log lists every lead moved for inactivity.
 *
 * Below a desktop's width a card per lead takes the place of the tables: eight
 * columns do not fit a phone, nor a tablet beside the sidebar, and the tables'
 * tooltips need a hover a touch screen hasn't got, so the cards write those
 * words out.
 */
export default function InactiveLeadsPage() {
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const qc = useQueryClient();
  // The signed-in user comes from localStorage: decide only once in the browser, so the server's HTML matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isSuperAdmin = mounted && Boolean(user?.role?.isSystemRole && user.role.roleName === "Super Admin");
  // Only the super admin, who may also move them.
  const canView = isSuperAdmin;
  const canMove = isSuperAdmin;

  const [tab, setTab] = useState<Tab>("inactive");
  const [page, setPage] = useState(1);
  const [movesPage, setMovesPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [teamId, setTeamId] = useState<string>(ALL);
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const [kind, setKind] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogLeads, setDialogLeads] = useState<InactiveLead[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // A new filter or page starts from page 1 with nothing ticked.
  useEffect(() => setPage(1), [query, teamId, owner]);
  useEffect(() => setSelected(new Set()), [query, teamId, owner, page]);
  useEffect(() => setMovesPage(1), [kind, teamId]);

  const filters = {
    page,
    limit: PAGE_SIZE,
    search: query || undefined,
    teamId: teamId === ALL ? undefined : teamId,
    ownerId: owner?.id,
  };
  const { data, isLoading, isFetching, error, refetch } = useInactiveLeads(filters, canView);
  const moves = useLeadMoves(
    {
      page: movesPage,
      limit: PAGE_SIZE,
      kind: kind === ALL ? undefined : (kind as "automatic" | "manual"),
      teamId: teamId === ALL ? undefined : teamId,
    },
    canView && tab === "moves"
  );
  const { data: teamsData } = useTeams({ status: "active", limit: 100 }, { enabled: canView });
  const teams = teamsData?.data ?? [];

  // Live: when the mover acts, or a lead is moved elsewhere, the list is stale.
  useEffect(() => {
    if (!canView) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    const socket = getSocket(token);
    const handler = (payload: { type?: string; data?: { type?: string } }) => {
      const type = payload?.type ?? payload?.data?.type ?? "";
      if (type.startsWith("inactive_") || type === "lead_assigned") {
        qc.invalidateQueries({ queryKey: INACTIVE_LEADS_KEY });
      }
    };
    socket.on("notification", handler);
    return () => {
      socket.off("notification", handler);
    };
  }, [canView, qc]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const moveItems = moves.data?.items ?? [];
  const rule = data?.rule;
  const summary = data?.summary;
  const timeZone = rule?.workingHours.timezone ?? DEFAULT_ZONE;
  const allTicked = items.length > 0 && items.every((l) => selected.has(l.id));
  const someTicked = items.some((l) => selected.has(l.id));
  const tickedLeads = items.filter((l) => selected.has(l.id));
  const filtered = Boolean(query || owner || teamId !== ALL);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allTicked ? new Set() : new Set(items.map((l) => l.id)));

  if (!mounted) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <TableSkeleton />
      </div>
    );
  }

  if (!canView) {
    return (
      <motion.div variants={pageVariants} initial="hidden" animate="visible">
        <Card className="border-border/50">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <TimerOff className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">Only a super admin can see inactive leads.</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <motion.div variants={pageVariants} initial="hidden" animate="visible" className="space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <TimerOff className="h-5 w-5 text-primary" />
              </span>
              Inactive Leads
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Leads whose owner hasn&apos;t changed the status, added a note, logged a follow-up or a call, or set a reminder
              within {rule ? ruleSentence(rule) : "the limit set in Settings"}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {rule && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}>
                <Badge variant={rule.autoReassign ? "success" : "secondary"} className="gap-1.5 py-1">
                  <Bot className="h-3.5 w-3.5" />
                  {rule.autoReassign
                    ? `Automatic moves on${rule.enabledAt ? ` since ${fmtDate(rule.enabledAt, timeZone)}` : ""}`
                    : "Automatic moves off"}
                </Badge>
              </motion.span>
            )}
            {hasPermission("settings", "view") && (
              <motion.div whileTap={{ scale: 0.97 }}>
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <Link href="/settings">
                    <Settings2 className="h-3.5 w-3.5" /> Settings
                  </Link>
                </Button>
              </motion.div>
            )}
          </div>
        </div>

        {/* ── Stats ── */}
        <motion.div variants={listContainerVariants} initial="hidden" animate="visible" className="grid gap-3 sm:grid-cols-3">
          <StatCard icon={Hourglass} label="Inactive now" value={summary?.total ?? "—"} hint="Waiting on their owner" tone="text-amber-500" />
          <StatCard icon={UserX} label="Nobody left to take" value={summary?.stuck ?? "—"} hint="Need you to pick someone" tone="text-red-500" />
          <StatCard icon={History} label="Moved today" value={summary?.movedToday ?? "—"} hint="Automatically and by hand" tone="text-primary" />
        </motion.div>

        {/* ── Tabs + filters ── */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex w-fit max-w-full shrink-0 overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-1">
            {([
              { key: "inactive", label: "Inactive now", icon: Hourglass },
              { key: "moves", label: "Moves log", icon: History },
            ] as const).map((t) => (
              <motion.button
                key={t.key}
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={cn(
                  "relative flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.key ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab === t.key && (
                  <motion.span
                    layoutId="inactive-tab-pill"
                    className="absolute inset-0 rounded-lg bg-primary shadow-sm"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <t.icon className="relative z-10 h-3.5 w-3.5" />
                <span className="relative z-10">{t.label}</span>
              </motion.button>
            ))}
          </div>

          {/* On a phone the search takes its own line and the pickers share the next. */}
          <div className="flex flex-wrap items-center gap-2">
            {tab === "inactive" && (
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or phone"
                  className="h-9 w-full pl-8"
                  aria-label="Search inactive leads"
                />
              </div>
            )}
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-44 sm:flex-none" aria-label="Team">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t._id} value={t._id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tab === "moves" && (
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label="How it moved">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All moves</SelectItem>
                  <SelectItem value="automatic">Automatic</SelectItem>
                  <SelectItem value="manual">By hand</SelectItem>
                </SelectContent>
              </Select>
            )}
            <motion.div whileTap={{ scale: 0.97 }} className="shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => (tab === "inactive" ? refetch() : moves.refetch())}
                aria-label="Refresh"
              >
                <RefreshCw className={cn("h-4 w-4", (tab === "inactive" ? isFetching : moves.isFetching) && "animate-spin")} />
              </Button>
            </motion.div>
          </div>
        </div>

        <AnimatePresence>
          {owner && tab === "inactive" && (
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
              <Badge variant="outline" className="max-w-full gap-1.5 py-1">
                <span className="truncate">Owner: {owner.name}</span>
                <button type="button" onClick={() => setOwner(null)} aria-label="Clear owner filter" className="shrink-0 rounded-full hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Inactive now ── */}
        {tab === "inactive" && (
          <Card className="overflow-hidden border-border/50">
            <AnimatePresence>
              {canMove && someTicked && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-primary/5 px-4 py-2.5"
                >
                  <span className="text-sm font-medium">{tickedLeads.length} selected</span>
                  <div className="flex gap-2">
                    <motion.div whileTap={{ scale: 0.97 }}>
                      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                        Clear
                      </Button>
                    </motion.div>
                    <motion.div whileTap={{ scale: 0.97 }}>
                      <Button size="sm" className="gap-1.5" onClick={() => setDialogLeads(tickedLeads)}>
                        <MoveRight className="h-3.5 w-3.5" /> Move {tickedLeads.length}
                      </Button>
                    </motion.div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <CardContent className="p-0">
              {isLoading ? (
                <TableSkeleton />
              ) : error ? (
                <ErrorState onRetry={() => refetch()} />
              ) : items.length === 0 ? (
                <EmptyState
                  icon={Hourglass}
                  title={filtered ? "No inactive leads match" : "No inactive leads"}
                  text={filtered ? "Try clearing the filters." : "Every lead has been acted on by its owner within the limit."}
                  action={
                    hasPermission("settings", "view") ? (
                      <Button asChild size="sm" variant="outline" className="gap-1.5">
                        <Link href="/settings">
                          <Settings2 className="h-3.5 w-3.5" /> Adjust the limit
                        </Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  {/* ── Phones and tablets ── */}
                  <div className="lg:hidden">
                    {canMove && (
                      <label className="flex items-center gap-3 border-b border-border/50 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={allTicked ? true : someTicked ? "indeterminate" : false}
                          onCheckedChange={toggleAll}
                          aria-label="Select all on this page"
                        />
                        Select all on this page
                      </label>
                    )}
                    <motion.ul
                      key={`${page}-${query}-${teamId}-${owner?.id ?? ""}`}
                      variants={listContainerVariants}
                      initial="hidden"
                      animate="visible"
                      className="divide-y divide-border/30"
                    >
                      {items.map((lead) => (
                        <LeadCard
                          key={lead.id}
                          lead={lead}
                          rule={rule}
                          canMove={canMove}
                          ticked={selected.has(lead.id)}
                          onTick={() => toggle(lead.id)}
                          onOwner={() => lead.owner && setOwner({ id: lead.owner.id, name: lead.owner.name })}
                          onMove={() => setDialogLeads([lead])}
                        />
                      ))}
                    </motion.ul>
                  </div>

                  {/* ── Desktop ── */}
                  <div className="hidden overflow-x-auto lg:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
                          {canMove && (
                            <th className="w-10 px-4 py-2.5">
                              <Checkbox
                                checked={allTicked ? true : someTicked ? "indeterminate" : false}
                                onCheckedChange={toggleAll}
                                aria-label="Select all on this page"
                              />
                            </th>
                          )}
                          <th className={cn("py-2.5 font-medium", canMove ? "px-3" : "px-4")}>Lead</th>
                          <th className="px-3 py-2.5 font-medium">Owner</th>
                          <th className="px-3 py-2.5 font-medium">Team</th>
                          <th className="px-3 py-2.5 font-medium">Waiting</th>
                          <th className="px-3 py-2.5 font-medium">Automatic</th>
                          <th className="px-3 py-2.5 font-medium">Before</th>
                          {canMove && <th className="px-3 py-2.5" />}
                        </tr>
                      </thead>
                      <motion.tbody
                        key={`${page}-${query}-${teamId}-${owner?.id ?? ""}`}
                        variants={listContainerVariants}
                        initial="hidden"
                        animate="visible"
                      >
                        {items.map((lead) => (
                          <LeadRow
                            key={lead.id}
                            lead={lead}
                            rule={rule}
                            canMove={canMove}
                            ticked={selected.has(lead.id)}
                            onTick={() => toggle(lead.id)}
                            onOwner={() => lead.owner && setOwner({ id: lead.owner.id, name: lead.owner.name })}
                            onMove={() => setDialogLeads([lead])}
                          />
                        ))}
                      </motion.tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
            {data && data.pagination && data.pagination.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-4 py-2.5">
                <span className="text-xs text-muted-foreground">
                  {summary?.capped ? "Showing the 2,000 that have waited longest — narrow it down with the filters." : ""}
                </span>
                <Pager page={page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />
              </div>
            )}
          </Card>
        )}

        {/* ── Moves log ── */}
        {tab === "moves" && (
          <Card className="overflow-hidden border-border/50">
            <CardContent className="p-0">
              {moves.isLoading ? (
                <TableSkeleton />
              ) : moves.error ? (
                <ErrorState onRetry={() => moves.refetch()} />
              ) : moveItems.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No moves yet"
                  text="Leads moved for inactivity — automatically or from this page — are listed here."
                  action={
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setTab("inactive")}>
                      <Hourglass className="h-3.5 w-3.5" /> See inactive leads
                    </Button>
                  }
                />
              ) : (
                <>
                  {/* ── Phones and tablets ── */}
                  <motion.ul
                    key={`${movesPage}-${kind}-${teamId}`}
                    variants={listContainerVariants}
                    initial="hidden"
                    animate="visible"
                    className="divide-y divide-border/30 lg:hidden"
                  >
                    {moveItems.map((m) => (
                      <MoveCard key={m.id} move={m} timeZone={timeZone} />
                    ))}
                  </motion.ul>

                  {/* ── Desktop ── */}
                  <div className="hidden overflow-x-auto lg:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
                          <th className="px-4 py-2.5 font-medium">When</th>
                          <th className="px-3 py-2.5 font-medium">Lead</th>
                          <th className="px-3 py-2.5 font-medium">From → To</th>
                          <th className="px-3 py-2.5 font-medium">Team</th>
                          <th className="px-3 py-2.5 font-medium">Waited</th>
                          <th className="px-3 py-2.5 font-medium">How</th>
                        </tr>
                      </thead>
                      <motion.tbody key={`${movesPage}-${kind}-${teamId}`} variants={listContainerVariants} initial="hidden" animate="visible">
                        {moveItems.map((m) => (
                          <motion.tr key={m.id} variants={listItemVariants} className="border-b border-border/30 transition-colors hover:bg-muted/20">
                            <td className="whitespace-nowrap px-4 py-2.5">
                              <div className="text-xs">{fmtDate(m.createdAt, timeZone)}</div>
                              <div className="text-[11px] text-muted-foreground">{timeAgo(m.createdAt)}</div>
                            </td>
                            <td className="px-3 py-2.5">
                              <Link
                                href={`/leads/${m.lead.id}`}
                                title={m.lead.name || undefined}
                                className="line-clamp-2 max-w-[18rem] font-medium hover:text-primary hover:underline"
                              >
                                {m.lead.name || "Unnamed lead"}
                              </Link>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                              <span className="text-muted-foreground">{m.from?.name ?? "—"}</span>
                              <MoveRight className="mx-1.5 inline h-3 w-3 text-muted-foreground" />
                              <span className="font-medium">{m.to?.name ?? "—"}</span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted-foreground">{m.team?.name ?? "—"}</td>
                            <td className="px-3 py-2.5 font-mono text-xs">{fmtMinutes(m.inactiveMinutes)}</td>
                            <td className="px-3 py-2.5">
                              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-block">
                                <HowBadge move={m} />
                              </motion.span>
                            </td>
                          </motion.tr>
                        ))}
                      </motion.tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
            {moves.data?.pagination && moves.data.pagination.total > 0 && (
              <div className="flex justify-end border-t border-border/50 px-4 py-2.5">
                <Pager
                  page={movesPage}
                  totalPages={moves.data.pagination.totalPages}
                  total={moves.data.pagination.total}
                  onPage={setMovesPage}
                />
              </div>
            )}
          </Card>
        )}

        <MoveLeadsDialog
          open={dialogLeads !== null}
          onOpenChange={(open) => !open && setDialogLeads(null)}
          leads={dialogLeads ?? []}
          onMoved={() => setSelected(new Set())}
        />
      </motion.div>
    </TooltipProvider>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
interface LeadRowProps {
  lead: InactiveLead;
  rule?: InactiveRule;
  /** May tick and move leads — the super admin. */
  canMove: boolean;
  ticked: boolean;
  onTick: () => void;
  onOwner: () => void;
  onMove: () => void;
}

function LeadRow({ lead, rule, canMove, ticked, onTick, onOwner, onMove }: LeadRowProps) {
  const { auto, label, late } = autoMoveOf(lead, rule);

  return (
    <motion.tr
      variants={listItemVariants}
      className={cn("border-b border-border/30 transition-colors hover:bg-muted/20", ticked && "bg-primary/5")}
    >
      {canMove && (
        <td className="px-4 py-2.5">
          <Checkbox checked={ticked} onCheckedChange={onTick} aria-label={`Select ${lead.name || lead.phone}`} />
        </td>
      )}
      <td className={cn("py-2.5", canMove ? "px-3" : "px-4")}>
        <Link
          href={`/leads/${lead.id}`}
          title={lead.name || undefined}
          className="line-clamp-2 max-w-[18rem] font-medium hover:text-primary hover:underline"
        >
          {lead.name || "Unnamed lead"}
        </Link>
        <div className="font-mono text-xs text-muted-foreground">{lead.phone}</div>
      </td>
      <td className="px-3 py-2.5">
        {lead.owner ? (
          <button type="button" onClick={onOwner} className="text-left hover:text-primary" title="Show only this person's inactive leads">
            <span className="block text-sm">{lead.owner.name}</span>
            {!lead.owner.active && <span className="text-[11px] text-destructive">Deactivated</span>}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-muted-foreground">{lead.team?.name ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <div className={cn("font-mono text-xs font-semibold", late ? "text-red-500" : "text-amber-500")}>
          {fmtMinutes(lead.waitingMinutes)}
        </div>
        <div className="text-[11px] text-muted-foreground">assigned {timeAgo(lead.assignedAt)}</div>
      </td>
      <td className="px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-block cursor-default">
              <Badge variant={auto.variant} className="whitespace-nowrap text-[11px]">
                {label}
              </Badge>
            </motion.span>
          </TooltipTrigger>
          {auto.hint && <TooltipContent className="max-w-xs text-xs">{auto.hint}</TooltipContent>}
        </Tooltip>
      </td>
      <td className="px-3 py-2.5 text-xs">
        {lead.moves > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-default items-center gap-1 text-muted-foreground">
                <CircleAlert className="h-3.5 w-3.5" /> Moved {lead.moves}×
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              Lost before by {lead.lostBy.map((p) => p.name).join(", ") || "—"} — never moved back to them automatically.
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      {canMove && (
        <td className="px-3 py-2.5 text-right">
          <motion.div whileTap={{ scale: 0.97 }} className="inline-block">
            <Button size="sm" variant="ghost" className="gap-1 text-primary hover:bg-primary/10 hover:text-primary" onClick={onMove}>
              <MoveRight className="h-3.5 w-3.5" /> Move
            </Button>
          </motion.div>
        </td>
      )}
    </motion.tr>
  );
}

/** A lead on a phone: the row's facts stacked, with the tooltips' words written out. */
function LeadCard({ lead, rule, canMove, ticked, onTick, onOwner, onMove }: LeadRowProps) {
  const { auto, label, late } = autoMoveOf(lead, rule);
  // Why it won't move on its own, written out — a touch screen has no hover for the tooltip.
  const explain = lead.autoMove === "before_switch" || lead.autoMove === "stuck" || lead.autoMove === "no_team";

  return (
    <motion.li variants={listItemVariants} className={cn("flex gap-3 px-4 py-3", ticked && "bg-primary/5")}>
      {canMove && (
        <Checkbox className="mt-1" checked={ticked} onCheckedChange={onTick} aria-label={`Select ${lead.name || lead.phone}`} />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/leads/${lead.id}`} className="block truncate font-medium hover:text-primary hover:underline">
              {lead.name || "Unnamed lead"}
            </Link>
            <div className="font-mono text-xs text-muted-foreground">{lead.phone}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className={cn("font-mono text-sm font-semibold", late ? "text-red-500" : "text-amber-500")}>
              {fmtMinutes(lead.waitingMinutes)}
            </div>
            <div className="text-[11px] text-muted-foreground">assigned {timeAgo(lead.assignedAt)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {lead.owner ? (
            <button type="button" onClick={onOwner} className="font-medium text-foreground hover:text-primary">
              {lead.owner.name}
            </button>
          ) : (
            <span>No owner</span>
          )}
          {lead.owner && !lead.owner.active && <span className="text-destructive">Deactivated</span>}
          {/* "No team" once: the badge below says it when automatic moves are on. */}
          {(lead.team || lead.autoMove !== "no_team") && (
            <>
              <span aria-hidden>·</span>
              <span>{lead.team?.name ?? "No team"}</span>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={auto.variant} className="whitespace-nowrap text-[11px]">
              {label}
            </Badge>
            {lead.moves > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <CircleAlert className="h-3 w-3" /> Moved {lead.moves}×
              </span>
            )}
          </div>
          {canMove && (
            <motion.div whileTap={{ scale: 0.97 }} className="shrink-0">
              <Button size="sm" variant="outline" className="h-8 gap-1 text-primary" onClick={onMove}>
                <MoveRight className="h-3.5 w-3.5" /> Move
              </Button>
            </motion.div>
          )}
        </div>

        {explain && auto.hint && <p className="text-[11px] text-muted-foreground">{auto.hint}</p>}
        {lead.moves > 0 && lead.lostBy.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Lost before by {lead.lostBy.map((p) => p.name).join(", ")} — never moved back to them automatically.
          </p>
        )}
      </div>
    </motion.li>
  );
}

/** How a lead moved: automatically, or by whom. `compact` (cards) shortens a long name; the table shows it whole. */
function HowBadge({ move, compact = false }: { move: LeadMoveEntry; compact?: boolean }) {
  return move.kind === "automatic" ? (
    <Badge variant="secondary" className="gap-1 whitespace-nowrap text-[11px]">
      <Bot className="h-3 w-3" /> Automatic
    </Badge>
  ) : (
    <Badge
      variant="outline"
      title={move.by?.name ?? undefined}
      className={cn("gap-1 text-[11px]", compact ? "max-w-[10rem]" : "whitespace-nowrap")}
    >
      <UserRound className="h-3 w-3 shrink-0" /> <span className={cn(compact && "truncate")}>{move.by?.name ?? "By hand"}</span>
    </Badge>
  );
}

/** A move on a phone. */
function MoveCard({ move, timeZone }: { move: LeadMoveEntry; timeZone: string }) {
  return (
    <motion.li variants={listItemVariants} className="space-y-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/leads/${move.lead.id}`} className="min-w-0 truncate font-medium hover:text-primary hover:underline">
          {move.lead.name || "Unnamed lead"}
        </Link>
        <span className="shrink-0">
          <HowBadge move={move} compact />
        </span>
      </div>
      <div className="flex min-w-0 items-center text-xs">
        <span className="truncate text-muted-foreground">{move.from?.name ?? "—"}</span>
        <MoveRight className="mx-1.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{move.to?.name ?? "—"}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {fmtDate(move.createdAt, timeZone)} · {timeAgo(move.createdAt)}
        </span>
        <span>{move.team?.name ?? "No team"}</span>
        <span>waited {fmtMinutes(move.inactiveMinutes)}</span>
      </div>
    </motion.li>
  );
}
