"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Users,
  Coffee,
  Bell,
  ShieldAlert,
  Search,
  Settings2,
  RefreshCw,
  LogIn,
  LogOut,
  KeyRound,
  Monitor,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatCard } from "@/components/shared/StatCard";
import { Pager } from "@/components/shared/Pager";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/shared/ListStates";
import { cn } from "@/lib/utils";
import { listContainerVariants, listItemVariants, pageVariants } from "@/lib/animations";
import { useAuthStore } from "@/lib/store/authStore";
import { useTeams } from "@/hooks/useTeams";
import { useActivityPeople, useIdleStretches, useLoginEvents } from "@/hooks/useActivity";
import type { IdleStretchEntry, LoginEventEntry, LoginEventKind, PersonActivity, PresenceStatus } from "@/types/activity";

// ── Types ──────────────────────────────────────────────────────────────────────
type Tab = "people" | "logins" | "idle";
type BadgeVariant = "default" | "secondary" | "warning" | "success" | "destructive" | "outline";

// ── Constants ──────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;
const ALL = "all";

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "people", label: "People", icon: Users },
  { key: "logins", label: "Sign-ins", icon: KeyRound },
  { key: "idle", label: "Idle alerts", icon: Coffee },
];

const FAIL_REASON: Record<string, string> = {
  wrong_password: "wrong password",
  unknown_email: "unknown email",
  deactivated: "account deactivated",
  no_account: "no account",
};

// ── Helpers ────────────────────────────────────────────────────────────────────
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

const clock = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });

const stamp = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function statusBadge(p: PersonActivity, timeZone: string): { label: string; variant: BadgeVariant } {
  const quiet = p.quietMinutes != null ? fmtMinutes(p.quietMinutes) : "";
  const map: Record<PresenceStatus, { label: string; variant: BadgeVariant }> = {
    active: { label: "Active", variant: "success" },
    idle: { label: quiet ? `No activity · ${quiet}` : "No activity", variant: "warning" },
    away: { label: quiet ? `App closed · ${quiet}` : "App closed", variant: "secondary" },
    signed_out: { label: p.lastLogoutAt ? `Signed out ${clock(p.lastLogoutAt, timeZone)}` : "Signed out", variant: "outline" },
    offline: { label: "Not seen today", variant: "outline" },
  };
  // A status this page doesn't know yet (a newer server) shows as itself rather than breaking the list.
  return map[p.status] ?? { label: String(p.status || "unknown"), variant: "outline" };
}

