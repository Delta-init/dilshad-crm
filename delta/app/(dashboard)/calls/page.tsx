"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download, Loader2, PhoneCall, PhoneIncoming,
  PhoneMissed, PhoneOff, PhoneOutgoing, PlugZap, RefreshCw, Search, Timer, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { dubaiDate } from "@/lib/dubaiDates";
import { useAuthStore } from "@/lib/store/authStore";
import { ClickToCall } from "@/components/leads/ClickToCall";
import {
  useCallLog, useSyncCallsNow, fetchCallLogForExport, type CallLogFilters, type ThreecxCall,
} from "@/hooks/useCalls";
import {
  CallPerson, CallResult, RecordingPlayer, SyncNote, RESULTS, fmtClockDuration, fmtTalkTotal, fmtWhen,
} from "@/components/calls/callUi";
import { ThreecxTestDialog } from "@/components/calls/ThreecxTestDialog";

/**
 * Calls (2026-10-14) — every call with a lead through 3CX, synced from 3CX's call log every minute: in or out,
 * connected, missed or not answered, who took it, how long, and the recording. Only these 3CX calls; the older
 * click-to-call / journal logs are not listed here. The server decides whose calls each person sees: their own
 * (and their leads'), their team's, or everyone's. Days are Dubai days.
 */

const PRESETS: { id: NonNullable<CallLogFilters["preset"]>; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];
const PAGE_SIZE = 50;
const ALL = "all";

type Direction = "" | "in" | "out";
type Result = "" | "connected" | "missed" | "not_answered";
type Sort = "date" | "talk" | "ring";

