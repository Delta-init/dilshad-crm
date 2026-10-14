"use client";

import { useState, useMemo, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import {
  TrendingUp, Users, UsersRound, Target, Award,
  Calendar, RefreshCw, BarChart2, Activity, Layers,
  GitFork, DollarSign, Trophy, ChevronDown, ChevronUp,
  Loader2, Tag, X, AlertTriangle, Timer, CalendarCheck, Filter, ArrowUpRight,
  Sparkles, TrendingDown, Star, Bell, Shield, GitMerge, Clock, CheckCircle2,
  XCircle, PhoneCall, UserCheck, AlertOctagon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ExportPdfDialog } from "@/components/reports/ExportPdfDialog";
import { AiChatPanel } from "@/components/leads/AiChatPanel";
import {
  useReportOverview,
  useReportTimeline,
  useReportUserRankings,
  useReportTeamRankings,
  useReportTeamSplit,
  useRevenueOverview,
  useRevenueTimeline,
  useRevenueTeams,
  useSourceAnalytics,
  useCampaignBreakdown,
  usePipelineBreakdown,
  useResponseTimeReport,
  useLeadTimingReport,
  useFollowUpReport,
  useLeadQualityReport,
  useSalesFunnel,
  useManagementAlerts,
  useAuditReport,
  useMemberSplitReport,
} from "@/hooks/useReports";
import type {
  PipelineStage, PipelineTrendPoint, LeadQualityCampaign, LeadQualitySourceSummary,
  FunnelStage, FunnelTeamRow, FunnelAgentRow,
  AlertLead, ManagementAlertsReport,
  AuditEvent,
  MemberSplitRow, DailyAssignmentPoint, SourceTableRow,
} from "@/hooks/useReports";
import { useTeams } from "@/hooks/useTeams";
import { useAuthStore } from "@/lib/store/authStore";
import { useCurrencyStore } from "@/lib/store/currencyStore";
import { fmtCompact, fmtFull } from "@/lib/currency";
import type {
  TimelinePeriod, LeadStatus, SplitPeriod,
  RevenuePeriod, RevenueTeamDetail, RevenueMemberItem,
  SourceAnalyticsItem, CampaignBreakdownItem,
} from "@/types/reports";
import { LEAD_STATUSES, STATUS_META as S_META } from "@/lib/statusConfig";
import { toGstDateISO } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, {
    label: S_META[s].label,
    color: S_META[s].chartColor,
    bar:   S_META[s].bar,
    dot:   S_META[s].dot,
  }]),
) as Record<LeadStatus, { label: string; color: string; bar: string; dot: string }>;

const ALL_STATUSES: LeadStatus[] = [...LEAD_STATUSES] as LeadStatus[];

const SOURCE_COLORS: Record<string, string> = {
  social:   "#8b5cf6",
  organic:  "#22c55e",
  referral: "#3b82f6",
  direct:   "#f97316",
  other:    "#64748b",
};

const BAR_COLORS = [
  "#6366f1","#8b5cf6","#ec4899","#f59e0b",
  "#10b981","#3b82f6","#ef4444","#14b8a6",
];

/** Palette for team bars in the split chart (cycles if more than 12 teams) */
const TEAM_PALETTE = [
  "#6366f1","#22c55e","#f97316","#14b8a6","#eab308","#ef4444",
  "#8b5cf6","#3b82f6","#ec4899","#84cc16","#06b6d4","#f43f5e",
];

// ── Period helpers ────────────────────────────────────────────────────────────

type QuickPeriod = "today" | "week" | "month" | "quarter" | "year" | "custom";

function toISO(d: Date) { return toGstDateISO(d); }

function getQuickRange(p: QuickPeriod): { from: string; to: string } {
  const now   = new Date();
  const today = toISO(now);
  switch (p) {
    case "today":   return { from: today, to: today };
    case "week": {
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      return { from: toISO(mon), to: today };
    }
    case "month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toISO(first), to: today };
    }
    case "quarter": {
      const first = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from: toISO(first), to: today };
    }
    case "year": {
      return { from: toISO(new Date(now.getFullYear(), 0, 1)), to: today };
    }
    default: return { from: "", to: "" };
  }
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted/50", className)} />;
}

function Empty({ text = "No data for this period" }: { text?: string }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <BarChart2 className="h-8 w-8 opacity-20" />
      {text}
    </div>
  );
}

interface KpiCardProps {
  title:      string;
  value:      string | number;
  sub?:       string;
  icon:       React.ElementType;
  gradient:   string;
  delay?:     number;
  loading?:   boolean;
  className?: string;
}
function KpiCard({ title, value, sub, icon: Icon, gradient, delay = 0, loading, className }: KpiCardProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: "easeOut" }}
    >
      <Card className="relative overflow-hidden border-border/50 bg-card/80 backdrop-blur-sm hover:shadow-lg transition-shadow h-full">
        <div className={cn("absolute inset-0 opacity-5", gradient)} />
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <p className="flex-1 min-w-0 text-[10px] font-medium text-muted-foreground uppercase tracking-wider line-clamp-2 leading-tight">{title}</p>
            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ml-3", gradient)}>
              <Icon className="h-5 w-5 text-white" />
            </div>
          </div>
          {/* The whole figure, under the icon so it has the card's width; long ones
              ("$71,570.25") a size smaller so they stay on one line on a phone. */}
          {loading
            ? <Skeleton className="h-8 w-20 mt-1" />
            : <p className={cn(
                "mt-1 font-bold text-foreground tabular-nums whitespace-nowrap",
                String(value).length > 10 ? "text-lg sm:text-2xl" : String(value).length > 7 ? "text-xl sm:text-3xl" : "text-2xl sm:text-3xl",
              )}>{value}</p>
          }
          {sub && !loading && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-base">🥇</span>;
  if (rank === 2) return <span className="text-base">🥈</span>;
  if (rank === 3) return <span className="text-base">🥉</span>;
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
      {rank}
    </span>
  );
}

function MiniStatusBars({ item, total }: { item: Record<string, number>; total: number }) {
  return (
    <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden w-full min-w-[60px]">
      {ALL_STATUSES.map((s) => {
        const count = item[s] ?? 0;
        const pct   = total > 0 ? (count / total) * 100 : 0;
        if (pct === 0) return null;
        return (
          <div
            key={s}
            className={cn("h-full", STATUS_META[s].bar)}
            style={{ width: `${pct}%` }}
            title={`${STATUS_META[s].label}: ${count}`}
          />
        );
      })}
    </div>
  );
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="rounded-xl border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs max-w-[200px]">
      <p className="font-semibold text-foreground mb-2 truncate">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground truncate">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="font-bold text-foreground shrink-0">{p.value}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="mt-2 pt-2 border-t border-border/50 flex justify-between">
          <span className="text-muted-foreground">Total</span>
          <span className="font-bold">{total}</span>
        </div>
      )}
    </div>
  );
}

// ── Currency helpers (delegates to global currency store) ─────────────────────
// Components that use these must call useCurrencyStore() to subscribe to changes

// The exact figure — "$2,250", not "$2.3K" (2026-10-14). Short amounts only
// on chart axes, where they mark the scale (fmtCompact there).
const fmtUSD  = fmtFull;
const fullUSD = fmtFull;

/** Plain number format */
function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

// ── Revenue chart tooltip ─────────────────────────────────────────────────────

function RevTooltip({ active, payload, label }: {
  active?:   boolean;
  payload?:  Array<{ name: string; value: number; color: string }>;
  label?:    string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="rounded-xl border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs max-w-[230px]">
      <p className="font-semibold text-foreground mb-2 truncate">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground truncate">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="font-bold text-foreground shrink-0">{fullUSD(p.value ?? 0)}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="mt-2 pt-2 border-t border-border/50 flex justify-between">
          <span className="text-muted-foreground">Total</span>
          <span className="font-bold">{fullUSD(total)}</span>
        </div>
      )}
    </div>
  );
}

// ── Period header (shared between tabs with independent state) ────────────────

interface PeriodHeaderProps {
  quickPeriod:    QuickPeriod;
  setQuickPeriod: (p: QuickPeriod) => void;
  customFrom:     string;
  setCustomFrom:  (v: string) => void;
  customTo:       string;
  setCustomTo:    (v: string) => void;
}

