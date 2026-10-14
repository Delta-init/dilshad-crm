"use client";

import { useState, useMemo, useEffect, useRef, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  ArrowLeft,
  Loader2,
  Shuffle,
  Search,
  ChevronLeft,
  ChevronRight,
  Crown,
  Trophy,
  Users,
  Target,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  ExternalLink,
  UserCheck,
  ArrowRightLeft,
  Activity,
  GitBranch,
  StickyNote,
  Edit3,
  Trash2,
  AlertTriangle,
  Star,
  Medal,
  BarChart3,
  Mail,
  Phone,
  Calendar,
  CheckSquare,
  Tags,
  X,
  Filter,
  CalendarDays,
  UserPlus,
  MessageCircle,
  Send,
  RefreshCw,
  GitMerge,
  UserCheck2,
  ArrowUpDown,
  FileEdit,
  Zap,
  DollarSign,
  ChevronDown,
  ChevronUp,
  Award,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { TodayLeadsButton, SplitTodayButton } from "@/components/leads/LeadsDateFilter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import {
  useTeam,
  useTeamLeads,
  useTeamMemberStats,
  useAutoAssignTeamLeads,
  useTeams,
  useDeleteTeam,
  useMyTeam,
  useBulkAssignTeamLeadsToMember,
  useBulkTransferTeamLeads,
  useBulkUpdateTeamLeadsStatus,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  useTeamDashboard,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  useTeamLogs,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  useAssignLeadToMember,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  useTransferLead,
  useTeamUpdates,
  usePostTeamMessage,
  useToggleMemberActive,
  useToggleMemberAbsentToday,
  useRedistributeToday,
  useTeamRevenue,
  useTeamRevenueTimeline,
  useTeamMemberSplit,
  type TeamMemberSplitItem,
  type TeamUpdatesFilters,
} from "@/hooks/useTeams";
import type { RevenuePeriod, TeamRevenueMember } from "@/types/reports";
import { useAuthStore } from "@/lib/store/authStore";
import { useTeamSocket } from "@/hooks/useTeamSocket";
import { cn, formatDate, getInitials } from "@/lib/utils";
import { TeamDialog } from "@/components/teams/TeamDialog";
import TeamRemindersTab from "@/components/teams/TeamRemindersTab";
import { TeamMemberKanban } from "@/components/teams/TeamMemberKanban";
import { TeamSettingsTab } from "@/components/teams/TeamSettingsTab";
import { UpcomingBatch } from "@/components/teams/UpcomingBatch";
import { DailySplitTab } from "@/components/teams/DailySplitTab";
import { QuickNoteDialog } from "@/components/leads/QuickNoteDialog";
import { ExactConcernEditor } from "@/components/leads/ExactConcernEditor";
import { ExportPdfDialog } from "@/components/reports/ExportPdfDialog";
import { AiChatPanel } from "@/components/leads/AiChatPanel";
import type { Team, TeamMemberStat, TeamUpdateItem, TeamMessageItem, TeamActivityItem } from "@/types/team";
import type { Lead } from "@/types/lead";
import type { LeadStatus } from "@/lib/statusConfig";
import { LEAD_STATUSES, STATUS_META as SM } from "@/lib/statusConfig";
import type { User } from "@/types";
import { useCurrencyStore } from "@/lib/store/currencyStore";
import { fmtCompact, fmtFull } from "@/lib/currency";
import { toGstDateISO } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamDashboardData {
  statusDistribution: {
    total: number;
    thisMonth: number;
    unassigned: number;
    new: number;
    assigned: number;
    pending_response: number;
    followup: number;
    meeting_scheduled?: number;
    meeting_done?: number;
    closed: number;
    lost: number;
    not_connected: number;
    wrong_number?: number;
    mia: number;
    repeated: number;
    callback: number;
    cnc: number;
  };
  memberRankings: Array<{
    user: Pick<User, "_id" | "name" | "email" | "designation">;
    total: number;
    assigned: number;
    pending_response: number;
    followup: number;
    closed: number;
    lost: number;
    not_connected: number;
    mia: number;
    repeated: number;
    callback: number;
    cnc: number;
    totalPayments: number;
    closureRate: number;
  }>;
}

interface TeamLog {
  _id: string;
  action: string;
  description: string;
  performedBy: { name: string; email: string } | string;
  leadId?: string;
  leadName?: string;
  createdAt: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

type TabId = "dashboard" | "members" | "leads" | "kanban" | "batch" | "dailysplit" | "logs" | "updates" | "revenue" | "reminders" | "report" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "dashboard",  label: "Dashboard"   },
  { id: "members",    label: "Members"     },
  { id: "leads",      label: "Leads"       },
  { id: "kanban",     label: "Kanban"      },
  { id: "batch",      label: "Batch"       },
  { id: "dailysplit", label: "Daily Split" },
  { id: "reminders",  label: "Reminders"  },
  { id: "revenue",    label: "Revenue"    },
  { id: "report",     label: "Report"     },
  { id: "updates",    label: "Updates"    },
  { id: "logs",       label: "Logs"       },
  { id: "settings",   label: "Settings"   },
];

const STATUS_CONFIG = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, { label: SM[s].label, color: SM[s].color, dot: SM[s].dot, bar: SM[s].bar, text: SM[s].text }]),
) as Record<LeadStatus, { label: string; color: string; dot: string; bar: string; text: string }>;

const LOG_ACTION_CONFIG: Record<
  string,
  { icon: React.ElementType; color: string; bg: string }
> = {
  lead_created: { icon: FileText, color: "text-blue-400", bg: "bg-blue-500/10" },
  lead_updated: { icon: Edit3, color: "text-amber-400", bg: "bg-amber-500/10" },
  status_changed: { icon: GitBranch, color: "text-purple-400", bg: "bg-purple-500/10" },
  lead_assigned: { icon: UserCheck, color: "text-green-400", bg: "bg-green-500/10" },
  team_assigned: { icon: Users, color: "text-indigo-400", bg: "bg-indigo-500/10" },
  note_added: { icon: StickyNote, color: "text-teal-400", bg: "bg-teal-500/10" },
  note_updated: { icon: StickyNote, color: "text-teal-400", bg: "bg-teal-500/10" },
  note_deleted: { icon: StickyNote, color: "text-red-400", bg: "bg-red-500/10" },
};

const DEFAULT_LOG_CONFIG = { icon: Activity, color: "text-muted-foreground", bg: "bg-muted" };

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};

const fadeIn = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" } },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(dateStr);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeadStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cfg.color}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function ClosureRateBadge({ rate }: { rate: number }) {
  const pct = Math.round(rate);
  const cls =
    pct >= 50
      ? "bg-green-500/15 text-green-400 border-green-500/30"
      : pct >= 20
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
        : "bg-red-500/15 text-red-400 border-red-500/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {pct}%
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 p-4 animate-pulse">
      <div className="h-9 w-9 rounded-full bg-muted" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-32 rounded bg-muted" />
        <div className="h-2.5 w-24 rounded bg-muted" />
      </div>
      <div className="h-3 w-16 rounded bg-muted" />
    </div>
  );
}

// ─── Revenue helpers (shared within this file) ───────────────────────────────

const MEMBER_PALETTE = [
  "#6366f1","#22c55e","#f97316","#14b8a6","#eab308","#ef4444",
  "#8b5cf6","#3b82f6","#ec4899","#84cc16","#06b6d4","#f43f5e",
];

// The exact figure — "$2,250", not "$2.3K" (2026-10-14); short only on chart axes.
const fmtUSD  = fmtFull;
const fullUSD = fmtFull;

/** A card's money figure on a line of its own, a size smaller when long, so the whole amount fits on a phone. */
function MoneyFigure({ value }: { value: string }) {
  return (
    <p className={cn(
      "mt-1 font-bold text-foreground tabular-nums whitespace-nowrap",
      value.length > 10 ? "text-base sm:text-xl" : value.length > 7 ? "text-lg sm:text-2xl" : "text-2xl",
    )}>{value}</p>
  );
}

type RevQuickPeriod = "today" | "week" | "month" | "quarter" | "year" | "custom";

function getRevRange(p: RevQuickPeriod): { from: string; to: string } {
  const now   = new Date();
  const today = toGstDateISO(now);
  switch (p) {
    case "today":   return { from: today, to: today };
    case "week": {
      const mon = new Date(now);
      mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      return { from: toGstDateISO(mon), to: today };
    }
    case "month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toGstDateISO(first), to: today };
    }
    case "quarter": {
      const first = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from: toGstDateISO(first), to: today };
    }
    case "year":
      return { from: toGstDateISO(new Date(now.getFullYear(), 0, 1)), to: today };
    default: return { from: "", to: "" };
  }
}

