"use client";
import { useState, useMemo, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Plus, Search, Pencil, Trash2, Loader2, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, X, ExternalLink, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserDialog } from "@/components/users/UserDialog";
import { DeleteUserDialog } from "@/components/users/DeleteUserDialog";
import { useUsers, useImpersonate } from "@/hooks/useUsers";
import { useRolesSimple } from "@/hooks/useRoles";
import { useTeams } from "@/hooks/useTeams";
import { useAuthStore } from "@/lib/store/authStore";
import { canViewAs } from "@/lib/impersonation";
import { formatDate, getInitials } from "@/lib/utils";
import type { User } from "@/types";
import Link from "next/link";

type SortField = "name" | "email" | "createdAt" | "status";
type SortOrder = "asc" | "desc";

function UsersPageContent() {
  const sp = useSearchParams();
  const router = useRouter();
  const { hasPermission, user: me } = useAuthStore();
  const impersonate = useImpersonate();
  const [search, setSearch] = useState(() => sp.get("q") ?? "");
  const [page, setPage] = useState(() => Number(sp.get("page") ?? "1"));
  const [status, setStatus] = useState<string>(() => sp.get("status") ?? "all");
  const [roleFilter, setRoleFilter] = useState<string>(() => sp.get("role") ?? "all");
  const [teamFilter, setTeamFilter] = useState<string>(() => sp.get("team") ?? "all");
  const [sortField, setSortField] = useState<SortField>(() => (sp.get("sortBy") as SortField) ?? "createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => (sp.get("sortOrder") as SortOrder) ?? "desc");

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (page > 1) params.set("page", String(page));
    if (status !== "all") params.set("status", status);
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (teamFilter !== "all") params.set("team", teamFilter);
    if (sortField !== "createdAt") params.set("sortBy", sortField);
    if (sortOrder !== "desc") params.set("sortOrder", sortOrder);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [search, page, status, roleFilter, teamFilter, sortField, sortOrder]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const params = useMemo(() => {
    const p: Record<string, string> = {
      page: String(page),
      limit: "10",
    };
    if (search) p.search = search;
    if (status !== "all") p.status = status;
    if (roleFilter !== "all") p.role = roleFilter;
    if (teamFilter !== "all") p.team = teamFilter;
    if (sortField) p.sortBy = sortField;
    if (sortOrder) p.sortOrder = sortOrder;
    return p;
  }, [page, search, status, roleFilter, teamFilter, sortField, sortOrder]);

  const { data, isLoading, isFetching } = useUsers(params);
  const { data: rolesData } = useRolesSimple();
  const { data: teamsData } = useTeams({ status: "active", limit: 200 });

  const users = data?.data ?? [];
  const pagination = data?.pagination;
  const roles = rolesData ?? [];
  const teams = teamsData?.data ?? [];

  // Build userId → teamName map
  const userTeamMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of teams) {
      for (const leader of team.leaders ?? []) {
        const id = typeof leader === "object" ? leader._id : leader;
        map[id] = team.name;
      }
      for (const member of team.members ?? []) {
        const id = typeof member === "object" ? member._id : member;
        map[id] = team.name;
      }
    }
    return map;
  }, [teams]);

  const handleCreate = () => {
    setSelectedUser(null);
    setDialogOpen(true);
  };

  const handleEdit = (user: User) => {
    setSelectedUser(user);
    setDialogOpen(true);
  };

  const handleDelete = (user: User) => {
    setSelectedUser(user);
    setDeleteOpen(true);
  };

  const canCreate = hasPermission("users", "create");
  const canEdit = hasPermission("users", "edit");
  const canDelete = hasPermission("users", "delete");

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <h2 className="text-2xl font-bold">Users Management</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Manage team members and their roles
          </p>
        </div>
        {canCreate && (
          <Button onClick={handleCreate} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            Add User
          </Button>
        )}
      </motion.div>

      {/* Search + Table */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-border/50">
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search users..."
                  className="pl-9"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={roleFilter} onValueChange={(v) => { setRoleFilter(v); setPage(1); }}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    {roles.map((role) => (
                      <SelectItem key={role._id} value={role._id}>
                        {role.roleName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {teams.length > 0 && (
                  <Select value={teamFilter} onValueChange={(v) => { setTeamFilter(v); setPage(1); }}>
                    <SelectTrigger className="w-[150px]">
                      <SelectValue placeholder="Team" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Teams</SelectItem>
                      {teams.map((team) => (
                        <SelectItem key={team._id} value={team._id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Select value={sortField} onValueChange={(v) => { setSortField(v as SortField); setPage(1); }}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt">Created Date</SelectItem>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="status">Status</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10"
                  onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                  title={sortOrder === "asc" ? "Ascending" : "Descending"}
                >
                  {sortOrder === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                </Button>
                {(status !== "all" || roleFilter !== "all" || teamFilter !== "all") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setStatus("all"); setRoleFilter("all"); setTeamFilter("all"); setPage(1); }}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Clear Filters
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : users.length === 0 ? (
              <div className="py-20 text-center">
                <p className="text-muted-foreground">No users found</p>
                {canCreate && (
                  <Button variant="outline" className="mt-4" onClick={handleCreate}>
                    <Plus className="h-4 w-4" /> Create first user
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <th className="px-6 py-3 text-left">User</th>
                      <th className="px-6 py-3 text-left">Role</th>
                      <th className="px-6 py-3 text-left hidden md:table-cell">Team</th>
                      <th className="px-6 py-3 text-left hidden lg:table-cell">Designation</th>
                      <th className="px-6 py-3 text-left hidden xl:table-cell">Ext.</th>
                      <th className="px-6 py-3 text-left">Status</th>
                      <th className="px-6 py-3 text-left hidden xl:table-cell">Created</th>
                      {(canEdit || canDelete) && (
                        <th className="px-6 py-3 text-right">Actions</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {users.map((user, i) => (
                      <motion.tr
                        key={user._id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.03 }}
                        className="group hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <Avatar className="h-9 w-9">
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                                {getInitials(user.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">{user.name}</p>
                              <p className="text-xs text-muted-foreground">{user.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-sm">
                            {typeof user.role === "object" ? user.role.roleName : "—"}
                          </span>
                        </td>
                        <td className="px-6 py-4 hidden md:table-cell">
                          {userTeamMap[user._id] ? (
                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                              {userTeamMap[user._id]}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 hidden lg:table-cell">
                          <span className="text-sm text-muted-foreground">
                            {user.designation || "—"}
                          </span>
                        </td>
                        <td className="px-6 py-4 hidden xl:table-cell">
                          {user.extension ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary">
                              #{user.extension}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={user.status === "active" ? "success" : "secondary"}>
                            {user.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 hidden xl:table-cell">
                          <span className="text-sm text-muted-foreground">
                            {formatDate(user.createdAt)}
                          </span>
                        </td>
                        { (
                          <td className="px-6 py-4">
                            <div className="flex items-center justify-end gap-2">
                              <Link href={`/users/${user._id}`}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity text-primary hover:text-primary"
                                  title="View Detail"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </Link>
                              {canViewAs(me, user) && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 md:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400"
                                  title={`View as ${user.name} — 30 minutes, acting as them`}
                                  aria-label={`View as ${user.name}`}
                                  disabled={impersonate.isPending}
                                  onClick={() => impersonate.mutate(user._id)}
                                >
                                  {impersonate.isPending && impersonate.variables === user._id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                              {canEdit && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={() => handleEdit(user)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              )}
                              {canDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 md:opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                                  onClick={() => handleDelete(user)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-6 py-4">
                <p className="text-sm text-muted-foreground">
                  Showing {(pagination.page - 1) * pagination.limit + 1}–
                  {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} users
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!pagination.hasPrevPage || isFetching}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm font-medium">
                    {pagination.page} / {pagination.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!pagination.hasNextPage || isFetching}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <UserDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        user={selectedUser}
      />
      <DeleteUserDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        user={selectedUser}
      />
    </div>
  );
}

export default function UsersPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <UsersPageContent />
    </Suspense>
  );
}
