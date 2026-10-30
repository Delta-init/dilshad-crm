"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeft, Loader2, ChevronLeft, ChevronRight,
  FileText, Users, Clock, CheckCircle2, XCircle,
  TrendingUp, Search, Mail, Phone, Shield, Calendar,
  Activity, StickyNote, ExternalLink, PhoneMissed, CalendarClock, CalendarCheck, PhoneOff,
  BookMarked, Sparkles, Star, Filter, X as XIcon, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUser, useImpersonate } from "@/hooks/useUsers";
import { useAuthStore } from "@/lib/store/authStore";
import { canViewAs } from "@/lib/impersonation";
import { useUserLeads, useUserLeadStats } from "@/hooks/useLeads";
import { RevenueCard } from "@/components/leads/RevenueCard";
import { formatDate, getInitials } from "@/lib/utils";
import { ExportPdfDialog } from "@/components/reports/ExportPdfDialog";
import { LeadsDateFilter, TodayLeadsButton, SplitTodayButton } from "@/components/leads/LeadsDateFilter";
import type { LeadStatus } from "@/lib/statusConfig";
import { LEAD_STATUSES, STATUS_META } from "@/lib/statusConfig";
import type { User } from "@/types";
import Link from "next/link";
import { toGstDateISO } from "@/lib/utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, { label: STATUS_META[s].label, color: STATUS_META[s].color, dot: STATUS_META[s].dot }]),
) as Record<LeadStatus, { label: string; color: string; dot: string }>;

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeadStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function InfoChip({
  icon: Icon, value,
}: { icon: React.ElementType; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{value}</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function UserDetailPage() {
  const params = useParams();
  const router = useRouter();
  const userId = params.userId as string;

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [splitFrom, setSplitFrom] = useState("");
  const [splitTo, setSplitTo] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);

  function todayISO() { return toGstDateISO(new Date()); }
  const isTodayActive = dateFrom === todayISO() && dateTo === todayISO();
  const isSplitTodayActive = splitFrom === todayISO() && splitTo === todayISO();
  function applySplitToday() {
    const t = todayISO();
    if (isSplitTodayActive) { setSplitFrom(""); setSplitTo(""); }
    else { setSplitFrom(t); setSplitTo(t); }
    setPage(1);
  }

  function applyToday() {
    const today = todayISO();
    if (isTodayActive) { setDateFrom(""); setDateTo(""); }
    else { setDateFrom(today); setDateTo(today); }
    setPage(1);
  }

  const { data: user, isLoading: userLoading } = useUser(userId);
  const me = useAuthStore((s) => s.user);
  const impersonate = useImpersonate();
  const { data: statsData, isLoading: statsLoading } = useUserLeadStats(userId);
  const {
    data: leadsData,
    isLoading: leadsLoading,
    isFetching,
  } = useUserLeads(userId, {
    page,
    limit,
    status: statusFilter !== "all" ? statusFilter : undefined,
    search: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    splitFrom: splitFrom || undefined,
    splitTo: splitTo || undefined,
  });

  const leads = leadsData?.data ?? [];
  const pagination = leadsData?.pagination;
  const stats = statsData;

  function handleSearch() {
    setSearch(searchInput);
    setPage(1);
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (userLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <p className="text-muted-foreground">User not found</p>
        <Button variant="outline" onClick={() => router.push("/users")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Users
        </Button>
      </div>
    );
  }

  const roleName = typeof user.role === "object" ? (user.role as { roleName: string }).roleName : user.role ?? "—";
  const roleObj = typeof user.role === "object" ? user.role as { roleName: string; isSystemRole?: boolean } : null;

  // ── Stat Cards ───────────────────────────────────────────────────────────────
  const statCards: {
    title: string;
    value: number;
    icon: React.ElementType;
    color: string;
    bg: string;
    border: string;
    activeRing: string;
    filterKey: string; // "all" or a LeadStatus value
  }[] = [
    {
      title: "Total",
      value: stats?.total ?? 0,
      icon: FileText,
      color: "text-primary",
      bg: "bg-primary/10",
      border: "border-primary/20",
      activeRing: "ring-primary/40",
      filterKey: "all",
    },
    {
      title: "New",
      value: stats?.new ?? 0,
      icon: Star,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
      activeRing: "ring-blue-400/40",
      filterKey: "new",
    },
    {
      title: "Assigned",
      value: stats?.assigned ?? 0,
      icon: Users,
      color: "text-yellow-400",
      bg: "bg-yellow-500/10",
      border: "border-yellow-500/20",
      activeRing: "ring-yellow-400/40",
      filterKey: "assigned",
    },
    {
      title: "Follow Up",
      value: stats?.followup ?? 0,
      icon: Clock,
      color: "text-orange-400",
      bg: "bg-orange-500/10",
      border: "border-orange-500/20",
      activeRing: "ring-orange-400/40",
      filterKey: "followup",
    },
    {
      title: "Meeting Scheduled",
      value: stats?.meeting_scheduled ?? 0,
      icon: CalendarClock,
      color: "text-teal-400",
      bg: "bg-teal-500/10",
      border: "border-teal-500/20",
      activeRing: "ring-teal-400/40",
      filterKey: "meeting_scheduled",
    },
    {
      title: "Meeting Done",
      value: stats?.meeting_done ?? 0,
      icon: CalendarCheck,
      color: "text-indigo-400",
      bg: "bg-indigo-500/10",
      border: "border-indigo-500/20",
      activeRing: "ring-indigo-400/40",
      filterKey: "meeting_done",
    },
    {
      title: "Pending Response",
      value: stats?.pending_response ?? 0,
      icon: Sparkles,
      color: "text-violet-400",
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
      activeRing: "ring-violet-400/40",
      filterKey: "pending_response",
    },
    {
      title: "CNC",
      value: stats?.cnc ?? 0,
      icon: PhoneMissed,
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
      activeRing: "ring-amber-400/40",
      filterKey: "cnc",
    },
    {
      title: "Not Connected",
      value: stats?.not_connected ?? 0,
      icon: PhoneMissed,
      color: "text-neutral-400",
      bg: "bg-neutral-500/10",
      border: "border-neutral-500/20",
      activeRing: "ring-neutral-400/40",
      filterKey: "not_connected",
    },
    {
      title: "Wrong Number",
      value: stats?.wrong_number ?? 0,
      icon: PhoneOff,
      color: "text-pink-400",
      bg: "bg-pink-500/10",
      border: "border-pink-500/20",
      activeRing: "ring-pink-400/40",
      filterKey: "wrong_number",
    },
    {
      title: "Closed",
      value: stats?.closed ?? 0,
      icon: CheckCircle2,
      color: "text-green-400",
      bg: "bg-green-500/10",
      border: "border-green-500/20",
      activeRing: "ring-green-400/40",
      filterKey: "closed",
    },
    {
      title: "Lost",
      value: stats?.lost ?? 0,
      icon: XCircle,
      color: "text-red-400",
      bg: "bg-red-500/10",
      border: "border-red-500/20",
      activeRing: "ring-red-400/40",
      filterKey: "lost",
    },
    {
      title: "MIA",
      value: stats?.mia ?? 0,
      icon: XCircle,
      color: "text-rose-400",
      bg: "bg-rose-500/10",
      border: "border-rose-500/20",
      activeRing: "ring-rose-400/40",
      filterKey: "mia",
    },
  ];

  // ── Completion rate ──────────────────────────────────────────────────────────
  const completionRate =
    stats && stats.total > 0
      ? Math.round(((stats.closed) / stats.total) * 100)
      : 0;

  return (
    <div className="space-y-6 pb-10">
      {/* Back */}
      <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
        <Button
          variant="ghost" size="sm"
          onClick={() => router.push("/users")}
          className="gap-2 -ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Users
        </Button>
      </motion.div>

      {/* User Profile Card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-border/50 overflow-hidden">
          {/* Gradient banner */}
          <div className="h-20 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />

          <CardContent className="relative pt-0 pb-6">
            {/* Avatar overlapping banner */}
            <div className="-mt-10 mb-4 flex items-end justify-between gap-4 flex-wrap">
              <Avatar className="h-20 w-20 border-4 border-background shadow-lg">
                <AvatarFallback className="bg-primary/15 text-primary text-2xl font-bold">
                  {getInitials(user.name)}
                </AvatarFallback>
              </Avatar>

              {/* Status + role badges + export */}
              <div className="flex items-center gap-2 pb-1 flex-wrap">
                <Badge
                  variant={user.status === "active" ? "success" : "secondary"}
                  className="capitalize"
                >
                  {user.status}
                </Badge>
                {roleObj?.isSystemRole && (
                  <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
                    <Shield className="h-3 w-3" />
                    System
                  </Badge>
                )}
                <ExportPdfDialog
                  type="user"
                  entityId={userId}
                  entityName={user.name}
                />
                {canViewAs(me, user) && (
                  <motion.div whileTap={{ scale: 0.97 }}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300"
                      title={`View as ${user.name} — 30 minutes, acting as them`}
                      disabled={impersonate.isPending}
                      onClick={() => impersonate.mutate(user._id)}
                    >
                      {impersonate.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                      View as
                    </Button>
                  </motion.div>
                )}
              </div>
            </div>

            {/* User details */}
            <div className="space-y-3">
              <div>
                <h2 className="text-2xl font-bold text-foreground">{user.name}</h2>
                {user.designation && (
                  <p className="text-sm text-muted-foreground mt-0.5">{user.designation}</p>
                )}
              </div>

              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <InfoChip icon={Mail}     value={user.email} />
                <InfoChip icon={Shield}   value={roleName} />
                <InfoChip icon={Calendar} value={`Joined ${formatDate(user.createdAt)}`} />
                {user.extension && (
                  <InfoChip icon={Phone} value={`Ext. ${user.extension}`} />
                )}
              </div>

              {/* Performance bar */}
              {!statsLoading && stats && stats.total > 0 && (
                <div className="pt-2">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-xs text-muted-foreground">Closure Rate</span>
                    <span className="text-xs font-semibold text-foreground">{completionRate}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${completionRate}%` }}
                      transition={{ duration: 0.8, ease: "easeOut", delay: 0.3 }}
                      className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                    />
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Stats Cards — click to filter leads below */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-9"
      >
        {statCards.map((stat) => {
          const isActive = statusFilter === stat.filterKey;
          return (
            <motion.div key={stat.title} variants={itemVariants}>
              <button
                type="button"
                className="w-full text-left"
                onClick={() => {
                  setStatusFilter(stat.filterKey);
                  setPage(1);
                }}
              >
                <Card className={`border transition-all cursor-pointer ${
                  isActive
                    ? `${stat.border} ring-2 ${stat.activeRing} bg-card`
                    : "border-border/50 hover:border-border hover:shadow-sm"
                }`}>
                  <CardHeader className="flex flex-row items-center justify-between pb-1.5 pt-3 px-3">
                    <CardTitle className={`text-[10px] font-medium uppercase tracking-wide ${isActive ? stat.color : "text-muted-foreground"}`}>
                      {stat.title}
                    </CardTitle>
                    <div className={`rounded-md p-1 ${stat.bg}`}>
                      <stat.icon className={`h-3 w-3 ${stat.color}`} />
                    </div>
                  </CardHeader>
                  <CardContent className="px-3 pb-3">
                    <p className={`text-xl font-bold ${isActive ? "text-foreground" : "text-foreground"}`}>
                      {statsLoading ? <span className="animate-pulse text-muted-foreground">—</span> : stat.value}
                    </p>
                  </CardContent>
                </Card>
              </button>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Revenue Card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <RevenueCard userId={userId} />
      </motion.div>

      {/* Leads Table */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Card className="border-border/50">
          <CardHeader className="pb-4 space-y-3">
            {/* Row 1 — title + controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base flex-wrap">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Assigned Leads
                {pagination && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {pagination.total}
                  </span>
                )}
                {statusFilter !== "all" && (
                  <button
                    type="button"
                    onClick={() => { setStatusFilter("all"); setPage(1); }}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                  >
                    {STATUS_CONFIG[statusFilter as LeadStatus]?.label}
                    <XCircle className="h-3 w-3" />
                  </button>
                )}
              </CardTitle>

              <div className="flex items-center gap-2 flex-wrap">
                <TodayLeadsButton active={isTodayActive} onClick={applyToday} />
                <SplitTodayButton active={isSplitTodayActive} onClick={applySplitToday} />
                <Button
                  variant={showDateFilter ? "secondary" : "outline"}
                  size="sm"
                  className="h-8 gap-1.5 relative"
                  onClick={() => setShowDateFilter((v) => !v)}
                >
                  <Filter className="h-3.5 w-3.5" />
                  Date Filter
                  {(dateFrom || dateTo || splitFrom || splitTo) && (
                    <span className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">!</span>
                  )}
                </Button>
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                      placeholder="Search leads..."
                      className="pl-8 h-8 w-40 text-sm"
                    />
                  </div>
                  <Button variant="outline" size="sm" className="h-8 px-3" onClick={handleSearch}>Go</Button>
                </div>
                <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
                  <SelectTrigger className="w-[120px] h-8 text-xs">
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    {(Object.keys(STATUS_CONFIG) as LeadStatus[]).map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">
                        {STATUS_CONFIG[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Row 2 — Date filter panel */}
            {showDateFilter && (
              <LeadsDateFilter
                splitFrom={splitFrom}
                splitTo={splitTo}
                onSplitFromChange={(v) => { setSplitFrom(v); setPage(1); }}
                onSplitToChange={(v) => { setSplitTo(v); setPage(1); }}
                dateFrom={dateFrom}
                dateTo={dateTo}
                onDateFromChange={(v) => { setDateFrom(v); setPage(1); }}
                onDateToChange={(v) => { setDateTo(v); setPage(1); }}
              />
            )}

            {/* Active date pills */}
            {(dateFrom || dateTo) && !showDateFilter && (
              <div className="flex flex-wrap items-center gap-1.5">
                {dateFrom && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    From: {dateFrom}
                    <button onClick={() => { setDateFrom(""); setPage(1); }}><XIcon className="h-3 w-3" /></button>
                  </span>
                )}
                {dateTo && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    To: {dateTo}
                    <button onClick={() => { setDateTo(""); setPage(1); }}><XIcon className="h-3 w-3" /></button>
                  </span>
                )}
              </div>
            )}
          </CardHeader>

          <CardContent className="p-0">
            {leadsLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : leads.length === 0 ? (
              <div className="py-16 text-center">
                <TrendingUp className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">No leads found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <th className="px-6 py-3 text-left">Lead</th>
                      <th className="px-6 py-3 text-left hidden sm:table-cell">Phone</th>
                      <th className="px-6 py-3 text-left">Status</th>
                      <th className="px-6 py-3 text-left hidden md:table-cell">Source</th>
                      <th className="px-6 py-3 text-center hidden lg:table-cell">Notes</th>
                      <th className="px-6 py-3 text-left hidden lg:table-cell">Created</th>
                      <th className="px-6 py-3 text-center">View</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {leads.map((lead, i) => {
                      const noteCount = Array.isArray(lead.notes) ? lead.notes.length : 0;
                      return (
                        <motion.tr
                          key={lead._id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.03 }}
                          className="hover:bg-muted/20 transition-colors group"
                        >
                          <td className="px-6 py-4">
                            <div>
                              <p className="font-medium text-sm text-foreground">{lead.name}</p>
                              {lead.email && (
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                  <Mail className="h-3 w-3" />
                                  {lead.email}
                                </p>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 hidden sm:table-cell">
                            <span className="text-sm text-muted-foreground flex items-center gap-1">
                              {lead.phone ? (
                                <><Phone className="h-3 w-3" /> {lead.phone}</>
                              ) : "—"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <StatusBadge status={lead.status} />
                          </td>
                          <td className="px-6 py-4 hidden md:table-cell">
                            <span className="text-sm text-muted-foreground capitalize">
                              {lead.source ?? "—"}
                            </span>
                          </td>
                          <td className="px-6 py-4 hidden lg:table-cell text-center">
                            {noteCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <StickyNote className="h-3 w-3" />
                                {noteCount}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground/40">—</span>
                            )}
                          </td>
                          <td className="px-6 py-4 hidden lg:table-cell">
                            <span className="text-sm text-muted-foreground">
                              {formatDate(lead.createdAt)}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <Link href={`/leads/${lead._id}`}>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 md:opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {pagination && pagination.totalPages >= 1 && (
              <div className="flex items-center justify-between border-t border-border px-6 py-4 flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    Showing{" "}
                    <span className="font-medium text-foreground">
                      {(pagination.page - 1) * pagination.limit + 1}–
                      {Math.min(pagination.page * pagination.limit, pagination.total)}
                    </span>{" "}
                    of <span className="font-medium text-foreground">{pagination.total}</span> leads
                  </p>
                  <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setPage(1); }}>
                    <SelectTrigger className="h-7 w-[70px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[10, 25, 50, 100].map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">{n} / page</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {pagination.totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline" size="icon" className="h-8 w-8"
                      disabled={!pagination.hasPrevPage || isFetching}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm font-medium px-1">
                      {pagination.page} / {pagination.totalPages}
                    </span>
                    <Button
                      variant="outline" size="icon" className="h-8 w-8"
                      disabled={!pagination.hasNextPage || isFetching}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
