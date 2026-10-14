"use client";
import { useState, useMemo, useEffect, useRef, useCallback, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Search, Pencil, Trash2, Loader2, ChevronLeft, ChevronRight,
  X, Upload, FileText, ChevronDown, ExternalLink, AlertTriangle,
  CalendarDays, Filter, Tags, ArrowRightLeft, CheckSquare, Square,
  LayoutGrid, List, Columns3, GripVertical, Phone, History,
  ArrowUpDown, ArrowUp, ArrowDown, MessageCircle, Sheet, UserPlus,
} from "lucide-react";
import Link from "next/link";
import { TodayLeadsButton, SplitTodayButton } from "@/components/leads/LeadsDateFilter";
import { ClickToCall } from "@/components/leads/ClickToCall";
import { QuickNoteDialog } from "@/components/leads/QuickNoteDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { LeadDialog } from "@/components/leads/LeadDialog";
import { DeleteLeadDialog } from "@/components/leads/DeleteLeadDialog";
import { AssignLeadDialog } from "@/components/leads/AssignLeadDialog";
import { KanbanBoard } from "@/components/leads/KanbanBoard";
import { useLeads, useLeadSources, useUpdateLeadStatus, useBulkUpdateLeadStatus, useBulkDeleteLeads, useBulkAssignLeadsToTeam, useUpdateLead } from "@/hooks/useLeads";
import { useAllCourses } from "@/hooks/useCourses";
import { useUsers } from "@/hooks/useUsers";
import { useMyTeam, useTeams } from "@/hooks/useTeams";
import { useAuthStore } from "@/lib/store/authStore";
import { cn, formatDate } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import type { Lead } from "@/types/lead";
import type { LeadStatus } from "@/lib/statusConfig";
import type { User } from "@/types";
import { INITIAL_RESPONSE_CONFIG, PRIMARY_CONCERN_CONFIG, FOLLOWUP_STRATEGY_CONFIG } from "@/lib/leadConfig";
import { ExactConcernEditor } from "@/components/leads/ExactConcernEditor";
import { CloseLeadDialog, CloseLeadsQueue } from "@/components/students/CloseLeadDialog";
import { toast } from "@/lib/toast";
import { LOST_REASONS, LostReasonModal } from "@/components/leads/LostReasonModal";
import { TruncatedCell } from "@/components/leads/TruncatedCell";
import { FollowupDetailsModal } from "@/components/leads/FollowupDetailsModal";
import { MeetingScheduledModal } from "@/components/leads/MeetingScheduledModal";

// ─── Constants ────────────────────────────────────────────────────────────────

import { LEAD_STATUSES, STATUS_META } from "@/lib/statusConfig";
import { toGstDateISO } from "@/lib/utils";

const THREECX_URL = "https://deltainstitutions.3cx.ae:5002";

const STATUS_OPTIONS: { value: LeadStatus | "all"; label: string }[] = [
  { value: "all", label: "All Status" },
  ...LEAD_STATUSES.map((s) => ({ value: s as LeadStatus, label: STATUS_META[s].label })),
];

const STATUS_COLORS: Record<LeadStatus, string> = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, STATUS_META[s].color]),
) as Record<LeadStatus, string>;

const STATUS_LABELS: Record<LeadStatus, string> = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, STATUS_META[s].label]),
) as Record<LeadStatus, string>;

// ─── Column definitions ───────────────────────────────────────────────────────

interface ColumnDef { id: string; label: string; defaultVisible: boolean; alwaysVisible?: boolean }

const ALL_COLUMNS: ColumnDef[] = [
  { id: "name",                 label: "Name",               defaultVisible: true,  alwaysVisible: true  },
  { id: "contact",              label: "Contact",            defaultVisible: true,  alwaysVisible: true  },
  { id: "status",               label: "Status",             defaultVisible: true,  alwaysVisible: true  },
  { id: "source",               label: "Source",             defaultVisible: true  },
  { id: "course",               label: "Course",             defaultVisible: true  },
  { id: "team",                 label: "Team",               defaultVisible: true  },
  { id: "assignedTo",           label: "Assigned To",        defaultVisible: true  },
  { id: "assignedAt",           label: "Assigned At",        defaultVisible: false },
  { id: "reporter",             label: "Reporter",           defaultVisible: false },
  { id: "created",              label: "Created",            defaultVisible: false },
  { id: "lastFollowup",         label: "Last Followup",      defaultVisible: true  },
  { id: "calls",                label: "Calls (3CX)",        defaultVisible: true  },
  { id: "demo",                 label: "Demo",               defaultVisible: false },
  { id: "firstContactTime",     label: "First Contact",      defaultVisible: false },
  { id: "lastContactedAt",      label: "Last Contacted",     defaultVisible: false },
  { id: "initialLeadResponse",  label: "Response",           defaultVisible: true  },
  { id: "primaryConcern",       label: "Concern",            defaultVisible: true  },
  { id: "exactConcern",         label: "Exact Concern",      defaultVisible: false },
  { id: "followupStrategyType", label: "Strategy",           defaultVisible: true  },
  { id: "lostNotes",            label: "Lost Notes",         defaultVisible: false },
];