function PeriodHeader({
  quickPeriod, setQuickPeriod,
  customFrom, setCustomFrom,
  customTo, setCustomTo,
}: PeriodHeaderProps) {
  const quickBtns: { id: QuickPeriod; label: string }[] = [
    { id: "today",   label: "Today"     },
    { id: "week",    label: "This Week" },
    { id: "month",   label: "This Month"},
    { id: "quarter", label: "Quarter"   },
    { id: "year",    label: "This Year" },
    { id: "custom",  label: "Custom"    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {quickBtns.map((b) => (
          <button
            key={b.id}
            onClick={() => setQuickPeriod(b.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150",
              quickPeriod === b.id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
            )}
          >
            {b.label}
          </button>
        ))}
      </div>
      <AnimatePresence>
        {quickPeriod === "custom" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1: Overview
// ─────────────────────────────────────────────────────────────────────────────

function OverviewTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const [period, setPeriod]       = useState<TimelinePeriod>("daily");
  const [chartView, setChartView] = useState<"all" | LeadStatus>("all");

  const overview  = useReportOverview(dateFrom, dateTo);
  const timeline  = useReportTimeline(period, dateFrom, dateTo);
  const userRanks = useReportUserRankings(dateFrom, dateTo);
  const teamRanks = useReportTeamRankings(dateFrom, dateTo);

  const isLoading  = overview.isLoading;
  const summary    = overview.data?.summary;
  const statusDist = overview.data?.statusDistribution ?? [];
  const sourceDist = overview.data?.sourceDistribution ?? [];

  const pieData = statusDist
    .filter((s) => s.count > 0)
    .map((s) => ({ name: STATUS_META[s.status]?.label, value: s.count, color: STATUS_META[s.status]?.color }));

  const sourceData = sourceDist.map((s) => ({
    name:  s.source.charAt(0).toUpperCase() + s.source.slice(1),
    count: s.count,
    fill:  SOURCE_COLORS[s.source] ?? "#64748b",
  }));

  const timelineSeries: { key: string; label: string; color: string }[] =
    chartView === "all"
      ? [
          { key: "total",      label: "Total",     color: "#94a3b8" },
          { key: "closed",     label: "Closed",    color: "#22c55e" },
          { key: "pending_response", label: "Pending",color: "#8b5cf6" },
          { key: "lost",    label: "Lost",   color: "#ef4444" },
        ]
      : [{ key: chartView, label: STATUS_META[chartView]?.label, color: STATUS_META[chartView]?.color }];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <KpiCard title="Total Leads"     value={summary?.total ?? 0}           icon={Layers}    gradient="bg-gradient-to-br from-blue-500 to-blue-600"   delay={0}    loading={isLoading} />
        <KpiCard title="Closed / Won"    value={summary?.closed ?? 0}          icon={Target}    gradient="bg-gradient-to-br from-green-500 to-green-600"  delay={0.06} loading={isLoading} />
        <KpiCard title="Conversion Rate" value={`${summary?.conversionRate ?? 0}%`} sub="closed ÷ total" icon={TrendingUp} gradient="bg-gradient-to-br from-violet-500 to-violet-600" delay={0.12} loading={isLoading} />
        <KpiCard title="Active Teams"    value={summary?.activeTeams ?? 0}     sub={`of ${summary?.totalTeams ?? 0} total`} icon={UsersRound} gradient="bg-gradient-to-br from-orange-500 to-orange-600" delay={0.18} loading={isLoading} />
        <KpiCard title="Active Users"    value={summary?.activeUsers ?? 0}     icon={Users}     gradient="bg-gradient-to-br from-teal-500 to-teal-600"    delay={0.24} loading={isLoading} className="col-span-2 sm:col-span-1" />
      </div>

      {/* Timeline + Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Area chart */}
        <motion.div className="lg:col-span-3" initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.3 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm h-full">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" /> Lead Volume Over Time
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={chartView} onValueChange={(v) => setChartView(v as typeof chartView)}>
                    <SelectTrigger className="h-7 w-32 text-xs border-border/50"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All overview</SelectItem>
                      {ALL_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex rounded-lg border border-border/50 overflow-hidden">
                    {(["daily","weekly","monthly"] as TimelinePeriod[]).map((p) => (
                      <button key={p} onClick={() => setPeriod(p)}
                        className={cn("px-2.5 py-1 text-xs capitalize font-medium transition-colors",
                          period === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                        {p === "daily" ? "D" : p === "weekly" ? "W" : "M"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {timeline.isLoading ? <Skeleton className="h-[260px] w-full" /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={timeline.data ?? []} margin={{ top:5, right:10, left:-20, bottom:0 }}>
                    <defs>
                      {timelineSeries.map((s) => (
                        <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={s.color} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                    <XAxis dataKey="label" tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <RechartsTooltip content={<ChartTooltip />} />
                    {timelineSeries.length > 1 && (
                      <Legend wrapperStyle={{ fontSize:"11px", paddingTop:"8px" }}
                        formatter={(v) => <span style={{ color:"hsl(var(--muted-foreground))" }}>{v}</span>} />
                    )}
                    {timelineSeries.map((s) => (
                      <Area key={s.key} type="monotone" dataKey={s.key} name={s.label}
                        stroke={s.color} strokeWidth={2} fill={`url(#grad-${s.key})`}
                        dot={false} activeDot={{ r:4, strokeWidth:0 }} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Donut */}
        <motion.div className="lg:col-span-2" initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.36 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" /> Status Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {isLoading ? <Skeleton className="h-[220px] w-full" /> : pieData.length === 0 ? <Empty /> : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={52} outerRadius={80} paddingAngle={2} dataKey="value">
                        {pieData.map((e, i) => <Cell key={i} fill={e.color} strokeWidth={0} />)}
                      </Pie>
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          return (
                            <div className="rounded-lg border border-border bg-card p-2 text-xs shadow-lg">
                              <span className="font-semibold">{payload[0].name}</span>: {payload[0].value}
                            </div>
                          );
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-1">
                    {statusDist.filter((s) => s.count > 0).map((s) => (
                      <div key={s.status} className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_META[s.status]?.dot)} />
                          <span className="text-xs text-muted-foreground truncate">{STATUS_META[s.status]?.label}</span>
                        </div>
                        <span className="text-xs font-semibold text-foreground tabular-nums shrink-0">{s.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* User + Team rankings */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* User Rankings */}
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.42 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Award className="h-4 w-4 text-primary" /> User Rankings
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                {userRanks.isLoading
                  ? <div className="space-y-2">{[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
                  : !userRanks.data?.length ? <Empty />
                  : (
                    <table className="w-full text-xs min-w-[620px]">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="pb-2 text-left font-medium text-muted-foreground w-8">#</th>
                          <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                          <th className="pb-2 text-right font-medium text-muted-foreground">Total</th>
                          <th className="pb-2 text-right font-medium text-green-500">Closed</th>
                          <th className="pb-2 text-right font-medium text-emerald-500">Revenue</th>
                          <th className="pb-2 text-right font-medium text-amber-500">Pending</th>
                          <th className="pb-2 text-right font-medium text-muted-foreground">Conv%</th>
                          <th className="pb-2 text-left font-medium text-muted-foreground pl-3 hidden sm:table-cell">Breakdown</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {userRanks.data.map((u) => (
                          <motion.tr key={u.userId} initial={{ opacity:0,x:-10 }} animate={{ opacity:1,x:0 }} transition={{ delay:0.05*u.rank }} className="hover:bg-muted/30 transition-colors">
                            <td className="py-2.5 pr-2"><RankBadge rank={u.rank} /></td>
                            <td className="py-2.5 pr-3">
                              <div className="flex items-center gap-2">
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs uppercase">{u.name.charAt(0)}</div>
                                <div className="min-w-0">
                                  <p className="font-semibold text-foreground truncate max-w-[120px]">{u.name}</p>
                                  {u.designation && <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{u.designation}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 text-right font-semibold tabular-nums">{u.total}</td>
                            <td className="py-2.5 text-right"><span className="font-bold text-green-500 tabular-nums">{u.closed}</span></td>
                            <td className="py-2.5 text-right">
                              <span className="font-semibold text-emerald-500 tabular-nums">{fmtUSD(u.revenue ?? 0)}</span>
                            </td>
                            <td className="py-2.5 text-right">
                              <span className={cn("font-semibold tabular-nums", (u.pendingAmount ?? 0) > 0 ? "text-amber-500" : "text-muted-foreground")}>
                                {fmtUSD(u.pendingAmount ?? 0)}
                              </span>
                            </td>
                            <td className="py-2.5 text-right">
                              <span className={cn("font-semibold tabular-nums", u.conversionRate>=50?"text-green-500":u.conversionRate>=25?"text-yellow-500":"text-muted-foreground")}>
                                {u.conversionRate}%
                              </span>
                            </td>
                            <td className="py-2.5 pl-3 hidden sm:table-cell">
                              <MiniStatusBars item={u as unknown as Record<string,number>} total={u.total} />
                            </td>
                          </motion.tr>
                        ))}
                      </tbody>
                    </table>
                  )
                }
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Team Rankings */}
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.48 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <UsersRound className="h-4 w-4 text-primary" /> Team Rankings
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                {teamRanks.isLoading
                  ? <div className="space-y-2">{[1,2,3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
                  : !teamRanks.data?.length ? <Empty />
                  : (
                    <table className="w-full text-xs min-w-[520px]">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="pb-2 text-left font-medium text-muted-foreground w-8">#</th>
                          <th className="pb-2 text-left font-medium text-muted-foreground">Team</th>
                          <th className="pb-2 text-right font-medium text-muted-foreground">Members</th>
                          <th className="pb-2 text-right font-medium text-muted-foreground">Leads</th>
                          <th className="pb-2 text-right font-medium text-emerald-500">Revenue</th>
                          <th className="pb-2 text-right font-medium text-muted-foreground">Conv%</th>
                          <th className="pb-2 text-left font-medium text-muted-foreground pl-3 hidden sm:table-cell">Breakdown</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {teamRanks.data.map((t) => (
                          <motion.tr key={t.teamId} initial={{ opacity:0,x:10 }} animate={{ opacity:1,x:0 }} transition={{ delay:0.05*t.rank }} className="hover:bg-muted/30 transition-colors">
                            <td className="py-2.5 pr-2"><RankBadge rank={t.rank} /></td>
                            <td className="py-2.5 pr-3"><p className="font-semibold text-foreground truncate max-w-[140px]">{t.name}</p></td>
                            <td className="py-2.5 text-right tabular-nums text-muted-foreground">{t.memberCount}</td>
                            <td className="py-2.5 text-right font-semibold tabular-nums">{t.total}</td>
                            <td className="py-2.5 text-right">
                              <span className="font-bold text-emerald-500 tabular-nums">
                                {fullUSD(t.totalPayments ?? 0)}
                              </span>
                            </td>
                            <td className="py-2.5 text-right">
                              <span className={cn("font-semibold tabular-nums", t.conversionRate>=50?"text-green-500":t.conversionRate>=25?"text-yellow-500":"text-muted-foreground")}>
                                {t.conversionRate}%
                              </span>
                            </td>
                            <td className="py-2.5 pl-3 hidden sm:table-cell">
                              <MiniStatusBars item={t as unknown as Record<string,number>} total={t.total} />
                            </td>
                          </motion.tr>
                        ))}
                      </tbody>
                    </table>
                  )
                }
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Status bars + Source */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.54 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" /> Leads by Status
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              {isLoading
                ? <div className="space-y-3">{[1,2,3,4,5,6].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
                : statusDist.map((s, idx) => {
                    const meta  = STATUS_META[s.status];
                    const maxC  = Math.max(...statusDist.map((x) => x.count), 1);
                    return (
                      <motion.div key={s.status} initial={{ opacity:0,x:-20 }} animate={{ opacity:1,x:0 }} transition={{ delay:0.06*idx }} className="flex items-center gap-3">
                        <div className="w-20 shrink-0 text-xs text-muted-foreground font-medium text-right">{meta?.label}</div>
                        <div className="flex-1 h-6 rounded-full bg-muted/40 overflow-hidden">
                          <motion.div className={cn("h-full rounded-full", meta?.bar)}
                            initial={{ width:0 }} animate={{ width:`${(s.count/maxC)*100}%` }}
                            transition={{ delay:0.1+0.05*idx, duration:0.6, ease:"easeOut" }} />
                        </div>
                        <div className="w-16 shrink-0 flex items-center justify-between">
                          <span className="text-xs font-bold text-foreground tabular-nums">{s.count}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{s.pct}%</span>
                        </div>
                      </motion.div>
                    );
                  })
              }
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.6 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" /> Leads by Source
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {isLoading ? <Skeleton className="h-[220px] w-full" /> : sourceData.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={sourceData} layout="vertical" margin={{ top:0, right:30, left:10, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                    <XAxis type="number" tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize:11, fill:"hsl(var(--foreground))" }} tickLine={false} axisLine={false} width={65} />
                    <RechartsTooltip content={<ChartTooltip />} cursor={{ fill:"hsl(var(--muted))", opacity:0.3 }} />
                    <Bar dataKey="count" name="Leads" radius={[0,4,4,0]} maxBarSize={28}>
                      {sourceData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Top 3 Performers */}
      {!userRanks.isLoading && (userRanks.data?.length ?? 0) >= 1 && (
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.66 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Award className="h-4 w-4 text-yellow-500" /> Top Performers
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {userRanks.data!.slice(0,3).map((u,i) => {
                  const grads = [
                    "from-yellow-500/10 to-yellow-500/5 border-yellow-500/20",
                    "from-neutral-400/10 to-neutral-400/5 border-neutral-400/20",
                    "from-orange-700/10 to-orange-700/5 border-orange-700/20",
                  ];
                  return (
                    <motion.div key={u.userId} initial={{ opacity:0,scale:0.95 }} animate={{ opacity:1,scale:1 }} transition={{ delay:0.1*i }}
                      className={cn("rounded-xl border bg-gradient-to-br p-4 text-center", grads[i])}>
                      <div className="text-3xl mb-2">{["🥇","🥈","🥉"][i]}</div>
                      <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-lg uppercase mb-2">
                        {u.name.charAt(0)}
                      </div>
                      <p className="font-bold text-foreground text-sm truncate">{u.name}</p>
                      {u.designation && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{u.designation}</p>}
                      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                        <div><p className="text-base font-bold text-foreground tabular-nums">{u.total}</p><p className="text-[10px] text-muted-foreground">Total</p></div>
                        <div><p className="text-base font-bold text-green-500 tabular-nums">{u.closed}</p><p className="text-[10px] text-muted-foreground">Closed</p></div>
                        <div><p className="text-sm font-bold text-emerald-500 tabular-nums">{fmtUSD(u.revenue ?? 0)}</p><p className="text-[10px] text-muted-foreground">Revenue</p></div>
                        <div><p className={cn("text-sm font-bold tabular-nums", (u.pendingAmount??0)>0?"text-amber-500":"text-muted-foreground")}>{fmtUSD(u.pendingAmount ?? 0)}</p><p className="text-[10px] text-muted-foreground">Pending</p></div>
                      </div>
                      <div className="mt-3"><MiniStatusBars item={u as unknown as Record<string,number>} total={u.total} /></div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2: Lead Splitting
// ─────────────────────────────────────────────────────────────────────────────

function LeadSplitTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [splitPeriod, setSplitPeriod] = useState<SplitPeriod>("monthly");
  const [focusTeam,   setFocusTeam]   = useState<string>("all");
  const [memberTeamId, setMemberTeamId] = useState<string>("");

  const query      = useReportTeamSplit(splitPeriod, dateFrom, dateTo);
  const memberQuery = useMemberSplitReport({ teamId: memberTeamId || undefined, dateFrom, dateTo });
  const data  = query.data;
  const mdata = memberQuery.data;

  const teams    = data?.teams    ?? [];
  const timeline = data?.timeline ?? [];
  const summary  = data?.summary  ?? [];

  // Chart series — filter to focused team or show all
  const activeSeries = useMemo(() => {
    const allTeams = focusTeam === "all" ? teams : teams.filter((t) => t === focusTeam);
    return allTeams.map((name, i) => ({
      name,
      color: TEAM_PALETTE[i % TEAM_PALETTE.length],
    }));
  }, [teams, focusTeam]);

  const periodBtns: { id: SplitPeriod; label: string }[] = [
    { id: "daily",   label: "Daily"   },
    { id: "weekly",  label: "Weekly"  },
    { id: "monthly", label: "Monthly" },
    { id: "yearly",  label: "Yearly"  },
  ];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Period toggle */}
        <div className="flex rounded-lg border border-border/50 overflow-hidden shrink-0">
          {periodBtns.map((b) => (
            <button
              key={b.id}
              onClick={() => setSplitPeriod(b.id)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                splitPeriod === b.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* Team focus filter */}
        {teams.length > 1 && (
          <Select value={focusTeam} onValueChange={setFocusTeam}>
            <SelectTrigger className="h-8 w-44 text-xs border-border/50">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {query.isFetching && (
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground ml-auto" />
        )}
      </div>

      {/* Stacked bar chart */}
      <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.1 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <GitFork className="h-4 w-4 text-primary" />
              Lead Distribution by Team
              <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">
                {splitPeriod}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {query.isLoading ? (
              <Skeleton className="h-[320px] w-full" />
            ) : timeline.length === 0 ? (
              <Empty text="No team lead data for this period" />
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={timeline} margin={{ top:5, right:20, left:-15, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <RechartsTooltip content={<ChartTooltip />} cursor={{ fill:"hsl(var(--muted))", opacity:0.3 }} />
                  <Legend
                    wrapperStyle={{ fontSize:"11px", paddingTop:"12px" }}
                    formatter={(v) => <span style={{ color:"hsl(var(--foreground))" }}>{v}</span>}
                  />
                  {activeSeries.map((s) => (
                    <Bar
                      key={s.name}
                      dataKey={s.name}
                      name={s.name}
                      stackId="a"
                      fill={s.color}
                      radius={activeSeries[activeSeries.length - 1].name === s.name ? [4,4,0,0] : [0,0,0,0]}
                      maxBarSize={60}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Team-by-team count cards (top summary) */}
      {!query.isLoading && summary.length > 0 && (
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.2 }}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {summary.map((t, i) => {
              const color = TEAM_PALETTE[i % TEAM_PALETTE.length];
              return (
                <motion.div
                  key={t.teamName}
                  initial={{ opacity:0, scale:0.95 }}
                  animate={{ opacity:1, scale:1 }}
                  transition={{ delay:0.05*i }}
                  onClick={() => setFocusTeam(focusTeam === t.teamName ? "all" : t.teamName)}
                  className={cn(
                    "rounded-xl border p-4 cursor-pointer transition-all duration-200 hover:shadow-md",
                    focusTeam === t.teamName
                      ? "border-primary/50 bg-primary/5 shadow-sm"
                      : "border-border/50 bg-card/80 hover:border-border",
                  )}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-white text-xs font-bold shrink-0"
                      style={{ background: color }}
                    >
                      {t.teamName.charAt(0).toUpperCase()}
                    </div>
                    <RankBadge rank={t.rank} />
                  </div>
                  <p className="text-xs font-semibold text-foreground truncate mb-1">{t.teamName}</p>
                  <p className="text-2xl font-bold text-foreground tabular-nums">{t.total}</p>
                  <p className="text-[10px] text-muted-foreground mb-2">leads total</p>
                  <MiniStatusBars item={t as unknown as Record<string,number>} total={t.total} />
                  <div className="mt-2 flex justify-between text-[10px]">
                    <span className="text-green-500 font-semibold">✓ {t.closed} closed</span>
                    <span className="text-muted-foreground">{t.conversionRate}% conv</span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Detailed status table */}
      {!query.isLoading && summary.length > 0 && (
        <motion.div initial={{ opacity:0,y:20 }} animate={{ opacity:1,y:0 }} transition={{ delay:0.3 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                Team Status Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs" style={{ minWidth: "720px" }}>
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground w-8">#</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground">Team</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Total</th>
                      {ALL_STATUSES.map((s) => (
                        <th key={s} className="pb-2 text-right font-medium" style={{ color: STATUS_META[s].color }}>
                          {STATUS_META[s].label}
                        </th>
                      ))}
                      <th className="pb-2 text-right font-medium text-green-500">Conv%</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground pl-3">Split</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {summary.map((t, i) => {
                      const color = TEAM_PALETTE[i % TEAM_PALETTE.length];
                      return (
                        <motion.tr
                          key={t.teamName}
                          initial={{ opacity:0, x:-10 }}
                          animate={{ opacity:1, x:0 }}
                          transition={{ delay:0.04*i }}
                          className="hover:bg-muted/30 transition-colors"
                        >
                          <td className="py-2.5 pr-2"><RankBadge rank={t.rank} /></td>
                          <td className="py-2.5 pr-3">
                            <div className="flex items-center gap-2">
                              <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
                              <span className="font-semibold text-foreground truncate max-w-[120px]">{t.teamName}</span>
                            </div>
                          </td>
                          <td className="py-2.5 text-right font-bold tabular-nums">{t.total}</td>
                          {ALL_STATUSES.map((s) => (
                            <td key={s} className="py-2.5 text-right tabular-nums text-muted-foreground">
                              {(t as unknown as Record<string,number>)[s] ?? 0}
                            </td>
                          ))}
                          <td className="py-2.5 text-right">
                            <span className={cn("font-semibold tabular-nums",
                              t.conversionRate>=50?"text-green-500":t.conversionRate>=25?"text-yellow-500":"text-muted-foreground")}>
                              {t.conversionRate}%
                            </span>
                          </td>
                          <td className="py-2.5 pl-3 min-w-[80px]">
                            <MiniStatusBars item={t as unknown as Record<string,number>} total={t.total} />
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                  {/* Totals row */}
                  {summary.length > 1 && (() => {
                    const grand = summary.reduce((acc, t) => {
                      acc.total += t.total;
                      ALL_STATUSES.forEach((s) => { acc[s] = (acc[s] ?? 0) + ((t as unknown as Record<string,number>)[s] ?? 0); });
                      return acc;
                    }, { total: 0 } as Record<string, number>);
                    return (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/20">
                          <td />
                          <td className="py-2.5 pr-3 text-xs font-bold text-foreground">Total</td>
                          <td className="py-2.5 text-right font-bold tabular-nums">{grand.total}</td>
                          {ALL_STATUSES.map((s) => (
                            <td key={s} className="py-2.5 text-right font-semibold tabular-nums text-foreground">{grand[s] ?? 0}</td>
                          ))}
                          <td className="py-2.5 text-right">
                            <span className={cn("font-semibold tabular-nums",
                              grand.total > 0 && ((grand.closed/grand.total)*100)>=50 ? "text-green-500"
                              : grand.total > 0 && ((grand.closed/grand.total)*100)>=25 ? "text-yellow-500"
                              : "text-muted-foreground")}>
                              {grand.total > 0 ? +((grand.closed/grand.total)*100).toFixed(1) : 0}%
                            </span>
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ── Member Split Panels ─────────────────────────────────────────── */}
      <MemberSplitPanels
        dateFrom={dateFrom}
        dateTo={dateTo}
        teamId={memberTeamId}
        setTeamId={setMemberTeamId}
      />
    </div>
  );
}

// ── Member Split Panels (sub-component to keep LeadSplitTab readable) ────────

const MEMBER_PALETTE = [
  "#6366f1","#22c55e","#f97316","#14b8a6","#eab308","#ef4444",
  "#8b5cf6","#3b82f6","#ec4899","#84cc16","#06b6d4","#f43f5e",
  "#a78bfa","#34d399","#fb923c","#38bdf8",
];

function MemberSplitPanels({
  dateFrom, dateTo, teamId, setTeamId,
}: {
  dateFrom: string; dateTo: string; teamId: string; setTeamId: (v: string) => void;
}) {
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teamsList = teamsData?.data ?? [];
  const { data, isLoading } = useMemberSplitReport({ teamId: teamId || undefined, dateFrom, dateTo });

  const members      = data?.members      ?? [];
  const daily        = data?.daily        ?? [];
  const sourceTable  = data?.sourceTable  ?? [];
  const sourceMembers = data?.sourceMembers ?? [];

  return (
    <div className="space-y-6">
      {/* Team filter for member panels */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Filter team:</span>
        </div>
        <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-44 text-xs border-border/50">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Teams</SelectItem>
            {teamsList.map((t: { _id: string; name: string }) => (
              <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <span className="text-xs text-muted-foreground ml-auto">
            {data.totalAssigned.toLocaleString()} total assignments
          </span>
        )}
      </div>

      {/* ── Panel 1: Daily Assignment Timeline ─────────────────────────── */}
      <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.15 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Daily Assignment Timeline
              <span className="text-[10px] text-muted-foreground font-normal ml-1">
                (leads auto-assigned per day)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : daily.length === 0 ? (
              <Empty text="No assignments in this period" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={daily} margin={{ top:5, right:20, left:-15, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.4} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize:9, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false} axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize:9, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false} axisLine={false}
                    allowDecimals={false}
                  />
                  <RechartsTooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-xl text-xs">
                          <p className="font-semibold text-foreground mb-1">{label}</p>
                          <p className="text-primary font-medium">{payload[0].value} assigned</p>
                        </div>
                      );
                    }}
                    cursor={{ fill:"hsl(var(--muted))", opacity:0.3 }}
                  />
                  <Bar dataKey="count" name="Assigned" fill="#6366f1" radius={[4,4,0,0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Panel 2: Member-wise Assignment Count ──────────────────────── */}
      <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.2 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-primary" />
              Member-wise Assignment Count
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : members.length === 0 ? (
              <Empty text="No member assignment data for this period" />
            ) : (
              <div className="space-y-4">
                {/* Horizontal bar chart */}
                <div className="space-y-2">
                  {members.map((m: MemberSplitRow, i: number) => {
                    const maxTotal = members[0].total || 1;
                    const pct      = Math.round((m.total / maxTotal) * 100);
                    const color    = MEMBER_PALETTE[i % MEMBER_PALETTE.length];
                    return (
                      <motion.div
                        key={m.memberId}
                        initial={{ opacity:0, x:-10 }}
                        animate={{ opacity:1, x:0 }}
                        transition={{ delay: i * 0.04 }}
                        className="flex items-center gap-3"
                      >
                        <span className="text-xs text-muted-foreground w-4 shrink-0 text-right">{i+1}</span>
                        <span className="text-xs font-medium w-28 shrink-0 truncate">{m.memberName}</span>
                        <div className="flex-1 h-5 bg-muted/40 rounded-full overflow-hidden">
                          <motion.div
                            className="h-full rounded-full"
                            style={{ background: color }}
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.6, delay: i * 0.04, ease: "easeOut" }}
                          />
                        </div>
                        <span className="text-xs font-bold tabular-nums w-8 text-right shrink-0">{m.total}</span>
                        <span className="text-[10px] text-green-500 w-12 shrink-0">{m.conversionRate}% conv</span>
                      </motion.div>
                    );
                  })}
                </div>

                {/* Summary table */}
                <div className="overflow-x-auto mt-4">
                  <table className="w-full text-xs" style={{ minWidth: "480px" }}>
                    <thead>
                      <tr className="border-b border-border/40">
                        <th className="pb-2 text-left text-muted-foreground font-medium">#</th>
                        <th className="pb-2 text-left text-muted-foreground font-medium">Member</th>
                        <th className="pb-2 text-right text-muted-foreground font-medium">Assigned</th>
                        <th className="pb-2 text-right text-green-500 font-medium">Closed</th>
                        <th className="pb-2 text-right text-red-500 font-medium">Lost</th>
                        <th className="pb-2 text-right text-blue-500 font-medium">Follow-Up</th>
                        <th className="pb-2 text-right text-muted-foreground font-medium">New/Asgn</th>
                        <th className="pb-2 text-right text-muted-foreground font-medium">Conv%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {members.map((m: MemberSplitRow, i: number) => (
                        <motion.tr
                          key={m.memberId}
                          initial={{ opacity:0 }}
                          animate={{ opacity:1 }}
                          transition={{ delay: i * 0.03 }}
                          className="hover:bg-muted/20 transition-colors"
                        >
                          <td className="py-2 pr-2">
                            <span className="text-muted-foreground">{m.rank}</span>
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-2 rounded-full shrink-0" style={{ background: MEMBER_PALETTE[i % MEMBER_PALETTE.length] }} />
                              <span className="font-medium text-foreground truncate max-w-[140px]">{m.memberName}</span>
                            </div>
                          </td>
                          <td className="py-2 text-right font-bold tabular-nums">{m.total}</td>
                          <td className="py-2 text-right tabular-nums text-green-500 font-medium">{m.closed}</td>
                          <td className="py-2 text-right tabular-nums text-red-500">{m.lost}</td>
                          <td className="py-2 text-right tabular-nums text-blue-500">{m.followup}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{m.new_assigned}</td>
                          <td className="py-2 text-right">
                            <span className={cn(
                              "font-semibold tabular-nums",
                              m.conversionRate >= 50 ? "text-green-500"
                              : m.conversionRate >= 25 ? "text-yellow-500"
                              : "text-muted-foreground",
                            )}>
                              {m.conversionRate}%
                            </span>
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                    {/* Totals row */}
                    {members.length > 1 && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/20">
                          <td />
                          <td className="py-2 font-bold text-foreground">Total</td>
                          <td className="py-2 text-right font-bold tabular-nums">{members.reduce((s, m) => s + m.total, 0)}</td>
                          <td className="py-2 text-right font-bold tabular-nums text-green-500">{members.reduce((s, m) => s + m.closed, 0)}</td>
                          <td className="py-2 text-right font-semibold tabular-nums text-red-500">{members.reduce((s, m) => s + m.lost, 0)}</td>
                          <td className="py-2 text-right font-semibold tabular-nums text-blue-500">{members.reduce((s, m) => s + m.followup, 0)}</td>
                          <td className="py-2 text-right font-semibold tabular-nums text-muted-foreground">{members.reduce((s, m) => s + m.new_assigned, 0)}</td>
                          <td className="py-2 text-right">
                            {(() => {
                              const tot = members.reduce((s, m) => s + m.total, 0);
                              const cls = members.reduce((s, m) => s + m.closed, 0);
                              const r   = tot > 0 ? +((cls / tot) * 100).toFixed(1) : 0;
                              return <span className={cn("font-bold tabular-nums", r>=50?"text-green-500":r>=25?"text-yellow-500":"text-muted-foreground")}>{r}%</span>;
                            })()}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Panel 3: Source-wise Split Cross-tab ───────────────────────── */}
      {(sourceTable.length > 0 || isLoading) && (
        <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.25 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Tag className="h-4 w-4 text-primary" />
                Source-wise Split
                <span className="text-[10px] text-muted-foreground font-normal ml-1">
                  (lead source → member assignment count)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {isLoading ? (
                <Skeleton className="h-[180px] w-full" />
              ) : sourceTable.length === 0 ? (
                <Empty text="No source data for this period" />
              ) : (
                <div className="overflow-x-auto -mx-2 px-2">
                  <table className="w-full text-xs" style={{ minWidth: `${Math.max(480, 160 + sourceMembers.length * 90)}px` }}>
                    <thead>
                      <tr className="border-b border-border/40">
                        <th className="pb-2 text-left text-muted-foreground font-medium w-28">Source</th>
                        <th className="pb-2 text-right text-muted-foreground font-medium">Total</th>
                        {sourceMembers.map((m, i) => (
                          <th key={m} className="pb-2 text-right font-medium" style={{ color: MEMBER_PALETTE[i % MEMBER_PALETTE.length] }}>
                            {m.split(" ")[0]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {sourceTable.map((row: SourceTableRow, i: number) => {
                        const maxTotal = sourceTable[0].total || 1;
                        const barPct   = Math.round(((row.total as number) / maxTotal) * 100);
                        return (
                          <motion.tr
                            key={row.source}
                            initial={{ opacity:0, x:-5 }}
                            animate={{ opacity:1, x:0 }}
                            transition={{ delay: i * 0.04 }}
                            className="hover:bg-muted/20 transition-colors"
                          >
                            <td className="py-2.5 pr-3">
                              <div className="flex items-center gap-2">
                                <div
                                  className="h-1.5 rounded-full bg-primary/60 shrink-0 transition-all"
                                  style={{ width: `${Math.max(4, barPct * 0.5)}px` }}
                                />
                                <span className="font-medium text-foreground capitalize truncate max-w-[90px]">
                                  {row.source}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 text-right font-bold tabular-nums">{row.total}</td>
                            {sourceMembers.map((m) => (
                              <td key={m} className="py-2.5 text-right tabular-nums text-muted-foreground">
                                {(row[m] as number) || 0}
                              </td>
                            ))}
                          </motion.tr>
                        );
                      })}
                    </tbody>
                    {/* Source totals footer */}
                    {sourceTable.length > 1 && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-muted/20">
                          <td className="py-2 font-bold text-foreground">Total</td>
                          <td className="py-2 text-right font-bold tabular-nums">
                            {sourceTable.reduce((s, r) => s + (r.total as number), 0)}
                          </td>
                          {sourceMembers.map((m) => (
                            <td key={m} className="py-2 text-right font-semibold tabular-nums">
                              {sourceTable.reduce((s, r) => s + ((r[m] as number) || 0), 0)}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3: Revenue
// ─────────────────────────────────────────────────────────────────────────────

function RevenueTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const [revPeriod,    setRevPeriod]    = useState<RevenuePeriod>("monthly");
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);

  const overview = useRevenueOverview(dateFrom, dateTo);
  const timeline = useRevenueTimeline(revPeriod, dateFrom, dateTo);
  const teamsQ   = useRevenueTeams(dateFrom, dateTo);

  const ovData     = overview.data;
  const tlData     = timeline.data;
  const teamsData  = (teamsQ.data ?? []) as RevenueTeamDetail[];
  const tlTeams    = tlData?.teams    ?? [];
  const tlTimeline = tlData?.timeline ?? [];

  const periodBtns: { id: RevenuePeriod; label: string }[] = [
    { id: "daily",   label: "D" },
    { id: "weekly",  label: "W" },
    { id: "monthly", label: "M" },
    { id: "yearly",  label: "Y" },
  ];

  return (
    <div className="space-y-6">

      {/* ── KPI Cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <KpiCard
          title="Total Received"
          value={overview.isLoading ? "—" : fmtUSD(ovData?.totalRevenue ?? 0)}
          sub={`${ovData?.paymentCount ?? 0} payments`}
          icon={DollarSign}
          gradient="bg-gradient-to-br from-emerald-500 to-emerald-600"
          delay={0}
          loading={overview.isLoading}
        />
        <KpiCard
          title="Total Pending"
          value={overview.isLoading ? "—" : fmtUSD(ovData?.totalPending ?? 0)}
          sub="outstanding balance"
          icon={TrendingUp}
          gradient="bg-gradient-to-br from-amber-500 to-amber-600"
          delay={0.06}
          loading={overview.isLoading}
        />
        <KpiCard
          title="Overpaid Leads"
          value={overview.isLoading ? "—" : String(ovData?.overpaidCount ?? 0)}
          sub={overview.isLoading ? "—" : `${fmtUSD(ovData?.overpaidTotal ?? 0)} excess`}
          icon={AlertTriangle}
          gradient={
            (ovData?.overpaidCount ?? 0) > 0
              ? "bg-gradient-to-br from-red-500 to-red-600"
              : "bg-gradient-to-br from-neutral-500 to-neutral-600"
          }
          delay={0.12}
          loading={overview.isLoading}
        />
        <KpiCard
          title="Top Earning Team"
          value={overview.isLoading ? "—" : fmtUSD(ovData?.topTeam?.revenue ?? 0)}
          sub={ovData?.topTeam?.name ?? "No data"}
          icon={Trophy}
          gradient="bg-gradient-to-br from-yellow-500 to-yellow-600"
          delay={0.18}
          loading={overview.isLoading}
        />
        <KpiCard
          title="Top Earning Agent"
          value={overview.isLoading ? "—" : fmtUSD(ovData?.topAgent?.revenue ?? 0)}
          sub={ovData?.topAgent?.name ?? "No data"}
          icon={Award}
          gradient="bg-gradient-to-br from-violet-500 to-violet-600"
          delay={0.24}
          loading={overview.isLoading}
        />
        <KpiCard
          title="Avg per Lead"
          value={overview.isLoading ? "—" : fmtUSD(ovData?.avgRevenuePerLead ?? 0)}
          sub={`${ovData?.payingLeadCount ?? 0} paying leads`}
          icon={Activity}
          gradient="bg-gradient-to-br from-blue-500 to-blue-600"
          delay={0.30}
          loading={overview.isLoading}
        />
      </div>

      {/* ── Revenue Timeline Chart ─────────────────────────────────────────── */}
      <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.24 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" /> Revenue Over Time
              </CardTitle>
              <div className="flex rounded-lg border border-border/50 overflow-hidden self-start">
                {periodBtns.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setRevPeriod(b.id)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors",
                      revPeriod === b.id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {timeline.isLoading ? (
              <Skeleton className="h-[280px] w-full" />
            ) : tlTimeline.length === 0 ? (
              <Empty text="No revenue data for this period" />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={tlTimeline} margin={{ top:5, right:10, left:10, bottom:0 }}>
                  <defs>
                    {(tlTeams.length > 0 ? tlTeams : ["Total"]).map((t, i) => (
                      <linearGradient key={t} id={`rev-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={TEAM_PALETTE[i % TEAM_PALETTE.length]} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={TEAM_PALETTE[i % TEAM_PALETTE.length]} stopOpacity={0.02} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtCompact(v)}
                    width={60}
                  />
                  <RechartsTooltip content={<RevTooltip />} />
                  {tlTeams.length > 1 && (
                    <Legend
                      wrapperStyle={{ fontSize:"11px", paddingTop:"8px" }}
                      formatter={(v) => <span style={{ color:"hsl(var(--foreground))" }}>{v}</span>}
                    />
                  )}
                  {tlTeams.length === 0 ? (
                    <Area
                      type="monotone"
                      dataKey="total"
                      name="Total Revenue"
                      stroke={TEAM_PALETTE[0]}
                      strokeWidth={2}
                      fill="url(#rev-grad-0)"
                      dot={false}
                      activeDot={{ r:4, strokeWidth:0 }}
                    />
                  ) : tlTeams.map((t, i) => (
                    <Area
                      key={t}
                      type="monotone"
                      dataKey={t}
                      name={t}
                      stroke={TEAM_PALETTE[i % TEAM_PALETTE.length]}
                      strokeWidth={2}
                      fill={`url(#rev-grad-${i})`}
                      dot={false}
                      activeDot={{ r:4, strokeWidth:0 }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Team Revenue Rankings + Agent Leaderboard ─────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Team Revenue Rankings — expandable */}
        <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.3 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <UsersRound className="h-4 w-4 text-primary" /> Team Revenue
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {teamsQ.isLoading ? (
                <div className="space-y-3">
                  {[1,2,3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
                </div>
              ) : teamsData.length === 0 ? (
                <Empty text="No team revenue data" />
              ) : (
                <div className="space-y-2">
                  {teamsData.map((team, i) => {
                    const color      = TEAM_PALETTE[i % TEAM_PALETTE.length];
                    const maxRev     = teamsData[0]?.revenue ?? 1;
                    const barPct     = maxRev > 0 ? (team.revenue / maxRev) * 100 : 0;
                    const isExpanded = expandedTeam === String(team.teamId);
                    return (
                      <motion.div
                        key={String(team.teamId)}
                        initial={{ opacity:0, x:-10 }}
                        animate={{ opacity:1, x:0 }}
                        transition={{ delay:0.04 * i }}
                      >
                        <button
                          onClick={() => setExpandedTeam(isExpanded ? null : String(team.teamId))}
                          className="w-full text-left rounded-xl border border-border/50 p-3 hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <RankBadge rank={team.rank} />
                            <div
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white text-xs font-bold"
                              style={{ background: color }}
                            >
                              {team.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="text-xs font-semibold text-foreground truncate">{team.name}</span>
                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                  <span className="text-xs font-bold text-emerald-500 tabular-nums">{fullUSD(team.revenue)}</span>
                                  {(team.pendingAmount ?? 0) > 0 && (
                                    <span className="text-[10px] font-medium text-amber-500 tabular-nums">
                                      {fullUSD(team.pendingAmount ?? 0)} pending
                                    </span>
                                  )}
                                  {isExpanded
                                    ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                                    : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                  }
                                </div>
                              </div>
                              <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                                <motion.div
                                  className="h-full rounded-full"
                                  style={{ background: color }}
                                  initial={{ width: 0 }}
                                  animate={{ width: `${barPct}%` }}
                                  transition={{ delay: 0.1 + 0.04 * i, duration: 0.6, ease: "easeOut" }}
                                />
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-1">
                                {team.paymentCount} payments · {team.leadCount} leads
                              </p>
                            </div>
                          </div>
                        </button>

                        {/* Member breakdown accordion */}
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-1 ml-4 pl-3 border-l-2 border-border/40 space-y-2 pb-2 pt-1">
                                {team.members.length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground">No member data</p>
                                ) : team.members.map((m: RevenueMemberItem) => (
                                  <div key={String(m.userId)} className="flex items-center gap-2 text-xs">
                                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-[10px] uppercase">
                                      {m.name.charAt(0)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between">
                                        <span className="font-medium text-foreground truncate max-w-[100px]">{m.name}</span>
                                        <div className="flex items-center gap-2 shrink-0 ml-2">
                                          <span className="font-semibold text-emerald-500 tabular-nums">{fullUSD(m.revenue)}</span>
                                          {(m.pendingAmount ?? 0) > 0 && (
                                            <span className="text-[10px] text-amber-500 tabular-nums">{fullUSD(m.pendingAmount ?? 0)} due</span>
                                          )}
                                        </div>
                                      </div>
                                      {m.designation && (
                                        <p className="text-[10px] text-muted-foreground">{m.designation}</p>
                                      )}
                                      <div className="h-1 rounded-full bg-muted/40 overflow-hidden mt-1">
                                        <motion.div
                                          className="h-full rounded-full bg-emerald-500/60"
                                          initial={{ width: 0 }}
                                          animate={{ width: `${m.pct}%` }}
                                          transition={{ duration: 0.4, ease: "easeOut" }}
                                        />
                                      </div>
                                    </div>
                                    <span className="text-[10px] text-muted-foreground shrink-0 w-9 text-right tabular-nums">{m.pct}%</span>
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Agent Revenue Leaderboard */}
        <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.36 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Award className="h-4 w-4 text-primary" /> Agent Revenue Leaderboard
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {overview.isLoading ? (
                <div className="space-y-2">
                  {[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
                </div>
              ) : !(ovData?.agentBreakdown?.length) ? (
                <Empty text="No agent revenue data" />
              ) : (
                <div className="space-y-2">
                  {ovData!.agentBreakdown.map((a, i) => {
                    const maxRev = ovData!.agentBreakdown[0]?.revenue ?? 1;
                    const barPct = maxRev > 0 ? (a.revenue / maxRev) * 100 : 0;
                    const podiumGrads = [
                      "bg-gradient-to-r from-yellow-500/10 to-transparent border-yellow-500/20",
                      "bg-gradient-to-r from-neutral-400/10 to-transparent border-neutral-400/20",
                      "bg-gradient-to-r from-orange-700/10 to-transparent border-orange-700/20",
                    ];
                    return (
                      <motion.div
                        key={String(a.userId)}
                        initial={{ opacity:0, x:10 }}
                        animate={{ opacity:1, x:0 }}
                        transition={{ delay:0.04 * i }}
                        className={cn(
                          "flex items-center gap-3 p-2.5 rounded-xl border",
                          i < 3
                            ? podiumGrads[i]
                            : "border-transparent bg-muted/20 hover:bg-muted/40 transition-colors",
                        )}
                      >
                        <RankBadge rank={a.rank} />
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs uppercase">
                          {a.name.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-foreground truncate max-w-[140px]">{a.name}</p>
                              {a.designation && (
                                <p className="text-[10px] text-muted-foreground truncate">{a.designation}</p>
                              )}
                            </div>
                            <span className="text-xs font-bold text-emerald-500 tabular-nums shrink-0 ml-2">
                              {fullUSD(a.revenue)}
                            </span>
                          </div>
                          <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
                            <motion.div
                              className="h-full rounded-full bg-emerald-500"
                              initial={{ width: 0 }}
                              animate={{ width: `${barPct}%` }}
                              transition={{ delay: 0.1 + 0.04 * i, duration: 0.5, ease: "easeOut" }}
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                            {a.paymentCount} payment{a.paymentCount !== 1 ? "s" : ""}
                          </p>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ── Top 3 Revenue Earners podium ──────────────────────────────────── */}
      {!overview.isLoading && (ovData?.agentBreakdown?.length ?? 0) >= 1 && (
        <motion.div initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.42 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Trophy className="h-4 w-4 text-yellow-500" /> Top Revenue Earners
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {ovData!.agentBreakdown.slice(0, 3).map((a, i) => {
                  const grads = [
                    "from-yellow-500/10 to-yellow-500/5 border-yellow-500/20",
                    "from-neutral-400/10 to-neutral-400/5 border-neutral-400/20",
                    "from-orange-700/10 to-orange-700/5 border-orange-700/20",
                  ];
                  return (
                    <motion.div
                      key={String(a.userId)}
                      initial={{ opacity:0, scale:0.95 }}
                      animate={{ opacity:1, scale:1 }}
                      transition={{ delay:0.1 * i }}
                      className={cn("rounded-xl border bg-gradient-to-br p-4 text-center", grads[i])}
                    >
                      <div className="text-3xl mb-2">{["🥇","🥈","🥉"][i]}</div>
                      <div className="flex h-12 w-12 mx-auto items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-lg uppercase mb-2">
                        {a.name.charAt(0)}
                      </div>
                      <p className="font-bold text-foreground text-sm truncate">{a.name}</p>
                      {a.designation && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{a.designation}</p>
                      )}
                      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                        <div>
                          <p className="text-sm font-bold text-emerald-500 tabular-nums">{fmtUSD(a.revenue)}</p>
                          <p className="text-[10px] text-muted-foreground">Revenue</p>
                        </div>
                        <div>
                          <p className="text-sm font-bold text-foreground tabular-nums">{a.paymentCount}</p>
                          <p className="text-[10px] text-muted-foreground">Payments</p>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 4: Source Analytics
// ─────────────────────────────────────────────────────────────────────────────

function CampaignPanel({
  source, dateFrom, dateTo, onClose,
}: {
  source: string; dateFrom: string; dateTo: string; onClose: () => void;
}) {
  const { data = [], isLoading } = useCampaignBreakdown(source, dateFrom, dateTo);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.18 }}
    >
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 text-primary" />
            <CardTitle className="text-xs font-semibold capitalize">
              Campaigns — {source}
            </CardTitle>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : data.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No campaigns found for this source.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left">Campaign</th>
                    <th className="px-4 py-2 text-right">Total</th>
                    <th className="px-4 py-2 text-right">Closed</th>
                    <th className="px-4 py-2 text-right">Booking</th>
                    <th className="px-4 py-2 text-right">Conversion</th>
                    <th className="px-4 py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {(data as CampaignBreakdownItem[]).map((c, i) => (
                    <motion.tr
                      key={c.campaignId}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className="hover:bg-muted/20"
                    >
                      <td className="px-4 py-2 font-mono text-[11px] font-medium max-w-[200px] truncate">{c.campaignId}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{fmt(c.total)}</td>
                      <td className="px-4 py-2 text-right text-green-500 tabular-nums">{fmt(c.closed)}</td>
                      <td className="px-4 py-2 text-right text-red-500 tabular-nums">{fmt(c.lost ?? 0)}</td>
                      <td className="px-4 py-2 text-right">
                        <span className={cn("font-semibold tabular-nums",
                          c.conversionRate >= 10 ? "text-green-500" : c.conversionRate >= 5 ? "text-yellow-500" : "text-red-500")}>
                          {c.conversionRate}%
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-primary font-semibold tabular-nums">{fmtUSD(c.revenue)}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

function SourceAnalyticsTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role?.isSystemRole === true && user?.role?.roleName === "Super Admin";

  const [teamId,        setTeamId]        = useState("all");
  const [sortKey,       setSortKey]       = useState<keyof SourceAnalyticsItem>("total");
  const [sortAsc,       setSortAsc]       = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const { data = [], isLoading } = useSourceAnalytics(
    dateFrom, dateTo,
    teamId !== "all" ? teamId : undefined,
  );

  const summary = useMemo(() => {
    if (!data.length) return { totalLeads: 0, bestSource: "—", topConversion: 0, totalRevenue: 0 };
    const totalLeads   = data.reduce((s, r) => s + r.total, 0);
    const totalRevenue = data.reduce((s, r) => s + r.revenue, 0);
    const best         = [...data].sort((a, b) => b.conversionRate - a.conversionRate)[0];
    return { totalLeads, totalRevenue, bestSource: best?.source ?? "—", topConversion: best?.conversionRate ?? 0 };
  }, [data]);

  const sorted = useMemo(
    () => [...data].sort((a, b) => {
      const av = a[sortKey] as number, bv = b[sortKey] as number;
      return sortAsc ? av - bv : bv - av;
    }),
    [data, sortKey, sortAsc],
  );

  function toggleSort(key: keyof SourceAnalyticsItem) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  function SortIcon({ k }: { k: keyof SourceAnalyticsItem }) {
    if (sortKey !== k) return null;
    return sortAsc ? <ChevronUp className="h-3 w-3 inline ml-0.5" /> : <ChevronDown className="h-3 w-3 inline ml-0.5" />;
  }

  return (
    <div className="space-y-6">
      {/* Team filter — Super Admin only */}
      {isSuperAdmin && (teamsData?.data?.length ?? 0) > 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Filter by team:</span>
            <Select value={teamId} onValueChange={(v) => { setTeamId(v); setSelectedSource(null); }}>
              <SelectTrigger className="h-8 w-44 text-xs border-border/50">
                <SelectValue placeholder="All Teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Teams</SelectItem>
                {(teamsData?.data ?? []).map((t) => (
                  <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </motion.div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <KpiCard title="Total Leads"    value={fmt(summary.totalLeads)}   icon={Layers}    gradient="bg-gradient-to-br from-blue-500 to-blue-600"    delay={0}    />
            <KpiCard title="Best Source"    value={summary.bestSource}        sub={`${summary.topConversion}% conversion`} icon={Target} gradient="bg-gradient-to-br from-green-500 to-green-600" delay={0.06} />
            <KpiCard title="Total Revenue"  value={fmtUSD(summary.totalRevenue)} icon={DollarSign} gradient="bg-gradient-to-br from-teal-500 to-teal-600"  delay={0.12} />
            <KpiCard title="Active Sources" value={String(data.length)}       icon={TrendingUp} gradient="bg-gradient-to-br from-violet-500 to-violet-600" delay={0.18} className="col-span-2 lg:col-span-1" />
          </div>

          {/* Bar chart */}
          {data.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }}>
              <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <BarChart2 className="h-4 w-4 text-primary" /> Leads by Source
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                      <XAxis dataKey="source" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false}
                        tickFormatter={(v: string) => v.charAt(0).toUpperCase() + v.slice(1)} />
                      <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <RechartsTooltip
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                        formatter={((v: unknown) => [fmt(Number(v ?? 0)), "Leads"]) as never}
                      />
                      <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={48}>
                        {data.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} fillOpacity={0.85} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Sortable table with campaign drill-down */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" /> Source Breakdown
                  <span className="text-xs font-normal text-muted-foreground ml-1">— click a row to view campaigns</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {sorted.length === 0 ? (
                  <Empty text="No leads found for this date range" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/50 bg-muted/30 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-3 text-left">Source</th>
                          {(
                            [
                              ["total",          "Total"],
                              ["closed",         "Closed"],
                              ["lost",           "Lost"],
                              ["conversionRate", "Conversion"],
                              ["lostRate",       "Lost Rate"],
                              ["revenue",        "Revenue"],
                            ] as [keyof SourceAnalyticsItem, string][]
                          ).map(([k, label]) => (
                            <th key={k}
                              className="px-4 py-3 text-right cursor-pointer hover:text-foreground transition-colors select-none"
                              onClick={() => toggleSort(k)}
                            >
                              {label}<SortIcon k={k} />
                            </th>
                          ))}
                          <th className="px-4 py-3 text-right">Campaigns</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        <AnimatePresence>
                          {sorted.map((row, i) => {
                            const isSelected = selectedSource === row.source;
                            return (
                              <>
                                <motion.tr
                                  key={row.source}
                                  initial={{ opacity: 0, x: -8 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: i * 0.03 }}
                                  onClick={() => setSelectedSource(isSelected ? null : row.source)}
                                  className={cn("cursor-pointer transition-colors",
                                    isSelected ? "bg-primary/10" : "hover:bg-muted/30")}
                                >
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <span className="h-2.5 w-2.5 rounded-full shrink-0"
                                        style={{ background: BAR_COLORS[i % BAR_COLORS.length] }} />
                                      <span className="font-semibold capitalize">{row.source}</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-right font-bold tabular-nums">{fmt(row.total)}</td>
                                  <td className="px-4 py-3 text-right text-green-500 tabular-nums">{fmt(row.closed)}</td>
                                  <td className="px-4 py-3 text-right text-red-500 tabular-nums">{fmt(row.lost ?? 0)}</td>
                                  <td className="px-4 py-3 text-right">
                                    <span className={cn("font-semibold tabular-nums",
                                      row.conversionRate >= 15 ? "text-green-500" : row.conversionRate >= 5 ? "text-yellow-500" : "text-red-500")}>
                                      {row.conversionRate}%
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{(row.lostRate ?? 0)}%</td>
                                  <td className="px-4 py-3 text-right text-primary font-semibold tabular-nums">{fmtUSD(row.revenue)}</td>
                                  <td className="px-4 py-3 text-right">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setSelectedSource(isSelected ? null : row.source); }}
                                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
                                    >
                                      <ArrowUpRight className="h-3 w-3" /> View
                                    </button>
                                  </td>
                                </motion.tr>
                                {isSelected && (
                                  <tr key={`${row.source}-campaigns`}>
                                    <td colSpan={8} className="px-4 py-3 bg-muted/10">
                                      <AnimatePresence>
                                        <CampaignPanel source={row.source} dateFrom={dateFrom} dateTo={dateTo} onClose={() => setSelectedSource(null)} />
                                      </AnimatePresence>
                                    </td>
                                  </tr>
                                )}
                              </>
                            );
                          })}
                        </AnimatePresence>
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT PAGE
// ─────────────────────────────────────────────────────────────────────────────

// ── Pipeline Tab ──────────────────────────────────────────────────────────────

const PIPELINE_COLORS: Record<string, { bg: string; text: string; border: string; bar: string }> = {
  contacted:    { bg: "bg-blue-500/10",    text: "text-blue-400",    border: "border-blue-500/20",    bar: "#3b82f6" },
  followUp:     { bg: "bg-amber-500/10",   text: "text-amber-400",   border: "border-amber-500/20",   bar: "#f59e0b" },
  interested:   { bg: "bg-violet-500/10",  text: "text-violet-400",  border: "border-violet-500/20",  bar: "#8b5cf6" },
  notInterested:{ bg: "bg-red-500/10",     text: "text-red-400",     border: "border-red-500/20",     bar: "#ef4444" },
  lost:         { bg: "bg-gray-500/10",    text: "text-gray-400",    border: "border-gray-500/20",    bar: "#6b7280" },
  converted:    { bg: "bg-green-500/10",   text: "text-green-400",   border: "border-green-500/20",   bar: "#10b981" },
};

const STAGE_ICONS: Record<string, React.ElementType> = {
  contacted:    Users,
  followUp:     CalendarCheck,
  interested:   Award,
  notInterested:X,
  lost:         AlertTriangle,
  converted:    Trophy,
};

function PipelineTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId, setTeamId] = useState("");
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];
  const { data, isLoading } = usePipelineBreakdown({ teamId: teamId || undefined, dateFrom, dateTo });

  return (
    <div className="space-y-6">
      {/* Team filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium">Filter by team:</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTeamId("")}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-all",
              !teamId
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground hover:border-primary/30",
            )}
          >
            All teams
          </button>
          {teams.map((t) => (
            <button
              key={t._id}
              onClick={() => setTeamId(t._id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-all",
                teamId === t._id
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground hover:border-primary/30",
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* Stage cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted/40 border border-border/50" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {data.stages.map((stage: PipelineStage) => {
              const c = PIPELINE_COLORS[stage.key] ?? PIPELINE_COLORS.converted;
              const Icon = STAGE_ICONS[stage.key] ?? Users;
              return (
                <motion.div
                  key={stage.key}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  whileHover={{ y: -2 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card className={cn("border", c.border, "overflow-hidden")}>
                    <CardContent className="pt-4 pb-3 px-4">
                      <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg mb-3", c.bg)}>
                        <Icon className={cn("h-4 w-4", c.text)} />
                      </div>
                      <p className="text-xs text-muted-foreground leading-tight">{stage.label}</p>
                      <p className={cn("text-2xl font-bold tabular-nums mt-0.5", c.text)}>{stage.count.toLocaleString()}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted/60 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${Math.min(stage.pct, 100)}%`, backgroundColor: c.bar }}
                          />
                        </div>
                        <span className={cn("text-[11px] font-semibold tabular-nums shrink-0", c.text)}>
                          {stage.pct}%
                        </span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">of {data.total.toLocaleString()} total</p>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>

          {/* Trend chart */}
          {data.trend.length > 1 && (
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  Pipeline Trend — Last 6 Months
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.trend} barSize={10} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={32} />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }}
                      labelStyle={{ fontWeight: 600 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                    {(Object.entries(PIPELINE_COLORS) as [string, { bar: string }][]).map(([key, c]) => (
                      <Bar key={key} dataKey={key} name={data.stages.find((s: PipelineStage) => s.key === key)?.label ?? key} fill={c.bar} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Funnel visual */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Filter className="h-4 w-4 text-primary" />
                Conversion Funnel
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.stages.map((stage: PipelineStage, idx: number) => {
                const c = PIPELINE_COLORS[stage.key] ?? PIPELINE_COLORS.converted;
                const barW = data.total > 0 ? Math.max((stage.count / data.total) * 100, stage.count > 0 ? 4 : 0) : 0;
                return (
                  <div key={stage.key} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-28 shrink-0">{stage.label}</span>
                    <div className="flex-1 h-7 rounded-lg bg-muted/40 overflow-hidden relative">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${barW}%` }}
                        transition={{ duration: 0.6, delay: idx * 0.07 }}
                        className="absolute left-0 top-0 h-full rounded-lg flex items-center px-2"
                        style={{ backgroundColor: c.bar + "33", borderLeft: `3px solid ${c.bar}` }}
                      >
                        <span className={cn("text-xs font-semibold tabular-nums", c.text)}>
                          {stage.count.toLocaleString()}
                        </span>
                      </motion.div>
                    </div>
                    <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">{stage.pct}%</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 6: Response Time SLA
// ─────────────────────────────────────────────────────────────────────────────

function ResponseTimeTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId,     setTeamId]     = useState("");
  const [slaMinutes, setSlaMinutes] = useState(30);
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];

  const { data, isLoading } = useResponseTimeReport({
    teamId: teamId || undefined,
    dateFrom,
    dateTo,
    slaMinutes,
  });

  const summary = data?.summary;

  function fmtMins(m: number | null) {
    if (m === null || m === undefined) return "—";
    if (m < 60) return `${Math.round(m)}m`;
    return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Team:</span>
          <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-40 text-xs border-border/50"><SelectValue placeholder="All Teams" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teams.map((t) => <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">SLA:</span>
          <div className="flex rounded-lg border border-border/50 overflow-hidden">
            {[15, 30, 60, 120].map((m) => (
              <button key={m} onClick={() => setSlaMinutes(m)}
                className={cn("px-3 py-1.5 text-xs font-medium transition-colors",
                  slaMinutes === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="Total Assigned"   value={summary?.totalAssigned ?? 0}       icon={Users}       gradient="bg-gradient-to-br from-blue-500 to-blue-600"    delay={0}    loading={isLoading} />
        <KpiCard title="Contacted"        value={summary?.totalContacted ?? 0}       icon={Activity}    gradient="bg-gradient-to-br from-green-500 to-green-600"   delay={0.05} loading={isLoading} />
        <KpiCard title="SLA Compliance"   value={`${summary?.overallSlaRate ?? 0}%`} icon={Target}      gradient="bg-gradient-to-br from-violet-500 to-violet-600" delay={0.1}  loading={isLoading} />
        <KpiCard title="Avg Response"     value={fmtMins(summary?.overallAvgResponseMinutes ?? null)} icon={Timer} gradient="bg-gradient-to-br from-orange-500 to-orange-600" delay={0.15} loading={isLoading} />
        <KpiCard title="Not Contacted"    value={summary?.notContacted ?? 0}         icon={AlertTriangle} gradient={(summary?.notContacted ?? 0) > 0 ? "bg-gradient-to-br from-red-500 to-red-600" : "bg-gradient-to-br from-neutral-500 to-neutral-600"} delay={0.2} loading={isLoading} className="col-span-2 sm:col-span-1" />
      </div>

      {/* Agent ranking */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Award className="h-4 w-4 text-primary" /> Agent Response Time Ranking
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : !data?.agentRanking?.length ? <Empty text="No agent data for this period" /> : (
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[560px]">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground w-8">#</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Assigned</th>
                      <th className="pb-2 text-right font-medium text-green-500">Contacted</th>
                      <th className="pb-2 text-right font-medium text-violet-400">SLA %</th>
                      <th className="pb-2 text-right font-medium text-orange-400">Avg Resp</th>
                      <th className="pb-2 text-right font-medium text-red-400">Not Contacted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data.agentRanking.map((a, i) => (
                      <motion.tr key={a.agentId} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.04 * i }}
                        className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 pr-2"><RankBadge rank={i + 1} /></td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs uppercase">
                              {a.agentName.charAt(0)}
                            </div>
                            <div>
                              <p className="font-semibold text-foreground truncate max-w-[130px]">{a.agentName}</p>
                              {a.agentEmail && <p className="text-[10px] text-muted-foreground truncate max-w-[130px]">{a.agentEmail}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 text-right tabular-nums">{a.totalAssigned}</td>
                        <td className="py-2.5 text-right text-green-500 font-semibold tabular-nums">{a.totalContacted}</td>
                        <td className="py-2.5 text-right">
                          <span className={cn("font-semibold tabular-nums",
                            a.slaComplianceRate >= 80 ? "text-green-500" : a.slaComplianceRate >= 50 ? "text-yellow-500" : "text-red-500")}>
                            {a.slaComplianceRate}%
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-orange-400 tabular-nums">{fmtMins(a.avgResponseMinutes)}</td>
                        <td className="py-2.5 text-right">
                          <span className={cn("tabular-nums", a.notContactedCount > 0 ? "text-red-400 font-semibold" : "text-muted-foreground")}>
                            {a.notContactedCount}
                          </span>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Breached leads */}
      {(data?.breachedLeads?.length ?? 0) > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
          <Card className="border-red-500/20 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-400">
                <AlertTriangle className="h-4 w-4" /> SLA Breached Leads ({data!.breachedLeads.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[480px]">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground">Lead</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Status</th>
                      <th className="pb-2 text-right font-medium text-red-400">Overdue by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data!.breachedLeads.map((lead, i) => (
                      <motion.tr key={lead._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.03 * i }}
                        className="hover:bg-muted/30">
                        <td className="py-2.5 pr-3">
                          <p className="font-semibold text-foreground">{lead.name}</p>
                          <p className="text-[10px] text-muted-foreground">{lead.phone}</p>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">{lead.assignedTo?.name ?? "—"}</td>
                        <td className="py-2.5 text-right">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize">{lead.status}</span>
                        </td>
                        <td className="py-2.5 text-right text-red-400 font-semibold tabular-nums">
                          {fmtMins(lead.minutesSinceAssign)}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB: Lead Timing — per-lead assigned / responded / follow-up times
// ─────────────────────────────────────────────────────────────────────────────

function LeadTimingTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId,     setTeamId]     = useState("");
  const [timingPage, setTimingPage] = useState(1);
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];

  const { data: timing, isLoading: timingLoading } = useLeadTimingReport({
    teamId: teamId || undefined,
    dateFrom,
    dateTo,
    page: timingPage,
    limit: 25,
  });
  useEffect(() => { setTimingPage(1); }, [teamId, dateFrom, dateTo]);

  const slaMinutes = 60; // response delay shown green when within 1 hour

  function fmtMins(m: number | null) {
    if (m === null || m === undefined) return "—";
    if (m < 60) return `${Math.round(m)}m`;
    return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  }

  function fmtDT(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-AE", {
      timeZone: "Asia/Dubai", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Team:</span>
          <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-40 text-xs border-border/50"><SelectValue placeholder="All Teams" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teams.map((t) => <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Per-lead timing table — assigned / responded / follow-up times */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> Lead Timing — Assigned / Responded / Follow-up
              {timing && <span className="ml-auto text-[11px] font-normal text-muted-foreground">{timing.total} leads</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {timingLoading ? (
              <div className="space-y-2">{[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : !timing?.leads?.length ? <Empty text="No assigned leads for this period" /> : (
              <>
                <div className="overflow-x-auto -mx-2 px-2">
                  <table className="w-full text-xs min-w-[760px]">
                    <thead>
                      <tr className="border-b border-border/50">
                        <th className="pb-2 text-left font-medium text-muted-foreground">Lead</th>
                        <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                        <th className="pb-2 text-left font-medium text-blue-400">Assigned Time</th>
                        <th className="pb-2 text-left font-medium text-green-500">Responded Time</th>
                        <th className="pb-2 text-left font-medium text-violet-400">Follow-up Time</th>
                        <th className="pb-2 text-right font-medium text-orange-400">Resp. Delay</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {timing.leads.map((l, i) => (
                        <motion.tr key={l._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.02 * i }}
                          className="hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 pr-3">
                            <p className="font-semibold text-foreground truncate max-w-[150px]">{l.name}</p>
                            <p className="text-[10px] text-muted-foreground">{l.source ?? ""}</p>
                          </td>
                          <td className="py-2.5 pr-3 text-muted-foreground truncate max-w-[110px]">{l.agent ?? "—"}</td>
                          <td className="py-2.5 pr-3 tabular-nums text-blue-400">{fmtDT(l.assignedAt)}</td>
                          <td className="py-2.5 pr-3 tabular-nums">
                            {l.respondedAt
                              ? <span className="text-green-500">{fmtDT(l.respondedAt)}</span>
                              : <span className="text-red-400">Not responded</span>}
                          </td>
                          <td className="py-2.5 pr-3 tabular-nums">
                            {l.followUpAt
                              ? <span className="text-violet-400">{fmtDT(l.followUpAt)}</span>
                              : <span className="text-muted-foreground/50">—</span>}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {l.responseMinutes !== null
                              ? <span className={cn("font-semibold", l.responseMinutes <= slaMinutes ? "text-green-500" : "text-orange-400")}>{fmtMins(l.responseMinutes)}</span>
                              : <span className="text-muted-foreground/50">—</span>}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {timing.totalPages > 1 && (
                  <div className="flex items-center justify-between pt-3">
                    <p className="text-[11px] text-muted-foreground">Page {timing.page} of {timing.totalPages}</p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={timingPage <= 1} onClick={() => setTimingPage((p) => p - 1)}>Previous</Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={timingPage >= timing.totalPages} onClick={() => setTimingPage((p) => p + 1)}>Next</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 7: Follow-Up Tracking
// ─────────────────────────────────────────────────────────────────────────────

function FollowUpTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId, setTeamId] = useState("");
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];

  const { data, isLoading } = useFollowUpReport({
    teamId: teamId || undefined,
    dateFrom,
    dateTo,
  });

  const summary = data?.summary;

  function fmtOverdue(mins: number | null) {
    if (!mins) return "—";
    if (mins < 60) return `${Math.round(mins)}m overdue`;
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return m > 0 ? `${h}h ${m}m overdue` : `${h}h overdue`;
  }

  return (
    <div className="space-y-6">
      {/* Team filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Team:</span>
        <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs border-border/50"><SelectValue placeholder="All Teams" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Teams</SelectItem>
            {teams.map((t) => <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="Total Follow-Ups"    value={summary?.totalFollowUps ?? 0}       icon={CalendarCheck} gradient="bg-gradient-to-br from-blue-500 to-blue-600"    delay={0}    loading={isLoading} />
        <KpiCard title="Agents Tracked"      value={summary?.totalAgentsTracked ?? 0}   icon={Users}         gradient="bg-gradient-to-br from-violet-500 to-violet-600" delay={0.05} loading={isLoading} />
        <KpiCard title="Leads w/ Follow-Ups" value={summary?.leadsWithFollowUps ?? 0}   icon={Activity}      gradient="bg-gradient-to-br from-green-500 to-green-600"   delay={0.1}  loading={isLoading} />
        <KpiCard title="Overdue"             value={summary?.overdueCount ?? 0}         icon={AlertTriangle} gradient={(summary?.overdueCount ?? 0) > 0 ? "bg-gradient-to-br from-red-500 to-red-600" : "bg-gradient-to-br from-neutral-500 to-neutral-600"} delay={0.15} loading={isLoading} />
      </div>

      {/* Agent ranking */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Award className="h-4 w-4 text-primary" /> Agent Follow-Up Ranking
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : !data?.agentRanking?.length ? <Empty text="No follow-up data for this period" /> : (
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[440px]">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground w-8">#</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Total Follow-Ups</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Unique Leads</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground hidden sm:table-cell">Last Follow-Up</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data.agentRanking.map((a, i) => (
                      <motion.tr key={a.agentId} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.04 * i }}
                        className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 pr-2"><RankBadge rank={i + 1} /></td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs uppercase">
                              {a.agentName.charAt(0)}
                            </div>
                            <p className="font-semibold text-foreground truncate max-w-[140px]">{a.agentName}</p>
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-bold tabular-nums text-primary">{a.totalFollowUps}</td>
                        <td className="py-2.5 text-right tabular-nums text-muted-foreground">{a.uniqueLeads}</td>
                        <td className="py-2.5 text-right text-muted-foreground hidden sm:table-cell text-[10px]">
                          {a.lastFollowUp ? new Date(a.lastFollowUp).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }) : "—"}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Overdue leads */}
      {(data?.overdueLeads?.length ?? 0) > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <Card className="border-red-500/20 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-400">
                <AlertTriangle className="h-4 w-4" /> Overdue Follow-Ups ({data!.overdueLeads.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[460px]">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground">Lead</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground">Agent</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground hidden sm:table-cell">Status</th>
                      <th className="pb-2 text-right font-medium text-red-400">Overdue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data!.overdueLeads.map((lead, i) => (
                      <motion.tr key={lead._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.03 * i }}
                        className="hover:bg-muted/30">
                        <td className="py-2.5 pr-3">
                          <p className="font-semibold text-foreground">{lead.name}</p>
                          <p className="text-[10px] text-muted-foreground">{lead.phone}</p>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">{lead.assignedTo?.name ?? "—"}</td>
                        <td className="py-2.5 text-right hidden sm:table-cell">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize">{lead.status}</span>
                        </td>
                        <td className="py-2.5 text-right text-red-400 font-semibold tabular-nums">
                          {fmtOverdue(lead.overdueByMinutes)}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Lead breakdown */}
      {(data?.leadBreakdown?.length ?? 0) > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" /> Lead Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[500px]">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="pb-2 text-left font-medium text-muted-foreground">Lead</th>
                      <th className="pb-2 text-left font-medium text-muted-foreground hidden sm:table-cell">Agent</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Follow-Ups</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground hidden sm:table-cell">Status</th>
                      <th className="pb-2 text-right font-medium text-muted-foreground">Next Due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {data!.leadBreakdown.map((lead, i) => {
                      const isOverdue = lead.nextFollowUpAt && new Date(lead.nextFollowUpAt) < new Date();
                      return (
                        <motion.tr key={lead._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.02 * i }}
                          className="hover:bg-muted/30">
                          <td className="py-2.5 pr-3">
                            <p className="font-semibold text-foreground truncate max-w-[130px]">{lead.name}</p>
                            <p className="text-[10px] text-muted-foreground">{lead.phone}</p>
                          </td>
                          <td className="py-2.5 pr-3 text-muted-foreground hidden sm:table-cell truncate max-w-[110px]">{lead.agentName}</td>
                          <td className="py-2.5 text-right font-bold tabular-nums text-primary">{lead.followUpCount}</td>
                          <td className="py-2.5 text-right hidden sm:table-cell">
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize">{lead.status}</span>
                          </td>
                          <td className="py-2.5 text-right">
                            {lead.nextFollowUpAt ? (
                              <span className={cn("text-[10px] font-medium tabular-nums", isOverdue ? "text-red-400" : "text-green-400")}>
                                {new Date(lead.nextFollowUpAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 8: Lead Quality Analysis
// ─────────────────────────────────────────────────────────────────────────────

const QUALITY_BAND = (score: number) =>
  score >= 70 ? { label: "High",   cls: "bg-green-500/15 text-green-400 border-green-500/30"  } :
  score >= 40 ? { label: "Medium", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30"  } :
               { label: "Low",    cls: "bg-red-500/15   text-red-400   border-red-500/30"    };

function QualityBadge({ score }: { score: number }) {
  const { label, cls } = QUALITY_BAND(score);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {label} · {score}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden min-w-[60px]">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(score, 100)}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      <span className="text-[11px] font-bold tabular-nums shrink-0" style={{ color }}>{score}</span>
    </div>
  );
}

type SortKey = "qualityScore" | "conversionRate" | "contactRate" | "followUpRate" | "lostRate" | "total";

function LeadQualityTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId,  setTeamId]  = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("qualityScore");
  const [sortAsc, setSortAsc] = useState(false);
  const [minLeads, setMinLeads] = useState(1);

  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const teams = teamsData?.data ?? [];

  const { data, isLoading } = useLeadQualityReport({
    teamId:   teamId || undefined,
    dateFrom,
    dateTo,
  });

  const summary = data?.summary;

  const sorted = useMemo(() => {
    const filtered = (data?.campaigns ?? []).filter((c) => c.total >= minLeads);
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] as number ?? 0;
      const bv = b[sortKey] as number ?? 0;
      return sortAsc ? av - bv : bv - av;
    });
  }, [data?.campaigns, sortKey, sortAsc, minLeads]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortAsc((v) => !v);
    else { setSortKey(k); setSortAsc(false); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="opacity-20 ml-0.5">↕</span>;
    return <span className="ml-0.5">{sortAsc ? "↑" : "↓"}</span>;
  }

  function fmtMins(m: number | null) {
    if (m === null || m === undefined) return "—";
    if (m < 60) return `${Math.round(m)}m`;
    return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Team:</span>
          <Select value={teamId || "all"} onValueChange={(v) => setTeamId(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-40 text-xs border-border/50"><SelectValue placeholder="All Teams" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Teams</SelectItem>
              {teams.map((t) => <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Min leads:</span>
          <div className="flex rounded-lg border border-border/50 overflow-hidden">
            {[1, 5, 10, 20].map((n) => (
              <button key={n} onClick={() => setMinLeads(n)}
                className={cn("px-3 py-1.5 text-xs font-medium transition-colors",
                  minLeads === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                {n}+
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Campaigns"       value={summary?.totalCampaigns ?? 0}           icon={Tag}         gradient="bg-gradient-to-br from-blue-500 to-blue-600"    delay={0}    loading={isLoading} />
        <KpiCard title="Total Leads"     value={summary?.totalLeads ?? 0}               icon={Users}       gradient="bg-gradient-to-br from-violet-500 to-violet-600" delay={0.04} loading={isLoading} />
        <KpiCard title="Converted"       value={summary?.totalConverted ?? 0}           icon={Trophy}      gradient="bg-gradient-to-br from-green-500 to-green-600"   delay={0.08} loading={isLoading} />
        <KpiCard title="Conversion Rate" value={`${summary?.overallConversionRate ?? 0}%`} icon={TrendingUp} gradient="bg-gradient-to-br from-teal-500 to-teal-600"  delay={0.12} loading={isLoading} />
        <KpiCard title="Avg Quality"     value={summary?.avgQualityScore ?? 0}          icon={Star}        gradient="bg-gradient-to-br from-amber-500 to-amber-600"   delay={0.16} loading={isLoading} />
        <KpiCard title="Low-Quality Src" value={summary?.lowQualityCount ?? 0}          icon={AlertTriangle} gradient={(summary?.lowQualityCount ?? 0) > 0 ? "bg-gradient-to-br from-red-500 to-red-600" : "bg-gradient-to-br from-neutral-500 to-neutral-600"} delay={0.2} loading={isLoading} className="col-span-2 sm:col-span-1" />
      </div>

      {/* Two side-by-side panels: top campaigns + low-quality sources */}
      {!isLoading && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* High-converting campaigns */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="border-green-500/20 bg-card/80 backdrop-blur-sm h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-green-400">
                  <Sparkles className="h-4 w-4" /> Top Converting Campaigns
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {data.topCampaigns.length === 0 ? (
                  <Empty text="No campaigns with 5+ leads yet" />
                ) : (
                  <div className="space-y-3">
                    {data.topCampaigns.map((c, i) => (
                      <motion.div key={`${c.source}-${c.campaign}-${i}`}
                        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * i }}
                        className="flex items-center gap-3 p-2.5 rounded-xl border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500/10 text-green-400 font-bold text-sm">
                          {i + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-foreground truncate">
                            {c.campaign || <span className="italic text-muted-foreground">No campaign tag</span>}
                          </p>
                          <p className="text-[10px] text-muted-foreground capitalize">{c.source} · {c.total} leads</p>
                          <ScoreBar score={c.qualityScore} />
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-green-400 tabular-nums">{c.conversionRate}%</p>
                          <p className="text-[10px] text-muted-foreground">conv rate</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Low-quality sources */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}>
            <Card className="border-red-500/20 bg-card/80 backdrop-blur-sm h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-400">
                  <TrendingDown className="h-4 w-4" /> Low-Quality Sources
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">(score &lt; 40, 5+ leads)</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {data.lowQualitySources.length === 0 ? (
                  <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-sm text-green-400">
                    <Sparkles className="h-8 w-8 opacity-40" />
                    All sources are healthy
                  </div>
                ) : (
                  <div className="space-y-3">
                    {data.lowQualitySources.map((s, i) => (
                      <motion.div key={s.source}
                        initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * i }}
                        className="flex items-center gap-3 p-2.5 rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-colors">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400 font-bold text-xs uppercase">
                          {s.source.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-foreground capitalize truncate">{s.source}</p>
                          <p className="text-[10px] text-muted-foreground">{s.total} leads · {s.conversionRate}% conv · {s.lostRate}% lost</p>
                          <ScoreBar score={s.avgQualityScore} />
                        </div>
                        <QualityBadge score={s.avgQualityScore} />
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}

      {/* Source summary bar chart */}
      {!isLoading && (data?.sourceSummary?.length ?? 0) > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-primary" /> Quality Score by Source
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {data!.sourceSummary.map((s, i) => {
                  const { cls } = QUALITY_BAND(s.avgQualityScore);
                  const color = s.avgQualityScore >= 70 ? "#22c55e" : s.avgQualityScore >= 40 ? "#f59e0b" : "#ef4444";
                  return (
                    <motion.div key={s.source} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * i }}
                      className="flex items-center gap-3">
                      <span className="w-20 shrink-0 text-xs font-medium text-foreground capitalize text-right">{s.source}</span>
                      <div className="flex-1 h-7 rounded-lg bg-muted/40 overflow-hidden relative">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min(s.avgQualityScore, 100)}%` }}
                          transition={{ duration: 0.6, delay: 0.08 * i }}
                          className="absolute left-0 top-0 h-full rounded-lg flex items-center px-2"
                          style={{ backgroundColor: color + "33", borderLeft: `3px solid ${color}` }}>
                          <span className="text-xs font-bold tabular-nums" style={{ color }}>{s.avgQualityScore}</span>
                        </motion.div>
                      </div>
                      <span className="w-16 shrink-0 text-[10px] text-muted-foreground text-right">{s.total} leads</span>
                      <QualityBadge score={s.avgQualityScore} />
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Full campaign table */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
        <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                Campaign Performance
                <span className="text-[10px] font-normal text-muted-foreground">— {sorted.length} campaigns</span>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : sorted.length === 0 ? (
              <Empty text="No campaign data for this period" />
            ) : (
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-xs min-w-[700px]">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/20 text-[10px] uppercase tracking-wide">
                      <th className="pb-2 pt-1 text-left font-medium text-muted-foreground px-2">Source</th>
                      <th className="pb-2 pt-1 text-left font-medium text-muted-foreground px-2">Campaign</th>
                      {([ ["total","Leads"],["conversionRate","Conv%"],["contactRate","Contact%"],["followUpRate","FollowUp%"],["lostRate","Lost%"],["qualityScore","Quality"] ] as [SortKey, string][]).map(([k, label]) => (
                        <th key={k} onClick={() => toggleSort(k)}
                          className="pb-2 pt-1 text-right font-medium text-muted-foreground px-2 cursor-pointer hover:text-foreground select-none transition-colors whitespace-nowrap">
                          {label}<SortIcon k={k} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {sorted.map((c, i) => (
                      <motion.tr key={`${c.source}-${c.campaign}-${i}`}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.02 * i }}
                        className="hover:bg-muted/30 transition-colors">
                        <td className="py-2.5 px-2">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary capitalize">{c.source}</span>
                        </td>
                        <td className="py-2.5 px-2 max-w-[180px]">
                          <p className="truncate text-foreground font-medium">{c.campaign || <span className="italic text-muted-foreground">—</span>}</p>
                        </td>
                        <td className="py-2.5 px-2 text-right font-semibold tabular-nums">{c.total}</td>
                        <td className="py-2.5 px-2 text-right">
                          <span className={cn("font-bold tabular-nums", c.conversionRate >= 15 ? "text-green-400" : c.conversionRate >= 5 ? "text-yellow-400" : "text-red-400")}>
                            {c.conversionRate}%
                          </span>
                        </td>
                        <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">{c.contactRate}%</td>
                        <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">{c.followUpRate}%</td>
                        <td className="py-2.5 px-2 text-right">
                          <span className={cn("tabular-nums", c.lostRate > 30 ? "text-red-400 font-semibold" : "text-muted-foreground")}>
                            {c.lostRate}%
                          </span>
                        </td>
                        <td className="py-2.5 px-2 text-right">
                          <QualityBadge score={c.qualityScore} />
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

// ── Sales Funnel Tab ──────────────────────────────────────────────────────────

const FUNNEL_COLORS = ["#6366f1","#8b5cf6","#3b82f6","#22c55e","#f59e0b","#ef4444"];

function SalesFunnelTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId, setTeamId] = useState<string>("");
  const teamsResult = useTeams();
  const teamsList = teamsResult.data?.data ?? [];
  const { data, isLoading } = useSalesFunnel({ teamId: teamId || undefined, dateFrom, dateTo });

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={teamId || "all"} onValueChange={v => setTeamId(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {teamsList.map((t: { _id: string; name: string }) => (
              <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : !data ? (
        <Empty text="No funnel data for this period" />
      ) : (
        <>
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {[
              { label: "Total Received",  value: data.summary.total,             color: FUNNEL_COLORS[0], icon: Users },
              { label: "Contact Rate",    value: `${data.summary.contactRate}%`,  color: FUNNEL_COLORS[1], icon: PhoneCall },
              { label: "Qualified",       value: `${data.summary.qualificationRate}%`, color: FUNNEL_COLORS[2], icon: UserCheck },
              { label: "Follow-Up",       value: `${data.summary.followUpRate}%`, color: FUNNEL_COLORS[3], icon: CalendarCheck },
              { label: "Converted",       value: `${data.summary.conversionRate}%`, color: FUNNEL_COLORS[4], icon: CheckCircle2 },
              { label: "Lost",            value: `${data.summary.lostRate}%`,     color: FUNNEL_COLORS[5], icon: XCircle },
            ].map(({ label, value, color, icon: Icon }, i) => (
              <motion.div key={label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
                <Card className="border-border/50">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
                        <Icon className="h-3.5 w-3.5" style={{ color }} />
                      </div>
                    </div>
                    <p className="text-xl font-bold text-foreground">{value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Visual Funnel */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Conversion Funnel</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.stages.map((stage: FunnelStage, i: number) => (
                <motion.div key={stage.key} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.07 }}>
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-xs text-muted-foreground w-28 shrink-0">{stage.label}</span>
                    <div className="flex-1 h-6 bg-muted/40 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full flex items-center px-2"
                        style={{ background: FUNNEL_COLORS[i % FUNNEL_COLORS.length], width: `${stage.pct}%` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${stage.pct}%` }}
                        transition={{ duration: 0.7, delay: i * 0.1, ease: "easeOut" }}
                      />
                    </div>
                    <span className="text-xs font-medium w-16 text-right shrink-0">{stage.count.toLocaleString()} ({stage.pct}%)</span>
                    {stage.dropPct !== null && (
                      <span className="text-xs text-red-500 w-16 shrink-0">↓ {stage.dropPct}%</span>
                    )}
                  </div>
                </motion.div>
              ))}
            </CardContent>
          </Card>

          {/* Team Breakdown + Top Agents */}
          <div className="grid lg:grid-cols-2 gap-6">
            {/* Team Breakdown */}
            {data.teamBreakdown.length > 0 && (
              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Team Breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/30">
                          <th className="text-left py-2 text-muted-foreground font-medium">Team</th>
                          <th className="text-right py-2 text-muted-foreground font-medium">Total</th>
                          <th className="text-right py-2 text-muted-foreground font-medium">Contacted</th>
                          <th className="text-right py-2 text-muted-foreground font-medium">Converted</th>
                          <th className="text-right py-2 text-muted-foreground font-medium">Conv %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.teamBreakdown.map((t: FunnelTeamRow) => (
                          <tr key={t.teamId} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                            <td className="py-2 font-medium text-foreground">{t.teamName}</td>
                            <td className="py-2 text-right">{t.total}</td>
                            <td className="py-2 text-right">{t.contacted}</td>
                            <td className="py-2 text-right text-green-600">{t.converted}</td>
                            <td className="py-2 text-right font-medium">{t.conversionRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Top Agents */}
            {data.topAgents.length > 0 && (
              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Top Agents by Conversions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.topAgents.slice(0, 8).map((agent: FunnelAgentRow, i: number) => (
                    <motion.div key={agent.agentId} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                      className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}.</span>
                      <span className="text-xs font-medium flex-1 truncate">{agent.agentName}</span>
                      <span className="text-xs text-green-600 font-semibold">{agent.converted} conv</span>
                      <span className="text-xs text-muted-foreground">{agent.conversionRate}%</span>
                    </motion.div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Management Alerts Tab ─────────────────────────────────────────────────────

function AlertsTab() {
  const [teamId, setTeamId] = useState<string>("");
  const [hours, setHours] = useState<number>(2);
  const alertsTeamsResult = useTeams();
  const alertsTeamsList = alertsTeamsResult.data?.data ?? [];
  const { data, isLoading, refetch } = useManagementAlerts({ teamId: teamId || undefined, uncontactedHours: hours });

  function formatIST(iso: string) {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }) + " IST";
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <Select value={teamId || "all"} onValueChange={v => setTeamId(v === "all" ? "" : v)}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {alertsTeamsList.map((t: { _id: string; name: string }) => (
                <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(hours)} onValueChange={v => setHours(Number(v))}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Uncontacted &gt; 1h</SelectItem>
              <SelectItem value="2">Uncontacted &gt; 2h</SelectItem>
              <SelectItem value="4">Uncontacted &gt; 4h</SelectItem>
              <SelectItem value="8">Uncontacted &gt; 8h</SelectItem>
              <SelectItem value="24">Uncontacted &gt; 24h</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="h-8 text-xs gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : !data ? null : (
        <>
          {/* Lost Spike Banner */}
          <AnimatePresence>
            {data.summary.hasSpikeAlert && (
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                <AlertOctagon className="h-5 w-5 text-red-500 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-red-600">Lost Lead Spike Detected</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {data.summary.lostRecent} lost in the last 7 days vs {data.summary.lostPrev} in the prior 7 days —{" "}
                    <span className="font-medium text-red-500">+{Math.round(data.summary.lostSpikePct)}% increase</span>
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: `Uncontacted > ${hours}h`, value: data.summary.uncontactedCount, color: "#f97316", icon: Clock, warn: data.summary.uncontactedCount > 0 },
              { label: "Overdue Follow-Ups",       value: data.summary.overdueFollowUps,  color: "#ef4444", icon: AlertTriangle, warn: data.summary.overdueFollowUps > 0 },
              { label: "Lost (last 7 days)",        value: data.summary.lostRecent,         color: data.summary.hasSpikeAlert ? "#ef4444" : "#64748b", icon: TrendingDown, warn: data.summary.hasSpikeAlert },
            ].map(({ label, value, color, icon: Icon, warn }, i) => (
              <motion.div key={label} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.08 }}>
                <Card className={cn("border-border/50", warn && "border-orange-500/30 bg-orange-500/5")}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
                        <Icon className="h-3.5 w-3.5" style={{ color }} />
                      </div>
                    </div>
                    <p className="text-2xl font-bold" style={{ color: warn ? color : undefined }}>{value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Uncontacted Leads list */}
          {data.uncontacted.length > 0 && (
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-orange-500" />
                  Uncontacted Leads ({data.uncontacted.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/20">
                  {data.uncontacted.map((lead: AlertLead) => (
                    <div key={lead._id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{lead.name}</p>
                        <p className="text-xs text-muted-foreground">{lead.phone}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-muted-foreground">{lead.assignedTo?.name ?? "Unassigned"}</p>
                        {lead.assignedAt && <p className="text-xs text-orange-500">Since {formatIST(lead.assignedAt)}</p>}
                      </div>
                      <div className="shrink-0">
                        <span className="text-xs bg-orange-500/10 text-orange-600 px-2 py-0.5 rounded-full font-medium">
                          {lead.hoursUncontacted != null ? `${Math.round(lead.hoursUncontacted)}h` : "—"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Overdue Follow-Ups list */}
          {data.overdueFollowUps.length > 0 && (
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                  Overdue Follow-Ups ({data.overdueFollowUps.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/20">
                  {data.overdueFollowUps.map((lead: AlertLead) => (
                    <div key={lead._id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{lead.name}</p>
                        <p className="text-xs text-muted-foreground">{lead.phone}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs text-muted-foreground">{lead.assignedTo?.name ?? "Unassigned"}</p>
                        {lead.nextFollowUpAt && <p className="text-xs text-red-500">Due {formatIST(lead.nextFollowUpAt)}</p>}
                      </div>
                      <div className="shrink-0">
                        <span className="text-xs bg-red-500/10 text-red-600 px-2 py-0.5 rounded-full font-medium">
                          {lead.overdueByMinutes != null ? `${Math.round(lead.overdueByMinutes)}m overdue` : "Overdue"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {data.uncontacted.length === 0 && data.overdueFollowUps.length === 0 && (
            <Empty text="No alerts — all leads are being handled on time 🎉" />
          )}
        </>
      )}
    </div>
  );
}

// ── Audit Trail Tab ────────────────────────────────────────────────────────────

const AUDIT_ACTIONS = [
  { value: "",                label: "All actions"           },
  { value: "status_changed",  label: "Status changes"        },
  { value: "lead_assigned",   label: "Lead assignments"      },
  { value: "note_added",      label: "Notes added"           },
  { value: "note_updated",    label: "Notes edited"          },
  { value: "note_deleted",    label: "Notes deleted"         },
];

const ACTION_META: Record<string, { label: string; color: string }> = {
  status_changed: { label: "Status Changed",  color: "#6366f1" },
  lead_assigned:  { label: "Assigned",         color: "#3b82f6" },
  note_added:     { label: "Note Added",       color: "#22c55e" },
  note_updated:   { label: "Note Edited",      color: "#f59e0b" },
  note_deleted:   { label: "Note Deleted",     color: "#ef4444" },
};

function AuditTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [teamId, setTeamId] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const auditTeamsResult = useTeams();
  const auditTeamsList = auditTeamsResult.data?.data ?? [];
  const { data, isLoading } = useAuditReport({ teamId: teamId || undefined, dateFrom, dateTo, action: action || undefined });

  function formatIST(iso: string) {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }) + " IST";
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={teamId || "all"} onValueChange={v => setTeamId(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            {auditTeamsList.map((t: { _id: string; name: string }) => (
              <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={action || "all-actions"} onValueChange={v => setAction(v === "all-actions" ? "" : v)}>
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUDIT_ACTIONS.map(a => (
              <SelectItem key={a.value || "all-actions"} value={a.value || "all-actions"}>{a.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Action summary pills */}
      {!isLoading && data && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.summary).map(([act, count]) => {
            const meta = ACTION_META[act];
            if (!meta || !count) return null;
            return (
              <motion.button key={act} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                onClick={() => setAction(act === action ? "" : act)}
                className={cn("flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                  action === act ? "border-primary/50 bg-primary/10 text-primary" : "border-border/50 hover:bg-muted/50"
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
                {meta.label}
                <span className="opacity-70">{count as number}</span>
              </motion.button>
            );
          })}
          {data.total > 0 && (
            <span className="text-xs text-muted-foreground self-center ml-1">{data.total} events total</span>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : !data?.events.length ? (
        <Empty text="No audit events for this period" />
      ) : (
        <Card className="border-border/50">
          <CardContent className="p-0">
            <div className="divide-y divide-border/20">
              {data.events.map((event: AuditEvent, i: number) => {
                const meta = ACTION_META[event.action] ?? { label: event.action, color: "#64748b" };
                return (
                  <motion.div key={event._id} initial={{ opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                    {/* Dot */}
                    <div className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ background: meta.color }} />
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground truncate max-w-[180px]">{event.leadName}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: `${meta.color}18`, color: meta.color }}>{meta.label}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{event.description}</p>
                      {event.changes && Object.keys(event.changes).length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {Object.entries(event.changes).map(([field, change]) => {
                            const c = change as { from: unknown; to: unknown };
                            if (c.from === null && c.to === null) return null;
                            return (
                              <span key={field} className="text-xs bg-muted/50 px-1.5 py-0.5 rounded text-muted-foreground">
                                {c.from != null ? <span className="line-through opacity-60">{String(c.from).slice(0, 40)}</span> : null}
                                {c.from != null && c.to != null ? " → " : null}
                                {c.to != null ? <span>{String(c.to).slice(0, 40)}</span> : null}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {/* Right meta */}
                    <div className="text-right shrink-0">
                      <p className="text-xs font-medium text-foreground">{event.performedBy?.name ?? "System"}</p>
                      <p className="text-xs text-muted-foreground">{formatIST(event.createdAt)}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Tab routing ───────────────────────────────────────────────────────────────

type Tab = "overview" | "split" | "revenue" | "sources" | "pipeline" | "response-time" | "followup" | "lead-timing" | "lead-quality" | "funnel" | "alerts" | "audit";

const TABS: { id: Tab; label: string; shortLabel: string; icon: React.ElementType }[] = [
  { id: "overview",       label: "Overview",           shortLabel: "Overview",  icon: BarChart2    },
  { id: "split",          label: "Lead Splitting",      shortLabel: "Leads",     icon: GitFork      },
  { id: "revenue",        label: "Revenue",             shortLabel: "Revenue",   icon: DollarSign   },
  { id: "sources",        label: "Sources",             shortLabel: "Sources",   icon: TrendingUp   },
  { id: "pipeline",       label: "Pipeline",            shortLabel: "Pipeline",  icon: Filter       },
  { id: "response-time",  label: "Response Time SLA",   shortLabel: "SLA",       icon: Timer        },
  { id: "followup",       label: "Follow-Up Tracking",  shortLabel: "Follow-Up", icon: CalendarCheck },
  { id: "lead-timing",    label: "Lead Timing",         shortLabel: "Timing",    icon: Clock        },
  { id: "lead-quality",   label: "Lead Quality",        shortLabel: "Quality",   icon: Sparkles     },
  { id: "funnel",         label: "Sales Funnel",        shortLabel: "Funnel",    icon: GitMerge     },
  { id: "alerts",         label: "Mgmt Alerts",         shortLabel: "Alerts",    icon: Bell         },
  { id: "audit",          label: "Audit Trail",         shortLabel: "Audit",     icon: Shield       },
];

function ReportsPageContent() {
  const sp     = useSearchParams();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>(() => (sp.get("tab") as Tab) ?? "overview");

  // Shared period state — each tab inherits the same date range
  const [quickPeriod, setQuickPeriod] = useState<QuickPeriod>(() => (sp.get("period") as QuickPeriod) ?? "month");
  const [customFrom,  setCustomFrom]  = useState(() => sp.get("from") ?? "");
  const [customTo,    setCustomTo]    = useState(() => sp.get("to") ?? "");

  const { from: dateFrom, to: dateTo } = useMemo(() => {
    if (quickPeriod === "custom") return { from: customFrom, to: customTo };
    return getQuickRange(quickPeriod) as { from: string; to: string };
  }, [quickPeriod, customFrom, customTo]);

  // ── Sync state → URL ───────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeTab !== "overview") params.set("tab", activeTab);
    if (quickPeriod !== "month") params.set("period", quickPeriod);
    if (customFrom) params.set("from", customFrom);
    if (customTo) params.set("to", customTo);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [activeTab, quickPeriod, customFrom, customTo]);

  // ── Smart-hide header on mobile scroll ─────────────────────────────────────
  const [headerVisible, setHeaderVisible] = useState(true);
  const lastScrollY  = useRef(0);
  const SCROLL_THRESHOLD = 6; // px — prevents jitter on tiny movements

  useEffect(() => {
    // The dashboard's scroll container is the <main> element
    const scrollEl = document.querySelector("main") as HTMLElement | null;
    if (!scrollEl) return;

    // function handleScroll() {
    //   // Desktop: always visible
    //   if (window.innerWidth >= 640) {
    //     setHeaderVisible(true);
    //     lastScrollY.current = scrollEl!.scrollTop;
    //     return;
    //   }

    //   const currentY = scrollEl!.scrollTop;
    //   const delta    = currentY - lastScrollY.current;

    //   if (Math.abs(delta) < SCROLL_THRESHOLD) return;

    //   if (delta > 0 && currentY > 60) {
    //     // Scrolling DOWN and not near top → hide
    //     setHeaderVisible(false);
    //   } else {
    //     // Scrolling UP or near top → show
    //     setHeaderVisible(true);
    //   }

    //   lastScrollY.current = currentY;
    // }

    // function handleResize() {
    //   if (window.innerWidth >= 640) setHeaderVisible(true);
    // }

    // scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    // window.addEventListener("resize", handleResize, { passive: true });
    // return () => {
    //   scrollEl.removeEventListener("scroll", handleScroll);
    //   window.removeEventListener("resize", handleResize);
    // };
  }, []);

  return (
    <div>
      {/* ── Sticky header (auto-hides on mobile scroll-down) ──────────────── */}
      <motion.div
        className=" z-10 -mx-6 px-6 border-b border-border/30"
        animate={{ y: headerVisible ? 0 : "-150%" }}
        transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <div className="py-4 space-y-4">
          {/* Title row */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <BarChart2 className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg sm:text-xl font-bold text-foreground">Reports & Analytics</h1>
                <p className="text-xs text-muted-foreground hidden sm:block">
                  {dateFrom && dateTo ? `${dateFrom} → ${dateTo}` : "All time"}
                </p>
              </div>
            </div>

            {/* Export PDF */}
            <ExportPdfDialog type="overall" entityName="CRM Overall" />
          </div>

          {/* Tabs — scrollable on mobile */}
          <div className="overflow-x-auto -mx-6 px-6 pb-0.5 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="flex gap-1 p-1 rounded-xl bg-muted/50 w-max">
              {TABS.map(({ id, label, shortLabel, icon: Icon }) => (
                <button
                  key={id}
                  title={label}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    "relative flex items-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors rounded-lg whitespace-nowrap",
                    activeTab === id
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {activeTab === id && (
                    <motion.div
                      layoutId="tab-active-pill"
                      className="absolute inset-0 rounded-lg bg-card border border-border/50 shadow-md"
                      transition={{ type: "spring", stiffness: 500, damping: 40, mass: 0.8 }}
                    />
                  )}
                  <Icon className="relative z-10 h-3.5 w-3.5 shrink-0" />
                  <span className="relative z-10">{shortLabel}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Period selector — shared, sits below tabs */}
        <div className="py-3 border-t border-border/20">
          <PeriodHeader
            quickPeriod={quickPeriod}
            setQuickPeriod={setQuickPeriod}
            customFrom={customFrom}
            setCustomFrom={setCustomFrom}
            customTo={customTo}
            setCustomTo={setCustomTo}
          />
        </div>
      </motion.div>

      {/* ── Tab content ───────────────────────────────────────────────────── */}
      <div className="py-6 max-w-[1600px] mx-auto space-y-6">
        <AnimatePresence mode="wait">
          {activeTab === "overview" ? (
            <motion.div key="overview" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <OverviewTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "split" ? (
            <motion.div key="split" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <LeadSplitTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "revenue" ? (
            <motion.div key="revenue" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <RevenueTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "pipeline" ? (
            <motion.div key="pipeline" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <PipelineTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "response-time" ? (
            <motion.div key="response-time" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <ResponseTimeTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "followup" ? (
            <motion.div key="followup" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <FollowUpTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "lead-timing" ? (
            <motion.div key="lead-timing" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <LeadTimingTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "lead-quality" ? (
            <motion.div key="lead-quality" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <LeadQualityTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "funnel" ? (
            <motion.div key="funnel" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <SalesFunnelTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : activeTab === "alerts" ? (
            <motion.div key="alerts" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <AlertsTab />
            </motion.div>
          ) : activeTab === "audit" ? (
            <motion.div key="audit" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <AuditTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          ) : (
            <motion.div key="sources" initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-10 }} transition={{ duration:0.2 }}>
              <SourceAnalyticsTab dateFrom={dateFrom} dateTo={dateTo} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* AI Analytics Assistant */}
        {/* <div className="max-w-2xl">
          <AiChatPanel contextType="report" contextId="global" />
        </div> */}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <ReportsPageContent />
    </Suspense>
  );
}