function DeviceIcon({ device }: { device: string }) {
  const Icon = /iOS|Android/.test(device) ? (/iPad|tablet/i.test(device) ? Tablet : Smartphone) : Monitor;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

// ── Page ───────────────────────────────────────────────────────────────────────
/**
 * The super admin's view of who is here: everyone's status right now and
 * their day so far, the sign-in history (including refused sign-ins), and the
 * idle alerts that went out.
 *
 * Below a desktop's width each list is a column of cards instead of a table:
 * five columns do not fit a phone, nor a tablet beside the sidebar.
 */
export default function ActivityPage() {
  const user = useAuthStore((s) => s.user);
  // The signed-in user comes from localStorage: decide only once in the browser, so the server's HTML matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isSuperAdmin = mounted && Boolean(user?.role?.isSystemRole && user.role.roleName === "Super Admin");

  const [tab, setTab] = useState<Tab>("people");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [teamId, setTeamId] = useState<string>(ALL);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [kind, setKind] = useState<string>(ALL);
  const [loginsPage, setLoginsPage] = useState(1);
  const [idlePage, setIdlePage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setLoginsPage(1), [kind, person]);
  useEffect(() => setIdlePage(1), [person]);

  const people = useActivityPeople({ search: query || undefined, teamId: teamId === ALL ? undefined : teamId }, isSuperAdmin);
  const logins = useLoginEvents(
    { page: loginsPage, limit: PAGE_SIZE, userId: person?.id, kind: kind === ALL ? undefined : (kind as LoginEventKind) },
    isSuperAdmin && tab === "logins"
  );
  const idle = useIdleStretches({ page: idlePage, limit: PAGE_SIZE, userId: person?.id }, isSuperAdmin && tab === "idle");
  const { data: teamsData } = useTeams({ status: "active", limit: 100 }, { enabled: isSuperAdmin });
  const teams = teamsData?.data ?? [];

  const summary = people.data?.summary;
  const rule = people.data?.idleRule;
  const tz = rule?.timezone ?? "Asia/Dubai";

  // One person's history: from the People tab to their sign-ins.
  const showHistory = (p: { id: string; name: string }, to: Tab) => {
    setPerson(p);
    setTab(to);
  };

  if (!mounted) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <TableSkeleton />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <motion.div variants={pageVariants} initial="hidden" animate="visible">
        <Card className="border-border/50">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Activity className="h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">Only a super admin can see activity.</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  const refetch = () => (tab === "people" ? people.refetch() : tab === "logins" ? logins.refetch() : idle.refetch());
  const fetching = tab === "people" ? people.isFetching : tab === "logins" ? logins.isFetching : idle.isFetching;

  return (
    <motion.div variants={pageVariants} initial="hidden" animate="visible" className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </span>
            Activity
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Who is using the CRM right now, how their day has gone, every sign-in, and the idle alerts that went out.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rule && (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}>
              <Badge variant={rule.enabled ? "success" : "secondary"} className="gap-1.5 whitespace-nowrap py-1">
                <Bell className="h-3.5 w-3.5" />
                {rule.enabled ? `Idle alerts on · after ${fmtMinutes(rule.limitMinutes)}` : "Idle alerts off"}
              </Badge>
            </motion.span>
          )}
          <motion.div whileTap={{ scale: 0.97 }}>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/settings">
                <Settings2 className="h-3.5 w-3.5" /> Settings
              </Link>
            </Button>
          </motion.div>
        </div>
      </div>

      {/* ── Stats ── */}
      <motion.div variants={listContainerVariants} initial="hidden" animate="visible" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Activity} label="Active now" value={summary?.active ?? "—"} hint="Used the CRM in the last 2 minutes" tone="text-emerald-500" />
        <StatCard
          icon={Coffee}
          label="Quiet now"
          value={summary ? summary.idle + summary.away : "—"}
          hint="Here today, nothing in the app lately"
          tone="text-amber-500"
        />
        <StatCard icon={Bell} label="Idle alerts today" value={summary?.alertsToday ?? "—"} hint="One per quiet stretch" tone="text-primary" />
        <StatCard
          icon={ShieldAlert}
          label="Refused sign-ins today"
          value={summary?.failedSignInsToday ?? "—"}
          hint="Wrong password or unknown email"
          tone="text-red-500"
        />
      </motion.div>

      {/* ── Tabs + filters ── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="inline-flex w-fit max-w-full shrink-0 overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-1">
          {TABS.map((t) => (
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
                  layoutId="activity-tab-pill"
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
          {tab === "people" && (
            <>
              <div className="relative w-full sm:w-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search people"
                  className="h-9 w-full pl-8"
                  aria-label="Search people"
                />
              </div>
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
            </>
          )}
          {tab === "logins" && (
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-44 sm:flex-none" aria-label="Event">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Everything</SelectItem>
                <SelectItem value="login">Signed in</SelectItem>
                <SelectItem value="login_failed">Refused</SelectItem>
                <SelectItem value="logout">Signed out</SelectItem>
              </SelectContent>
            </Select>
          )}
          <motion.div whileTap={{ scale: 0.97 }} className="shrink-0">
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={refetch} aria-label="Refresh">
              <RefreshCw className={cn("h-4 w-4", fetching && "animate-spin")} />
            </Button>
          </motion.div>
        </div>
      </div>

      <AnimatePresence>
        {person && tab !== "people" && (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
            <Badge variant="outline" className="max-w-full gap-1.5 py-1">
              <span className="truncate">{person.name}</span>
              <button type="button" onClick={() => setPerson(null)} aria-label="Show everyone" className="shrink-0 rounded-full hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── People ── */}
      {tab === "people" && (
        <Card className="overflow-hidden border-border/50">
          <CardContent className="p-0">
            {people.isLoading ? (
              <TableSkeleton />
            ) : people.error ? (
              <ErrorState onRetry={() => people.refetch()} />
            ) : (people.data?.items ?? []).length === 0 ? (
              <EmptyState
                icon={Users}
                title="Nobody matches"
                text="Try clearing the search or the team."
                action={
                  <Button size="sm" variant="outline" onClick={() => { setSearch(""); setTeamId(ALL); }}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <>
              {/* ── Phones and tablets ── */}
              <motion.ul key={`cards-${query}-${teamId}`} variants={listContainerVariants} initial="hidden" animate="visible" className="divide-y divide-border/30 lg:hidden">
                {(people.data?.items ?? []).map((p) => (
                  <PersonCard key={p.id} person={p} timeZone={tz} onHistory={showHistory} />
                ))}
              </motion.ul>

              {/* ── Desktop ── */}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Person</th>
                      <th className="px-3 py-2.5 font-medium">Now</th>
                      <th className="px-3 py-2.5 font-medium">Active today</th>
                      <th className="px-3 py-2.5 font-medium">Last seen</th>
                      <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                    </tr>
                  </thead>
                  <motion.tbody key={`${query}-${teamId}`} variants={listContainerVariants} initial="hidden" animate="visible">
                    {(people.data?.items ?? []).map((p) => {
                      const badge = statusBadge(p, tz);
                      return (
                        <motion.tr key={p.id} variants={listItemVariants} className="border-b border-border/30 transition-colors hover:bg-muted/20">
                          <td className="px-4 py-2.5">
                            <button
                              type="button"
                              onClick={() => showHistory({ id: p.id, name: p.name }, "logins")}
                              className="text-left font-medium hover:text-primary"
                              title="Show this person's sign-ins"
                            >
                              {p.name}
                            </button>
                            <div className="text-xs text-muted-foreground">
                              {[p.role, p.teams.join(", ")].filter(Boolean).join(" · ") || p.email}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-block">
                                <Badge variant={badge.variant} className="whitespace-nowrap text-[11px]">
                                  {badge.label}
                                </Badge>
                              </motion.span>
                              {p.alerted && (
                                <button type="button" onClick={() => showHistory({ id: p.id, name: p.name }, "idle")} title="See the idle alerts">
                                  <Badge variant="destructive" className="whitespace-nowrap text-[11px]">
                                    Alerted
                                  </Badge>
                                </button>
                              )}
                              {p.superAdmin && <span className="text-[11px] text-muted-foreground">not tracked</span>}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <div className="font-mono text-xs font-semibold">{p.activeMinutesToday ? fmtMinutes(p.activeMinutesToday) : "—"}</div>
                            {p.firstActiveToday && (
                              <div className="text-[11px] text-muted-foreground">from {clock(p.firstActiveToday, tz)}</div>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">
                            {p.lastSeenAt ? timeAgo(p.lastSeenAt) : "Never"}
                          </td>
                          <td className="px-3 py-2.5 text-xs">
                            {p.lastLogin ? (
                              <div className="flex items-start gap-1.5">
                                <DeviceIcon device={p.lastLogin.device} />
                                <div>
                                  <div className="whitespace-nowrap">{stamp(p.lastLogin.at, tz)}</div>
                                  <div className="text-[11px] text-muted-foreground">
                                    {p.lastLogin.device}
                                    {p.lastLogin.ip ? ` · ${p.lastLogin.ip}` : ""}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </motion.tbody>
                </table>
              </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Sign-ins ── */}
      {tab === "logins" && (
        <Card className="overflow-hidden border-border/50">
          <CardContent className="p-0">
            {logins.isLoading ? (
              <TableSkeleton />
            ) : logins.error ? (
              <ErrorState onRetry={() => logins.refetch()} />
            ) : (logins.data?.items ?? []).length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="No sign-ins here"
                text={person || kind !== ALL ? "Nothing matches these filters." : "Sign-ins, refused sign-ins and sign-outs appear here as they happen."}
                action={
                  <Button size="sm" variant="outline" onClick={() => { setPerson(null); setKind(ALL); }}>
                    Show everything
                  </Button>
                }
              />
            ) : (
              <>
              {/* ── Phones and tablets ── */}
              <motion.ul key={`cards-${loginsPage}-${kind}-${person?.id ?? ""}`} variants={listContainerVariants} initial="hidden" animate="visible" className="divide-y divide-border/30 lg:hidden">
                {(logins.data?.items ?? []).map((e) => (
                  <LoginCard key={e.id} event={e} timeZone={tz} />
                ))}
              </motion.ul>

              {/* ── Desktop ── */}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">When</th>
                      <th className="px-3 py-2.5 font-medium">Who</th>
                      <th className="px-3 py-2.5 font-medium">What</th>
                      <th className="px-3 py-2.5 font-medium">Device</th>
                      <th className="px-3 py-2.5 font-medium">IP</th>
                    </tr>
                  </thead>
                  <motion.tbody key={`${loginsPage}-${kind}-${person?.id ?? ""}`} variants={listContainerVariants} initial="hidden" animate="visible">
                    {(logins.data?.items ?? []).map((e) => (
                      <motion.tr key={e.id} variants={listItemVariants} className="border-b border-border/30 transition-colors hover:bg-muted/20">
                        <td className="whitespace-nowrap px-4 py-2.5">
                          <div className="text-xs">{stamp(e.createdAt, tz)}</div>
                          <div className="text-[11px] text-muted-foreground">{timeAgo(e.createdAt)}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{e.user?.name ?? "No account"}</div>
                          <div className="text-xs text-muted-foreground">{e.email}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <EventBadge event={e} />
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <DeviceIcon device={e.device} /> {e.device || "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{e.ip || "—"}</td>
                      </motion.tr>
                    ))}
                  </motion.tbody>
                </table>
              </div>
              </>
            )}
          </CardContent>
          {logins.data?.pagination && logins.data.pagination.total > 0 && (
            <div className="flex justify-end border-t border-border/50 px-4 py-2.5">
              <Pager page={loginsPage} totalPages={logins.data.pagination.totalPages} total={logins.data.pagination.total} onPage={setLoginsPage} />
            </div>
          )}
        </Card>
      )}

      {/* ── Idle alerts ── */}
      {tab === "idle" && (
        <Card className="overflow-hidden border-border/50">
          <CardContent className="p-0">
            {idle.isLoading ? (
              <TableSkeleton />
            ) : idle.error ? (
              <ErrorState onRetry={() => idle.refetch()} />
            ) : (idle.data?.items ?? []).length === 0 ? (
              <EmptyState
                icon={Coffee}
                title="No idle alerts"
                text={
                  rule?.enabled
                    ? "Nobody has gone quiet for the limit during working hours."
                    : "Idle alerts are off — switch them on in Settings to be told when someone goes quiet."
                }
                action={
                  <Button asChild size="sm" variant="outline" className="gap-1.5">
                    <Link href="/settings">
                      <Settings2 className="h-3.5 w-3.5" /> Settings
                    </Link>
                  </Button>
                }
              />
            ) : (
              <>
              {/* ── Phones and tablets ── */}
              <motion.ul key={`cards-${idlePage}-${person?.id ?? ""}`} variants={listContainerVariants} initial="hidden" animate="visible" className="divide-y divide-border/30 lg:hidden">
                {(idle.data?.items ?? []).map((s) => (
                  <IdleCard key={s.id} stretch={s} timeZone={tz} />
                ))}
              </motion.ul>

              {/* ── Desktop ── */}
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Who</th>
                      <th className="px-3 py-2.5 font-medium">Quiet since</th>
                      <th className="px-3 py-2.5 font-medium">Alerted</th>
                      <th className="px-3 py-2.5 font-medium">Back</th>
                      <th className="px-3 py-2.5 font-medium">Working time</th>
                    </tr>
                  </thead>
                  <motion.tbody key={`${idlePage}-${person?.id ?? ""}`} variants={listContainerVariants} initial="hidden" animate="visible">
                    {(idle.data?.items ?? []).map((s) => (
                      <motion.tr key={s.id} variants={listItemVariants} className="border-b border-border/30 transition-colors hover:bg-muted/20">
                        <td className="px-4 py-2.5 font-medium">{s.user?.name ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs">{stamp(s.since, tz)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs">{clock(s.alertedAt, tz)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                          {s.endedAt ? (
                            stamp(s.endedAt, tz)
                          ) : (
                            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-block">
                              <Badge variant="warning" className="text-[11px]">Not back yet</Badge>
                            </motion.span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs">{fmtMinutes(s.minutes)}</td>
                      </motion.tr>
                    ))}
                  </motion.tbody>
                </table>
              </div>
              </>
            )}
          </CardContent>
          {idle.data?.pagination && idle.data.pagination.total > 0 && (
            <div className="flex justify-end border-t border-border/50 px-4 py-2.5">
              <Pager page={idlePage} totalPages={idle.data.pagination.totalPages} total={idle.data.pagination.total} onPage={setIdlePage} />
            </div>
          )}
        </Card>
      )}
    </motion.div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function EventBadge({ event }: { event: LoginEventEntry }) {
  const via = event.method === "sso" ? " (Root portal)" : "";
  const cfg =
    event.kind === "login"
      ? { icon: LogIn, label: `Signed in${via}`, variant: "success" as BadgeVariant }
      : event.kind === "logout"
        ? { icon: LogOut, label: "Signed out", variant: "secondary" as BadgeVariant }
        : { icon: ShieldAlert, label: `Refused — ${FAIL_REASON[event.reason ?? ""] ?? "refused"}`, variant: "destructive" as BadgeVariant };
  const Icon = cfg.icon;
  return (
    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="inline-block">
      <Badge variant={cfg.variant} className="gap-1 whitespace-nowrap text-[11px]">
        <Icon className="h-3 w-3" /> {cfg.label}
      </Badge>
    </motion.span>
  );
}

/** A person on a phone or tablet: the row's facts stacked. Tap the name for their sign-ins. */
function PersonCard({
  person: p,
  timeZone,
  onHistory,
}: {
  person: PersonActivity;
  timeZone: string;
  onHistory: (p: { id: string; name: string }, to: Tab) => void;
}) {
  const badge = statusBadge(p, timeZone);
  return (
    <motion.li variants={listItemVariants} className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onHistory({ id: p.id, name: p.name }, "logins")}
            className="block max-w-full truncate text-left font-medium hover:text-primary"
          >
            {p.name}
          </button>
          <div className="truncate text-xs text-muted-foreground">
            {[p.role, p.teams.join(", ")].filter(Boolean).join(" · ") || p.email}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-semibold">{p.activeMinutesToday ? fmtMinutes(p.activeMinutesToday) : "—"}</div>
          <div className="text-[11px] text-muted-foreground">
            {p.firstActiveToday ? `active today from ${clock(p.firstActiveToday, timeZone)}` : "active today"}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={badge.variant} className="whitespace-nowrap text-[11px]">
          {badge.label}
        </Badge>
        {p.alerted && (
          <button type="button" onClick={() => onHistory({ id: p.id, name: p.name }, "idle")}>
            <Badge variant="destructive" className="whitespace-nowrap text-[11px]">
              Alerted
            </Badge>
          </button>
        )}
        {p.superAdmin && <span className="text-[11px] text-muted-foreground">not tracked</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>Last seen {p.lastSeenAt ? timeAgo(p.lastSeenAt) : "never"}</span>
        {p.lastLogin && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <DeviceIcon device={p.lastLogin.device} />
            <span className="truncate">
              Signed in {stamp(p.lastLogin.at, timeZone)}
              {p.lastLogin.device ? ` · ${p.lastLogin.device}` : ""}
              {p.lastLogin.ip ? ` · ${p.lastLogin.ip}` : ""}
            </span>
          </span>
        )}
      </div>
    </motion.li>
  );
}

/** A sign-in, refused sign-in or sign-out on a phone or tablet. */
function LoginCard({ event: e, timeZone }: { event: LoginEventEntry; timeZone: string }) {
  return (
    <motion.li variants={listItemVariants} className="space-y-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{e.user?.name ?? "No account"}</div>
          <div className="truncate text-xs text-muted-foreground">{e.email}</div>
        </div>
        <span className="shrink-0">
          <EventBadge event={e} />
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {stamp(e.createdAt, timeZone)} · {timeAgo(e.createdAt)}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <DeviceIcon device={e.device} />
          <span className="truncate">{e.device || "—"}</span>
        </span>
        {e.ip && <span className="font-mono">{e.ip}</span>}
      </div>
    </motion.li>
  );
}

/** An idle alert on a phone or tablet. */
function IdleCard({ stretch: s, timeZone }: { stretch: IdleStretchEntry; timeZone: string }) {
  return (
    <motion.li variants={listItemVariants} className="space-y-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 truncate font-medium">{s.user?.name ?? "—"}</div>
        <div className="shrink-0 font-mono text-sm font-semibold">{fmtMinutes(s.minutes)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>Quiet since {stamp(s.since, timeZone)}</span>
        <span>Alerted {clock(s.alertedAt, timeZone)}</span>
        {s.endedAt ? (
          <span>Back {stamp(s.endedAt, timeZone)}</span>
        ) : (
          <Badge variant="warning" className="text-[11px]">
            Not back yet
          </Badge>
        )}
      </div>
    </motion.li>
  );
}