function RevTooltip({ active, payload, label }: {
  active?:  boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?:   string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="rounded-xl border border-border bg-card/95 backdrop-blur-sm p-3 shadow-xl text-xs max-w-[220px]">
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

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

type DashFilterPreset = "all" | "month" | "year" | "custom";

function getDashDates(preset: DashFilterPreset): { dateFrom: string; dateTo: string } {
  const now    = new Date();
  const pad    = (n: number) => String(n).padStart(2, "0");
  const today  = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (preset === "month") {
    const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    return { dateFrom: from, dateTo: today };
  }
  if (preset === "year") {
    return { dateFrom: `${now.getFullYear()}-01-01`, dateTo: today };
  }
  return { dateFrom: "", dateTo: "" };
}

function DashboardTab({
  teamId,
  team,
  isLeaderOrAdmin,
  onAutoAssign,
  assigning,
  onToggleMemberActive,
  togglingMember,
}: {
  teamId: string;
  team: Team;
  isLeaderOrAdmin: boolean;
  onAutoAssign: () => void;
  assigning: boolean;
  onToggleMemberActive: (memberId: string) => void;
  togglingMember: boolean;
}) {
  const [filterPreset, setFilterPreset] = useState<DashFilterPreset>("all");
  const [customFrom,   setCustomFrom]   = useState("");
  const [customTo,     setCustomTo]     = useState("");

  const { dateFrom, dateTo } = useMemo(() => {
    if (filterPreset === "custom") return { dateFrom: customFrom, dateTo: customTo };
    return getDashDates(filterPreset);
  }, [filterPreset, customFrom, customTo]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dashData, isLoading } = (useTeamDashboard as any)(teamId, dateFrom || undefined, dateTo || undefined) as {
    data: TeamDashboardData | undefined;
    isLoading: boolean;
  };

  const dist = dashData?.statusDistribution;
  const rankings = dashData?.memberRankings ?? [];
  const total = dist?.total ?? 0;
  const inactiveMemberIds = useMemo(
    () => new Set(team.inactiveMembers ?? []),
    [team.inactiveMembers],
  );

  const statCards = [
    {
      title: "Total Leads",
      value: total,
      icon: FileText,
      color: "text-primary",
      bg: "bg-primary/10",
      border: "border-primary/20",
    },
    {
      title: "This Month",
      value: dist?.thisMonth ?? 0,
      icon: CalendarDays,
      color: "text-violet-400",
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
    },
    {
      title: "Unassigned",
      value: dist?.unassigned ?? 0,
      icon: Target,
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
    },
    {
      title: "Closed",
      value: dist?.closed ?? 0,
      icon: CheckCircle2,
      color: "text-green-400",
      bg: "bg-green-500/10",
      border: "border-green-500/20",
    },
    {
      title: "Lost Rate",
      value:
        total > 0
          ? `${Math.round(((dist?.lost ?? 0) / total) * 100)}%`
          : "0%",
      icon: XCircle,
      color: "text-red-400",
      bg: "bg-red-500/10",
      border: "border-red-500/20",
    },
  ];

  const statusBars: Array<{ key: LeadStatus; label: string }> = LEAD_STATUSES.map((s) => ({ key: s as LeadStatus, label: SM[s].label }));

  const medalColors = ["text-yellow-400", "text-neutral-400", "text-amber-600"];
  const medalBgs = ["bg-yellow-400/10", "bg-neutral-400/10", "bg-amber-600/10"];

  const sortedRankings = useMemo(
    () => [...rankings].sort((a, b) => (b.totalPayments ?? 0) - (a.totalPayments ?? 0)),
    [rankings]
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
        <div className="h-48 rounded-lg bg-muted animate-pulse" />
        <div className="h-64 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  const PRESETS: { key: DashFilterPreset; label: string }[] = [
    { key: "all",    label: "All Time"    },
    { key: "month",  label: "This Month"  },
    { key: "year",   label: "This Year"   },
    { key: "custom", label: "Custom"      },
  ];

  const filterLabel = filterPreset === "month"
    ? "This Month"
    : filterPreset === "year"
    ? "This Year"
    : filterPreset === "custom" && (customFrom || customTo)
    ? `${customFrom || "…"} → ${customTo || "…"}`
    : "All Time";

  return (
    <div className="space-y-6">
      {/* Header row with date filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">{team.name}</h2>
          <Badge variant={team.status === "active" ? "default" : "secondary"} className="capitalize shrink-0">
            {team.status}
          </Badge>
          {filterPreset !== "all" && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
            >
              <CalendarDays className="h-3 w-3" />
              {filterLabel}
            </motion.span>
          )}
        </div>

        {/* Date filter toggles */}
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilterPreset(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  filterPreset === key
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Custom date pickers */}
          <AnimatePresence>
            {filterPreset === "custom" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2 overflow-hidden"
              >
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground [color-scheme:dark]"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground [color-scheme:dark]"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Stat cards */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4"
      >
        {statCards.map((card) => (
          <motion.div key={card.title} variants={itemVariants}>
            <Card className={`border-border/50 hover:border-border transition-colors`}>
              <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {card.title}
                </CardTitle>
                <div className={`rounded-lg p-1.5 ${card.bg}`}>
                  <card.icon className={`h-3.5 w-3.5 ${card.color}`} />
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-2xl font-bold text-foreground">{card.value}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      {/* Status distribution */}
      <motion.div variants={fadeIn} initial="hidden" animate="show">
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Status Distribution
              <span className="ml-auto text-xs font-normal text-muted-foreground">{filterLabel}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {statusBars.map(({ key, label }) => {
              const count = dist?.[key] ?? 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              const cfg = STATUS_CONFIG[key];
              return (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
                      className={`h-full rounded-full ${cfg.bar}`}
                    />
                  </div>
                  <span className={`w-8 shrink-0 text-right text-xs font-medium ${cfg.text}`}>
                    {count}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </motion.div>

      {/* Member rankings */}
      <motion.div variants={fadeIn} initial="hidden" animate="show" transition={{ delay: 0.1 }}>
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-400" />
              Top Performers
              <span className="ml-auto text-xs font-normal text-muted-foreground">{filterLabel}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sortedRankings.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No performance data yet.
              </p>
            ) : (
              sortedRankings.map((member, idx) => {
                const isMedal = idx < 3;
                const medalColor = isMedal ? medalColors[idx] : "text-muted-foreground";
                const medalBg = isMedal ? medalBgs[idx] : "bg-muted";
                const closureRate = member.closureRate ?? (member.total > 0 ? (member.closed / member.total) * 100 : 0);

                return (
                  <motion.div
                    key={member.user._id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="flex items-center gap-2 rounded-lg border border-border/40 p-2.5 hover:bg-muted/20 transition-colors"
                  >
                    {/* Rank badge */}
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${medalBg}`}
                    >
                      {isMedal ? (
                        <Medal className={`h-3.5 w-3.5 ${medalColor}`} />
                      ) : (
                        <span className="text-xs font-bold text-muted-foreground">{idx + 1}</span>
                      )}
                    </div>

                    {/* Avatar */}
                    <Avatar className="h-8 w-8 shrink-0">
                      <AvatarFallback className="text-xs bg-primary/10 text-primary">
                        {getInitials(member.user.name)}
                      </AvatarFallback>
                    </Avatar>

                    {/* Info */}
                    <div className="min-w-0 flex-1 max-w-[120px] sm:max-w-none">
                      <Link
                        href={`/teams/${team._id}/members/${member.user._id}`}
                        className="text-sm font-medium text-foreground truncate hover:text-primary hover:underline underline-offset-2 transition-colors inline-flex items-center gap-1"
                      >
                        {member.user.name}
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                      </Link>
                      {member.user.designation && (
                        <p className="text-xs text-muted-foreground truncate">
                          {member.user.designation}
                        </p>
                      )}
                      {/* Closure rate bar */}
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.min(closureRate, 100)}%` }}
                            transition={{ duration: 0.7, ease: "easeOut", delay: idx * 0.05 + 0.2 }}
                            className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400"
                          />
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {Math.round(closureRate)}%
                        </span>
                      </div>
                    </div>

                    {/* Stat chips — 2 on mobile, 4 on sm+ */}
                    <div className="flex items-center gap-1 shrink-0 ml-auto">
                      {[
                        { label: "Total", value: member.total, cls: "text-foreground", show: "always" },
                        { label: "Closed", value: member.closed, cls: "text-green-400", show: "sm" },
                        { label: "Revenue", value: fmtFull(member.totalPayments ?? 0), cls: "text-emerald-400", show: "always" },
                        { label: "Lost", value: member.lost, cls: "text-red-400", show: "sm" },
                      ].map(({ label, value, cls, show }) => (
                        <div
                          key={label}
                          className={`flex flex-col items-center rounded bg-muted/60 px-1.5 sm:px-2 py-1 min-w-[28px] sm:min-w-[36px] ${show === "sm" ? "hidden sm:flex" : ""}`}
                        >
                          <span className={`text-[11px] font-bold ${cls}`}>{value}</span>
                          <span className="text-[10px] text-muted-foreground">{label}</span>
                        </div>
                      ))}
                      {/* Active / Inactive toggle — leaders & admins only */}
                      {isLeaderOrAdmin && (
                        <button
                          type="button"
                          disabled={togglingMember}
                          onClick={() => onToggleMemberActive(member.user._id)}
                          title={inactiveMemberIds.has(member.user._id) ? "Mark active for auto-assignment" : "Mark inactive (skip auto-assignment)"}
                          className={cn(
                            "ml-1 flex flex-col items-center rounded px-1.5 py-1 text-[10px] font-semibold transition-all border",
                            inactiveMemberIds.has(member.user._id)
                              ? "border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                              : "border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20",
                          )}
                        >
                          {inactiveMemberIds.has(member.user._id) ? "Inactive" : "Active"}
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

// ─── Members Tab ──────────────────────────────────────────────────────────────

function MembersTab({
  team,
  memberStats,
  isLoading,
  isLeaderOrAdmin = false,
  onEditMembers,
  onToggleMemberActive,
  togglingMember,
  onToggleMemberAbsentToday,
  onRedistributeToday,
  redistributing,
}: {
  team: Team;
  memberStats: TeamMemberStat[] | undefined;
  isLoading: boolean;
  isLeaderOrAdmin?: boolean;
  onEditMembers?: () => void;
  onToggleMemberActive?: (memberId: string) => void;
  togglingMember?: boolean;
  onToggleMemberAbsentToday?: (memberId: string, absent: boolean) => void;
  onRedistributeToday?: () => void;
  redistributing?: boolean;
}) {
  const leaderIds = new Set((team.leaders ?? []).map((l) => l._id));
  const inactiveMemberIds = useMemo(
    () => new Set(team.inactiveMembers ?? []),
    [team.inactiveMembers],
  );

  // Build absent-today set from team data (matches today's AED date)
  const absentTodayIds = useMemo(() => {
    if (!team.absentToday?.length) return new Set<string>();
    const nowAED = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const todayStr = `${nowAED.getUTCFullYear()}-${String(nowAED.getUTCMonth() + 1).padStart(2, "0")}-${String(nowAED.getUTCDate()).padStart(2, "0")}`;
    return new Set(
      team.absentToday
        .filter((a) => {
          const d = new Date(a.date);
          const dAED = new Date(d.getTime() + 4 * 60 * 60 * 1000);
          const dStr = `${dAED.getUTCFullYear()}-${String(dAED.getUTCMonth() + 1).padStart(2, "0")}-${String(dAED.getUTCDate()).padStart(2, "0")}`;
          return dStr === todayStr;
        })
        .map((a) => (typeof a.userId === "string" ? a.userId : (a.userId as { _id?: string })._id ?? String(a.userId))),
    );
  }, [team.absentToday]);

  const hasAbsentMembers = absentTodayIds.size > 0;

  return (
    <div className="space-y-4">
      <Card className="border-border/50">
        {isLeaderOrAdmin && (
          <div className="flex mb-2 items-center justify-between px-4 pt-4 pb-0">
            <p className="text-sm font-medium text-muted-foreground">
              {(team.members?.length ?? 0) + (team.leaders?.length ?? 0)} member{((team.members?.length ?? 0) + (team.leaders?.length ?? 0)) !== 1 ? "s" : ""} total
            </p>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={onEditMembers}
            >
              <UserPlus className="h-3.5 w-3.5" />
              Edit Members
            </Button>
          </div>
        )}
        {/* Redistribute today's leads banner */}
        {isLeaderOrAdmin && hasAbsentMembers && team.settings?.autoAssign && (
          <div className="flex items-center justify-between gap-3 mx-4 mt-4 rounded-xl border border-orange-500/30 bg-orange-500/5 px-4 py-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-7 w-7 shrink-0 flex items-center justify-center rounded-full bg-orange-500/15">
                <UserX className="h-3.5 w-3.5 text-orange-400" />
              </div>
              <p className="text-xs text-orange-300/90">
                <span className="font-semibold">{absentTodayIds.size}</span> member{absentTodayIds.size !== 1 ? "s are" : " is"} absent today. Today's leads can be redistributed to present members.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5 border-orange-500/40 text-orange-400 hover:bg-orange-500/10 text-xs"
              onClick={onRedistributeToday}
              disabled={redistributing}
            >
              {redistributing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
              Redistribute
            </Button>
          </div>
        )}
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-0 divide-y divide-border/50">
              {[0, 1, 2, 3].map((i) => (
                <SkeletonRow key={i} />
              ))}
            </div>
          ) : !memberStats || memberStats.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No members in this team yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center w-8 sm:w-12">Rank</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-left">Member</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden sm:table-cell">Role</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">Total</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center text-emerald-500">Revenue</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden md:table-cell">Assigned</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden md:table-cell">Follow Up</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">Pending</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">CNC</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden xl:table-cell">Not Connected</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">Closed</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">Lost</th>
                    <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">Conv%</th>
                    {isLeaderOrAdmin && (
                      <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">Auto-assign</th>
                    )}
                    {isLeaderOrAdmin && (
                      <th className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">Today</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {[...memberStats]
                    .sort((a, b) => (b.totalPayments ?? 0) - (a.totalPayments ?? 0))
                    .map((stat, idx) => {
                      const isLeader = leaderIds.has(stat.user._id);
                      const closureRate =
                        stat.total > 0 ? Math.round((stat.closed / stat.total) * 100) : 0;
                      return (
                        <motion.tr
                          key={stat.user._id}
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.04 }}
                          className="hover:bg-muted/20 transition-colors"
                        >
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                            <span className="text-sm font-semibold text-muted-foreground">
                              {idx + 1}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3">
                            <div className="flex items-center gap-2.5">
                              <Avatar className="h-8 w-8 shrink-0">
                                <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                  {getInitials(stat.user.name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <Link
                                    href={`/teams/${team._id}/members/${stat.user._id}`}
                                    className="text-sm font-medium text-foreground truncate hover:text-primary hover:underline underline-offset-2 transition-colors inline-flex items-center gap-1"
                                  >
                                    {stat.user.name}
                                    <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                                  </Link>
                                  {isLeader && (
                                    <Crown className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground truncate">
                                  {stat.user.designation ?? stat.user.email}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden sm:table-cell">
                            {isLeader ? (
                              <Badge
                                variant="outline"
                                className="gap-1 border-amber-500/30 text-amber-400 text-[10px]"
                              >
                                <Crown className="h-2.5 w-2.5" />
                                Leader
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                Member
                              </Badge>
                            )}
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                            <span className="text-sm font-semibold">{stat.total}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                            <span className="text-sm font-bold text-emerald-400">
                              {fmtFull(stat.totalPayments ?? 0)}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden md:table-cell">
                            <span className="text-sm text-amber-400">{stat.assigned}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden md:table-cell">
                            <span className="text-sm text-purple-400">{stat.followup}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">
                            <span className="text-sm text-violet-400">{stat.pending_response ?? 0}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">
                            <span className="text-sm text-amber-400">{stat.cnc ?? 0}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden xl:table-cell">
                            <span className="text-sm text-neutral-400">{stat.not_connected ?? 0}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                            <span className="text-sm text-green-400 font-medium">{stat.closed}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center hidden lg:table-cell">
                            <span className="text-sm text-red-400">{stat.lost ?? 0}</span>
                          </td>
                          <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                            <ClosureRateBadge rate={closureRate} />
                          </td>
                          {isLeaderOrAdmin && (
                            <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                              <button
                                type="button"
                                disabled={togglingMember}
                                onClick={() => onToggleMemberActive?.(stat.user._id)}
                                className={cn(
                                  "rounded-full px-2.5 py-0.5 text-[11px] font-semibold border transition-all",
                                  inactiveMemberIds.has(stat.user._id)
                                    ? "border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                                    : "border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20",
                                )}
                              >
                                {inactiveMemberIds.has(stat.user._id) ? "Inactive" : "Active"}
                              </button>
                            </td>
                          )}
                          {isLeaderOrAdmin && (
                            <td className="px-2 py-2.5 sm:px-4 sm:py-3 text-center">
                              <button
                                type="button"
                                onClick={() => onToggleMemberAbsentToday?.(
                                  stat.user._id,
                                  !absentTodayIds.has(stat.user._id),
                                )}
                                className={cn(
                                  "rounded-full px-2.5 py-0.5 text-[11px] font-semibold border transition-all",
                                  absentTodayIds.has(stat.user._id)
                                    ? "border-orange-500/40 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
                                    : "border-border/50 bg-muted/30 text-muted-foreground hover:border-orange-500/30 hover:text-orange-400",
                                )}
                                title={absentTodayIds.has(stat.user._id) ? "Mark present" : "Mark absent today"}
                              >
                                {absentTodayIds.has(stat.user._id) ? "Absent" : "Present"}
                              </button>
                            </td>
                          )}
                        </motion.tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Leads Tab ────────────────────────────────────────────────────────────────

function LeadsTab({
  teamId,
  team,
  isLeaderOrAdmin,
  onAutoAssign,
  assigning,
}: {
  teamId: string;
  team: Team;
  isLeaderOrAdmin: boolean;
  onAutoAssign: () => void;
  assigning: boolean;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [reporterFilter, setReporterFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [splitFrom, setSplitFrom] = useState<string>("");
  const [splitTo, setSplitTo] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [unassignedOnly, setUnassignedOnly] = useState(false);

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
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [assigningLeadId, setAssigningLeadId] = useState<string | null>(null);
  const [transferLeadId, setTransferLeadId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string>("");
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");

  // ── Bulk selection ────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkTransferOpen, setBulkTransferOpen] = useState(false);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkMemberId, setBulkMemberId] = useState<string>("");
  const [bulkNewTeamId, setBulkNewTeamId] = useState<string>("");
  const [bulkStatus, setBulkStatus] = useState<string>("followup");

  const bulkAssignMutation = useBulkAssignTeamLeadsToMember(teamId);
  const bulkTransferMutation = useBulkTransferTeamLeads(teamId);
  const bulkStatusMutation = useBulkUpdateTeamLeadsStatus(teamId);

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll(ids: string[]) {
    setSelectedIds((prev) =>
      ids.every((id) => prev.has(id)) ? new Set() : new Set(ids)
    );
  }

  function handleSearchChange(val: string) {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 400);
  }

  // Clear selection when filters change
  useEffect(() => { setSelectedIds(new Set()); }, [page, debouncedSearch, statusFilter, assigneeFilter, reporterFilter, dateFrom, dateTo, splitFrom, splitTo, unassignedOnly]);

  function applyFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  function clearAllFilters() {
    setSearch("");
    setDebouncedSearch("");
    setStatusFilter("all");
    setAssigneeFilter("all");
    setReporterFilter("all");
    setDateFrom("");
    setDateTo("");
    setSplitFrom("");
    setSplitTo("");
    setUnassignedOnly(false);
    setPage(1);
  }

  const activeFilterCount = [
    statusFilter !== "all",
    assigneeFilter !== "all",
    reporterFilter !== "all",
    !!dateFrom,
    !!dateTo,
    !!splitFrom,
    !!splitTo,
    unassignedOnly,
    !!debouncedSearch,
  ].filter(Boolean).length;

  const hasActiveFilters = activeFilterCount > 0;

  const { data: leadsResult, isLoading, isFetching } = useTeamLeads(teamId, {
    search: debouncedSearch || undefined,
    status: statusFilter !== "all" ? (statusFilter as LeadStatus) : undefined,
    assignedTo: assigneeFilter !== "all" ? assigneeFilter : undefined,
    reporter: reporterFilter !== "all" ? reporterFilter : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    splitFrom: splitFrom || undefined,
    splitTo: splitTo || undefined,
    unassignedOnly,
    page,
    limit,
  });

  const { data: allTeamsResult } = useTeams();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assignMutation = (useAssignLeadToMember as any)(teamId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transferMutation = (useTransferLead as any)(teamId);

  const leads = leadsResult?.data ?? [];
  const pagination = leadsResult?.pagination;

  const allMembers: User[] = useMemo(
    () =>
      [
        ...(team?.leaders ?? []),
        ...(team?.members ?? []),
      ].filter((u, i, arr) => arr.findIndex((x) => x._id === u._id) === i),
    [team]
  );

  const leaderIds = useMemo(
    () => new Set((team?.leaders ?? []).map((l) => l._id)),
    [team]
  );

  const otherTeams = (allTeamsResult?.data ?? []).filter((t: Team) => t._id !== teamId);

  function handleAssign(leadId: string) {
    if (!selectedMemberId) return;
    assignMutation.mutate(
      { leadId, memberId: selectedMemberId },
      {
        onSuccess: () => {
          setAssigningLeadId(null);
          setSelectedMemberId("");
        },
      }
    );
  }

  function handleTransfer(leadId: string) {
    if (!selectedTeamId) return;
    transferMutation.mutate(
      { leadId, newTeamId: selectedTeamId },
      {
        onSuccess: () => {
          setTransferLeadId(null);
          setSelectedTeamId("");
        },
      }
    );
  }

  const canActOnLead = (lead: Lead) =>
    isLeaderOrAdmin && lead.status !== "closed" && lead.status !== "lost";

  return (
    <div className="space-y-4">
      {/* ── Filter Card ────────────────────────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardHeader className="pb-3 space-y-3">

          {/* Row 1 — Search + Filter toggle + Auto-assign */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Search */}
            <div className="relative w-full sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, phone…"
                className="pl-9"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              {search && (
                <button
                  onClick={() => { if (debounceRef.current) clearTimeout(debounceRef.current); setSearch(""); setDebouncedSearch(""); setPage(1); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Right actions */}
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <TodayLeadsButton active={isTodayActive} onClick={applyToday} />
                <SplitTodayButton active={isSplitTodayActive} onClick={applySplitToday} />
              <Button
                variant={showFilters ? "secondary" : "outline"}
                size="sm"
                className="gap-2 relative"
                onClick={() => setShowFilters((v) => !v)}
              >
                <Filter className="h-3.5 w-3.5" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearAllFilters} className="gap-1.5 text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                  Clear all
                </Button>
              )}
              {isLeaderOrAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAutoAssign}
                  disabled={assigning}
                  className="gap-2 shrink-0"
                >
                  {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
                  Auto-assign
                </Button>
              )}
            </div>
          </div>

          {/* Row 2 — Expandable filter panel */}
          <AnimatePresence initial={false}>
            {showFilters && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 lg:grid-cols-5">

                  {/* Status */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Status</p>
                    <Select value={statusFilter} onValueChange={(v) => applyFilter(setStatusFilter, v)}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="All Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        {(Object.keys(STATUS_CONFIG) as LeadStatus[]).map((s) => (
                          <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Assigned To */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Assigned To</p>
                    <Select value={assigneeFilter} onValueChange={(v) => applyFilter(setAssigneeFilter, v)}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder="All Members" />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        <SelectItem value="all">All Members</SelectItem>
                        {allMembers.map((m) => (
                          <SelectItem key={m._id} value={m._id}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Unassigned only toggle (inside panel) */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Availability</p>
                    <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm select-none hover:bg-muted/30 transition-colors">
                      <Checkbox
                        checked={unassignedOnly}
                        onCheckedChange={(v) => { setUnassignedOnly(!!v); setPage(1); }}
                      />
                      Unassigned only
                    </label>
                  </div>

                  {/* Split Date (assigned) */}
                  <div className="space-y-2 col-span-2">
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      Split Date (Assigned)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(() => {
                        const t = toGstDateISO(new Date());
                        const isActive = splitFrom === t && splitTo === t;
                        return (
                          <button
                            type="button"
                            onClick={() => { if (isActive) { setSplitFrom(""); setSplitTo(""); } else { setSplitFrom(t); setSplitTo(t); } setPage(1); }}
                            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${isActive ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"}`}
                          >
                            Split Today
                          </button>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="date"
                        value={splitFrom}
                        max={splitTo || undefined}
                        onChange={(e) => { setSplitFrom(e.target.value); setPage(1); }}
                        className="h-9 text-sm px-2 flex-1 [color-scheme:dark]"
                      />
                      <span className="text-xs text-muted-foreground shrink-0">to</span>
                      <Input
                        type="date"
                        value={splitTo}
                        min={splitFrom || undefined}
                        onChange={(e) => { setSplitTo(e.target.value); setPage(1); }}
                        className="h-9 text-sm px-2 flex-1 [color-scheme:dark]"
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground/70">Shows leads split in this range, even if created earlier.</p>
                  </div>

                  {/* Date Range */}
                  <div className="space-y-2 col-span-2">
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      Date Range (Created)
                    </p>
                    {/* Quick period buttons */}
                    <div className="flex flex-wrap gap-1.5">
                      {(["today", "week", "month", "year"] as const).map((p) => {
                        const labels = { today: "Today", week: "This Week", month: "This Month", year: "This Year" };
                        const getRangeFor = (period: string) => {
                          const now = new Date(); const t = toGstDateISO(now);
                          if (period === "today") return { f: t, t };
                          if (period === "week") { const m = new Date(now); m.setDate(now.getDate()-((now.getDay()+6)%7)); return { f: toGstDateISO(m), t }; }
                          if (period === "month") return { f: toGstDateISO(new Date(now.getFullYear(),now.getMonth(),1)), t };
                          return { f: toGstDateISO(new Date(now.getFullYear(),0,1)), t };
                        };
                        const range = getRangeFor(p);
                        const isActive = dateFrom === range.f && dateTo === range.t;
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => { if (isActive) { setDateFrom(""); setDateTo(""); } else { setDateFrom(range.f); setDateTo(range.t); } setPage(1); }}
                            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${isActive ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"}`}
                          >
                            {labels[p]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="date"
                        value={dateFrom}
                        max={dateTo || undefined}
                        onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                        className="h-9 text-sm px-2 flex-1 [color-scheme:dark]"
                      />
                      <span className="text-xs text-muted-foreground shrink-0">to</span>
                      <Input
                        type="date"
                        value={dateTo}
                        min={dateFrom || undefined}
                        onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                        className="h-9 text-sm px-2 flex-1 [color-scheme:dark]"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Row 3 — Active filter pills */}
          {hasActiveFilters && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-wrap items-center gap-1.5"
            >
              {debouncedSearch && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Search: &quot;{debouncedSearch}&quot;
                  <button onClick={() => { setSearch(""); setDebouncedSearch(""); setPage(1); }} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
              {statusFilter !== "all" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Status: {STATUS_CONFIG[statusFilter as LeadStatus]?.label ?? statusFilter}
                  <button onClick={() => applyFilter(setStatusFilter, "all")} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
              {assigneeFilter !== "all" && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Assigned: {allMembers.find((m) => m._id === assigneeFilter)?.name ?? assigneeFilter}
                  <button onClick={() => applyFilter(setAssigneeFilter, "all")} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
              {unassignedOnly && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Unassigned only
                  <button onClick={() => { setUnassignedOnly(false); setPage(1); }} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
              {dateFrom && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  From: {dateFrom}
                  <button onClick={() => { setDateFrom(""); setPage(1); }} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
              {dateTo && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  To: {dateTo}
                  <button onClick={() => { setDateTo(""); setPage(1); }} className="ml-0.5 hover:text-primary/60"><X className="h-3 w-3" /></button>
                </span>
              )}
            </motion.div>
          )}
        </CardHeader>
      </Card>

      {/* Table */}
      <Card className="border-border/50">
        <CardHeader className="pb-3 px-6 pt-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Team Leads
            {pagination && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {pagination.total}
              </span>
            )}
            {isFetching && !isLoading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
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
                    <th className="pl-2 pr-1 sm:pl-4 sm:pr-2 py-2.5 sm:py-3 w-10">
                      <Checkbox
                        checked={leads.length > 0 && leads.every((l) => selectedIds.has(l._id))}
                        onCheckedChange={() => toggleAll(leads.map((l) => l._id))}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left">Lead</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left hidden sm:table-cell">Phone</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left">Status</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left hidden md:table-cell">Assigned To</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left hidden lg:table-cell">Source</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left hidden lg:table-cell">Exact Concern</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-left hidden lg:table-cell">Date</th>
                    <th className="px-3 py-2.5 sm:px-4 sm:py-3 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {leads.map((lead, i) => {
                    const assignedTo =
                      lead.assignedTo && typeof lead.assignedTo === "object"
                        ? (lead.assignedTo as User)
                        : null;
                    return (
                      <motion.tr
                        key={lead._id}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.03 }}
                        className={`hover:bg-muted/20 transition-colors group ${selectedIds.has(lead._id) ? "bg-primary/5" : ""}`}
                      >
                        <td className="pl-2 pr-1 sm:pl-4 sm:pr-2 py-2.5 sm:py-3">
                          <Checkbox
                            checked={selectedIds.has(lead._id)}
                            onCheckedChange={() => toggleId(lead._id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Select lead"
                          />
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">{lead.name}</p>
                            {lead.email && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Mail className="h-3 w-3" />
                                {lead.email}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3 hidden sm:table-cell">
                          {lead.phone ? (
                            <span className="text-sm text-muted-foreground flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {lead.phone}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3">
                          <StatusBadge status={lead.status} />
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3 hidden md:table-cell">
                          {assignedTo ? (
                            <div className="flex items-center gap-2">
                              <Avatar className="h-6 w-6 shrink-0">
                                <AvatarFallback className="text-[10px] bg-primary/10 text-primary">
                                  {getInitials(assignedTo.name)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="text-sm text-foreground">{assignedTo.name}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">Unassigned</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3 hidden lg:table-cell">
                          <span className="text-sm text-muted-foreground capitalize">
                            {lead.source ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3 hidden lg:table-cell">
                          <ExactConcernEditor leadId={lead._id} leadName={lead.name} value={lead.exactConcern} />
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3 hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDate(lead.createdAt)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 sm:px-4 sm:py-3">
                          <div className="flex items-center justify-center gap-1">
                            {/* View */}
                            <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                              <Link href={`/leads/${lead._id}`}>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Link>
                            </Button>

                            {/* Quick note */}
                            <QuickNoteDialog leadId={lead._id} leadName={lead.name} className="h-7 w-7" />

                            {/* Assign to member */}
                            {canActOnLead(lead) && (
                              <Dialog
                                open={assigningLeadId === lead._id}
                                onOpenChange={(open) => {
                                  setAssigningLeadId(open ? lead._id : null);
                                  if (!open) setSelectedMemberId("");
                                }}
                              >
                                <DialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                                    title="Assign to member"
                                  >
                                    <UserCheck className="h-3.5 w-3.5" />
                                  </Button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-sm">
                                  <DialogHeader>
                                    <DialogTitle className="text-base">Assign Lead</DialogTitle>
                                  </DialogHeader>
                                  <div className="space-y-4 pt-2">
                                    <p className="text-sm text-muted-foreground">
                                      Assign <span className="font-medium text-foreground">{lead.name}</span> to:
                                    </p>
                                    <Select
                                      value={selectedMemberId}
                                      onValueChange={setSelectedMemberId}
                                    >
                                      <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Select a member..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {allMembers.map((m) => (
                                          <SelectItem key={m._id} value={m._id}>
                                            <span className="flex items-center gap-1.5">
                                              {leaderIds.has(m._id) && (
                                                <Crown className="h-3 w-3 text-yellow-400 shrink-0" />
                                              )}
                                              {m.name}
                                              {leaderIds.has(m._id) && (
                                                <span className="text-xs text-yellow-500/80">(Leader)</span>
                                              )}
                                              {!leaderIds.has(m._id) && m.designation && (
                                                <span className="text-muted-foreground text-xs">
                                                  · {m.designation}
                                                </span>
                                              )}
                                            </span>
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <div className="flex justify-end gap-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                          setAssigningLeadId(null);
                                          setSelectedMemberId("");
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                      <Button
                                        size="sm"
                                        disabled={!selectedMemberId || assignMutation.isPending}
                                        onClick={() => handleAssign(lead._id)}
                                      >
                                        {assignMutation.isPending ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                          "Assign"
                                        )}
                                      </Button>
                                    </div>
                                  </div>
                                </DialogContent>
                              </Dialog>
                            )}

                            {/* Transfer team */}
                            {isLeaderOrAdmin && (
                              <Dialog
                                open={transferLeadId === lead._id}
                                onOpenChange={(open) => {
                                  setTransferLeadId(open ? lead._id : null);
                                  if (!open) setSelectedTeamId("");
                                }}
                              >
                                <DialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-purple-400 hover:text-purple-300 hover:bg-purple-500/10"
                                    title="Transfer to another team"
                                  >
                                    <ArrowRightLeft className="h-3.5 w-3.5" />
                                  </Button>
                                </DialogTrigger>
                                <DialogContent className="sm:max-w-sm">
                                  <DialogHeader>
                                    <DialogTitle className="text-base">Transfer Lead</DialogTitle>
                                  </DialogHeader>
                                  <div className="space-y-4 pt-2">
                                    <p className="text-sm text-muted-foreground">
                                      Transfer <span className="font-medium text-foreground">{lead.name}</span> to another team:
                                    </p>
                                    <Select
                                      value={selectedTeamId}
                                      onValueChange={setSelectedTeamId}
                                    >
                                      <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Select a team..." />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {otherTeams.map((t: Team) => (
                                          <SelectItem key={t._id} value={t._id}>
                                            {t.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <div className="flex justify-end gap-2">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                          setTransferLeadId(null);
                                          setSelectedTeamId("");
                                        }}
                                      >
                                        Cancel
                                      </Button>
                                      <Button
                                        size="sm"
                                        disabled={!selectedTeamId || transferMutation.isPending}
                                        onClick={() => handleTransfer(lead._id)}
                                      >
                                        {transferMutation.isPending ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                          "Transfer"
                                        )}
                                      </Button>
                                    </div>
                                  </div>
                                </DialogContent>
                              </Dialog>
                            )}
                          </div>
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
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border px-4 sm:px-6 py-4">
              <div className="flex items-center justify-center sm:justify-start gap-3">
                <p className="text-sm text-muted-foreground text-center sm:text-left">
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {(pagination.page - 1) * pagination.limit + 1}–
                    {Math.min(pagination.page * pagination.limit, pagination.total)}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-foreground">{pagination.total}</span> leads
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
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline" size="sm"
                    className="gap-1"
                    disabled={!pagination.hasPrevPage || isFetching}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Prev</span>
                  </Button>
                  <span className="text-sm font-medium px-1 tabular-nums">
                    {pagination.page} / {pagination.totalPages}
                  </span>
                  <Button
                    variant="outline" size="sm"
                    className="gap-1"
                    disabled={!pagination.hasNextPage || isFetching}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Bulk: Assign to Member ────────────────────────────────────────────── */}
      <ResponsiveDialog open={bulkAssignOpen} onOpenChange={setBulkAssignOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex items-center gap-2">
              <UserCheck2 className="h-4 w-4 text-primary" />
              Assign to Member
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Assigning{" "}
              <span className="font-semibold text-foreground">{selectedIds.size}</span> lead(s) to a team member.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="px-4 sm:px-0 py-2 space-y-3">
            <Select value={bulkMemberId} onValueChange={setBulkMemberId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a member" />
              </SelectTrigger>
              <SelectContent>
                {allMembers.map((m) => (
                  <SelectItem key={m._id} value={m._id}>
                    <span className="flex items-center gap-1.5">
                      {leaderIds.has(m._id) && (
                        <Crown className="h-3 w-3 text-yellow-400 shrink-0" />
                      )}
                      {m.name}
                      {leaderIds.has(m._id) && (
                        <span className="text-xs text-yellow-500/80">(Leader)</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkAssignOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!bulkMemberId || bulkAssignMutation.isPending}
              onClick={() => {
                if (!bulkMemberId) return;
                bulkAssignMutation.mutate(
                  { leadIds: Array.from(selectedIds), memberId: bulkMemberId },
                  { onSuccess: () => { setBulkAssignOpen(false); setSelectedIds(new Set()); setBulkMemberId(""); } },
                );
              }}
            >
              {bulkAssignMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Assign
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Bulk: Transfer ────────────────────────────────────────────────────── */}
      <ResponsiveDialog open={bulkTransferOpen} onOpenChange={setBulkTransferOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Transfer Leads
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Transferring{" "}
              <span className="font-semibold text-foreground">{selectedIds.size}</span> lead(s) to another team.
              Current member assignment will be cleared.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="px-4 sm:px-0 py-2 space-y-3">
            <Select value={bulkNewTeamId} onValueChange={setBulkNewTeamId}>
              <SelectTrigger>
                <SelectValue placeholder="Select target team" />
              </SelectTrigger>
              <SelectContent>
                {otherTeams.map((t: Team) => (
                  <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkTransferOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!bulkNewTeamId || bulkTransferMutation.isPending}
              onClick={() => {
                if (!bulkNewTeamId) return;
                bulkTransferMutation.mutate(
                  { leadIds: Array.from(selectedIds), newTeamId: bulkNewTeamId },
                  { onSuccess: () => { setBulkTransferOpen(false); setSelectedIds(new Set()); setBulkNewTeamId(""); } },
                );
              }}
            >
              {bulkTransferMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Transfer
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Bulk: Change Status ───────────────────────────────────────────────── */}
      <ResponsiveDialog open={bulkStatusOpen} onOpenChange={setBulkStatusOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex items-center gap-2">
              <Tags className="h-4 w-4 text-primary" />
              Change Status
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Updating status for{" "}
              <span className="font-semibold text-foreground">{selectedIds.size}</span> lead(s)
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="px-4 sm:px-0 py-2 space-y-3">
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STATUS_CONFIG) as LeadStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkStatusOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={bulkStatusMutation.isPending}
              onClick={() => {
                bulkStatusMutation.mutate(
                  { leadIds: Array.from(selectedIds), status: bulkStatus },
                  { onSuccess: () => { setBulkStatusOpen(false); setSelectedIds(new Set()); } },
                );
              }}
            >
              {bulkStatusMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Apply
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Floating Bulk Action Bar ──────────────────────────────────────────── */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="fixed bottom-4 sm:bottom-6 sm:left-1/2 z-50 -translate-x-1/2 w-[calc(100vw-2rem)] sm:w-auto max-w-lg"
          >
            <div className="flex items-center gap-1 sm:gap-2 rounded-2xl border border-border/60 bg-card/95 backdrop-blur-md shadow-2xl px-3 sm:px-4 py-2.5 sm:py-3">
              <div className="flex items-center gap-1.5 pr-2.5 sm:pr-3 border-r border-border shrink-0">
                <CheckSquare className="h-4 w-4 text-primary" />
                <span className="text-xs sm:text-sm font-semibold whitespace-nowrap">
                  {selectedIds.size}
                  <span className="hidden sm:inline"> selected</span>
                </span>
              </div>
              {/* Assign to member */}
              {isLeaderOrAdmin && (
                <Button
                  variant="ghost" size="sm"
                  className="gap-1 sm:gap-1.5 h-8 text-xs px-2 sm:px-3 hover:bg-muted"
                  onClick={() => setBulkAssignOpen(true)}
                >
                  <UserCheck className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Assign</span>
                </Button>
              )}
              {/* Change status */}
              <Button
                variant="ghost" size="sm"
                className="gap-1 sm:gap-1.5 h-8 text-xs px-2 sm:px-3 hover:bg-muted"
                onClick={() => setBulkStatusOpen(true)}
              >
                <Tags className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">Status</span>
              </Button>
              {/* Transfer */}
              {isLeaderOrAdmin && (
                <Button
                  variant="ghost" size="sm"
                  className="gap-1 sm:gap-1.5 h-8 text-xs px-2 sm:px-3 hover:bg-muted"
                  onClick={() => setBulkTransferOpen(true)}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Transfer</span>
                </Button>
              )}
              {/* Clear */}
              <div className="pl-2 border-l border-border">
                <Button
                  variant="ghost" size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Logs Tab ─────────────────────────────────────────────────────────────────

function LogsTab({ teamId }: { teamId: string }) {
  const [page, setPage] = useState(1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: logsResult, isLoading, isFetching } = (useTeamLogs as any)(teamId, page) as {
    data: { data: TeamLog[]; pagination: { total: number; page: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean; limit: number } } | undefined;
    isLoading: boolean;
    isFetching: boolean;
  };

  const logs = logsResult?.data ?? [];
  const pagination = logsResult?.pagination;

  return (
    <div className="space-y-4">
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Team Activity Logs
            {pagination && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {pagination.total}
              </span>
            )}
            {isFetching && !isLoading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-0 divide-y divide-border/50">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                  <div className="h-8 w-8 rounded-full bg-muted shrink-0 mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-40 rounded bg-muted" />
                    <div className="h-2.5 w-64 rounded bg-muted" />
                    <div className="h-2 w-20 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="py-16 text-center">
              <Activity className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No activity logs yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              <AnimatePresence mode="wait">
                {logs.map((log: TeamLog, i: number) => {
                  const cfg = LOG_ACTION_CONFIG[log.action] ?? DEFAULT_LOG_CONFIG;
                  const Icon = cfg.icon;
                  const performedBy =
                    typeof log.performedBy === "object"
                      ? log.performedBy.name
                      : log.performedBy ?? "System";

                  return (
                    <motion.div
                      key={log._id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 8 }}
                      transition={{ delay: i * 0.03 }}
                      className="flex items-start gap-3 px-4 py-4 hover:bg-muted/20 transition-colors"
                    >
                      <div
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${cfg.bg}`}
                      >
                        <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-medium text-foreground">
                            {performedBy}
                          </span>
                          {log.leadName && (
                            <>
                              <span className="text-xs text-muted-foreground">on lead</span>
                              {log.leadId ? (
                                <Link
                                  href={`/leads/${log.leadId}`}
                                  className="text-xs font-medium text-primary hover:underline"
                                >
                                  {log.leadName}
                                </Link>
                              ) : (
                                <span className="text-xs font-medium text-foreground">
                                  {log.leadName}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {log.description}
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 mt-1">
                          {timeAgo(log.createdAt)}
                        </p>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border px-4 sm:px-6 py-4">
              <p className="text-sm text-muted-foreground text-center sm:text-left">
                Page{" "}
                <span className="font-medium text-foreground">{pagination.page}</span> of{" "}
                <span className="font-medium text-foreground">{pagination.totalPages}</span>
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline" size="sm" className="gap-1"
                  disabled={!pagination.hasPrevPage || isFetching}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">Prev</span>
                </Button>
                <span className="text-sm font-medium px-1 tabular-nums">
                  {pagination.page} / {pagination.totalPages}
                </span>
                <Button
                  variant="outline" size="sm" className="gap-1"
                  disabled={!pagination.hasNextPage || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Revenue Tab ─────────────────────────────────────────────────────────────

function TeamRevenueTab({ teamId }: { teamId: string }) {
  const [quickPeriod, setQuickPeriod] = useState<RevQuickPeriod>("month");
  const [customFrom,  setCustomFrom]  = useState("");
  const [customTo,    setCustomTo]    = useState("");
  const [revPeriod,   setRevPeriod]   = useState<RevenuePeriod>("monthly");
  const [expandedMember, setExpandedMember] = useState<string | null>(null);

  const { from: dateFrom, to: dateTo } = useMemo(() => {
    if (quickPeriod === "custom") return { from: customFrom, to: customTo };
    return getRevRange(quickPeriod) as { from: string; to: string };
  }, [quickPeriod, customFrom, customTo]);

  const overview = useTeamRevenue(teamId, dateFrom, dateTo);
  const timeline = useTeamRevenueTimeline(teamId, revPeriod, dateFrom, dateTo);

  const ovData     = overview.data;
  const tlData     = timeline.data;
  const tlMembers  = tlData?.members  ?? [];
  const tlTimeline = tlData?.timeline ?? [];

  const quickBtns: { id: RevQuickPeriod; label: string }[] = [
    { id: "today",   label: "Today"   },
    { id: "week",    label: "Week"    },
    { id: "month",   label: "Month"   },
    { id: "quarter", label: "Quarter" },
    { id: "year",    label: "Year"    },
    { id: "custom",  label: "Custom"  },
  ];

  const periodBtns: { id: RevenuePeriod; label: string }[] = [
    { id: "daily",   label: "D" },
    { id: "weekly",  label: "W" },
    { id: "monthly", label: "M" },
    { id: "yearly",  label: "Y" },
  ];

  return (
    <div className="space-y-5">

      {/* ── Date Filter ────────────────────────────────────────────────────── */}
      <Card className="border-border/50 bg-card/60">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {quickBtns.map((b) => (
              <button
                key={b.id}
                onClick={() => setQuickPeriod(b.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
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
        </CardContent>
      </Card>

      {/* ── KPI Cards ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Total Received */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0 }}>
          <Card className="relative overflow-hidden border-border/50 bg-card/80 hover:shadow-lg transition-shadow">
            <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-emerald-500 to-emerald-600" />
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <p className="flex-1 min-w-0 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Total Received</p>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ml-2 bg-gradient-to-br from-emerald-500 to-emerald-600">
                  <DollarSign className="h-4 w-4 text-white" />
                </div>
              </div>
              {overview.isLoading
                ? <div className="h-7 w-20 rounded-lg bg-muted/50 animate-pulse mt-1" />
                : <MoneyFigure value={fmtUSD(ovData?.totalRevenue ?? 0)} />
              }
              {!overview.isLoading && <p className="text-xs text-muted-foreground">{ovData?.paymentCount ?? 0} payments</p>}
            </CardContent>
          </Card>
        </motion.div>

        {/* Total Pending */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.06 }}>
          <Card className="relative overflow-hidden border-border/50 bg-card/80 hover:shadow-lg transition-shadow">
            <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-amber-500 to-amber-600" />
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <p className="flex-1 min-w-0 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Total Pending</p>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ml-2 bg-gradient-to-br from-amber-500 to-amber-600">
                  <TrendingUp className="h-4 w-4 text-white" />
                </div>
              </div>
              {overview.isLoading
                ? <div className="h-7 w-20 rounded-lg bg-muted/50 animate-pulse mt-1" />
                : <MoneyFigure value={fmtUSD(ovData?.totalPending ?? 0)} />
              }
              {!overview.isLoading && <p className="text-xs text-muted-foreground">outstanding balance</p>}
            </CardContent>
          </Card>
        </motion.div>

        {/* Top Earner */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.12 }}>
          <Card className="relative overflow-hidden border-border/50 bg-card/80 hover:shadow-lg transition-shadow">
            <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-yellow-500 to-yellow-600" />
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1 min-w-0">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Top Earner</p>
                  {overview.isLoading
                    ? <div className="h-7 w-24 rounded-lg bg-muted/50 animate-pulse mt-1" />
                    : <p className="text-xl font-bold text-foreground truncate">{ovData?.topMember?.name ?? "—"}</p>
                  }
                  {!overview.isLoading && ovData?.topMember && (
                    <p className="text-xs text-muted-foreground">{fullUSD(ovData.topMember.revenue)}</p>
                  )}
                </div>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ml-2 bg-gradient-to-br from-yellow-500 to-yellow-600">
                  <Trophy className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Avg per Lead */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.18 }}>
          <Card className="relative overflow-hidden border-border/50 bg-card/80 hover:shadow-lg transition-shadow">
            <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-blue-500 to-blue-600" />
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <p className="flex-1 min-w-0 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Avg per Lead</p>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ml-2 bg-gradient-to-br from-blue-500 to-blue-600">
                  <TrendingUp className="h-4 w-4 text-white" />
                </div>
              </div>
              {overview.isLoading
                ? <div className="h-7 w-20 rounded-lg bg-muted/50 animate-pulse mt-1" />
                : <MoneyFigure value={fmtUSD(ovData?.avgRevenuePerLead ?? 0)} />
              }
              {!overview.isLoading && <p className="text-xs text-muted-foreground">{ovData?.payingLeadCount ?? 0} paying leads</p>}
            </CardContent>
          </Card>
        </motion.div>

        {/* Total Payments */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.18 }} className="col-span-2 lg:col-span-1">
          <Card className="relative overflow-hidden border-border/50 bg-card/80 hover:shadow-lg transition-shadow">
            <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-violet-500 to-violet-600" />
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1 min-w-0">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Payments</p>
                  {overview.isLoading
                    ? <div className="h-7 w-16 rounded-lg bg-muted/50 animate-pulse mt-1" />
                    : <p className="text-2xl font-bold text-foreground tabular-nums">{ovData?.paymentCount ?? 0}</p>
                  }
                  {!overview.isLoading && <p className="text-xs text-muted-foreground">{ovData?.payingLeadCount ?? 0} leads paid</p>}
                </div>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ml-2 bg-gradient-to-br from-violet-500 to-violet-600">
                  <Award className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ── Revenue Timeline Chart ──────────────────────────────────────────── */}
      <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.24 }}>
        <Card className="border-border/50 bg-card/80">
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
              <div className="h-[260px] w-full animate-pulse rounded-lg bg-muted/50" />
            ) : tlTimeline.length === 0 ? (
              <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <DollarSign className="h-8 w-8 opacity-20" />
                No revenue data for this period
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={tlTimeline} margin={{ top:5, right:10, left:10, bottom:0 }}>
                  <defs>
                    {(tlMembers.length > 0 ? tlMembers : ["Total"]).map((m, i) => (
                      <linearGradient key={m} id={`trg-${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={MEMBER_PALETTE[i % MEMBER_PALETTE.length]} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={MEMBER_PALETTE[i % MEMBER_PALETTE.length]} stopOpacity={0.02} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis dataKey="label" tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize:10, fill:"hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtCompact(v)} width={58} />
                  <RechartsTooltip content={<RevTooltip />} />
                  {tlMembers.length > 1 && (
                    <Legend wrapperStyle={{ fontSize:"11px", paddingTop:"8px" }} formatter={(v) => <span style={{ color:"hsl(var(--foreground))" }}>{v}</span>} />
                  )}
                  {tlMembers.length === 0 ? (
                    <Area type="monotone" dataKey="total" name="Total Revenue" stroke={MEMBER_PALETTE[0]} strokeWidth={2} fill="url(#trg-0)" dot={false} activeDot={{ r:4, strokeWidth:0 }} />
                  ) : tlMembers.map((m, i) => (
                    <Area key={m} type="monotone" dataKey={m} name={m} stroke={MEMBER_PALETTE[i % MEMBER_PALETTE.length]} strokeWidth={2} fill={`url(#trg-${i})`} dot={false} activeDot={{ r:4, strokeWidth:0 }} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Member Revenue Breakdown + Top 3 ──────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* Member Rankings */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.3 }}>
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" /> Member Revenue
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {overview.isLoading ? (
                <div className="space-y-3">
                  {[1,2,3].map((i) => <div key={i} className="h-16 rounded-xl bg-muted/50 animate-pulse" />)}
                </div>
              ) : !(ovData?.memberBreakdown?.length) ? (
                <div className="flex h-[160px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <DollarSign className="h-8 w-8 opacity-20" />
                  No member revenue data
                </div>
              ) : (
                <div className="space-y-2">
                  {ovData!.memberBreakdown.map((m: TeamRevenueMember, i: number) => {
                    const color    = MEMBER_PALETTE[i % MEMBER_PALETTE.length];
                    const maxRev   = ovData!.memberBreakdown[0]?.revenue ?? 1;
                    const barPct   = maxRev > 0 ? (m.revenue / maxRev) * 100 : 0;
                    const isExpanded = expandedMember === String(m.userId);
                    return (
                      <motion.div key={String(m.userId)} initial={{ opacity:0, x:-10 }} animate={{ opacity:1, x:0 }} transition={{ delay:0.04*i }}>
                        <button
                          onClick={() => setExpandedMember(isExpanded ? null : String(m.userId))}
                          className="w-full text-left rounded-xl border border-border/50 p-3 hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            {/* Rank */}
                            <span className="shrink-0">
                              {i === 0 ? <span className="text-base">🥇</span>
                               : i === 1 ? <span className="text-base">🥈</span>
                               : i === 2 ? <span className="text-base">🥉</span>
                               : <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">{m.rank}</span>}
                            </span>
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white text-xs font-bold" style={{ background: color }}>
                              {m.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-foreground truncate max-w-[140px]">{m.name}</p>
                                  {m.designation && <p className="text-[10px] text-muted-foreground truncate">{m.designation}</p>}
                                </div>
                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                  <span className="text-xs font-bold text-emerald-500 tabular-nums">{fullUSD(m.revenue)}</span>
                                  {(m.pendingAmount ?? 0) > 0 && (
                                    <span className="text-[10px] font-medium text-amber-500 tabular-nums">{fullUSD(m.pendingAmount ?? 0)} due</span>
                                  )}
                                  {isExpanded
                                    ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                                    : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                  }
                                </div>
                              </div>
                              <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                                <motion.div className="h-full rounded-full" style={{ background: color }}
                                  initial={{ width: 0 }} animate={{ width: `${barPct}%` }}
                                  transition={{ delay: 0.1 + 0.04*i, duration: 0.5, ease: "easeOut" }} />
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                                {m.paymentCount} payments · {m.leadCount} leads · {m.pct}% of total
                              </p>
                            </div>
                          </div>
                        </button>

                        {/* Expanded detail */}
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-1 ml-4 pl-3 border-l-2 border-border/40 py-2 space-y-1.5">
                                <div className="grid grid-cols-3 gap-2 text-center">
                                  <div className="rounded-lg bg-muted/30 p-2">
                                    <p className="text-sm font-bold text-emerald-500 tabular-nums">{fullUSD(m.revenue)}</p>
                                    <p className="text-[10px] text-muted-foreground">Total Revenue</p>
                                  </div>
                                  <div className="rounded-lg bg-muted/30 p-2">
                                    <p className="text-sm font-bold text-foreground tabular-nums">{m.paymentCount}</p>
                                    <p className="text-[10px] text-muted-foreground">Payments</p>
                                  </div>
                                  <div className="rounded-lg bg-muted/30 p-2">
                                    <p className="text-sm font-bold text-foreground tabular-nums">{m.leadCount}</p>
                                    <p className="text-[10px] text-muted-foreground">Leads</p>
                                  </div>
                                </div>
                                <p className="text-[10px] text-muted-foreground text-center">
                                  Avg per lead: <span className="font-semibold text-foreground">{m.leadCount > 0 ? fullUSD(Math.round(m.revenue / m.leadCount)) : "—"}</span>
                                </p>
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

        {/* Top 3 Podium */}
        <motion.div initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.36 }}>
          <Card className="border-border/50 bg-card/80">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Trophy className="h-4 w-4 text-yellow-500" /> Top Revenue Earners
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {overview.isLoading ? (
                <div className="space-y-3">
                  {[1,2,3].map((i) => <div key={i} className="h-20 rounded-xl bg-muted/50 animate-pulse" />)}
                </div>
              ) : !(ovData?.memberBreakdown?.length) ? (
                <div className="flex h-[160px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Trophy className="h-8 w-8 opacity-20" />
                  No earners data
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {ovData!.memberBreakdown.slice(0, 3).map((m: TeamRevenueMember, i: number) => {
                    const podiumGrads = [
                      "from-yellow-500/10 to-yellow-500/5 border-yellow-500/20",
                      "from-neutral-400/10 to-neutral-400/5 border-neutral-400/20",
                      "from-orange-700/10 to-orange-700/5 border-orange-700/20",
                    ];
                    return (
                      <motion.div
                        key={String(m.userId)}
                        initial={{ opacity:0, scale:0.95 }}
                        animate={{ opacity:1, scale:1 }}
                        transition={{ delay:0.08*i }}
                        className={cn("rounded-xl border bg-gradient-to-br p-4 text-center", podiumGrads[i])}
                      >
                        <div className="text-3xl mb-1">{["🥇","🥈","🥉"][i]}</div>
                        <div className="flex h-10 w-10 mx-auto items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-base uppercase mb-1.5">
                          {m.name.charAt(0)}
                        </div>
                        <p className="font-bold text-foreground text-sm truncate">{m.name}</p>
                        {m.designation && <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{m.designation}</p>}
                        <div className="mt-3 grid grid-cols-2 gap-1.5 text-center">
                          <div>
                            <p className="text-sm font-bold text-emerald-500 tabular-nums">{fmtUSD(m.revenue)}</p>
                            <p className="text-[10px] text-muted-foreground">Revenue</p>
                          </div>
                          <div>
                            <p className="text-sm font-bold text-foreground tabular-nums">{m.paymentCount}</p>
                            <p className="text-[10px] text-muted-foreground">Payments</p>
                          </div>
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

    </div>
  );
}

// ─── Updates Tab ──────────────────────────────────────────────────────────────

const ACTION_META: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  lead_created:   { icon: Zap,         color: "text-blue-400",   bg: "bg-blue-500/15"   },
  lead_updated:   { icon: FileEdit,    color: "text-yellow-400", bg: "bg-yellow-500/15" },
  status_changed: { icon: ArrowUpDown, color: "text-violet-400", bg: "bg-violet-500/15" },
  lead_assigned:  { icon: UserCheck2,  color: "text-teal-400",   bg: "bg-teal-500/15"   },
  team_assigned:  { icon: GitMerge,    color: "text-orange-400", bg: "bg-orange-500/15" },
  note_added:     { icon: StickyNote,  color: "text-green-400",  bg: "bg-green-500/15"  },
  note_updated:   { icon: FileEdit,    color: "text-amber-400",  bg: "bg-amber-500/15"  },
  note_deleted:   { icon: Trash2,      color: "text-red-400",    bg: "bg-red-500/15"    },
};

// function timeAgo(iso: string) {
//   const diff = Date.now() - new Date(iso).getTime();
//   const m = Math.floor(diff / 60_000);
//   if (m < 1)  return "just now";
//   if (m < 60) return `${m}m ago`;
//   const h = Math.floor(m / 60);
//   if (h < 24) return `${h}h ago`;
//   const d = Math.floor(h / 24);
//   if (d < 7)  return `${d}d ago`;
//   return formatDate(iso);
// }

// ── Date helpers ──────────────────────────────────────────────────────────────
function todayISO() {
  return toGstDateISO(new Date());
}
function weekStartISO() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return toGstDateISO(d);
}
function monthStartISO() {
  const d = new Date();
  d.setDate(1);
  return toGstDateISO(d);
}

type DatePreset = "today" | "week" | "month" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  today:  "Today",
  week:   "This Week",
  month:  "This Month",
  custom: "Custom",
};

const ACTION_FILTERS = [
  { key: "all",         label: "All",         icon: Activity  },
  { key: "notes",       label: "Notes",       icon: StickyNote },
  { key: "status",      label: "Status",      icon: ArrowUpDown },
  { key: "assignments", label: "Assigned",    icon: UserCheck2  },
  { key: "messages",    label: "Messages",    icon: MessageCircle },
  { key: "created",     label: "Created",     icon: Zap         },
] as const;

function UpdatesTab({
  teamId,
  currentUserId,
  team,
}: {
  teamId: string;
  currentUserId: string;
  team: Team | undefined;
}) {
  // ── Filter state ─────────────────────────────────────────────────────────
  const [preset,      setPreset]      = useState<DatePreset>("today");
  const [customFrom,  setCustomFrom]  = useState("");
  const [customTo,    setCustomTo]    = useState(todayISO());
  const [memberId,    setMemberId]    = useState("all");
  const [actionType,  setActionType]  = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search,      setSearch]      = useState("");
  const [page,        setPage]        = useState(1);
  const [message,     setMessage]     = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Derive dateFrom / dateTo from preset
  const dateFrom = preset === "today"  ? todayISO()
                 : preset === "week"   ? weekStartISO()
                 : preset === "month"  ? monthStartISO()
                 : preset === "custom" ? (customFrom || undefined)
                 : undefined;
  const dateTo   = preset === "custom" ? (customTo || todayISO()) : todayISO();

  const filters: TeamUpdatesFilters = {
    page,
    dateFrom,
    dateTo,
    memberId:  memberId  !== "all" ? memberId  : undefined,
    action:    actionType !== "all" ? actionType : undefined,
    search:    search || undefined,
  };

  // Real-time socket connection — auto-prepends new items to the feed
  useTeamSocket(teamId);

  const { data, isLoading, isFetching, refetch } = useTeamUpdates(teamId, filters);
  const { mutate: sendMessage, isPending: sending } = usePostTeamMessage(teamId);

  const items      = data?.data       ?? [];
  const pagination = data?.pagination;

  // Team members list (leaders + members) for the member filter dropdown
  const allMembers: { _id: string; name: string }[] = [
    ...(team?.leaders ?? []).map((u: User) => ({ _id: u._id, name: u.name })),
    ...(team?.members ?? []).map((u: User) => ({ _id: u._id, name: u.name })),
  ];

  function resetPage() { setPage(1); }

  function handlePreset(p: DatePreset) {
    setPreset(p);
    if (p !== "custom") { setCustomFrom(""); setCustomTo(todayISO()); }
    resetPage();
  }

  function handleSend() {
    const text = message.trim();
    if (!text || sending) return;
    sendMessage(text, {
      onSuccess: () => {
        setMessage("");
        resetPage();
        setTimeout(() => inputRef.current?.focus(), 50);
      },
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  // Count active non-default filters for badge
  const activeFilterCount = [
    memberId  !== "all",
    actionType !== "all",
    !!search,
    preset    !== "today",
  ].filter(Boolean).length;

  return (
    <div className="flex flex-col gap-4">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-sm text-foreground">Team Updates</span>
          {/* Live indicator */}
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
            </span>
            Live
          </span>
          {pagination && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {pagination.total}
            </span>
          )}
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary/15 border border-primary/30 px-2 py-0.5 text-xs font-medium text-primary">
              {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* ── Filters Card ────────────────────────────────────────────────────── */}
      <Card className="border-border/50 bg-card/60">
        <CardContent className="p-4 space-y-3">

          {/* Row 1: Date presets */}
          <div className="flex items-center gap-2 flex-wrap">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5 min-w-0">
              {(Object.keys(PRESET_LABELS) as DatePreset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handlePreset(p)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border transition-all ${
                    preset === p
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/40 border-border/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Custom date pickers */}
          <AnimatePresence>
            {preset === "custom" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 pt-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground w-7">From</span>
                    <Input
                      type="date"
                      value={customFrom}
                      max={customTo || todayISO()}
                      onChange={(e) => { setCustomFrom(e.target.value); resetPage(); }}
                      className="h-7 text-xs w-36"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground w-5">To</span>
                    <Input
                      type="date"
                      value={customTo}
                      min={customFrom}
                      max={todayISO()}
                      onChange={(e) => { setCustomTo(e.target.value); resetPage(); }}
                      className="h-7 text-xs w-36"
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Row 2: Search + Member + Action type */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* Search */}
            <div className="flex items-center gap-1 flex-1 min-w-[180px]">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { setSearch(searchInput); resetPage(); }
                  }}
                  placeholder="Search notes, leads…"
                  className="pl-8 h-8 text-xs"
                />
              </div>
              {searchInput !== search && (
                <Button
                  variant="outline" size="sm" className="h-8 px-2.5 text-xs shrink-0"
                  onClick={() => { setSearch(searchInput); resetPage(); }}
                >
                  Go
                </Button>
              )}
              {search && (
                <button
                  type="button"
                  onClick={() => { setSearch(""); setSearchInput(""); resetPage(); }}
                  className="rounded-full p-1 hover:bg-muted transition-colors"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>

            {/* Member filter */}
            <Select
              value={memberId}
              onValueChange={(v) => { setMemberId(v); resetPage(); }}
            >
              <SelectTrigger className="h-8 w-full sm:w-[160px] text-xs">
                <SelectValue placeholder="All Members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All Members</SelectItem>
                {allMembers.map((m) => (
                  <SelectItem key={m._id} value={m._id} className="text-xs">{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Row 3: Action type pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
            {ACTION_FILTERS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => { setActionType(key); resetPage(); }}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all ${
                  actionType === key
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-muted/30 border-border/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>

        </CardContent>
      </Card>

      {/* ── Message Composer ────────────────────────────────────────────────── */}
      <Card className="border-border/60 bg-card/80">
        <CardContent className="p-3 flex gap-3 items-end">
          <div className="flex-1">
            <textarea
              ref={inputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write a message to your team… (Enter to send, Shift+Enter for new line)"
              rows={2}
              maxLength={1000}
              className="w-full resize-none rounded-lg bg-muted/40 border border-border/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-all"
            />
            <div className="flex justify-end mt-1">
              <span className="text-[10px] text-muted-foreground/60">{message.length}/1000</span>
            </div>
          </div>
          <Button
            size="sm" onClick={handleSend}
            disabled={!message.trim() || sending}
            className="gap-2 shrink-0 self-end mb-[22px]"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send
          </Button>
        </CardContent>
      </Card>

      {/* ── Feed ────────────────────────────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="rounded-full bg-muted/50 p-4">
                <MessageCircle className="h-8 w-8 text-muted-foreground/40" />
              </div>
              <p className="text-muted-foreground text-sm">No updates found</p>
              <p className="text-muted-foreground/60 text-xs">
                {activeFilterCount > 0 ? "Try adjusting your filters" : "Be the first to send a message"}
              </p>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setPreset("today"); setMemberId("all"); setActionType("all");
                    setSearch(""); setSearchInput(""); resetPage();
                  }}
                  className="text-xs text-primary hover:underline"
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={`${page}-${dateFrom}-${dateTo}-${memberId}-${actionType}-${search}`}
                className="divide-y divide-border/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.15 }}
              >
                {items.map((item) => (
                  <motion.div
                    key={item._id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    {item.type === "message" ? (
                      <MessageBubble
                        item={item as TeamMessageItem}
                        isSelf={(item as TeamMessageItem).author?._id === currentUserId}
                      />
                    ) : (
                      <ActivityRow item={item as TeamActivityItem} />
                    )}
                  </motion.div>
                ))}
              </motion.div>
            </AnimatePresence>
          )}

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border/50 px-5 py-3">
              <p className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline" size="sm" className="h-7 gap-1 text-xs"
                  disabled={!pagination.hasPrevPage || isFetching}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Newer
                </Button>
                <Button
                  variant="outline" size="sm" className="h-7 gap-1 text-xs"
                  disabled={!pagination.hasNextPage || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Older <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MessageBubble({ item, isSelf }: { item: TeamMessageItem; isSelf: boolean }) {
  const author = item.author;
  const initials = author?.name
    ? author.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  return (
    <div className={`flex gap-3 px-4 py-3.5 hover:bg-muted/20 transition-colors ${isSelf ? "flex-row-reverse" : ""}`}>
      <Avatar className="h-8 w-8 shrink-0 mt-0.5">
        <AvatarFallback className={`text-[10px] font-semibold ${isSelf ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
          {initials}
        </AvatarFallback>
      </Avatar>

      <div className={`flex flex-col max-w-[85%] sm:max-w-[72%] gap-1 ${isSelf ? "items-end" : "items-start"}`}>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground">{author?.name ?? "Unknown"}</span>
          {author?.designation && (
            <span className="text-[10px] text-muted-foreground/70">{author.designation}</span>
          )}
          <span className="text-[10px] text-muted-foreground/50">{timeAgo(item.createdAt)}</span>
        </div>
        <div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words ${
          isSelf
            ? "bg-primary text-primary-foreground rounded-tr-sm"
            : "bg-muted/60 text-foreground rounded-tl-sm border border-border/40"
        }`}>
          {item.content}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ item }: { item: TeamActivityItem }) {
  const meta = ACTION_META[item.action] ?? { icon: Activity, color: "text-muted-foreground", bg: "bg-muted/30" };
  const Icon = meta.icon;
  const performer = typeof item.performedBy === "object" && item.performedBy !== null
    ? item.performedBy
    : null;

  const isNote = item.action === "note_added" || item.action === "note_updated";
  const noteContent = isNote
    ? (item.changes?.note?.to as string | undefined) ?? null
    : null;

  if (isNote && noteContent) {
    return (
      <div className="flex gap-3 px-4 py-3.5 hover:bg-muted/10 transition-colors">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-1">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-[10px] font-semibold bg-green-500/15 text-green-400">
              {performer?.name
                ? performer.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
                : "?"}
            </AvatarFallback>
          </Avatar>
          <div className="w-px flex-1 bg-border/30 min-h-[8px]" />
        </div>

        <div className="flex-1 min-w-0 pb-1">
          {/* Header row */}
          <div className="flex items-start justify-between gap-2 flex-wrap mb-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className={`flex h-5 w-5 items-center justify-center rounded-full ${meta.bg}`}>
                <Icon className={`h-3 w-3 ${meta.color}`} />
              </div>
              <span className="text-xs font-medium text-muted-foreground">
                {item.action === "note_updated" ? "Note updated" : "Note added"}
              </span>
              {item.leadName && (
                <>
                  <span className="text-[10px] text-muted-foreground/40">on</span>
                  <Link
                    href={`/leads/${item.leadId}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {item.leadName}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </Link>
                </>
              )}
              {performer && (
                <>
                  <span className="text-[10px] text-muted-foreground/40">by</span>
                  <span className="text-xs font-semibold text-foreground">{performer.name}</span>
                </>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/50 shrink-0">{timeAgo(item.createdAt)}</span>
          </div>

          {/* Note bubble */}
          <div className="rounded-2xl rounded-tl-sm bg-green-500/10 border border-green-500/20 px-3.5 py-2.5 text-sm text-foreground leading-relaxed break-words">
            {noteContent}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 px-4 py-3 hover:bg-muted/10 transition-colors">
      {/* Timeline dot */}
      <div className="flex flex-col items-center pt-0.5">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.bg}`}>
          <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
        </div>
        <div className="mt-1 w-px flex-1 bg-border/40 min-h-[8px]" />
      </div>

      <div className="flex-1 min-w-0 pb-1">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm text-foreground leading-snug">{item.description}</p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {item.leadName && (
                <Link
                  href={`/leads/${item.leadId}`}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {item.leadName}
                </Link>
              )}
              {performer && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <span className="text-muted-foreground/40">by</span>
                  <span className="font-medium text-muted-foreground">{performer.name}</span>
                </span>
              )}
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 mt-0.5">
            {timeAgo(item.createdAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Report Tab ───────────────────────────────────────────────────────────────

type ReportPeriod = "today" | "week" | "month" | "year" | "custom";

/** "YYYY-MM-DD" moved by whole days — arithmetic on the date itself, no time zone involved. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The period as Dubai (GST) days whatever the viewer's own time zone; the API reads them as Dubai days too.
 * Taken from the browser's calendar, the month began a day early for anyone east of Dubai.
 */
function getReportRange(p: ReportPeriod): { from: string; to: string } {
  const today = toGstDateISO(new Date());
  switch (p) {
    case "today": return { from: today, to: today };
    case "week": {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      return { from: shiftDay(today, -((weekday + 6) % 7)), to: today }; // back to Monday
    }
    case "month": return { from: `${today.slice(0, 8)}01`, to: today };
    case "year":  return { from: `${today.slice(0, 5)}01-01`, to: today };
    default: return { from: "", to: "" };
  }
}

const REPORT_PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week",  label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year",  label: "This Year" },
  { value: "custom", label: "Custom Range" },
];

/** One column per lead status, with the names and colours the Leads page uses. */
const STATUS_COLS = LEAD_STATUSES.map((key) => ({ key, label: SM[key].label, color: SM[key].text }));

/** Leads in a row's total that no status column counts: a status this list doesn't know, or one the API didn't send. */
function otherCount(m: TeamMemberSplitItem): number {
  return Math.max(0, m.total - LEAD_STATUSES.reduce((sum, s) => sum + (m[s] ?? 0), 0));
}

function ReportTab({ teamId }: { teamId: string }) {
  const [period, setPeriod]   = useState<ReportPeriod>("month");
  const [customFrom, setFrom] = useState("");
  const [customTo, setTo]     = useState("");

  const range = period === "custom"
    ? { from: customFrom, to: customTo }
    : getReportRange(period);

  const enabled = period !== "custom" || (!!customFrom && !!customTo);
  const { data, isLoading } = useTeamMemberSplit(
    teamId,
    enabled ? range.from : "",
    enabled ? range.to   : "",
  );

  const totalLeads  = data?.reduce((s, m) => s + m.total, 0) ?? 0;
  const totalClosed = data?.reduce((s, m) => s + (m.closed ?? 0), 0) ?? 0;
  const totalOther  = data?.reduce((s, m) => s + otherCount(m), 0) ?? 0;
  const showOther   = totalOther > 0;

  return (
    <div className="space-y-4">
      {/* Header + Period Filter */}
      <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Member Lead Split
            </CardTitle>

            {/* Period Dropdown */}
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={period} onValueChange={(v) => { setPeriod(v as ReportPeriod); }}>
                <SelectTrigger className="h-8 w-36 text-xs border-border/50">
                  <CalendarDays className="h-3.5 w-3.5 text-muted-foreground mr-1.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_PERIODS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-xs">
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Custom date inputs */}
          <AnimatePresence>
            {period === "custom" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 pt-2">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setFrom(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs [color-scheme:dark] flex-1"
                  />
                  <span className="text-xs text-muted-foreground shrink-0">to</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setTo(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 text-xs [color-scheme:dark] flex-1"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CardHeader>

        {/* Summary KPI strip */}
        {!isLoading && !!data?.length && (
          <CardContent className="pt-0 pb-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1 rounded-xl border border-blue-500/20 bg-blue-500/8 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">Members</p>
                <p className="text-xl font-bold text-blue-400 tabular-nums">{data.length}</p>
              </div>
              <div className="flex flex-col gap-1 rounded-xl border border-primary/20 bg-primary/8 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">Total Leads</p>
                <p className="text-xl font-bold text-primary tabular-nums">{totalLeads}</p>
              </div>
              <div className="flex flex-col gap-1 rounded-xl border border-green-500/20 bg-green-500/8 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">Total Closed</p>
                <p className="text-xl font-bold text-green-400 tabular-nums">{totalClosed}</p>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Member Table */}
      <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map((i) => (
                <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-muted/40" />
              ))}
            </div>
          ) : !data?.length ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <BarChart3 className="h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">No leads found for this period</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-2 px-2">
              <table className="w-full text-xs" style={{ minWidth: "900px" }}>
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="pb-2.5 text-left font-medium text-muted-foreground w-8">#</th>
                    <th className="pb-2.5 text-left font-medium text-muted-foreground pr-4 min-w-[140px]">Member</th>
                    <th className="pb-2.5 text-right font-semibold text-foreground pr-3">Total</th>
                    {STATUS_COLS.map((c) => (
                      <th key={c.key} className={`pb-2.5 text-right font-medium pr-3 ${c.color}`}>{c.label}</th>
                    ))}
                    {showOther && (
                      <th
                        className="pb-2.5 text-right font-medium pr-3 text-muted-foreground"
                        title="Leads whose status has no column here"
                      >
                        Other
                      </th>
                    )}
                    <th className="pb-2.5 text-right font-medium text-muted-foreground">Conv%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {data.map((m, idx) => (
                    <motion.tr
                      key={m.userId}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.04 * idx, duration: 0.2 }}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      {/* Rank */}
                      <td className="py-3 pr-2">
                        {m.rank === 1 ? <span className="text-sm">🥇</span>
                         : m.rank === 2 ? <span className="text-sm">🥈</span>
                         : m.rank === 3 ? <span className="text-sm">🥉</span>
                         : <span className="font-medium text-muted-foreground">{m.rank}</span>}
                      </td>

                      {/* Member */}
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs uppercase">
                            {m.name?.charAt(0) ?? "?"}
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground truncate max-w-[110px]">{m.name}</p>
                            {m.designation && (
                              <p className="text-[10px] text-muted-foreground truncate max-w-[110px]">{m.designation}</p>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Total */}
                      <td className="py-3 pr-3 text-right">
                        <span className="font-bold text-foreground tabular-nums">{m.total}</span>
                      </td>

                      {/* Status columns */}
                      {STATUS_COLS.map((c) => {
                        const val = m[c.key] ?? 0;
                        return (
                          <td key={c.key} className="py-3 pr-3 text-right">
                            {val > 0 ? (
                              <span className={`font-semibold tabular-nums ${c.color}`}>{val}</span>
                            ) : (
                              <span className="text-muted-foreground/40">—</span>
                            )}
                          </td>
                        );
                      })}

                      {/* Other */}
                      {showOther && (
                        <td className="py-3 pr-3 text-right">
                          {otherCount(m) > 0 ? (
                            <span className="font-semibold tabular-nums text-foreground">{otherCount(m)}</span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      )}

                      {/* Conv% */}
                      <td className="py-3 text-right">
                        <span className={`font-semibold tabular-nums ${
                          m.conversionRate >= 50 ? "text-green-400"
                          : m.conversionRate >= 25 ? "text-amber-400"
                          : "text-muted-foreground"
                        }`}>
                          {m.conversionRate}%
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>

                {/* Totals footer */}
                <tfoot>
                  <tr className="border-t border-border/50 bg-muted/10">
                    <td className="pt-2.5 pb-1" />
                    <td className="pt-2.5 pb-1 text-xs font-semibold text-muted-foreground">Total</td>
                    <td className="pt-2.5 pb-1 pr-3 text-right font-bold text-foreground tabular-nums">{totalLeads}</td>
                    {STATUS_COLS.map((c) => {
                      const sum = data.reduce((s, m) => s + (m[c.key] ?? 0), 0);
                      return (
                        <td key={c.key} className="pt-2.5 pb-1 pr-3 text-right">
                          {sum > 0 ? (
                            <span className={`font-semibold tabular-nums ${c.color}`}>{sum}</span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      );
                    })}
                    {showOther && (
                      <td className="pt-2.5 pb-1 pr-3 text-right">
                        <span className="font-semibold tabular-nums text-foreground">{totalOther}</span>
                      </td>
                    )}
                    <td className="pt-2.5 pb-1 text-right">
                      <span className={`font-semibold tabular-nums ${
                        totalLeads > 0 && (totalClosed / totalLeads) * 100 >= 50 ? "text-green-400"
                        : totalLeads > 0 && (totalClosed / totalLeads) * 100 >= 25 ? "text-amber-400"
                        : "text-muted-foreground"
                      }`}>
                        {totalLeads > 0 ? `${((totalClosed / totalLeads) * 100).toFixed(1)}%` : "—"}
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function TeamDetailPageContent() {
  useCurrencyStore(); // subscribe so component re-renders on currency change
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = params.teamId as string;

  const { user, hasPermission } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const t = searchParams.get("tab") as TabId | null;
    const valid: TabId[] = ["dashboard", "members", "leads", "kanban", "batch", "dailysplit", "logs", "updates", "revenue", "reminders", "report", "settings"];
    return t && valid.includes(t) ? t : "dashboard";
  });

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("tab", tab);
    router.replace(`?${qs.toString()}`, { scroll: false });
  }
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editMembersOpen, setEditMembersOpen] = useState(false);

  const { data: team, isLoading: loadingTeam } = useTeam(teamId);
  const { data: memberStats, isLoading: loadingStats } = useTeamMemberStats(teamId);
  const { mutate: autoAssign, isPending: assigning } = useAutoAssignTeamLeads(teamId);
  const { mutate: deleteTeam, isPending: deleting } = useDeleteTeam();
  const { mutate: toggleMemberActive, isPending: togglingMember } = useToggleMemberActive(teamId);
  const { mutate: toggleMemberAbsent } = useToggleMemberAbsentToday(teamId);
  const { mutate: redistributeToday, isPending: redistributing } = useRedistributeToday(teamId);

  // ── Access control ───────────────────────────────────────────────────────────
  const isSuperAdmin =
    (user?.role?.isSystemRole && user?.role?.roleName === "Super Admin") || user?.role?.roleName === "Reporter";

  // Always call the hook (rules of hooks) — only redirect for non-super-admins
  const { data: myTeam, isLoading: myTeamLoading } = useMyTeam();

  // Once we know the user's team, redirect if they're trying to view another team
  useEffect(() => {
    if (isSuperAdmin || myTeamLoading || !myTeam) return;
    // If the page's teamId doesn't match the user's team → redirect to their team
    if (myTeam._id !== teamId) {
      router.replace(`/teams/${myTeam._id}`);
    }
  }, [isSuperAdmin, myTeamLoading, myTeam, teamId, router]);
  // ─────────────────────────────────────────────────────────────────────────────

  const isAdmin = hasPermission("leads", "edit");
  const isLeader =
    user &&
    team?.leaders?.some((l: User) => l._id === user._id);
  const isLeaderOrAdmin = isLeader || isAdmin;
  const canDelete = hasPermission("leads", "delete");

  // Leads + Logs tabs are only visible to: Super Admin, team leaders, and Reporters
  const isReporter =
    user?.role?.roleName === "Reporter" ||
    user?.role?.roleName === "reporter";
  const canSeeSensitiveTabs = isSuperAdmin || !!isLeader || isReporter;

  // If a regular member somehow lands on a restricted tab, bounce them to dashboard
  useEffect(() => {
    if (!canSeeSensitiveTabs && (activeTab === "leads" || activeTab === "logs" || activeTab === "revenue" || activeTab === "reminders" || activeTab === "kanban" || activeTab === "batch" || activeTab === "dailysplit" || activeTab === "report")) {
      setActiveTab("dashboard");
    }
  }, [canSeeSensitiveTabs, activeTab]);


  // "updates" is always visible to team members; "leads"/"logs"/"revenue"/"reminders"/"kanban"/"batch" only for leaders/admins
  const visibleTabs = TABS.filter((tab) => {
    if (tab.id === "leads" || tab.id === "logs" || tab.id === "revenue" || tab.id === "reminders" || tab.id === "kanban" || tab.id === "batch" || tab.id === "dailysplit" || tab.id === "report") return canSeeSensitiveTabs;
    if (tab.id === "settings") return !!isLeaderOrAdmin;
    return true;
  });

  function handleAutoAssign() {
    autoAssign(undefined);
  }

  function handleDelete() {
    deleteTeam(teamId, {
      onSuccess: () => router.push("/teams"),
    });
  }

  // ── Access guard: show spinner while checking for non-super-admins ───────────
  if (!isSuperAdmin && (myTeamLoading || (myTeam && myTeam._id !== teamId))) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Non-super-admin with no team at all → redirect to teams list
  if (!isSuperAdmin && !myTeamLoading && !myTeam) {
    router.replace("/teams");
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loadingTeam) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <AlertTriangle className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-muted-foreground">Team not found</p>
        <Button variant="outline" onClick={() => router.push("/teams")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Teams
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* ── Back button ── */}
      <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/teams")}
          className="gap-2 -ml-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Teams
        </Button>
      </motion.div>

      {/* ── Page header ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-border/50 overflow-hidden">
          <div className="h-14 sm:h-16 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />
          <CardContent className="relative pt-0 pb-5">
            <div className="-mt-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              {/* Team icon + name */}
              <div className="flex items-end gap-3 sm:gap-4 min-w-0">
                <div className="flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-xl border-4 border-background bg-primary/10 shadow-lg">
                  <Users className="h-6 w-6 sm:h-7 sm:w-7 text-primary" />
                </div>
                <div className="pb-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-lg sm:text-xl font-bold text-foreground truncate">{team.name}</h1>
                    <Badge
                      variant={team.status === "active" ? "default" : "secondary"}
                      className="capitalize shrink-0"
                    >
                      {team.status}
                    </Badge>
                  </div>
                  {team.description && (
                    <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{team.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1.5 text-xs text-muted-foreground">
                    {/* Leader names */}
                    {(team.leaders?.length ?? 0) > 0 ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Crown className="h-3 w-3 text-amber-400 shrink-0" />
                        {team.leaders.map((l: User) => (
                          <div key={l._id} className="flex items-center gap-1">
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-[9px] bg-amber-500/15 text-amber-500">
                                {getInitials(l.name)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium text-foreground">{l.name}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="flex items-center gap-1">
                        <Crown className="h-3 w-3 text-amber-400 shrink-0" />
                        No leader assigned
                      </span>
                    )}
                    <span className="text-muted-foreground/40">·</span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3 shrink-0" />
                      {team.members?.length ?? 0} member{(team.members?.length ?? 0) !== 1 ? "s" : ""}
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3 shrink-0" />
                      Created {formatDate(team.createdAt)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 pb-1 flex-wrap shrink-0">
                 <ExportPdfDialog
                  type="team"
                  entityId={teamId}
                  entityName={team.name}
                />
                {/* {isLeaderOrAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAutoAssign}
                    disabled={assigning}
                    className="gap-2"
                  >
                    {assigning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Shuffle className="h-3.5 w-3.5" />
                    )}
                    Auto-assign
                  </Button>
                )}
               
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditMembersOpen(true)}
                    className="gap-2"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit Team
                  </Button>
                )}
                {canDelete && (
                  <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Team</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to delete{" "}
                          <span className="font-semibold">{team.name}</span>? This action
                          cannot be undone. All leads assigned to this team will be unassigned.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDelete}
                          disabled={deleting}
                          className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                        >
                          {deleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                          ) : null}
                          Delete Team
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )} */}
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Custom Tabs ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        {/* Tab list — scrollable on mobile */}
        <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto scrollbar-none -mx-1 px-1">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={[
                "relative px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0",
                activeTab === tab.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {tab.label}
              {activeTab === tab.id && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full"
                  transition={{ duration: 0.2 }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <DashboardTab
                teamId={teamId}
                team={team}
                isLeaderOrAdmin={!!isLeaderOrAdmin}
                onAutoAssign={handleAutoAssign}
                assigning={assigning}
                onToggleMemberActive={toggleMemberActive}
                togglingMember={togglingMember}
              />
            </motion.div>
          )}

          {activeTab === "members" && (
            <motion.div
              key="members"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <MembersTab
                team={team}
                memberStats={memberStats}
                isLoading={loadingStats}
                isLeaderOrAdmin={!!canSeeSensitiveTabs}
                onEditMembers={() => setEditMembersOpen(true)}
                onToggleMemberActive={toggleMemberActive}
                togglingMember={togglingMember}
                onToggleMemberAbsentToday={(memberId, absent) => toggleMemberAbsent({ memberId, absent })}
                onRedistributeToday={redistributeToday}
                redistributing={redistributing}
              />
            </motion.div>
          )}

          {activeTab === "leads" && canSeeSensitiveTabs && (
            <motion.div
              key="leads"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <LeadsTab
                teamId={teamId}
                team={team}
                isLeaderOrAdmin={!!isLeaderOrAdmin}
                onAutoAssign={handleAutoAssign}
                assigning={assigning}
              />
            </motion.div>
          )}

          {activeTab === "kanban" && canSeeSensitiveTabs && (
            <motion.div
              key="kanban"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <TeamMemberKanban
                teamId={teamId}
                team={team}
                canEdit={!!isLeaderOrAdmin}
              />
            </motion.div>
          )}

          {activeTab === "batch" && canSeeSensitiveTabs && (
            <motion.div
              key="batch"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <UpcomingBatch
                teamId={teamId}
                canEdit={!!isLeaderOrAdmin}
              />
            </motion.div>
          )}

          {activeTab === "dailysplit" && canSeeSensitiveTabs && (
            <motion.div
              key="dailysplit"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <DailySplitTab teamId={teamId} />
            </motion.div>
          )}

          {activeTab === "reminders" && (
            <motion.div
              key="reminders"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <TeamRemindersTab
                teamId={teamId}
                members={[
                  ...(team?.leaders ?? []).map((u: User) => ({ _id: u._id, name: u.name })),
                  ...(team?.members ?? []).map((u: User) => ({ _id: u._id, name: u.name })),
                ].filter((u, i, a) => a.findIndex((x) => x._id === u._id) === i)}
              />
            </motion.div>
          )}

          {activeTab === "revenue" && (
            <motion.div
              key="revenue"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <TeamRevenueTab teamId={teamId} />
            </motion.div>
          )}

          {activeTab === "report" && canSeeSensitiveTabs && (
            <motion.div
              key="report"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <ReportTab teamId={teamId} />
            </motion.div>
          )}

          {activeTab === "updates" && (
            <motion.div
              key="updates"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <UpdatesTab teamId={teamId} currentUserId={user?._id ?? ""} team={team} />
            </motion.div>
          )}

          {activeTab === "logs" && canSeeSensitiveTabs && (
            <motion.div
              key="logs"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <LogsTab teamId={teamId} />
            </motion.div>
          )}

          {activeTab === "settings" && !!isLeaderOrAdmin && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <TeamSettingsTab
                teamId={teamId}
                team={team}
                isLeaderOrAdmin={!!isLeaderOrAdmin}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* AI Team Assistant */}
      {/* <div className="mt-6 px-4 sm:px-6 pb-6 max-w-2xl">
        <AiChatPanel contextType="team" contextId={teamId} />
      </div> */}

      {/* Edit members dialog — reuses TeamDialog pre-filled with current team */}
      <TeamDialog
        open={editMembersOpen}
        onOpenChange={setEditMembersOpen}
        team={team}
      />
    </div>
  );
}

export default function TeamDetailPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <TeamDetailPageContent />
    </Suspense>
  );
}
