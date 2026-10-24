"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, FileSpreadsheet, Download, ChevronDown, ChevronUp,
  ArrowLeft, CheckCircle2, XCircle, Loader2, AlertCircle,
  UsersRound, Check, X, CheckSquare, Square, User, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";
import { uploadLeadSchema, type UploadLeadFormValues } from "@/lib/validations/leadSchema";
import { useUploadLeads } from "@/hooks/useLeads";
import { useTeams, useMyTeam } from "@/hooks/useTeams";
import { useAuthStore } from "@/lib/store/authStore";
import type { UploadLeadsResult, InvalidRow } from "@/types/lead";
import type { Team } from "@/types/team";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function downloadTemplate() {
  const headers = ["Name", "Email", "Phone", "Source", "Notes", "Referral Type", "Referred By"];
  const sample  = ["John Doe", "john@example.com", "+1234567890", "website", "Interested in product A", "", ""];
  const sample2 = ["Jane Doe", "jane@example.com", "+1234567891", "referral", "Referred lead", "student", "Ashik"];
  const csvContent = [headers.join(","), sample.join(","), sample2.join(",")].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "leads_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Result Summary ────────────────────────────────────────────────────────────

function ResultSummary({ result }: { result: UploadLeadsResult }) {
  const [invalidExpanded, setInvalidExpanded] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="space-y-4"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-green-400" />
        <h3 className="font-semibold text-foreground">Upload Complete</h3>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total Processed", value: result.total,    color: "bg-blue-500/10 border-blue-500/20 text-blue-400" },
          { label: "Leads Created",   value: result.created,  color: "bg-green-500/10 border-green-500/20 text-green-400" },
          { label: "Invalid Rows",    value: result.invalid,  color: result.invalid > 0 ? "bg-red-500/10 border-red-500/20 text-red-400" : "bg-muted/30 border-border text-muted-foreground" },
          { label: "Auto Assigned",   value: result.assigned, color: "bg-purple-500/10 border-purple-500/20 text-purple-400" },
          ...((result.cameAgain ?? 0) > 0
            ? [{ label: "Came in again", value: result.cameAgain ?? 0, color: "bg-orange-500/10 border-orange-500/20 text-orange-500" }]
            : []),
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + i * 0.08, duration: 0.3 }}
          >
            <div className={`rounded-lg border p-4 ${stat.color}`}>
              <p className="text-2xl font-bold">{stat.value}</p>
              <p className="text-xs mt-0.5 opacity-80">{stat.label}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {result.assigned > 0 && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="text-sm text-muted-foreground"
        >
          {result.assigned} leads auto-assigned across selected teams
        </motion.p>
      )}

      {(result.repeatDetails?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3 space-y-1">
          <p className="text-sm font-medium text-orange-500">
            {result.repeatDetails!.length} number{result.repeatDetails!.length !== 1 ? "s were" : " was"} already in the CRM — not added twice; see Repeat leads
          </p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.repeatDetails!.map((r) => (
              <li key={`${r.row}-${r.leadId}`}>Row {r.row} · {r.phone} — {r.message}</li>
            ))}
          </ul>
        </div>
      )}

      {result.invalid > 0 && result.invalidDetails.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="rounded-lg border border-red-500/20 bg-red-500/5 overflow-hidden"
        >
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-red-400"
            onClick={() => setInvalidExpanded(!invalidExpanded)}
          >
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4" />
              {result.invalid} invalid row{result.invalid !== 1 ? "s" : ""} — click to review
            </div>
            {invalidExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          <AnimatePresence>
            {invalidExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="overflow-x-auto border-t border-red-500/20">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-red-500/10 text-muted-foreground">
                        <th className="px-4 py-2 text-left font-medium">Row</th>
                        <th className="px-4 py-2 text-left font-medium">Name</th>
                        <th className="px-4 py-2 text-left font-medium">Email</th>
                        <th className="px-4 py-2 text-left font-medium">Errors</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-red-500/10">
                      {result.invalidDetails.map((row: InvalidRow) => (
                        <tr key={row.row} className="hover:bg-red-500/5">
                          <td className="px-4 py-2 font-mono">{row.row}</td>
                          <td className="px-4 py-2">{(row.data.name as string) ?? "—"}</td>
                          <td className="px-4 py-2">{(row.data.email as string) ?? "—"}</td>
                          <td className="px-4 py-2 text-red-400">{row.errors.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Member Selector (shown below each selected team) ─────────────────────────

interface MemberSelectorProps {
  team: Team;
  selectedMemberIds: Set<string>;
  onMemberToggle: (memberId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  locked?: boolean;
  lockedMemberId?: string;
}

function MemberSelector({
  team,
  selectedMemberIds,
  onMemberToggle,
  onSelectAll,
  onDeselectAll,
  locked,
  lockedMemberId,
}: MemberSelectorProps) {
  const inactiveSet = new Set(team.inactiveMembers ?? []);
  const allMembers = [
    ...team.leaders.map((u) => ({ ...u, isLeader: true })),
    ...team.members
      .filter((m) => !team.leaders.some((l) => l._id === m._id))
      .map((u) => ({ ...u, isLeader: false })),
  ];

  // In locked (BDE) mode, only show the locked member
  const visibleMembers = locked && lockedMemberId
    ? allMembers.filter((m) => m._id === lockedMemberId)
    : allMembers;

  const activeMembers = visibleMembers.filter((m) => !inactiveSet.has(m._id));
  const allActiveSelected = activeMembers.length > 0 && activeMembers.every((m) => selectedMemberIds.has(m._id));
  const noneSelected = selectedMemberIds.size === 0;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="overflow-hidden"
    >
      <div className="mt-3 rounded-xl border border-primary/15 bg-primary/3 p-3 space-y-2.5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {locked ? (
              <Lock className="h-3 w-3 text-muted-foreground" />
            ) : (
              <User className="h-3 w-3 text-primary" />
            )}
            <span className="text-xs font-medium text-foreground">
              {locked ? "Assigned to you" : `Members — ${selectedMemberIds.size} selected`}
            </span>
          </div>
          {!locked && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onSelectAll}
                disabled={allActiveSelected}
                className="text-[10px] text-muted-foreground hover:text-primary disabled:opacity-40 transition-colors"
              >
                All
              </button>
              <span className="text-muted-foreground/40 text-[10px]">·</span>
              <button
                type="button"
                onClick={onDeselectAll}
                disabled={noneSelected}
                className="text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40 transition-colors"
              >
                None
              </button>
            </div>
          )}
        </div>

        {/* Member pills */}
        <div className="flex flex-wrap gap-1.5">
          {visibleMembers.map((member) => {
            const isInactive = inactiveSet.has(member._id);
            const isSelected = selectedMemberIds.has(member._id);
            const isLocked = locked && member._id === lockedMemberId;

            return (
              <motion.button
                key={member._id}
                type="button"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                whileTap={!isInactive && !isLocked ? { scale: 0.95 } : undefined}
                onClick={() => !isInactive && !isLocked && onMemberToggle(member._id)}
                disabled={isInactive || isLocked}
                className={`
                  inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium
                  transition-all duration-150
                  ${isInactive
                    ? "border-border/30 bg-muted/20 text-muted-foreground/40 cursor-not-allowed"
                    : isSelected
                      ? isLocked
                        ? "border-primary/30 bg-primary/10 text-primary cursor-default"
                        : "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/50 bg-card text-muted-foreground hover:border-border hover:text-foreground"
                  }
                `}
              >
                <div className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center shrink-0 transition-colors
                  ${isSelected ? "bg-primary border-primary" : "border-border/60 bg-background"}`}
                >
                  {isSelected && <Check className="h-2 w-2 text-primary-foreground" strokeWidth={3} />}
                </div>
                <span>{member.name}</span>
                {member.isLeader && (
                  <span className="text-[9px] opacity-60">(L)</span>
                )}
                {isInactive && (
                  <span className="text-[9px] opacity-50">inactive</span>
                )}
                {isLocked && <Lock className="h-2.5 w-2.5 opacity-50" />}
              </motion.button>
            );
          })}

          {visibleMembers.length === 0 && (
            <p className="text-xs text-muted-foreground">No members found in this team.</p>
          )}
        </div>

        {!locked && selectedMemberIds.size === 0 && activeMembers.length > 0 && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[11px] text-amber-400 flex items-center gap-1"
          >
            <AlertCircle className="h-3 w-3" />
            No members selected — leads won&apos;t be split within this team
          </motion.p>
        )}
      </div>
    </motion.div>
  );
}

// ─── Team + Member Selector ────────────────────────────────────────────────────

interface TeamMemberSelectorProps {
  teams: Team[];
  selectedTeamIds: Set<string>;
  selectedMemberIds: Record<string, Set<string>>;
  onTeamToggle: (id: string) => void;
  onTeamSelectAll: () => void;
  onTeamDeselectAll: () => void;
  onMemberToggle: (teamId: string, memberId: string) => void;
  onMemberSelectAll: (team: Team) => void;
  onMemberDeselectAll: (teamId: string) => void;
  lockedTeamId?: string;
  lockedMemberId?: string;
}

function TeamMemberSelector({
  teams,
  selectedTeamIds,
  selectedMemberIds,
  onTeamToggle,
  onTeamSelectAll,
  onTeamDeselectAll,
  onMemberToggle,
  onMemberSelectAll,
  onMemberDeselectAll,
  lockedTeamId,
  lockedMemberId,
}: TeamMemberSelectorProps) {
  const allSelected = teams.length > 0 && selectedTeamIds.size === teams.length;
  const noneSelected = selectedTeamIds.size === 0;
  const isLocked = !!lockedTeamId;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {isLocked
            ? "Auto-assigning to your team"
            : selectedTeamIds.size === 0
              ? "No teams selected — leads won't be auto-assigned"
              : selectedTeamIds.size === teams.length
                ? "All teams selected"
                : `${selectedTeamIds.size} of ${teams.length} teams selected`}
        </span>
        {!isLocked && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onTeamSelectAll} disabled={allSelected}
            >
              <CheckSquare className="h-3.5 w-3.5 mr-1.5" />All
            </Button>
            <Button type="button" variant="ghost" size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onTeamDeselectAll} disabled={noneSelected}
            >
              <Square className="h-3.5 w-3.5 mr-1.5" />None
            </Button>
          </div>
        )}
      </div>

      {/* Team list */}
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {teams.map((team, i) => {
            const isSelected = selectedTeamIds.has(team._id);
            const isTeamLocked = isLocked && team._id === lockedTeamId;
            const memberCount = (team.members?.length ?? 0) + (team.leaders?.length ?? 0);
            const teamMembers = selectedMemberIds[team._id] ?? new Set<string>();

            return (
              <motion.div
                key={team._id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                {/* Team row */}
                <motion.button
                  type="button"
                  whileTap={!isTeamLocked ? { scale: 0.99 } : undefined}
                  onClick={() => !isTeamLocked && onTeamToggle(team._id)}
                  className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150
                    ${isTeamLocked
                      ? "border-primary/30 bg-primary/5 cursor-default"
                      : isSelected
                        ? "border-primary/40 bg-primary/8 ring-1 ring-primary/20"
                        : "border-border/50 bg-card hover:border-border hover:bg-muted/30"
                    }
                  `}
                >
                  {/* Checkbox */}
                  <div className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border transition-colors
                    ${isSelected ? "bg-primary border-primary" : "border-border bg-background"}`}
                  >
                    {isSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate ${isSelected ? "text-primary" : "text-foreground"}`}>
                      {team.name}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {memberCount} member{memberCount !== 1 ? "s" : ""}
                      {team.leadStats?.thisMonth != null && (
                        <span className="ml-1.5 text-violet-400/80">· {team.leadStats.thisMonth} this mo.</span>
                      )}
                      {isSelected && !isTeamLocked && (
                        <span className="ml-1.5 text-primary/70">
                          · {teamMembers.size} member{teamMembers.size !== 1 ? "s" : ""} in split
                        </span>
                      )}
                    </p>
                  </div>

                  {isTeamLocked && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                </motion.button>

                {/* Member sub-selector — expands when team is selected */}
                <AnimatePresence>
                  {isSelected && (
                    <MemberSelector
                      team={team}
                      selectedMemberIds={teamMembers}
                      onMemberToggle={(memberId) => onMemberToggle(team._id, memberId)}
                      onSelectAll={() => onMemberSelectAll(team)}
                      onDeselectAll={() => onMemberDeselectAll(team._id)}
                      locked={isTeamLocked}
                      lockedMemberId={lockedMemberId}
                    />
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function UploadLeadsPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuthStore();
  const [dragOver, setDragOver] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadLeadsResult | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>("");
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [selectedMemberIds, setSelectedMemberIds] = useState<Record<string, Set<string>>>({});
  const [initialised, setInitialised] = useState(false);

  const { mutate: uploadLeads, isPending } = useUploadLeads();

  // ── Role / BDE detection ──────────────────────────────────────────────────────
  const isSuperAdmin = user?.role?.isSystemRole === true && user?.role?.roleName === "Super Admin";
  // Mirrors backend getTeams controller: only Super Admin, Reporter, Team Leader can see all teams
  const canSeeAllTeams =
    isSuperAdmin ||
    user?.role?.roleName === "Team Leader" ||
    user?.role?.roleName === "Reporter";
  const isBDE = !!user && !canSeeAllTeams;

  // Full-access users fetch all teams; BDE users skip (they get 403 from the backend)
  const { data: teamsData, isLoading: teamsLoading } = useTeams(
    { status: "active", limit: 100 },
    { enabled: !!user && canSeeAllTeams },
  );
  const activeTeams = teamsData?.data ?? [];

  // BDE users get their own team via /teams/mine (no teams:view required)
  const { data: myOwnTeam, isLoading: myTeamLoading } = useMyTeam();

  const isLoading = isBDE ? myTeamLoading : teamsLoading;

  // Teams visible to this user
  const visibleTeams = isBDE ? (myOwnTeam ? [myOwnTeam] : []) : activeTeams;

  // ── Initialise selections once teams load ────────────────────────────────────
  useEffect(() => {
    if (initialised) return;

    if (isBDE) {
      // BDE: wait for own team to load
      if (!myOwnTeam || !user) return;
      setInitialised(true);
      setSelectedTeamIds(new Set([myOwnTeam._id]));
      setSelectedMemberIds({ [myOwnTeam._id]: new Set([user._id]) });
    } else {
      // Admin: wait for all teams to load
      if (activeTeams.length === 0) return;
      setInitialised(true);
      const teamSet = new Set(activeTeams.map((t) => t._id));
      const memberMap: Record<string, Set<string>> = {};
      for (const team of activeTeams) {
        const inactive = new Set(team.inactiveMembers ?? []);
        const active = [
          ...team.leaders.map((l) => l._id),
          ...team.members.map((m) => m._id),
        ].filter((id) => !inactive.has(id));
        memberMap[team._id] = new Set(active);
      }
      setSelectedTeamIds(teamSet);
      setSelectedMemberIds(memberMap);
    }
  }, [activeTeams, isBDE, myOwnTeam, user, initialised]);

  // ── Team toggle handlers ──────────────────────────────────────────────────────
  const handleToggleTeam = (id: string) => {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Clear member selection for deselected team
        setSelectedMemberIds((m) => { const n = { ...m }; delete n[id]; return n; });
      } else {
        next.add(id);
        // Pre-select all active members when team is toggled ON
        const team = activeTeams.find((t) => t._id === id);
        if (team) {
          const inactive = new Set(team.inactiveMembers ?? []);
          const active = [
            ...team.leaders.map((l) => l._id),
            ...team.members.map((m) => m._id),
          ].filter((mid) => !inactive.has(mid));
          setSelectedMemberIds((m) => ({ ...m, [id]: new Set(active) }));
        }
      }
      return next;
    });
  };

  const handleSelectAllTeams = () => {
    const newTeamIds = new Set(visibleTeams.map((t) => t._id));
    setSelectedTeamIds(newTeamIds);
    const memberMap: Record<string, Set<string>> = { ...selectedMemberIds };
    for (const team of visibleTeams) {
      if (!memberMap[team._id]) {
        const inactive = new Set(team.inactiveMembers ?? []);
        memberMap[team._id] = new Set([
          ...team.leaders.map((l) => l._id),
          ...team.members.map((m) => m._id),
        ].filter((id) => !inactive.has(id)));
      }
    }
    setSelectedMemberIds(memberMap);
  };

  const handleDeselectAllTeams = () => {
    setSelectedTeamIds(new Set());
    setSelectedMemberIds({});
  };

  // ── Member toggle handlers ────────────────────────────────────────────────────
  const handleMemberToggle = (teamId: string, memberId: string) => {
    setSelectedMemberIds((prev) => {
      const teamSet = new Set(prev[teamId] ?? []);
      if (teamSet.has(memberId)) teamSet.delete(memberId);
      else teamSet.add(memberId);
      return { ...prev, [teamId]: teamSet };
    });
  };

  const handleMemberSelectAll = (team: Team) => {
    const inactive = new Set(team.inactiveMembers ?? []);
    const all = [
      ...team.leaders.map((l) => l._id),
      ...team.members.map((m) => m._id),
    ].filter((id) => !inactive.has(id));
    setSelectedMemberIds((prev) => ({ ...prev, [team._id]: new Set(all) }));
  };

  const handleMemberDeselectAll = (teamId: string) => {
    setSelectedMemberIds((prev) => ({ ...prev, [teamId]: new Set() }));
  };

  // ── Form ─────────────────────────────────────────────────────────────────────
  const {
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<UploadLeadFormValues>({
    resolver: zodResolver(uploadLeadSchema),
  });

  const fileList = watch("file");
  const hasFile = fileList && fileList.length > 0;

  const handleFileChange = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setValue("file", files, { shouldValidate: true });
    setSelectedFileName(files[0].name);
    setUploadResult(null);
  };

  const onSubmit = (data: UploadLeadFormValues) => {
    const file = data.file[0];
    const teamIds = Array.from(selectedTeamIds);

    // Build per-team member overrides — only for selected teams with explicit selections
    const memberOverrides: Record<string, string[]> = {};
    for (const teamId of teamIds) {
      const members = selectedMemberIds[teamId];
      if (members && members.size > 0) {
        memberOverrides[teamId] = Array.from(members);
      }
    }

    uploadLeads(
      {
        file,
        teamIds: teamIds.length > 0 ? teamIds : [],
        memberOverrides: Object.keys(memberOverrides).length > 0 ? memberOverrides : undefined,
      },
      {
        onSuccess: (result) => {
          setUploadResult(result);
          setSelectedFileName("");
          setValue("file", undefined as unknown as FileList);
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
      },
    );
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-4"
      >
        <Button variant="ghost" size="icon" onClick={() => router.push("/leads")} className="h-9 w-9">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h2 className="text-2xl font-bold">Upload Leads</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Bulk import leads from an Excel or CSV file
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="space-y-4"
      >
        {/* Template download */}
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Download className="h-4 w-4 text-primary" />
              Download Template
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Download the CSV template to see the required format. Supported columns:{" "}
              {["Name", "Email", "Phone", "Source", "Notes", "Referral Type", "Referred By"].map((c) => (
                <span key={c} className="font-mono text-xs bg-muted px-1 py-0.5 rounded mr-1">{c}</span>
              ))}
            </p>
            <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
              For <span className="font-semibold">Referral</span> leads, the <span className="font-mono">Referred By</span> column is <span className="font-semibold">mandatory</span> — mention who referred the lead (Delta employee, external referral, or student name). Rows without it will be rejected.
            </p>
            <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-2">
              <FileSpreadsheet className="h-4 w-4" />
              Download Sample CSV
            </Button>
          </CardContent>
        </Card>

        {/* Team + Member Selection */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
        >
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <UsersRound className="h-4 w-4 text-primary" />
                  Auto-Assign Teams &amp; Members
                </CardTitle>
                {!isLoading && visibleTeams.length > 0 && (
                  <Badge
                    variant="secondary"
                    className={`text-xs tabular-nums transition-colors ${
                      selectedTeamIds.size === 0
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                        : "bg-primary/10 text-primary border-primary/20"
                    }`}
                  >
                    {selectedTeamIds.size}/{visibleTeams.length} selected
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {isBDE
                  ? "Leads will be auto-assigned within your team. Only you will receive them."
                  : "Select teams and which members within each team participate in auto-split."
                }
              </p>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading teams…
                </div>
              ) : visibleTeams.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" />
                  No active teams found. Leads will be uploaded without auto-assignment.
                </div>
              ) : (
                <TeamMemberSelector
                  teams={visibleTeams}
                  selectedTeamIds={selectedTeamIds}
                  selectedMemberIds={selectedMemberIds}
                  onTeamToggle={handleToggleTeam}
                  onTeamSelectAll={handleSelectAllTeams}
                  onTeamDeselectAll={handleDeselectAllTeams}
                  onMemberToggle={handleMemberToggle}
                  onMemberSelectAll={handleMemberSelectAll}
                  onMemberDeselectAll={handleMemberDeselectAll}
                  lockedTeamId={isBDE && myOwnTeam ? myOwnTeam._id : undefined}
                  lockedMemberId={isBDE ? user?._id : undefined}
                />
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Upload form */}
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4 text-primary" />
              Upload File
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleFileChange(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed
                  cursor-pointer transition-all duration-200 py-12 px-6 text-center
                  ${dragOver
                    ? "border-primary bg-primary/5 scale-[1.01]"
                    : hasFile
                      ? "border-green-500/50 bg-green-500/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                  }
                `}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => handleFileChange(e.target.files)}
                />

                <AnimatePresence mode="wait">
                  {hasFile ? (
                    <motion.div
                      key="selected"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-2"
                    >
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-green-500/10">
                        <FileSpreadsheet className="h-6 w-6 text-green-400" />
                      </div>
                      <p className="font-medium text-sm text-foreground">{selectedFileName}</p>
                      <p className="text-xs text-muted-foreground">Click to change file</p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3"
                    >
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                        <Upload className={`h-6 w-6 ${dragOver ? "text-primary" : "text-muted-foreground"}`} />
                      </div>
                      <div>
                        <p className="font-medium text-sm">
                          {dragOver ? "Drop file here" : "Drag & drop or click to browse"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">Supports .xlsx, .xls, .csv</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {errors.file && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {errors.file.message as string}
                </div>
              )}

              {/* Selected teams summary pill */}
              <AnimatePresence>
                {visibleTeams.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors
                      ${selectedTeamIds.size === 0
                        ? "border-amber-500/20 bg-amber-500/5 text-amber-400"
                        : "border-primary/15 bg-primary/5 text-primary"
                      }`}
                  >
                    <UsersRound className="h-3.5 w-3.5 shrink-0" />
                    {selectedTeamIds.size === 0
                      ? "No teams selected — leads will be uploaded but NOT auto-assigned"
                      : isBDE && myOwnTeam
                        ? `Auto-assigning to ${myOwnTeam.name} — assigned to you`
                        : selectedTeamIds.size === visibleTeams.length
                          ? `Auto-assigning across all ${visibleTeams.length} teams`
                          : `Auto-assigning to ${selectedTeamIds.size} selected team${selectedTeamIds.size !== 1 ? "s" : ""}`
                    }
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-center gap-3">
                <motion.div whileTap={{ scale: 0.97 }}>
                  <Button
                    type="submit"
                    disabled={isPending || !hasFile}
                    className="gap-2"
                  >
                    {isPending ? (
                      <><Loader2 className="h-4 w-4 animate-spin" />Uploading…</>
                    ) : (
                      <><Upload className="h-4 w-4" />Upload &amp; Import</>
                    )}
                  </Button>
                </motion.div>
                {hasFile && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedFileName("");
                      setValue("file", undefined as unknown as FileList);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                      setUploadResult(null);
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        <AnimatePresence>
          {uploadResult && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35 }}
            >
              <Card className="border-green-500/20">
                <CardContent className="pt-6">
                  <ResultSummary result={uploadResult} />
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Instructions */}
        <Card className="border-border/30 bg-muted/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground text-sm">Import Notes</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>The <strong>Name</strong> column is required; all other columns are optional.</li>
                  <li>Duplicate emails will be skipped.</li>
                  <li>Select specific teams and members to control who receives the auto-split leads.</li>
                  <li>Deselecting all teams will upload leads without auto-assignment.</li>
                  <li>Maximum 500 rows per upload.</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