const DEFAULT_VISIBLE = new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id));
/** This browser's last choice of Table or Kanban on the Leads page. */
const LEADS_VIEW_KEY = "crm_leads_view";
/** Remembers "All leads" / "My leads" for super admins and team leaders, per browser. */
const LEADS_SCOPE_KEY = "crm_leads_scope";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A lead's calls through 3CX (counted from 3CX's calls, 2026-10-14): calls · connected · not connected. */
function CallCounts({ lead }: { lead: Lead }) {
  const total = lead.callCount ?? 0;
  if (!total) return <span className="text-xs text-muted-foreground/40">—</span>;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums"
      title={`${total} calls through 3CX — ${lead.callConnected ?? 0} connected, ${lead.callNotConnected ?? 0} not connected`}
    >
      <span className="text-sky-400">{total}</span>
      <span className="text-emerald-400">✓{lead.callConnected ?? 0}</span>
      <span className="text-orange-400">✗{lead.callNotConnected ?? 0}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function getUserName(user: User | string | null | undefined): string {
  if (!user) return "Unassigned";
  if (typeof user === "object") return user.name;
  return user;
}

function getUserId(user: User | string | null | undefined): string {
  if (!user) return "";
  if (typeof user === "object") return user._id;
  return user;
}

// ─── Active filter pill ───────────────────────────────────────────────────────

function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
      {label}
      <button onClick={onRemove} className="ml-0.5 hover:text-primary/60 transition-colors">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function LeadsPageContent() {
  const { hasPermission, user } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Filter state — all initialised from URL params ───────────────────────────
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(() => Number(searchParams.get("page") ?? "1"));
  const [limit, setLimit] = useState(() => Number(searchParams.get("limit") ?? "10"));
  const [status, setStatus] = useState<string>(() => searchParams.get("status") ?? "all");
  const [assignedTo, setAssignedTo] = useState<string>(() => searchParams.get("assignedTo") ?? "all");
  const [reporter, setReporter] = useState<string>(() => searchParams.get("reporter") ?? "all");
  const [dateFrom, setDateFrom] = useState<string>(() => searchParams.get("from") ?? "");
  const [dateTo, setDateTo] = useState<string>(() => searchParams.get("to") ?? "");
  const [courseId, setCourseId] = useState<string>(() => searchParams.get("course") ?? "all");
  const [teamId, setTeamId] = useState<string>(() => searchParams.get("team") ?? "all");
  const [demoScheduled, setDemoScheduled] = useState<string>(() => searchParams.get("demoScheduled") ?? "all");
  const [demoAttended, setDemoAttended] = useState<string>(() => searchParams.get("demoAttended") ?? "all");
  const [followupFrom, setFollowupFrom] = useState<string>(() => searchParams.get("followupFrom") ?? "");
  const [splitFrom, setSplitFrom] = useState<string>(() => searchParams.get("splitFrom") ?? "");
  const [splitTo, setSplitTo] = useState<string>(() => searchParams.get("splitTo") ?? "");
  const [followupTo, setFollowupTo] = useState<string>(() => searchParams.get("followupTo") ?? "");
  const [source, setSource] = useState<string>(() => searchParams.get("source") ?? "all");
  const [lostReason, setLostReason] = useState<string>(() => searchParams.get("lostReason") ?? "all");
  const [sortBy, setSortBy] = useState<string>(() => searchParams.get("sortBy") ?? "createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(() => (searchParams.get("sortOrder") as "asc" | "desc") ?? "desc");
  const [showFilters, setShowFilters] = useState(() => {
    // Auto-open filters panel if any filter param is present in URL
    const sp = searchParams;
    return !!(sp.get("status") || sp.get("assignedTo") || sp.get("reporter") || sp.get("course") || sp.get("team") || sp.get("from") || sp.get("to") || sp.get("demoScheduled") || sp.get("demoAttended") || sp.get("followupFrom") || sp.get("splitFrom") || sp.get("source"));
  });

  // ── View mode — synced to ?view= URL param ────────────────────────────────────
  // Table or Kanban: a link's ?view= wins, else what this browser last chose (the owner, 2026-10-07).
  const [viewMode, setViewMode] = useState<"table" | "kanban">(() => {
    const v = searchParams.get("view");
    if (v === "kanban" || v === "table") return v;
    if (typeof window === "undefined") return "table";
    try { return localStorage.getItem(LEADS_VIEW_KEY) === "kanban" ? "kanban" : "table"; } catch { return "table"; }
  });

  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return DEFAULT_VISIBLE;
    try {
      const saved = localStorage.getItem("crm_leads_columns");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return DEFAULT_VISIBLE;
  });

  const [columnOrder, setColumnOrder] = useState<string[]>(() => {
    if (typeof window === "undefined") return ALL_COLUMNS.map((c) => c.id);
    try {
      const saved = localStorage.getItem("crm_leads_column_order");
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        // Merge: keep saved order, append any new columns not yet in saved
        const savedSet = new Set(parsed);
        const all = ALL_COLUMNS.map((c) => c.id);
        const merged = [...parsed.filter((id) => all.includes(id)), ...all.filter((id) => !savedSet.has(id))];
        return merged;
      }
    } catch { /* ignore */ }
    return ALL_COLUMNS.map((c) => c.id);
  });

  // Drag state for column reordering (uses refs to avoid re-renders during drag)
  const dragColId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function onColDragStart(id: string) {
    dragColId.current = id;
  }

  function onColDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    if (dragColId.current && dragColId.current !== id) setDragOverId(id);
  }

  function onColDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const sourceId = dragColId.current;
    if (!sourceId || sourceId === targetId) { setDragOverId(null); return; }
    setColumnOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(sourceId);
      const to   = next.indexOf(targetId);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, sourceId);
      try { localStorage.setItem("crm_leads_column_order", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    dragColId.current = null;
    setDragOverId(null);
  }

  function onColDragEnd() {
    dragColId.current = null;
    setDragOverId(null);
  }

  function toggleColumn(id: string) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem("crm_leads_columns", JSON.stringify(Array.from(next))); } catch { /* ignore */ }
      return next;
    });
  }

  // Ordered list of columns to render (respects both order and visibility)
  const orderedColumns = columnOrder
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter(Boolean) as typeof ALL_COLUMNS;

  const col = (id: string) => visibleColumns.has(id);

  // ── Column header renderer ────────────────────────────────────────────────────
  function renderColHeader(colId: string) {
    if (colId === "name")   return <th key="name"   className="px-4 py-3 text-left">Name</th>;
    if (colId === "status") return <th key="status" className="px-4 py-3 text-left">Status</th>;
    if (!col(colId)) return null;
    const labelMap: Record<string, { label: string; cls: string }> = {
      contact:              { label: "Contact",       cls: "px-4 py-3 text-left" },
      source:               { label: "Source",        cls: "px-4 py-3 text-left hidden md:table-cell" },
      course:               { label: "Course",        cls: "px-4 py-3 text-left hidden lg:table-cell" },
      team:                 { label: "Team",          cls: "px-4 py-3 text-left hidden lg:table-cell" },
      assignedTo:           { label: "Assigned To",   cls: "px-4 py-3 text-left hidden lg:table-cell" },
      assignedAt:           { label: "Assigned At",   cls: "px-4 py-3 text-left hidden xl:table-cell" },
      reporter:             { label: "Reporter",      cls: "px-4 py-3 text-left hidden xl:table-cell" },
      created:              { label: "Created",       cls: "px-4 py-3 text-left hidden xl:table-cell" },
      lastFollowup:         { label: "Last Followup", cls: "px-4 py-3 text-left hidden lg:table-cell" },
      calls:                { label: "Calls",         cls: "px-4 py-3 text-left hidden lg:table-cell" },
      demo:                 { label: "Demo",          cls: "px-4 py-3 text-left hidden lg:table-cell" },
      firstContactTime:     { label: "First Contact", cls: "px-4 py-3 text-left hidden xl:table-cell" },
      lastContactedAt:      { label: "Last Contacted", cls: "px-4 py-3 text-left hidden xl:table-cell" },
      initialLeadResponse:  { label: "Response",      cls: "px-4 py-3 text-left hidden lg:table-cell" },
      primaryConcern:       { label: "Concern",       cls: "px-4 py-3 text-left hidden lg:table-cell" },
      exactConcern:         { label: "Exact Concern", cls: "px-4 py-3 text-left hidden lg:table-cell" },
      followupStrategyType: { label: "Strategy",      cls: "px-4 py-3 text-left hidden lg:table-cell" },
      lostNotes:            { label: "Lost Notes",    cls: "px-4 py-3 text-left hidden lg:table-cell" },
    };
    const h = labelMap[colId];
    if (!h) return null;
    return <th key={colId} className={h.cls}>{h.label}</th>;
  }

  // ── Column cell renderer ──────────────────────────────────────────────────────
  function renderColCell(colId: string, lead: Lead) {
    if (colId === "name") return (
      <td key="name" className="px-4 py-4">
        <p className="font-medium text-sm">{lead.name}</p>
      </td>
    );
    if (colId === "status") return (
      <td key="status" className="px-4 py-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={getUserId(lead.assignedTo as User | string | null) !== user?._id && !isAdmin}
            asChild
          >
            <button className="flex items-center gap-1 group/status">
              <StatusBadge status={lead.status} />
              <ChevronDown className="h-3 w-3 text-muted-foreground opacity-0 group-hover/status:opacity-100 transition-opacity" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
              <DropdownMenuItem key={s} onClick={() => handleStatusChange(lead, s)} className={lead.status === s ? "font-semibold" : ""}>
                <StatusBadge status={s} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    );
    if (!col(colId)) return null;
    switch (colId) {
      case "contact": return (
        <td key="contact" className="px-4 py-4">
          <div className="space-y-0.5">
            {lead.email && <p className="text-sm text-muted-foreground">{lead.email}</p>}
            {lead.phone && (
              <div className="flex items-center gap-1.5">
                <p className="text-xs text-muted-foreground/70">{lead.phone}</p>
                {lead.hasWhatsapp && (
                  <a
                    href={`https://wa.me/${lead.phone.replace(/\D/g, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Open WhatsApp"
                    className="text-green-500 hover:text-green-600 transition-colors"
                  >
                    <MessageCircle className="h-3.5 w-3.5 fill-green-500/20" />
                  </a>
                )}
              </div>
            )}
            {!lead.email && !lead.phone && <span className="text-sm text-muted-foreground/50">—</span>}
          </div>
        </td>
      );
      case "source": return (
        <td key="source" className="px-4 py-4 hidden md:table-cell">
          <span className="text-sm text-muted-foreground capitalize">{lead.source ?? "—"}</span>
          {lead.referredBy && (
            <span className="block text-[10px] text-amber-500/90 truncate max-w-[160px]" title={`Referred by ${lead.referredBy}`}>
              by {lead.referredBy}{lead.referralType ? ` (${lead.referralType})` : ""}
            </span>
          )}
        </td>
      );
      case "course": return (
        <td key="course" className="px-4 py-4 hidden lg:table-cell">
          {lead.course
            ? <span className="text-sm text-muted-foreground">{typeof lead.course === "object" ? lead.course.name : lead.course}</span>
            : <span className="text-sm text-muted-foreground/40">—</span>}
        </td>
      );
      case "team": return (
        <td key="team" className="px-4 py-4 hidden lg:table-cell">
          {lead.team
            ? <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">{typeof lead.team === "object" ? lead.team.name : lead.team}</span>
            : <span className="text-xs text-muted-foreground/50">—</span>}
        </td>
      );
      case "assignedTo": return (
        <td key="assignedTo" className="px-4 py-4 hidden lg:table-cell">
          <span className="text-sm text-muted-foreground">{getUserName(lead.assignedTo as User | string | null)}</span>
        </td>
      );
      case "assignedAt": return (
        <td key="assignedAt" className="px-4 py-4 hidden xl:table-cell">
          {lead.assignedAt ? (
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground">{new Date(lead.assignedAt).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" })}</p>
              <p className="text-[11px] text-muted-foreground/60">{new Date(lead.assignedAt).toLocaleTimeString("en-AE", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: true })} GST</p>
            </div>
          ) : <span className="text-xs text-muted-foreground/40">—</span>}
        </td>
      );
      case "reporter": return (
        <td key="reporter" className="px-4 py-4 hidden xl:table-cell">
          <span className="text-sm text-muted-foreground">{getUserName(lead.reporter as User | string | null)}</span>
        </td>
      );
      case "created": return (
        <td key="created" className="px-4 py-4 hidden xl:table-cell">
          <span className="text-sm text-muted-foreground">{formatDate(lead.createdAt)}</span>
        </td>
      );
      case "lastFollowup": {
        const missed =
          !!lead.missedFollowUpWarnedAt &&
          !!lead.nextFollowUpAt &&
          new Date(lead.missedFollowUpWarnedAt) >= new Date(lead.nextFollowUpAt);
        return (
          <td key="lastFollowup" className="px-4 py-4 hidden lg:table-cell">
            <div className="flex items-center gap-1.5">
              {missed && (
                <span title="Missed follow-up — warning sent">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                </span>
              )}
              {lead.lastFollowupDate
                ? <span className={`text-xs ${missed ? "text-red-400" : "text-muted-foreground"}`}>{new Date(lead.lastFollowupDate).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" })}</span>
                : <span className={`text-xs ${missed ? "text-red-400" : "text-muted-foreground/40"}`}>—</span>}
            </div>
          </td>
        );
      }
      case "calls": return (
        <td key="calls" className="px-4 py-4 hidden lg:table-cell">
          <CallCounts lead={lead} />
        </td>
      );
      case "demo": return (
        <td key="demo" className="px-4 py-4 hidden lg:table-cell">
          <div className="flex flex-col gap-1">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium w-fit ${lead.demoScheduled ? "bg-violet-500/10 text-violet-400" : "bg-muted/40 text-muted-foreground/50"}`}>
              {lead.demoScheduled ? "✓ Scheduled" : "Not scheduled"}
            </span>
            {lead.demoScheduled && (
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium w-fit ${lead.demoAttended ? "bg-green-500/10 text-green-400" : "bg-amber-500/10 text-amber-400"}`}>
                {lead.demoAttended ? "✓ Attended" : "Not attended"}
              </span>
            )}
          </div>
        </td>
      );
      case "firstContactTime": return (
        <td key="firstContactTime" className="px-4 py-4 hidden xl:table-cell">
          {lead.firstContactTime
            ? <span className="text-xs text-muted-foreground">{new Date(lead.firstContactTime).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })}</span>
            : <span className="text-xs text-muted-foreground/40">—</span>}
        </td>
      );
      case "lastContactedAt": return (
        <td key="lastContactedAt" className="px-4 py-4 hidden xl:table-cell">
          {lead.lastContactedAt
            ? <span className="text-xs text-muted-foreground">{new Date(lead.lastContactedAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })}</span>
            : <span className="text-xs text-muted-foreground/40">—</span>}
        </td>
      );
      case "initialLeadResponse": return (
        <td key="initialLeadResponse" className="px-4 py-4 hidden lg:table-cell">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 group/ilr">
                {lead.initialLeadResponse ? (() => { const c = INITIAL_RESPONSE_CONFIG.find((x) => x.value === lead.initialLeadResponse); return c ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${c.bg} ${c.color} ${c.border}`}>{c.label}</span> : <span className="text-xs text-muted-foreground/40">—</span>; })() : <span className="text-xs text-muted-foreground/40">—</span>}
                <ChevronDown className="h-3 w-3 text-muted-foreground opacity-0 group-hover/ilr:opacity-100 transition-opacity" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => updateLeadField({ id: lead._id, data: { initialLeadResponse: null } as never })} className="text-xs text-muted-foreground">— Clear —</DropdownMenuItem>
              {INITIAL_RESPONSE_CONFIG.map((opt) => <DropdownMenuItem key={opt.value} onClick={() => updateLeadField({ id: lead._id, data: { initialLeadResponse: opt.value } as never })} className={`text-xs ${opt.color} ${lead.initialLeadResponse === opt.value ? "font-semibold" : ""}`}>{opt.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      );
      case "primaryConcern": return (
        <td key="primaryConcern" className="px-4 py-4 hidden lg:table-cell">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 group/pc">
                {lead.primaryConcern ? (() => { const c = PRIMARY_CONCERN_CONFIG.find((x) => x.value === lead.primaryConcern); return c ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${c.bg} ${c.color} ${c.border}`}>{c.label}</span> : <span className="text-xs text-muted-foreground/40">—</span>; })() : <span className="text-xs text-muted-foreground/40">—</span>}
                <ChevronDown className="h-3 w-3 text-muted-foreground opacity-0 group-hover/pc:opacity-100 transition-opacity" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => updateLeadField({ id: lead._id, data: { primaryConcern: null } as never })} className="text-xs text-muted-foreground">— Clear —</DropdownMenuItem>
              {PRIMARY_CONCERN_CONFIG.map((opt) => <DropdownMenuItem key={opt.value} onClick={() => updateLeadField({ id: lead._id, data: { primaryConcern: opt.value } as never })} className={`text-xs ${opt.color} ${lead.primaryConcern === opt.value ? "font-semibold" : ""}`}>{opt.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      );
      case "exactConcern": return (
        <td key="exactConcern" className="px-4 py-4 hidden lg:table-cell">
          <ExactConcernEditor leadId={lead._id} leadName={lead.name} value={lead.exactConcern} />
        </td>
      );
      case "lostNotes": return (
        <td key="lostNotes" className="px-4 py-4 hidden lg:table-cell">
          <TruncatedCell value={lead.lostNotes} label={`Lost Notes — ${lead.name}`} />
        </td>
      );
      case "followupStrategyType": return (
        <td key="followupStrategyType" className="px-4 py-4 hidden lg:table-cell">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 group/fst">
                {lead.followupStrategyType ? (() => { const c = FOLLOWUP_STRATEGY_CONFIG.find((x) => x.value === lead.followupStrategyType); return c ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${c.bg} ${c.color} ${c.border}`}>{c.label}</span> : <span className="text-xs text-muted-foreground/40">—</span>; })() : <span className="text-xs text-muted-foreground/40">—</span>}
                <ChevronDown className="h-3 w-3 text-muted-foreground opacity-0 group-hover/fst:opacity-100 transition-opacity" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => updateLeadField({ id: lead._id, data: { followupStrategyType: null } as never })} className="text-xs text-muted-foreground">— Clear —</DropdownMenuItem>
              {FOLLOWUP_STRATEGY_CONFIG.map((opt) => <DropdownMenuItem key={opt.value} onClick={() => updateLeadField({ id: lead._id, data: { followupStrategyType: opt.value } as never })} className={`text-xs ${opt.color} ${lead.followupStrategyType === opt.value ? "font-semibold" : ""}`}>{opt.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      );
      default: return null;
    }
  }

  function changeViewMode(mode: "table" | "kanban") {
    setViewMode(mode);
    try { localStorage.setItem(LEADS_VIEW_KEY, mode); } catch { /* ignore */ }
  }

  // ── Sync all filter state → URL ───────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams();
    if (viewMode !== "table") params.set("view", viewMode);
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (page > 1) params.set("page", String(page));
    if (limit !== 10) params.set("limit", String(limit));
    if (status !== "all") params.set("status", status);
    if (assignedTo !== "all") params.set("assignedTo", assignedTo);
    if (reporter !== "all") params.set("reporter", reporter);
    if (courseId !== "all") params.set("course", courseId);
    if (teamId !== "all") params.set("team", teamId);
    if (source !== "all") params.set("source", source);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    if (demoScheduled !== "all") params.set("demoScheduled", demoScheduled);
    if (demoAttended !== "all") params.set("demoAttended", demoAttended);
    if (followupFrom) params.set("followupFrom", followupFrom);
    if (splitFrom) params.set("splitFrom", splitFrom);
    if (splitTo) params.set("splitTo", splitTo);
    if (followupTo) params.set("followupTo", followupTo);
    if (sortBy !== "createdAt") params.set("sortBy", sortBy);
    if (sortOrder !== "desc") params.set("sortOrder", sortOrder);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [viewMode, debouncedSearch, page, limit, status, assignedTo, reporter, courseId, teamId, source, dateFrom, dateTo, demoScheduled, demoAttended, followupFrom, followupTo, splitFrom, splitTo, sortBy, sortOrder]);

  // ── Dialog state ─────────────────────────────────────────────────────────────
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  // ── Bulk selection state ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkTeamOpen, setBulkTeamOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<LeadStatus>("followup");
  const [bulkTeamId, setBulkTeamId] = useState<string>("");

  // Lost reason modal — shared across all single-status change points
  const [lostModalOpen,     setLostModalOpen]     = useState(false);
  const [lostModalLead,     setLostModalLead]      = useState<Lead | null>(null);
  // Lost reason modal for bulk flow
  const [bulkLostModalOpen, setBulkLostModalOpen]  = useState(false);
  const [followupModalOpen,     setFollowupModalOpen]     = useState(false);
  const [followupModalLead,     setFollowupModalLead]     = useState<Lead | null>(null);
  const [bulkFollowupModalOpen, setBulkFollowupModalOpen] = useState(false);
  const [meetingModalLead,      setMeetingModalLead]      = useState<Lead | null>(null);

  const bulkUpdateStatus = useBulkUpdateLeadStatus();
  const bulkDeleteLeads = useBulkDeleteLeads();
  const bulkAssignTeam = useBulkAssignLeadsToTeam();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { mutate: updateStatus, mutateAsync: updateStatusAsync, isPending: updateStatusPending } = useUpdateLeadStatus();
  const { mutate: updateLeadField } = useUpdateLead();

  // Clear selection when page/filters change
  useEffect(() => { setSelectedIds(new Set()); }, [page, debouncedSearch, status, assignedTo, reporter, dateFrom, dateTo, courseId, teamId, source, demoScheduled, demoAttended, followupFrom, followupTo, splitFrom, splitTo]);

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allPageIds = useMemo(() => [], []); // filled after leads load
  const toggleAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      if (ids.every((id) => prev.has(id))) return new Set();
      return new Set(ids);
    });
  }, []);

  function handleSearchChange(val: string) {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 400);
  }

  // Reset page when any filter changes
  function applyFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  function applySort(by: string, order: "asc" | "desc") {
    setSortBy(by);
    setSortOrder(order);
    setPage(1);
  }

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

  const filters = useMemo(() => ({
    page,
    limit,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(assignedTo !== "all" ? { assignedTo } : {}),
    ...(reporter !== "all" ? { reporter } : {}),
    ...(courseId !== "all" ? { course: courseId } : {}),
    ...(teamId !== "all" ? { team: teamId } : {}),
    ...(source !== "all" ? { source } : {}),
    ...(lostReason !== "all" ? { lostReason } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(demoScheduled !== "all" ? { demoScheduled } : {}),
    ...(demoAttended !== "all" ? { demoAttended } : {}),
    ...(followupFrom ? { followupFrom } : {}),
    ...(followupTo ? { followupTo } : {}),
    ...(splitFrom ? { splitFrom } : {}),
    ...(splitTo ? { splitTo } : {}),
    sortBy,
    sortOrder,
  }), [page, limit, debouncedSearch, status, assignedTo, reporter, courseId, teamId, source, lostReason, dateFrom, dateTo, demoScheduled, demoAttended, followupFrom, followupTo, splitFrom, splitTo, sortBy, sortOrder]);

  const { data, isLoading, isFetching } = useLeads(filters);
  const { data: usersData } = useUsers({ status: "active", limit: "200" });
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  // The team this person is on — readable by any role that sees leads, unlike the teams list.
  const { data: myTeam } = useMyTeam();
  const { data: allCourses = [] } = useAllCourses();
  const { data: allSources = [] } = useLeadSources();

  const leads = data?.data ?? [];
  const pagination = data?.pagination;
  const allUsers = usersData?.data ?? [];

  // ── Permissions & role detection ──────────────────────────────────────────────
  const canCreate = hasPermission("leads", "create");
  const canEdit = hasPermission("leads", "edit");
  const canDelete = hasPermission("leads", "delete");
  const isSuperAdmin =
    user?.role?.isSystemRole === true && user?.role?.roleName === "Super Admin";

  // Detect if current user is a leader of any team — from the teams list when the role may read it,
  // otherwise from their own team (most leaders' roles can't list teams).
  const isLeaderOf = (t: { leaders?: Array<User | string> } | null | undefined) =>
    Boolean(t?.leaders?.some((l) => (typeof l === "object" ? l._id : l) === user?._id));
  const myLeaderTeam = teamsData?.data?.find((t) => isLeaderOf(t)) ?? (isLeaderOf(myTeam) ? myTeam ?? null : null);

  const isTeamLeader = !!myLeaderTeam;
  // "Admin-level" = can see people-based filters
  const isAdmin = isSuperAdmin || isTeamLeader;
  const myId = user?._id ?? "";

  // For Assigned To filter: super admin sees all users; team leader sees their team members (and themselves); else empty
  const leaderMembers = (myLeaderTeam?.members ?? []).filter((m): m is typeof allUsers[0] => typeof m === "object");
  const filterableUsers: Array<{ _id: string; name: string }> = isSuperAdmin
    ? allUsers
    : isTeamLeader && myLeaderTeam
      ? [...(myId && !leaderMembers.some((m) => m._id === myId) ? [{ _id: myId, name: "You" }] : []), ...leaderMembers]
      : [];

  // ── "My leads" — super admins and team leaders see more than their own; this shows just theirs ──
  // A shortcut for Assigned To = you, so the list, the board, paging and the URL all follow it.
  const mineOnly = Boolean(myId) && assignedTo === myId;
  const scopeRestored = useRef(false);
  // The last choice comes back once we know who is looking — unless the address sets Assigned To itself.
  useEffect(() => {
    if (scopeRestored.current || !isAdmin || !myId) return;
    scopeRestored.current = true;
    if (searchParams.get("assignedTo")) return;
    try {
      if (localStorage.getItem(LEADS_SCOPE_KEY) === "mine") setAssignedTo(myId);
    } catch { /* storage unavailable — start on all leads */ }
  }, [isAdmin, myId, searchParams]);
  // …and is remembered: "mine" whenever Assigned To is you, "all" when it is cleared. Filtering to
  // someone else (a link, the dropdown) leaves the remembered choice alone.
  useEffect(() => {
    if (!scopeRestored.current || !isAdmin) return;
    if (!mineOnly && assignedTo !== "all") return;
    try {
      localStorage.setItem(LEADS_SCOPE_KEY, mineOnly ? "mine" : "all");
    } catch { /* storage unavailable */ }
  }, [mineOnly, assignedTo, isAdmin]);

  // Reporter filter only makes sense for super admin
  const showReporterFilter = isSuperAdmin;

  // ── Active filter detection ───────────────────────────────────────────────────
  const activeFilterCount = [
    status !== "all",
    assignedTo !== "all",
    reporter !== "all",
    courseId !== "all",
    teamId !== "all",
    source !== "all",
    !!dateFrom,
    !!dateTo,
    demoScheduled !== "all",
    demoAttended !== "all",
    !!followupFrom,
    !!followupTo,
    !!splitFrom,
    !!splitTo,
    !!debouncedSearch,
  ].filter(Boolean).length;

  const hasActiveFilters = activeFilterCount > 0;

  function clearAllFilters() {
    setStatus("all");
    setAssignedTo("all");
    setReporter("all");
    setCourseId("all");
    setTeamId("all");
    setSource("all");
    setDateFrom("");
    setDateTo("");
    setDemoScheduled("all");
    setSplitFrom("");
    setSplitTo("");
    setDemoAttended("all");
    setFollowupFrom("");
    setFollowupTo("");
    setSearch("");
    setDebouncedSearch("");
    setPage(1);
  }

  // ── Student modal state ───────────────────────────────────────────────────────
  const [studentModalLead, setStudentModalLead] = useState<Lead | null>(null);
  const [pendingStatus,    setPendingStatus]    = useState<{ lead: Lead; status: LeadStatus } | null>(null);
  /** Leads chosen to close together: their enrolments open one after another. */
  const [closeQueue, setCloseQueue] = useState<string[] | null>(null);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleCreate = () => { setSelectedLead(null); setDialogOpen(true); };
  const handleEdit = (l: Lead) => { setSelectedLead(l); setDialogOpen(true); };
  const handleDelete = (l: Lead) => { setSelectedLead(l); setDeleteOpen(true); };
  const handleAssign = (l: Lead) => { setSelectedLead(l); setAssignOpen(true); };

  function handleStatusChange(l: Lead, s: LeadStatus) {
    if (s === "lost") {
      setLostModalLead(l);
      setLostModalOpen(true);
    } else if (s === "followup") {
      setFollowupModalLead(l);
      setFollowupModalOpen(true);
    } else if (s === "meeting_scheduled") {
      // When the meeting is — it becomes a reminder
      setMeetingModalLead(l);
    } else if (s === "closed") {
      setPendingStatus({ lead: l, status: s });
      setStudentModalLead(l);
    } else {
      updateStatus({ id: l._id, status: s });
    }
  }

  // ── Active filter label helpers ───────────────────────────────────────────────
  function userName(id: string) {
    if (id === myId) return "You";
    return allUsers.find((u) => u._id === id)?.name ?? id;
  }

  return (
    <div className="space-y-6">
      {/* ── Page Header ────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <div className="flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            <h2 className="text-2xl font-bold">Leads Management</h2>
          </div>
          <p className="text-muted-foreground text-sm mt-0.5">
            Track and manage all your sales leads
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <>
              <Button variant="outline" size="sm" onClick={() => router.push("/leads/sheets")} className="gap-2">
                <Sheet className="h-4 w-4" />
                <span className="hidden sm:inline">Sheets & Sources</span>
              </Button>
              <Button variant="outline" onClick={() => router.push("/leads/upload-legacy")} className="gap-2">
                <History className="h-4 w-4" />
                <span className="hidden sm:inline">Import Old Leads</span>
              </Button>
              <Button variant="outline" onClick={() => router.push("/leads/upload")} className="gap-2">
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Upload Leads</span>
              </Button>
              <Button onClick={handleCreate} className="gap-2">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Add Lead</span>
              </Button>
            </>
          )}
        </div>
      </motion.div>

      {/* ── Filters + Table ────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-border/50">
          <CardHeader className="pb-3 space-y-3">

            {/* Row 1 — Search + toggle filter button */}
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

              {/* Right side — whose leads + Today + filter toggle + view toggle + clear */}
              <div className="flex items-center gap-2 flex-wrap">
                {isAdmin && myId && (
                  <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5" role="group" aria-label="Whose leads">
                    {([
                      { key: "all", label: isSuperAdmin ? "All leads" : "My team", on: assignedTo === "all" },
                      { key: "mine", label: "My leads", on: mineOnly },
                    ] as const).map((o) => (
                      <motion.button
                        key={o.key}
                        type="button"
                        whileTap={{ scale: 0.97 }}
                        aria-pressed={o.on}
                        onClick={() => applyFilter(setAssignedTo, o.key === "mine" ? myId : "all")}
                        className={cn(
                          "relative whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                          o.on ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {o.on && (
                          <motion.span
                            layoutId="leads-scope-pill"
                            className="absolute inset-0 rounded-md bg-primary"
                            transition={{ type: "spring", stiffness: 500, damping: 40 }}
                          />
                        )}
                        <span className="relative z-10">{o.label}</span>
                      </motion.button>
                    ))}
                  </div>
                )}
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

                {/* Sort */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2">
                      <ArrowUpDown className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Sort</span>
                      {sortBy !== "createdAt" || sortOrder !== "desc" ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      ) : null}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <div className="px-2 py-1.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sort by</p>
                    </div>
                    <DropdownMenuSeparator />
                    {[
                      { label: "Created Date",       value: "createdAt" },
                      { label: "Last Follow-up Date", value: "lastFollowupDate" },
                    ].map((opt) => (
                      <div key={opt.value}>
                        <DropdownMenuItem
                          className={`text-xs flex items-center justify-between ${sortBy === opt.value && sortOrder === "desc" ? "text-primary" : ""}`}
                          onClick={() => applySort(opt.value, "desc")}
                        >
                          <span>{opt.label} — Newest</span>
                          {sortBy === opt.value && sortOrder === "desc" && <ArrowDown className="h-3 w-3 text-primary" />}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className={`text-xs flex items-center justify-between ${sortBy === opt.value && sortOrder === "asc" ? "text-primary" : ""}`}
                          onClick={() => applySort(opt.value, "asc")}
                        >
                          <span>{opt.label} — Oldest</span>
                          {sortBy === opt.value && sortOrder === "asc" && <ArrowUp className="h-3 w-3 text-primary" />}
                        </DropdownMenuItem>
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Column visibility + reorder */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2">
                      <Columns3 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Columns</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
                    <div className="px-2 py-1.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Columns</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">Toggle · Drag to reorder</p>
                    </div>
                    <DropdownMenuSeparator />
                    <div className="py-1">
                      {orderedColumns.filter((c) => !c.alwaysVisible).map((c) => (
                        <div
                          key={c.id}
                          draggable
                          onDragStart={() => onColDragStart(c.id)}
                          onDragOver={(e) => onColDragOver(e, c.id)}
                          onDrop={(e) => onColDrop(e, c.id)}
                          onDragEnd={onColDragEnd}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded mx-1 cursor-grab active:cursor-grabbing transition-colors select-none ${
                            dragOverId === c.id
                              ? "bg-primary/15 border border-primary/40"
                              : "hover:bg-muted/60"
                          }`}
                        >
                          <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                          <span
                            className="flex-1 text-sm cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); toggleColumn(c.id); }}
                          >
                            {c.label}
                          </span>
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors cursor-pointer ${col(c.id) ? "bg-primary border-primary" : "border-border"}`}
                            onClick={(e) => { e.stopPropagation(); toggleColumn(c.id); }}
                          >
                            {col(c.id) && <svg className="h-2.5 w-2.5 text-primary-foreground" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        const defaultOrder = ALL_COLUMNS.map((c) => c.id);
                        setColumnOrder(defaultOrder);
                        setVisibleColumns(new Set(DEFAULT_VISIBLE));
                        try {
                          localStorage.setItem("crm_leads_columns", JSON.stringify(Array.from(DEFAULT_VISIBLE)));
                          localStorage.setItem("crm_leads_column_order", JSON.stringify(defaultOrder));
                        } catch { /* ignore */ }
                      }}
                      className="text-xs text-muted-foreground"
                    >
                      Reset to default
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* View mode toggle */}
                <div className="flex items-center rounded-lg border border-border/60 bg-muted/30 p-0.5 gap-0.5">
                  <motion.button
                    whileTap={{ scale: 0.93 }}
                    onClick={() => changeViewMode("table")}
                    title="Table view"
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-all ${viewMode === "table"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                      }`}
                  >
                    <List className="h-3.5 w-3.5" />
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.93 }}
                    onClick={() => changeViewMode("kanban")}
                    title="Kanban view"
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-all ${viewMode === "kanban"
                        ? "bg-background text-primary shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                      }`}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </motion.button>
                </div>

                {hasActiveFilters && (
                  <Button variant="ghost" size="sm" onClick={clearAllFilters} className="gap-1.5 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                    Clear all
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
                  <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">

                    {/* Status */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Status</p>
                      <Select value={status} onValueChange={(v) => applyFilter(setStatus, v)}>
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="All Status" />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Assigned To — only visible to admins/team leaders */}
                    {isAdmin && filterableUsers.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">Assigned To</p>
                        <Select value={assignedTo} onValueChange={(v) => applyFilter(setAssignedTo, v)}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="All Members" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            <SelectItem value="all">All Members</SelectItem>
                            {filterableUsers.map((u) => (
                              <SelectItem key={u._id} value={u._id}>{u.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Reporter — only visible to super admins */}
                    {showReporterFilter && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">Reporter</p>
                        <Select value={reporter} onValueChange={(v) => applyFilter(setReporter, v)}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="All Reporters" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            <SelectItem value="all">All Reporters</SelectItem>
                            {allUsers.map((u) => (
                              <SelectItem key={u._id} value={u._id}>{u.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Course */}
                    {allCourses.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">Course</p>
                        <Select value={courseId} onValueChange={(v) => applyFilter(setCourseId, v)}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="All Courses" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            <SelectItem value="all">All Courses</SelectItem>
                            {allCourses.map((c) => (
                              <SelectItem key={c._id} value={c._id}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}


                    {/* Demo Scheduled */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Demo Scheduled</p>
                      <Select value={demoScheduled} onValueChange={(v) => applyFilter(setDemoScheduled, v)}>
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="Any" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any</SelectItem>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Demo Attended */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Demo Attended</p>
                      <Select value={demoAttended} onValueChange={(v) => applyFilter(setDemoAttended, v)}>
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="Any" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any</SelectItem>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Team — only visible to super admins */}
                    {isSuperAdmin && (teamsData?.data?.length ?? 0) > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">Team</p>
                        <Select value={teamId} onValueChange={(v) => applyFilter(setTeamId, v)}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="All Teams" />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            <SelectItem value="all">All Teams</SelectItem>
                            {(teamsData?.data ?? []).map((t) => (
                              <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Source */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Source</p>
                      <Select value={source} onValueChange={(v) => applyFilter(setSource, v)}>
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="All Sources" />
                        </SelectTrigger>
                        <SelectContent className="max-h-60">
                          <SelectItem value="all">All Sources</SelectItem>
                          {allSources.map((s) => (
                            <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Lost reason — only a lost lead carries one, so this is disabled
                        unless the status filter lets lost leads through. Enabled but
                        always-empty would look broken in exactly the way this filter
                        used to be. */}
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Lost Reason</p>
                      <Select
                        value={lostReason}
                        onValueChange={(v) => applyFilter(setLostReason, v)}
                        disabled={status !== "all" && status !== "lost"}
                      >
                        <SelectTrigger className="h-9 text-sm">
                          <SelectValue placeholder="All Reasons" />
                        </SelectTrigger>
                        <SelectContent className="max-h-60">
                          <SelectItem value="all">All Reasons</SelectItem>
                          {LOST_REASONS.map((r) => (
                            <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="md:block hidden"></div>
                    <div className="space-y-2 ">
                      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" />
                        Last Follow-up Date
                      </p>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="date"
                          value={followupFrom}
                          max={followupTo || undefined}
                          onChange={(e) => { setFollowupFrom(e.target.value); setPage(1); }}
                          className="h-9 text-xs px-2 flex-1 [color-scheme:dark]"
                        />
                        <span className="text-xs text-muted-foreground shrink-0">to</span>
                        <Input
                          type="date"
                          value={followupTo}
                          min={followupFrom || undefined}
                          onChange={(e) => { setFollowupTo(e.target.value); setPage(1); }}
                          className="h-9 text-xs px-2 flex-1 [color-scheme:dark]"
                        />
                      </div>
                    </div>
                    {/* Split Date (assigned) */}
                    <div className="space-y-2">
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
                          className="h-9 text-xs px-2 flex-1 [color-scheme:dark]"
                        />
                        <span className="text-xs text-muted-foreground shrink-0">to</span>
                        <Input
                          type="date"
                          value={splitTo}
                          min={splitFrom || undefined}
                          onChange={(e) => { setSplitTo(e.target.value); setPage(1); }}
                          className="h-9 text-xs px-2 flex-1 [color-scheme:dark]"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/70">Shows leads split in this range, even if created earlier.</p>
                    </div>
                    {/* Date Range */}
                    <div className="space-y-2 md:translate-x-20">
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
                            if (period === "week") { const m = new Date(now); m.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return { f: toGstDateISO(m), t }; }
                            if (period === "month") return { f: toGstDateISO(new Date(now.getFullYear(), now.getMonth(), 1)), t };
                            return { f: toGstDateISO(new Date(now.getFullYear(), 0, 1)), t };
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


                    {/* Last Follow-up Date Range */}

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
                  <FilterPill label={`Search: "${debouncedSearch}"`} onRemove={() => { setSearch(""); setDebouncedSearch(""); setPage(1); }} />
                )}
                {status !== "all" && (
                  <FilterPill label={`Status: ${STATUS_LABELS[status as LeadStatus]}`} onRemove={() => applyFilter(setStatus, "all")} />
                )}
                {assignedTo !== "all" && (
                  <FilterPill label={`Assigned: ${userName(assignedTo)}`} onRemove={() => applyFilter(setAssignedTo, "all")} />
                )}
                {reporter !== "all" && (
                  <FilterPill label={`Reporter: ${userName(reporter)}`} onRemove={() => applyFilter(setReporter, "all")} />
                )}
                {courseId !== "all" && (
                  <FilterPill
                    label={`Course: ${allCourses.find((c) => c._id === courseId)?.name ?? courseId}`}
                    onRemove={() => applyFilter(setCourseId, "all")}
                  />
                )}
                {teamId !== "all" && (
                  <FilterPill
                    label={`Team: ${teamsData?.data?.find((t) => t._id === teamId)?.name ?? teamId}`}
                    onRemove={() => applyFilter(setTeamId, "all")}
                  />
                )}
                {source !== "all" && (
                  <FilterPill
                    label={`Source: ${source}`}
                    onRemove={() => applyFilter(setSource, "all")}
                  />
                )}
                {dateFrom && (
                  <FilterPill label={`From: ${dateFrom}`} onRemove={() => { setDateFrom(""); setPage(1); }} />
                )}
                {dateTo && (
                  <FilterPill label={`To: ${dateTo}`} onRemove={() => { setDateTo(""); setPage(1); }} />
                )}
                {followupFrom && (
                  <FilterPill label={`Followup From: ${followupFrom}`} onRemove={() => { setFollowupFrom(""); setPage(1); }} />
                )}
                {followupTo && (
                  <FilterPill label={`Followup To: ${followupTo}`} onRemove={() => { setFollowupTo(""); setPage(1); }} />
                )}
                {demoScheduled !== "all" && (
                  <FilterPill label={`Demo Scheduled: ${demoScheduled === "true" ? "Yes" : "No"}`} onRemove={() => applyFilter(setDemoScheduled, "all")} />
                )}
                {demoAttended !== "all" && (
                  <FilterPill label={`Demo Attended: ${demoAttended === "true" ? "Yes" : "No"}`} onRemove={() => applyFilter(setDemoAttended, "all")} />
                )}
              </motion.div>
            )}
          </CardHeader>

          {/* ── Kanban Board ───────────────────────────────────────────────────── */}
          {viewMode === "kanban" && (
            <CardContent className="px-3 sm:px-4 pt-4 pb-3 overflow-hidden">
              <KanbanBoard
                filters={{
                  ...(debouncedSearch ? { search: debouncedSearch } : {}),
                  ...(status !== "all" ? { status } : {}),
                  ...(assignedTo !== "all" ? { assignedTo } : {}),
                  ...(reporter !== "all" ? { reporter } : {}),
                  ...(courseId !== "all" ? { course: courseId } : {}),
                  ...(teamId !== "all" ? { team: teamId } : {}),
                  ...(source !== "all" ? { source } : {}),
                  ...(lostReason !== "all" ? { lostReason } : {}),
                  ...(dateFrom ? { dateFrom } : {}),
                  ...(dateTo ? { dateTo } : {}),
                }}
                canEdit={canEdit}
              />
            </CardContent>
          )}

          {/* ── Table ──────────────────────────────────────────────────────────── */}
          {viewMode === "table" && (
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : leads.length === 0 ? (
                <div className="py-20 text-center">
                  <FileText className="mx-auto h-12 w-12 text-muted-foreground/30 mb-3" />
                  <p className="text-muted-foreground font-medium">No leads found</p>
                  <p className="text-sm text-muted-foreground/60 mt-1">
                    {hasActiveFilters ? "Try adjusting your filters" : "Create your first lead to get started"}
                  </p>
                  {canCreate && !hasActiveFilters && (
                    <Button variant="outline" className="mt-4" onClick={handleCreate}>
                      <Plus className="h-4 w-4 mr-1" /> Create first lead
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  {/* ── Mobile card list (< sm) ─────────────────────────────────── */}
                  <div className="sm:hidden divide-y divide-border">
                    {/* Select-all row */}
                    <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/20">
                      <Checkbox
                        checked={leads.length > 0 && leads.every((l) => selectedIds.has(l._id))}
                        onCheckedChange={() => toggleAll(leads.map((l) => l._id))}
                        aria-label="Select all"
                      />
                      <span className="text-xs text-muted-foreground font-medium">Select all on this page</span>
                    </div>
                    <AnimatePresence>
                      {leads.map((lead, i) => (
                        <motion.div
                          key={lead._id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{ delay: i * 0.025 }}
                          className={`px-4 py-3 transition-colors ${selectedIds.has(lead._id) ? "bg-primary/5" : ""}`}
                        >
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={selectedIds.has(lead._id)}
                              onCheckedChange={() => toggleId(lead._id)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Select lead"
                              className="mt-0.5 shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              {/* Name + status */}
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <p className="font-medium text-sm truncate">{lead.name}</p>
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    disabled={getUserId(lead.assignedTo as User | string | null) !== user?._id && !isAdmin}
                                    asChild
                                  >
                                    <button className="flex items-center gap-0.5 shrink-0">
                                      <StatusBadge status={lead.status} />
                                      <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((s) => (
                                      <DropdownMenuItem
                                        key={s}
                                        onClick={() => handleStatusChange(lead, s)}
                                        className={lead.status === s ? "font-semibold" : ""}
                                      >
                                        <StatusBadge status={s} />
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                              {/* Contact */}
                              {lead.email && <p className="text-xs text-muted-foreground mt-0.5 truncate">{lead.email}</p>}
                              {lead.phone && <p className="text-xs text-muted-foreground/70">{lead.phone}</p>}
                              {/* Meta row */}
                              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5">
                                {lead.team && (
                                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                                    {typeof lead.team === "object" ? lead.team.name : lead.team}
                                  </span>
                                )}
                                {lead.assignedTo && (
                                  <span className="text-[11px] text-muted-foreground">
                                    {getUserName(lead.assignedTo as User | string | null)}
                                    {lead.assignedAt && (
                                      <span className="ml-1 text-muted-foreground/50">
                                        · {new Date(lead.assignedAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true })}
                                      </span>
                                    )}
                                  </span>
                                )}
                                {lead.source && (
                                  <span className="text-[11px] text-muted-foreground/60 capitalize">{lead.source}</span>
                                )}
                              </div>
                              {/* Demo / Followup row */}
                              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1">
                                {lead.lastFollowupDate && (
                                  <span className="text-[11px] text-muted-foreground">
                                    Followup: {new Date(lead.lastFollowupDate).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" })}
                                  </span>
                                )}
                                {(lead.callCount ?? 0) > 0 && <CallCounts lead={lead} />}
                                {lead.demoScheduled && (
                                  <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-400">Demo Scheduled</span>
                                )}
                                {lead.demoAttended && (
                                  <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-400">Demo Attended</span>
                                )}
                              </div>
                            </div>
                            {/* Actions — wrap three to a row so the lead's details keep their width on a phone */}
                            <div className="flex flex-wrap items-center justify-end gap-0.5 shrink-0 max-w-[6.5rem]">
                              {lead.phone && (
                                <ClickToCall
                                  phoneNumber={lead.phone}
                                  leadId={lead._id}
                                  leadName={lead.name}
                                />
                              )}
                              <QuickNoteDialog leadId={lead._id} leadName={lead.name} className="h-8 w-8" />
                              {isSuperAdmin && (
                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleAssign(lead)} title="Assign to">
                                  <UserPlus className="h-4 w-4" />
                                </Button>
                              )}
                              <Link href={`/leads/${lead._id}`}>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" title="View">
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </Link>
                              {canEdit && (
                                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleEdit(lead)} title="Edit">
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
                              {canDelete && (
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(lead)} title="Delete">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>

                  {/* ── Desktop table (≥ sm) ────────────────────────────────────── */}
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          <th className="pl-4 pr-2 py-3 w-10">
                            <Checkbox
                              checked={leads.length > 0 && leads.every((l) => selectedIds.has(l._id))}
                              onCheckedChange={() => toggleAll(leads.map((l) => l._id))}
                              aria-label="Select all"
                            />
                          </th>
                          {orderedColumns.map((c) => renderColHeader(c.id))}
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <AnimatePresence>
                          {leads.map((lead, i) => (
                            <motion.tr
                              key={lead._id}
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: 8 }}
                              transition={{ delay: i * 0.025 }}
                              className={`group hover:bg-muted/20 transition-colors ${selectedIds.has(lead._id) ? "bg-primary/5" : ""}`}
                            >
                              <td className="pl-4 pr-2 py-4">
                                <Checkbox
                                  checked={selectedIds.has(lead._id)}
                                  onCheckedChange={() => toggleId(lead._id)}
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label="Select lead"
                                />
                              </td>
                              {orderedColumns.map((c) => renderColCell(c.id, lead))}

                              <td className="px-4 py-4">
                                <div className="flex items-center justify-end gap-1">
                                  {lead.phone && (
                                    <ClickToCall
                                      phoneNumber={lead.phone}
                                      leadId={lead._id}
                                      leadName={lead.name}
                                      className="md:opacity-0 group-hover:opacity-100"
                                    />
                                  )}
                                  <QuickNoteDialog
                                    leadId={lead._id}
                                    leadName={lead.name}
                                    className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity"
                                  />
                                  {isSuperAdmin && (
                                    <Button
                                      variant="ghost" size="icon"
                                      className="h-8 w-8 md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                      onClick={() => handleAssign(lead)}
                                      title="Assign to"
                                    >
                                      <UserPlus className="h-4 w-4" />
                                    </Button>
                                  )}
                                  <Link href={`/leads/${lead._id}`}>
                                    <Button
                                      variant="ghost" size="icon"
                                      className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity text-primary hover:text-primary"
                                      title="View Detail"
                                    >
                                      <ExternalLink className="h-4 w-4" />
                                    </Button>
                                  </Link>
                                  {canEdit && (
                                    <Button
                                      variant="ghost" size="icon"
                                      className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity"
                                      onClick={() => handleEdit(lead)}
                                      title="Edit"
                                    >
                                      <Pencil className="h-4 w-4" />
                                    </Button>
                                  )}
                                  {canDelete && (
                                    <Button
                                      variant="ghost" size="icon"
                                      className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                      onClick={() => handleDelete(lead)}
                                      title="Delete"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </motion.tr>
                          ))}
                        </AnimatePresence>
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* ── Pagination ──────────────────────────────────────────────────── */}
              {pagination && pagination.totalPages >= 1 && (
                <div className="flex items-center justify-between border-t border-border px-4 sm:px-6 py-3 sm:py-4 gap-2 flex-wrap">
                  <div className="flex items-center gap-3">
                    <p className="text-xs sm:text-sm text-muted-foreground">
                      {pagination.total === 0 ? "No leads" : (
                        <>
                          <span className="hidden sm:inline">Showing </span>
                          <span className="font-medium text-foreground">
                            {(pagination.page - 1) * pagination.limit + 1}–
                            {Math.min(pagination.page * pagination.limit, pagination.total)}
                          </span>
                          <span className="hidden sm:inline"> of </span>
                          <span className="sm:hidden"> / </span>
                          <span className="font-medium text-foreground">{pagination.total}</span>
                          <span className="hidden sm:inline"> leads</span>
                        </>
                      )}
                    </p>
                    <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setPage(1); }}>
                      <SelectTrigger className="h-7 w-[70px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[10, 25, 50, 100, 200, 300].map((n) => (
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
                      <span className="text-sm font-medium">
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
          )}
        </Card>
      </motion.div>

      {/* ── Dialogs ────────────────────────────────────────────────────────────── */}
      <LeadDialog open={dialogOpen} onOpenChange={setDialogOpen} lead={selectedLead} />
      <DeleteLeadDialog open={deleteOpen} onOpenChange={setDeleteOpen} lead={selectedLead} />
      <AssignLeadDialog open={assignOpen} onOpenChange={setAssignOpen} lead={selectedLead} />

      {/* Single-lead lost reason modal */}
      <LostReasonModal
        open={lostModalOpen}
        leadName={lostModalLead?.name}
        loading={updateStatusPending}
        onConfirm={(reason, notes) => {
          if (!lostModalLead) return;
          updateStatus(
            { id: lostModalLead._id, status: "lost", lostReason: reason, lostNotes: notes || undefined },
            { onSettled: () => { setLostModalOpen(false); setLostModalLead(null); } },
          );
        }}
        onCancel={() => { setLostModalOpen(false); setLostModalLead(null); }}
      />

      {/* Bulk lost reason modal */}
      <LostReasonModal
        open={bulkLostModalOpen}
        leadName={`${selectedIds.size} lead(s)`}
        loading={bulkUpdateStatus.isPending}
        onConfirm={(reason, notes) => {
          bulkUpdateStatus.mutate(
            { leadIds: Array.from(selectedIds), status: "lost", lostReason: reason, lostNotes: notes || undefined },
            { onSettled: () => { setBulkLostModalOpen(false); setSelectedIds(new Set()); } },
          );
        }}
        onCancel={() => setBulkLostModalOpen(false)}
      />

      {/* Single-lead follow-up details modal */}
      <FollowupDetailsModal
        open={followupModalOpen}
        leadName={followupModalLead?.name}
        loading={updateStatusPending}
        onConfirm={(d) => {
          if (!followupModalLead) return;
          updateStatus(
            { id: followupModalLead._id, status: "followup", ...d },
            { onSettled: () => { setFollowupModalOpen(false); setFollowupModalLead(null); } },
          );
        }}
        onCancel={() => { setFollowupModalOpen(false); setFollowupModalLead(null); }}
      />

      {/* Single-lead meeting time — mandatory for Meeting Scheduled; becomes a reminder */}
      <MeetingScheduledModal
        open={!!meetingModalLead}
        leadName={meetingModalLead?.name}
        loading={updateStatusPending}
        onConfirm={(d) => {
          if (!meetingModalLead) return;
          updateStatus(
            { id: meetingModalLead._id, status: "meeting_scheduled", ...d },
            { onSuccess: () => setMeetingModalLead(null) },
          );
        }}
        onCancel={() => setMeetingModalLead(null)}
      />

      {/* Bulk follow-up details modal */}
      <FollowupDetailsModal
        open={bulkFollowupModalOpen}
        leadName={`${selectedIds.size} lead(s)`}
        loading={bulkUpdateStatus.isPending}
        onConfirm={(d) => {
          bulkUpdateStatus.mutate(
            { leadIds: Array.from(selectedIds), status: "followup", ...d },
            { onSettled: () => { setBulkFollowupModalOpen(false); setSelectedIds(new Set()); } },
          );
        }}
        onCancel={() => setBulkFollowupModalOpen(false)}
      />

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
            <Select value={bulkStatus} onValueChange={(v) => setBulkStatus(v as LeadStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Not Meeting Scheduled: each lead needs its own meeting time */}
                {(Object.keys(STATUS_LABELS) as LeadStatus[]).filter((s) => s !== "meeting_scheduled").map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkStatusOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={bulkUpdateStatus.isPending}
              onClick={() => {
                if (bulkStatus === "lost") {
                  setBulkStatusOpen(false);
                  setBulkLostModalOpen(true);
                } else if (bulkStatus === "followup") {
                  setBulkStatusOpen(false);
                  setBulkFollowupModalOpen(true);
                } else if (bulkStatus === "closed") {
                  // Closed only through each lead's enrolment, one after another.
                  setBulkStatusOpen(false);
                  setCloseQueue(Array.from(selectedIds));
                } else {
                  bulkUpdateStatus.mutate(
                    { leadIds: Array.from(selectedIds), status: bulkStatus },
                    { onSuccess: () => { setBulkStatusOpen(false); setSelectedIds(new Set()); } },
                  );
                }
              }}
            >
              {bulkUpdateStatus.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Apply
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Bulk: Assign to Team ──────────────────────────────────────────────── */}
      <ResponsiveDialog open={bulkTeamOpen} onOpenChange={setBulkTeamOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Assign to Team
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Assigning{" "}
              <span className="font-semibold text-foreground">{selectedIds.size}</span> lead(s) to a team.
              Current member assignment will be cleared.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="px-4 sm:px-0 py-2 space-y-3">
            <Select value={bulkTeamId} onValueChange={setBulkTeamId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a team" />
              </SelectTrigger>
              <SelectContent>
                {(teamsData?.data ?? []).map((t) => (
                  <SelectItem key={t._id} value={t._id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkTeamOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!bulkTeamId || bulkAssignTeam.isPending}
              onClick={() => {
                if (!bulkTeamId) return;
                bulkAssignTeam.mutate(
                  { leadIds: Array.from(selectedIds), teamId: bulkTeamId },
                  { onSuccess: () => { setBulkTeamOpen(false); setSelectedIds(new Set()); setBulkTeamId(""); } },
                );
              }}
            >
              {bulkAssignTeam.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Assign
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Bulk: Delete confirm ──────────────────────────────────────────────── */}
      <ResponsiveDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete {selectedIds.size} Lead(s)?
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              This permanently deletes the selected leads and all their notes and activity logs.
              This action <span className="font-semibold text-foreground">cannot be undone</span>.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={bulkDeleteLeads.isPending}
              onClick={() => {
                bulkDeleteLeads.mutate(Array.from(selectedIds), {
                  onSuccess: () => { setBulkDeleteOpen(false); setSelectedIds(new Set()); },
                });
              }}
            >
              {bulkDeleteLeads.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Delete
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {/* ── Floating Bulk Action Bar ─────────────────────────────────────────── */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="fixed bottom-4 sm:bottom-6 left-1/4 sm:left-1/2 z-50 -translate-x-1/2  sm:w-auto max-w-lg"
          >
            <div className="flex items-center gap-1 sm:gap-2 rounded-2xl border border-border/60 bg-card/95 backdrop-blur-md shadow-2xl px-3 sm:px-4 py-2.5 sm:py-3">
              <div className="flex items-center gap-1.5 pr-2.5 sm:pr-3 border-r border-border shrink-0">
                <CheckSquare className="h-4 w-4 text-primary" />
                <span className="text-xs sm:text-sm font-semibold text-foreground whitespace-nowrap">
                  {selectedIds.size}
                  <span className="hidden sm:inline"> selected</span>
                </span>
              </div>

              {/* Change Status */}
              {canEdit && (
                <Button
                  variant="ghost" size="sm"
                  className="gap-1 h-8 text-xs px-2 sm:px-3 text-foreground hover:bg-muted"
                  onClick={() => setBulkStatusOpen(true)}
                >
                  <Tags className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Status</span>
                </Button>
              )}

              {/* Assign to Team */}
              {(isSuperAdmin || isTeamLeader) && (
                <Button
                  variant="ghost" size="sm"
                  className="gap-1 h-8 text-xs px-2 sm:px-3 text-foreground hover:bg-muted"
                  onClick={() => setBulkTeamOpen(true)}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Assign Team</span>
                </Button>
              )}

              {/* Delete */}
              {canDelete && (
                <Button
                  variant="ghost" size="sm"
                  className="gap-1 h-8 text-xs px-2 sm:px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline">Delete</span>
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

      {/* ── Create Student Modal ──────────────────────────────────────────────── */}
      {/* Dismissing is not closing: ✕ or Escape leaves the lead's status alone.
          A lead marked closed with no enrolment behind it is one finance and
          the LMS never hear about. */}
      {studentModalLead && (
        <CloseLeadDialog
          key={studentModalLead._id}
          lead={studentModalLead}
          onClose={() => { setStudentModalLead(null); setPendingStatus(null); }}
          onClosed={() => {
            if (pendingStatus) updateStatus({ id: pendingStatus.lead._id, status: pendingStatus.status });
            setStudentModalLead(null);
            setPendingStatus(null);
          }}
        />
      )}

      {/* ── Several leads closed at once: an enrolment each ─────────────────── */}
      {closeQueue && (
        <CloseLeadsQueue
          leadIds={closeQueue}
          markClosed={(id) => updateStatusAsync({ id, status: "closed" })}
          onDone={({ closed, skipped }) => {
            setCloseQueue(null);
            setSelectedIds(new Set());
            if (skipped) toast.info(`${closed} closed · ${skipped} left as they were — no enrolment saved`);
          }}
        />
      )}
    </div>
  );
}

export default function LeadsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <LeadsPageContent />
    </Suspense>
  );
}