function StatCard({ label, value, hint, icon: Icon, color, active, onClick }: {
  label: string; value: string; hint?: string; icon: React.ElementType; color: string; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={onClick ? (active ? "Show all" : `Show only: ${label.toLowerCase()}`) : undefined}
      className={cn(
        "rounded-xl border bg-card p-4 text-left transition-colors",
        onClick && "hover:bg-muted/40",
        active ? "border-primary ring-1 ring-primary/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn("rounded-lg p-2.5", color)}><Icon className="h-4 w-4" /></div>
        <div className="min-w-0">
          <p className="text-xl font-bold tabular-nums">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
      {hint && <p className="mt-2 text-[11px] text-muted-foreground/80">{hint}</p>}
    </button>
  );
}

export default function CallsPage() {
  const canExport = useAuthStore((s) => s.hasPermission("calls", "export"));
  const [preset, setPreset] = useState<NonNullable<CallLogFilters["preset"]>>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [direction, setDirection] = useState<Direction>("");
  const [result, setResult] = useState<Result>("");
  const [person, setPerson] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => setPage(1), [preset, from, to, direction, result, person, search, sort, order]);

  const filters: CallLogFilters = {
    preset, from: preset === "custom" ? from : undefined, to: preset === "custom" ? to : undefined,
    direction, result, person, search, sort, order, page, limit: PAGE_SIZE,
  };
  const { data, isLoading, isFetching, error, refetch } = useCallLog(filters);
  const sync = useSyncCallsNow();
  const [testing, setTesting] = useState(false);

  const calls = data?.calls ?? [];
  const stats = data?.stats;
  const people = data?.people ?? [];
  const pagination = data?.pagination;
  const named = people.filter((p) => p.key !== "-");
  const hasFilters = !!(direction || result || person || search);
  const personName = useMemo(() => people.find((p) => p.key === person)?.name, [people, person]);

  function choosePreset(id: NonNullable<CallLogFilters["preset"]>) {
    if (id === "custom" && !from && !to && data?.period) {
      setFrom(data.period.from);
      setTo(data.period.to);
    }
    setPreset(id);
  }
  function clearFilters() {
    setDirection(""); setResult(""); setPerson(""); setSearchInput(""); setSearch("");
  }
  function sortBy(s: Sort) {
    if (sort === s) setOrder(order === "desc" ? "asc" : "desc");
    else { setSort(s); setOrder("desc"); }
  }

  async function syncNow() {
    try {
      const r = await sync.mutateAsync();
      toast.success(r.message || "Synced");
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || "The sync failed");
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const rows = await fetchCallLogForExport({ ...filters, page: 1 });
      const head = ["When (Dubai)", "Lead", "Number", "Direction", "Result", "Who", "Extension", "Talk (seconds)", "Ring (seconds)", "Recorded"];
      const lines = [head, ...rows.map((c: ThreecxCall) => [
        fmtWhen(c.startedAt), c.leadName, c.number, c.direction === "in" ? "Incoming" : "Outgoing",
        RESULTS[c.status]?.label ?? c.status, c.userName || c.agentName, c.extension, c.talkSeconds, c.ringSeconds, c.recordings ? "yes" : "no",
      ])];
      const csv = lines.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `calls_${data?.period.from || "all"}_${data?.period.to || dubaiDate()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (rows.length < (pagination?.total ?? 0)) toast.warning(`The CSV holds the first ${rows.length.toLocaleString()} calls — pick a shorter period for the rest.`);
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || "Could not export the calls");
    } finally {
      setExporting(false);
    }
  }

  const n = (v?: number) => (v ?? 0).toLocaleString("en-US");
  const SortHead = ({ id, children, right }: { id: Sort; children: React.ReactNode; right?: boolean }) => (
    <th className={cn("px-4 py-2.5 font-medium", right ? "text-right" : "text-left")}>
      <button type="button" onClick={() => sortBy(id)} className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", sort === id && "text-foreground")}>
        {children}
        {sort === id && (order === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
  const dash = <span className="text-muted-foreground/40">—</span>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Calls</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every call with a lead through 3CX — in or out, connected or missed, who took it, how long, and the recording.
          </p>
          <div className="mt-2"><SyncNote threecx={data?.threecx} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
          </Button>
          {/* Super Admin, as Sync now: the connection step by step (2026-10-14). */}
          {data?.canSync && (
            <Button variant="outline" size="sm" onClick={() => setTesting(true)}>
              <PlugZap className="mr-2 h-3.5 w-3.5" /> Test connection
            </Button>
          )}
          {data?.canSync && (
            <Button size="sm" onClick={syncNow} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <PhoneCall className="mr-2 h-3.5 w-3.5" />} Sync now
            </Button>
          )}
        </div>
      </motion.div>

      {/* Period */}
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <Button key={p.id} size="sm" variant={preset === p.id ? "default" : "outline"} className="h-8 text-xs" onClick={() => choosePreset(p.id)}>
            {p.label}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-1.5">
            <Input type="date" value={from} max={to || dubaiDate()} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[150px] text-xs" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={to} min={from} max={dubaiDate()} onChange={(e) => setTo(e.target.value)} className="h-8 w-[150px] text-xs" />
          </div>
        )}
        {data?.period && (
          <span className="text-xs text-muted-foreground">
            {data.period.from || "the start"} → {data.period.to || "today"} (Dubai)
          </span>
        )}
      </div>

      {/* Totals — click one to show only those calls */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <StatCard label="All calls" value={n(stats?.total)} icon={PhoneCall} color="bg-primary/10 text-primary"
          active={!direction && !result} onClick={() => { setDirection(""); setResult(""); }} />
        <StatCard label="Outgoing" value={n(stats?.outgoing)} icon={PhoneOutgoing} color="bg-green-500/10 text-green-500"
          active={direction === "out"} onClick={() => setDirection(direction === "out" ? "" : "out")} />
        <StatCard label="Incoming" value={n(stats?.incoming)} icon={PhoneIncoming} color="bg-blue-500/10 text-blue-500"
          active={direction === "in"} onClick={() => setDirection(direction === "in" ? "" : "in")} />
        <StatCard label="Connected" value={n(stats?.connected)} icon={CheckCircle2} color="bg-emerald-500/10 text-emerald-500"
          active={result === "connected"} onClick={() => setResult(result === "connected" ? "" : "connected")} />
        <StatCard label="Missed" value={n(stats?.missed)} hint="They called, nobody answered" icon={PhoneMissed} color="bg-red-500/10 text-red-500"
          active={result === "missed"} onClick={() => setResult(result === "missed" ? "" : "missed")} />
        <StatCard label="Not answered" value={n(stats?.notAnswered)} hint="We called, they didn't pick up" icon={PhoneOff} color="bg-orange-500/10 text-orange-500"
          active={result === "not_answered"} onClick={() => setResult(result === "not_answered" ? "" : "not_answered")} />
        <StatCard label="Talk time" value={fmtTalkTotal(stats?.talkSeconds ?? 0)} icon={Clock} color="bg-cyan-500/10 text-cyan-500" />
        <StatCard label="Average connected call" value={fmtClockDuration(stats?.averageTalkSeconds ?? 0)} icon={Timer} color="bg-purple-500/10 text-purple-500" />
      </div>

      {/* Per person */}
      {named.length > 1 && (
        <Card className="overflow-hidden border-border">
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="h-4 w-4" /> By person
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-medium">Person</th>
                    <th className="px-4 py-2.5 text-right font-medium">Calls</th>
                    <th className="px-4 py-2.5 text-right font-medium">Connected</th>
                    <th className="px-4 py-2.5 text-right font-medium">Missed</th>
                    <th className="px-4 py-2.5 text-right font-medium">Not answered</th>
                    <th className="px-4 py-2.5 text-right font-medium">Talk time</th>
                    <th className="px-4 py-2.5 text-right font-medium">Average</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr
                      key={p.key}
                      onClick={() => setPerson(person === p.key ? "" : p.key)}
                      title={person === p.key ? "Show everyone" : `Show only ${p.name}'s calls`}
                      className={cn("cursor-pointer border-b border-border/50 hover:bg-muted/30", person === p.key && "bg-primary/10")}
                    >
                      <td className="px-4 py-2.5">
                        <div className={cn("text-xs", p.key === "-" ? "text-muted-foreground" : "font-medium text-foreground")}>{p.name}</div>
                        {!p.userId && p.extension && !p.name.includes(p.extension) && (
                          <div className="text-[11px] text-muted-foreground">Ext {p.extension} · not linked to a CRM user</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-medium tabular-nums">{p.total}</td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-green-500">{p.connected || dash}</td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-red-500">{p.missed || dash}</td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-orange-500">{p.notAnswered || dash}</td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums">{p.talkSeconds ? fmtTalkTotal(p.talkSeconds) : dash}</td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{p.connected ? fmtClockDuration(p.averageTalkSeconds) : dash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card className="border-border">
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Lead name or number…" className="h-8 pl-8 text-sm" />
            </div>
            <Select value={direction || ALL} onValueChange={(v) => setDirection(v === ALL ? "" : (v as Direction))}>
              <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>In and out</SelectItem>
                <SelectItem value="out">Outgoing</SelectItem>
                <SelectItem value="in">Incoming</SelectItem>
              </SelectContent>
            </Select>
            <Select value={result || ALL} onValueChange={(v) => setResult(v === ALL ? "" : (v as Result))}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All results</SelectItem>
                <SelectItem value="connected">Connected</SelectItem>
                <SelectItem value="missed">Missed</SelectItem>
                <SelectItem value="not_answered">Not answered</SelectItem>
              </SelectContent>
            </Select>
            {named.length > 1 && (
              <Select value={person || ALL} onValueChange={(v) => setPerson(v === ALL ? "" : v)}>
                <SelectTrigger className="h-8 w-[190px] text-xs"><SelectValue placeholder="Everyone" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Everyone</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.key} value={p.key}>{p.name} ({p.total})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={(v) => { setSort(v as Sort); setOrder("desc"); }}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Sort: date</SelectItem>
                <SelectItem value="talk">Sort: talk time</SelectItem>
                <SelectItem value="ring">Sort: ring time</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setOrder(order === "desc" ? "asc" : "desc")}
              title={order === "desc" ? "Newest / longest first" : "Oldest / shortest first"}>
              {order === "desc" ? <ArrowDown className="mr-1 h-3 w-3" /> : <ArrowUp className="mr-1 h-3 w-3" />}
              {order === "desc" ? "Desc" : "Asc"}
            </Button>
            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                <X className="mr-1 h-3 w-3" /> Clear{personName ? ` (${personName})` : ""}
              </Button>
            )}
            {canExport && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={exportCsv} disabled={exporting || !pagination?.total}>
                {exporting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />} CSV
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Calls */}
      <Card className="overflow-hidden border-border">
        <CardHeader className="px-4 pb-0 pt-4">
          <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {n(pagination?.total)} call{pagination?.total === 1 ? "" : "s"}{hasFilters && " (filtered)"}
          </CardTitle>
        </CardHeader>
        <CardContent className="mt-2 p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/40" />)}</div>
          ) : error ? (
            <p className="py-12 text-center text-sm text-destructive">
              {(error as { response?: { data?: { message?: string } } })?.response?.data?.message || "Could not load the calls"}
            </p>
          ) : calls.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted/60 p-4"><PhoneCall className="h-6 w-6 text-muted-foreground" /></div>
              <p className="text-sm text-muted-foreground">
                {hasFilters ? "No calls match these filters." : "No calls with leads in this period."}
              </p>
              {hasFilters && <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                    <SortHead id="date">When</SortHead>
                    <th className="px-4 py-2.5 text-left font-medium">Lead</th>
                    <th className="px-4 py-2.5 text-left font-medium">Call</th>
                    <th className="hidden px-4 py-2.5 text-left font-medium md:table-cell">Who</th>
                    <SortHead id="talk" right>Talk</SortHead>
                    <SortHead id="ring" right>Ring</SortHead>
                    <th className="px-4 py-2.5 text-left font-medium">Recording</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id} className="group border-b border-border/50 align-top transition-colors hover:bg-muted/30">
                      <td className="whitespace-nowrap px-4 py-3 text-xs font-medium">{fmtWhen(c.startedAt)}</td>
                      <td className="px-4 py-3">
                        <Link href={`/leads/${c.leadId}`} className="block max-w-[180px] truncate text-xs font-medium text-primary hover:underline">
                          {c.leadName || "Lead"}
                        </Link>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-[11px] text-muted-foreground">{c.number}</span>
                          <ClickToCall
                            phoneNumber={c.leadPhone || c.number}
                            leadId={c.leadId}
                            leadName={c.leadName}
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3"><CallResult call={c} /></td>
                      <td className="hidden px-4 py-3 md:table-cell"><CallPerson call={c} /></td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums">{c.talkSeconds ? fmtClockDuration(c.talkSeconds) : dash}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-xs tabular-nums text-muted-foreground">{c.ringSeconds ? fmtClockDuration(c.ringSeconds) : dash}</td>
                      <td className="px-4 py-2.5"><RecordingPlayer call={c} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-7" disabled={!pagination.hasPrevPage || isFetching} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="sm" className="h-7" disabled={!pagination.hasNextPage || isFetching} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ThreecxTestDialog open={testing} onClose={() => setTesting(false)} />
    </div>
  );
}
