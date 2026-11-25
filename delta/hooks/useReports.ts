import { useQuery } from "@tanstack/react-query";
import api from "@/lib/axios";
import type {
  OverviewReport,
  TimelinePoint,
  UserRankItem,
  TeamRankItem,
  TimelinePeriod,
  TeamSplitReport,
  SplitPeriod,
  RevenuePeriod,
  RevenueOverview,
  RevenueTimelineReport,
  RevenueTeamDetail,
  SourceAnalyticsItem,
  CampaignBreakdownItem,
} from "@/types/reports";

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export function useReportOverview(dateFrom: string, dateTo: string) {
  return useQuery<OverviewReport>({
    queryKey: ["reports", "overview", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<OverviewReport>>(
        `/reports/overview?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export function useReportTimeline(
  period: TimelinePeriod,
  dateFrom: string,
  dateTo: string,
) {
  return useQuery<TimelinePoint[]>({
    queryKey: ["reports", "timeline", period, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<TimelinePoint[]>>(
        `/reports/timeline?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── User Rankings ─────────────────────────────────────────────────────────────

export function useReportUserRankings(dateFrom: string, dateTo: string) {
  return useQuery<UserRankItem[]>({
    queryKey: ["reports", "users", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "20" });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<UserRankItem[]>>(
        `/reports/users?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Team Rankings ─────────────────────────────────────────────────────────────

export function useReportTeamRankings(dateFrom: string, dateTo: string) {
  return useQuery<TeamRankItem[]>({
    queryKey: ["reports", "teams", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<TeamRankItem[]>>(
        `/reports/teams?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Team Split ────────────────────────────────────────────────────────────────

export function useReportTeamSplit(
  period: SplitPeriod,
  dateFrom: string,
  dateTo: string,
) {
  return useQuery<TeamSplitReport>({
    queryKey: ["reports", "team-split", period, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<TeamSplitReport>>(
        `/reports/team-split?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Revenue Overview ──────────────────────────────────────────────────────────

export function useRevenueOverview(dateFrom: string, dateTo: string) {
  return useQuery<RevenueOverview>({
    queryKey: ["reports", "revenue", "overview", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<RevenueOverview>>(
        `/reports/revenue/overview?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Old books (2026-11-25) ────────────────────────────────────────────────────

/** One payment from finance's old books counted for a salesperson here. */
export interface OldBooksRow {
  invoiceNumber: string; customerName: string; course: string; userId: string; name: string;
  amount: number; paidAt: string; paidInFull: boolean;
}
export interface OldBooksReport { total: number; count: number; rows: OldBooksRow[] }

/** Finance's old books counted here in the range — already inside every revenue figure; this lists them. */
export function useOldBooks(dateFrom: string, dateTo: string) {
  return useQuery<OldBooksReport>({
    queryKey: ["reports", "old-books", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<OldBooksReport>>(`/reports/old-books?${params}`);
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Revenue Timeline ──────────────────────────────────────────────────────────

export function useRevenueTimeline(
  period: RevenuePeriod,
  dateFrom: string,
  dateTo: string,
) {
  return useQuery<RevenueTimelineReport>({
    queryKey: ["reports", "revenue", "timeline", period, dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<RevenueTimelineReport>>(
        `/reports/revenue/timeline?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Source Analytics ──────────────────────────────────────────────────────────

export function useSourceAnalytics(dateFrom: string, dateTo: string, teamId?: string) {
  return useQuery<SourceAnalyticsItem[]>({
    queryKey: ["reports", "sources", dateFrom, dateTo, teamId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      if (teamId)   params.set("team",     teamId);
      const { data } = await api.get<ApiResponse<SourceAnalyticsItem[]>>(
        `/reports/sources?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

export function useCampaignBreakdown(source: string, dateFrom: string, dateTo: string) {
  return useQuery<CampaignBreakdownItem[]>({
    queryKey: ["reports", "sources", source, "campaigns", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<CampaignBreakdownItem[]>>(
        `/reports/sources/${encodeURIComponent(source)}/campaigns?${params}`,
      );
      return data.data;
    },
    enabled: !!source,
    staleTime: 60_000,
  });
}

// ── Revenue Teams (with member breakdown) ─────────────────────────────────────

export function useRevenueTeams(dateFrom: string, dateTo: string) {
  return useQuery<RevenueTeamDetail[]>({
    queryKey: ["reports", "revenue", "teams", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo)   params.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<RevenueTeamDetail[]>>(
        `/reports/revenue/teams?${params}`,
      );
      return data.data;
    },
    staleTime: 60_000,
  });
}

// ── Response Time SLA ──────────────────────────────────────────────────────────

export interface ResponseTimeAgent {
  agentId: string;
  agentName: string;
  agentEmail?: string;
  totalAssigned: number;
  totalContacted: number;
  totalWithinSla: number;
  slaComplianceRate: number;
  avgResponseMinutes: number | null;
  minResponseMinutes: number | null;
  maxResponseMinutes: number | null;
  notContactedCount: number;
}

export interface ResponseTimeBreachedLead {
  _id: string;
  name: string;
  phone: string;
  source?: string;
  status: string;
  assignedAt: string;
  assignedTo?: { _id: string; name: string; email: string };
  course?: { _id: string; name: string };
  minutesSinceAssign: number | null;
}

export interface ResponseTimeReport {
  summary: {
    slaMinutes: number;
    totalAssigned: number;
    totalContacted: number;
    notContacted: number;
    totalWithinSla: number;
    overallSlaRate: number;
    overallAvgResponseMinutes: number;
  };
  agentRanking: ResponseTimeAgent[];
  breachedLeads: ResponseTimeBreachedLead[];
}

export function useResponseTimeReport(params: {
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
  slaMinutes?: number;
}) {
  const { teamId, dateFrom, dateTo, slaMinutes } = params;
  return useQuery<ResponseTimeReport>({
    queryKey: ["reports", "response-time", teamId, dateFrom, dateTo, slaMinutes],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)     p.set("teamId", teamId);
      if (dateFrom)   p.set("dateFrom", dateFrom);
      if (dateTo)     p.set("dateTo", dateTo);
      if (slaMinutes) p.set("slaMinutes", String(slaMinutes));
      const { data } = await api.get<ApiResponse<ResponseTimeReport>>(`/reports/response-time?${p}`);
      return data.data as ResponseTimeReport;
    },
    staleTime: 60_000,
  });
}

// ── Lead Timing Report — per-lead assigned / responded / follow-up times ──────

export interface LeadTimingRow {
  _id: string;
  name: string;
  phone?: string;
  source: string | null;
  status: string;
  agent: string | null;
  team: string | null;
  assignedAt: string | null;
  respondedAt: string | null;
  followUpAt: string | null;
  nextFollowUpAt: string | null;
  responseMinutes: number | null;
  followUpMinutes: number | null;
}

export interface LeadTimingReport {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  leads: LeadTimingRow[];
}

export function useLeadTimingReport(params: {
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  const { teamId, dateFrom, dateTo, page = 1, limit = 25 } = params;
  return useQuery<LeadTimingReport>({
    queryKey: ["reports", "lead-timing", teamId, dateFrom, dateTo, page, limit],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId", teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo", dateTo);
      p.set("page", String(page));
      p.set("limit", String(limit));
      const { data } = await api.get<ApiResponse<LeadTimingReport>>(`/reports/lead-timing?${p}`);
      return data.data as LeadTimingReport;
    },
    staleTime: 60_000,
  });
}

// ── Follow-Up Report ───────────────────────────────────────────────────────────

export interface FollowUpAgentRank {
  agentId: string;
  agentName: string;
  agentEmail?: string;
  totalFollowUps: number;
  uniqueLeads: number;
  lastFollowUp?: string;
}

export interface FollowUpLeadBreakdown {
  _id: string;
  name: string;
  phone: string;
  status: string;
  source?: string;
  nextFollowUpAt?: string | null;
  followUpCount: number;
  totalFollowUpsAllTime: number;
  lastFollowUpAt?: string;
  agentName: string;
  agentEmail?: string;
}

export interface FollowUpOverdueLead {
  _id: string;
  name: string;
  phone: string;
  source?: string;
  status: string;
  nextFollowUpAt: string;
  assignedTo?: { _id: string; name: string; email: string };
  course?: { _id: string; name: string };
  overdueByMinutes: number | null;
  totalFollowUps: number;
}

export interface FollowUpReport {
  summary: {
    totalFollowUps: number;
    totalAgentsTracked: number;
    overdueCount: number;
    leadsWithFollowUps: number;
  };
  agentRanking: FollowUpAgentRank[];
  leadBreakdown: FollowUpLeadBreakdown[];
  overdueLeads: FollowUpOverdueLead[];
}

export function useFollowUpReport(params: {
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const { teamId, dateFrom, dateTo } = params;
  return useQuery<FollowUpReport>({
    queryKey: ["reports", "followups", teamId, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<FollowUpReport>>(`/reports/followups?${p}`);
      return data.data as FollowUpReport;
    },
    staleTime: 60_000,
  });
}

// ── Pipeline Breakdown ─────────────────────────────────────────────────────────

export interface PipelineStage {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
}

export interface PipelineTrendPoint {
  month: string;
  total: number;
  contacted: number;
  followUp: number;
  interested: number;
  notInterested: number;
  lost: number;
  converted: number;
}

export interface PipelineBreakdown {
  total: number;
  stages: PipelineStage[];
  trend: PipelineTrendPoint[];
}

export function usePipelineBreakdown(params: {
  teamId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const { teamId, dateFrom, dateTo } = params;
  return useQuery<PipelineBreakdown>({
    queryKey: ["reports", "pipeline", teamId, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<PipelineBreakdown>>(`/reports/pipeline?${p}`);
      return data.data as PipelineBreakdown;
    },
    staleTime: 60_000,
  });
}

// ── Lead Quality Report ────────────────────────────────────────────────────────

export interface LeadQualityCampaign {
  source:             string;
  campaign:           string;
  total:              number;
  converted:          number;
  contacted:          number;
  withFollowUp:       number;
  lost:               number;
  conversionRate:     number;
  contactRate:        number;
  followUpRate:       number;
  lostRate:           number;
  avgResponseMinutes: number | null;
  qualityScore:       number;
}

export interface LeadQualitySourceSummary {
  source:          string;
  total:           number;
  avgQualityScore: number;
  converted:       number;
  lost:            number;
  conversionRate:  number;
  lostRate:        number;
}

export interface LeadQualityReport {
  summary: {
    totalCampaigns:        number;
    totalLeads:            number;
    totalConverted:        number;
    overallConversionRate: number;
    avgQualityScore:       number;
    lowQualityCount:       number;
  };
  campaigns:        LeadQualityCampaign[];
  topCampaigns:     LeadQualityCampaign[];
  sourceSummary:    LeadQualitySourceSummary[];
  lowQualitySources: LeadQualitySourceSummary[];
}

export function useLeadQualityReport(params: {
  teamId?:  string;
  dateFrom?: string;
  dateTo?:  string;
}) {
  const { teamId, dateFrom, dateTo } = params;
  return useQuery<LeadQualityReport>({
    queryKey: ["reports", "lead-quality", teamId, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<LeadQualityReport>>(`/reports/lead-quality?${p}`);
      return data.data as LeadQualityReport;
    },
    staleTime: 60_000,
  });
}

// ── Sales Funnel ───────────────────────────────────────────────────────────────

export interface FunnelStage {
  key:      string;
  label:    string;
  count:    number;
  pct:      number;
  dropPct:  number | null;
}

export interface FunnelTeamRow {
  teamId:         string;
  teamName:       string;
  total:          number;
  contacted:      number;
  converted:      number;
  lost:           number;
  conversionRate: number;
  contactRate:    number;
}

export interface FunnelAgentRow {
  agentId:        string;
  agentName:      string;
  total:          number;
  contacted:      number;
  converted:      number;
  inFollowUp:     number;
  conversionRate: number;
}

export interface SalesFunnelReport {
  summary: {
    total:             number;
    contactRate:       number;
    qualificationRate: number;
    followUpRate:      number;
    conversionRate:    number;
    lostRate:          number;
  };
  stages:        FunnelStage[];
  teamBreakdown: FunnelTeamRow[];
  topAgents:     FunnelAgentRow[];
}

export function useSalesFunnel(params: { teamId?: string; dateFrom?: string; dateTo?: string }) {
  const { teamId, dateFrom, dateTo } = params;
  return useQuery<SalesFunnelReport>({
    queryKey: ["reports", "funnel", teamId, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<SalesFunnelReport>>(`/reports/funnel?${p}`);
      return data.data as SalesFunnelReport;
    },
    staleTime: 60_000,
  });
}

// ── Management Alerts ──────────────────────────────────────────────────────────

export interface AlertLead {
  _id:              string;
  name:             string;
  phone:            string;
  source?:          string;
  status:           string;
  assignedAt?:      string;
  nextFollowUpAt?:  string;
  assignedTo?:      { _id: string; name: string; email: string };
  team?:            { _id: string; name: string };
  hoursUncontacted?:  number | null;
  overdueByMinutes?:  number | null;
}

export interface ManagementAlertsReport {
  summary: {
    uncontactedCount:  number;
    overdueFollowUps:  number;
    lostRecent:        number;
    lostPrev:          number;
    lostSpikePct:      number;
    hasSpikeAlert:     boolean;
  };
  uncontacted:      AlertLead[];
  overdueFollowUps: AlertLead[];
}

export function useManagementAlerts(params: { teamId?: string; uncontactedHours?: number }) {
  const { teamId, uncontactedHours } = params;
  return useQuery<ManagementAlertsReport>({
    queryKey: ["reports", "alerts", teamId, uncontactedHours],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)            p.set("teamId",           teamId);
      if (uncontactedHours)  p.set("uncontactedHours", String(uncontactedHours));
      const { data } = await api.get<ApiResponse<ManagementAlertsReport>>(`/reports/alerts?${p}`);
      return data.data as ManagementAlertsReport;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ── Audit & Transparency ───────────────────────────────────────────────────────

export interface AuditEvent {
  _id:         string;
  leadId:      string;
  leadName:    string;
  leadPhone:   string;
  action:      string;
  description: string;
  changes?:    Record<string, { from: unknown; to: unknown }>;
  createdAt:   string;
  performedBy?: { _id: string; name: string; email: string };
}

export interface AuditReport {
  total:   number;
  summary: Record<string, number>;
  events:  AuditEvent[];
}

export function useAuditReport(params: { teamId?: string; dateFrom?: string; dateTo?: string; action?: string }) {
  const { teamId, dateFrom, dateTo, action } = params;
  return useQuery<AuditReport>({
    queryKey: ["reports", "audit", teamId, dateFrom, dateTo, action],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      if (action)   p.set("action",   action);
      const { data } = await api.get<ApiResponse<AuditReport>>(`/reports/audit?${p}`);
      return data.data as AuditReport;
    },
    staleTime: 30_000,
  });
}

// ── Member Split Report ────────────────────────────────────────────────────────

export interface MemberSplitRow {
  rank:           number;
  memberId:       string;
  memberName:     string;
  total:          number;
  closed:         number;
  lost:           number;
  followup:       number;
  new_assigned:   number;
  conversionRate: number;
}

export interface DailyAssignmentPoint {
  date:  string;
  count: number;
}

export interface SourceTableRow {
  source: string;
  total:  number;
  [memberName: string]: number | string;
}

export interface MemberSplitReport {
  members:       MemberSplitRow[];
  daily:         DailyAssignmentPoint[];
  sourceTable:   SourceTableRow[];
  sourceMembers: string[];
  totalAssigned: number;
}

export function useMemberSplitReport(params: { teamId?: string; dateFrom?: string; dateTo?: string }) {
  const { teamId, dateFrom, dateTo } = params;
  return useQuery<MemberSplitReport>({
    queryKey: ["reports", "member-split", teamId, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (teamId)   p.set("teamId",   teamId);
      if (dateFrom) p.set("dateFrom", dateFrom);
      if (dateTo)   p.set("dateTo",   dateTo);
      const { data } = await api.get<ApiResponse<MemberSplitReport>>(`/reports/member-split?${p}`);
      return data.data as MemberSplitReport;
    },
    staleTime: 60_000,
  });
}
