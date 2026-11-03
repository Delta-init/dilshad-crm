"use client";

import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Search, Loader2, Edit2, Trash2, ExternalLink,
  UsersRound, ChevronLeft, ChevronRight, X, ShieldOff, Crown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getInitials } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useTeams, useMyTeam } from "@/hooks/useTeams";
import { TeamDialog } from "@/components/teams/TeamDialog";
import { DeleteTeamDialog } from "@/components/teams/DeleteTeamDialog";
import { LeadSourceTeams } from "@/components/teams/LeadSourceTeams";
import { useAuthStore } from "@/lib/store/authStore";
import type { Team } from "@/types/team";

// ─── Super-Admin Teams List ───────────────────────────────────────────────────
// Only rendered when isSuperAdmin === true, so hooks run unconditionally here.

function AdminTeamsList() {
  const { hasPermission, user } = useAuthStore();
  // Lead sources → teams: the Super Admin's alone (a Reporter sees this list too).
  const superAdmin = user?.role?.roleName === "Super Admin";
  const canCreate = hasPermission("teams", "create");
  const canEdit   = hasPermission("teams", "edit");
  const canDelete = hasPermission("teams", "delete");

  const sp     = useSearchParams();
  const router = useRouter();

  const [search, setSearch]           = useState(() => sp.get("q") ?? "");
  const [statusFilter, setStatus]     = useState(() => sp.get("status") ?? "all");
  const [page, setPage]               = useState(() => Number(sp.get("page") ?? "1"));
  const [teamDialog, setTeamDialog]   = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (page > 1) params.set("page", String(page));
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [search, statusFilter, page]);

  const { data, isLoading } = useTeams({
    search:  search || undefined,
    status:  statusFilter !== "all" ? statusFilter : undefined,
    page,
    limit:   12,
  });

  const teams      = data?.data ?? [];
  const pagination = data?.pagination;
  console.log(canCreate,"can Create",canEdit,"can Edit",canDelete,"can Delete")
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teams</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage teams, leaders, and members
          </p>
        </div>
        {canCreate && (
          <Button
            onClick={() => setTeamDialog({ open: true, team: null })}
            className="gap-2 w-full sm:w-auto shrink-0"
          >
            <Plus className="h-4 w-4" />
            New Team
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search teams..."
            className="pl-9 pr-8"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          {search && (
            <button
              onClick={() => { setSearch(""); setPage(1); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-20 gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <UsersRound className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="text-lg font-semibold">No teams found</p>
          <p className="text-sm text-muted-foreground max-w-xs px-4">
            {search || statusFilter !== "all"
              ? "Try adjusting your filters."
              : "Create your first team to start organising leads."}
          </p>
          {canCreate && !search && statusFilter === "all" && (
            <Button onClick={() => setTeamDialog({ open: true, team: null })} className="mt-2 gap-2">
              <Plus className="h-4 w-4" /> New Team
            </Button>
          )}
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          initial="hidden"
          animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
        >
          <AnimatePresence>
            {teams.map((team) => (
              <motion.div
                key={team._id}
                variants={{ hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0 } }}
                layout
              >
                <Card className="hover:shadow-md transition-shadow h-full flex flex-col">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <UsersRound className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-base truncate">{team.name}</CardTitle>
                          {team.description && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{team.description}</p>
                          )}
                        </div>
                      </div>
                      <Badge variant={team.status === "active" ? "default" : "secondary"} className="shrink-0 capitalize">
                        {team.status}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 flex-1 flex flex-col justify-between">
                    <div className="space-y-3">
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <div className="rounded-md bg-muted/50 p-2">
                          <p className="text-lg font-bold">{team.leaders?.length ?? 0}</p>
                          <p className="text-xs text-muted-foreground">Leaders</p>
                        </div>
                        <div className="rounded-md bg-muted/50 p-2">
                          <p className="text-lg font-bold">{team.members?.length ?? 0}</p>
                          <p className="text-xs text-muted-foreground">Members</p>
                        </div>
                        <div className="rounded-md bg-muted/50 p-2">
                          <p className="text-lg font-bold">{team.leadStats?.total ?? 0}</p>
                          <p className="text-xs text-muted-foreground">Total</p>
                        </div>
                        <div className="rounded-md bg-primary/10 border border-primary/20 p-2">
                          <p className="text-lg font-bold text-primary">{team.leadStats?.thisMonth ?? 0}</p>
                          <p className="text-xs text-primary/70">This Month</p>
                        </div>
                      </div>
                      {/* Leaders */}
                      {team.leaders && team.leaders.length > 0 && (
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <Crown className="h-3 w-3 text-amber-400 shrink-0" />
                          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                            {team.leaders.map((l) => (
                              <div key={typeof l === "object" ? l._id : l} className="flex items-center gap-1">
                                <Avatar className="h-5 w-5">
                                  <AvatarFallback className="text-[9px] bg-amber-500/15 text-amber-400">
                                    {getInitials(typeof l === "object" ? l.name : "?")}
                                  </AvatarFallback>
                                </Avatar>
                                <span className="text-xs text-muted-foreground truncate">
                                  {typeof l === "object" ? l.name : l}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {team.leadStats && team.leadStats.unassigned > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                          {team.leadStats.unassigned} unassigned lead{team.leadStats.unassigned > 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button asChild variant="outline" size="sm" className="flex-1">
                        <Link href={`/teams/${team._id}`}>
                          <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> View
                        </Link>
                      </Button>
                      {canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                          onClick={() => setTeamDialog({ open: true, team })}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button variant="ghost" size="icon"
                          className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteDialog({ open: true, team })}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border/40 pt-4">
          <p className="text-sm text-muted-foreground text-center sm:text-left">
            Page <span className="font-medium text-foreground">{pagination.page}</span> of{" "}
            <span className="font-medium text-foreground">{pagination.totalPages}</span>
            <span className="hidden sm:inline"> ({pagination.total} teams)</span>
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={!pagination.hasPrevPage} className="gap-1">
              <ChevronLeft className="h-4 w-4" /><span className="hidden sm:inline">Prev</span>
            </Button>
            <span className="text-sm font-medium px-1 tabular-nums">{pagination.page} / {pagination.totalPages}</span>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!pagination.hasNextPage} className="gap-1">
              <span className="hidden sm:inline">Next</span><ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {superAdmin && <LeadSourceTeams />}

      {/* Dialogs */}
      <TeamDialog
        open={teamDialog.open}
        onOpenChange={(open) => setTeamDialog((d) => ({ ...d, open }))}
        team={teamDialog.team}
      />
      <DeleteTeamDialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog((d) => ({ ...d, open }))}
        team={deleteDialog.team}
      />
    </div>
  );
}

// ─── Gate component — all hooks run unconditionally here ─────────────────────

function TeamsPageContent() {
  const { user } = useAuthStore();
  const router   = useRouter();

  const isSuperAdmin =user?.role?.roleName === "Super Admin" || user?.role?.roleName === "Reporter";

  // Always call useMyTeam — but only act on it for non-super-admins
  const { data: myTeam, isLoading: myTeamLoading } = useMyTeam();

  useEffect(() => {
    if (isSuperAdmin || myTeamLoading) return;
    // Non-super-admin: send them directly to their team page
    if (myTeam?._id) {
      router.replace(`/teams/${myTeam._id}`);
    }
  }, [isSuperAdmin, myTeamLoading, myTeam, router]);

  // ── Super Admin: render the full list
  if (isSuperAdmin) return <AdminTeamsList />;

  // ── Non-super-admin: resolving …
  if (myTeamLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Not in any team
  if (!myTeam) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-20 gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <ShieldOff className="h-8 w-8 text-muted-foreground" />
        </div>
        <div>
          <p className="text-lg font-semibold">Not assigned to a team</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-xs">
            You are not a member of any team yet. Please contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  // Has a team — redirect in progress, show spinner
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function TeamsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <TeamsPageContent />
    </Suspense>
  );
}
