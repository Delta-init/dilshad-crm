"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Loader2, Phone, Mail, Globe, User2, Calendar,
  RefreshCw, StickyNote, Send, Pencil, Trash2, CheckCheck,
  X, ChevronDown, Activity, Clock, UserCheck, FilePlus2,
  MessageSquarePlus, PencilLine, Minus, UsersRound, ArrowRightLeft, BookOpen,
  MessageSquare, AlertTriangle, Target, TrendingUp, CircleDollarSign,
  MessageCircle, XCircle, Repeat2,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useLead, useUpdateLeadStatus, useAssignLead, useAddLeadNote, useUpdateLeadNote, useDeleteLeadNote, useUpdateLead, useAssignLeadToTeam, useTransferLeadToTeam } from "@/hooks/useLeads";
import { useAllCourses } from "@/hooks/useCourses";
import { useTeams } from "@/hooks/useTeams";
import { useAuthStore } from "@/lib/store/authStore";
import { formatDate, getInitials } from "@/lib/utils";
import type { LeadNote, ActivityLog, ActivityAction } from "@/types/lead";
import type { LeadStatus } from "@/lib/statusConfig";
import type { Course } from "@/types/course";
import type { User } from "@/types";
import type { Team } from "@/types/team";
import LeadDialog from "@/components/leads/LeadDialog";
import { ReminderPanel } from "@/components/leads/ReminderPanel";
import { AiChatPanel } from "@/components/leads/AiChatPanel";
import { PaymentPanel } from "@/components/leads/PaymentPanel";
import { LeadWhatsAppCard } from "@/components/leads/LeadWhatsAppCard";
import { CallsPanel } from "@/components/leads/CallsPanel";
import { FollowUpPanel } from "@/components/leads/FollowUpPanel";
import { ClickToCall } from "@/components/leads/ClickToCall";
import { LOST_REASONS, LostReasonModal } from "@/components/leads/LostReasonModal";

const LOST_REASON_LABELS: Record<string, string> = Object.fromEntries(
  LOST_REASONS.map((r) => [r.value, r.label]),
);
import { FollowupDetailsModal } from "@/components/leads/FollowupDetailsModal";
import { MeetingScheduledModal } from "@/components/leads/MeetingScheduledModal";
import { fmtFull } from "@/lib/currency";
import { INITIAL_RESPONSE_CONFIG, PRIMARY_CONCERN_CONFIG, FOLLOWUP_STRATEGY_CONFIG } from "@/lib/leadConfig";
import { LEAD_STATUSES, STATUS_META } from "@/lib/statusConfig";
import { CreateStudentModal } from "@/components/students/CreateStudentModal";
import { useStudentByLeadId } from "@/hooks/useStudents";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_CONFIG = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, { label: STATUS_META[s].label, color: STATUS_META[s].color, dot: STATUS_META[s].dot }]),
) as Record<LeadStatus, { label: string; color: string; dot: string }>;

const ACTION_CONFIG: Record<ActivityAction, { icon: React.ElementType; color: string; bg: string }> = {
  lead_created: { icon: FilePlus2, color: "text-blue-400", bg: "bg-blue-500/15" },
  lead_updated: { icon: PencilLine, color: "text-purple-400", bg: "bg-purple-500/15" },
  status_changed: { icon: RefreshCw, color: "text-orange-400", bg: "bg-orange-500/15" },
  team_assigned: { icon: UsersRound, color: "text-indigo-400", bg: "bg-indigo-500/15" },
  lead_assigned: { icon: UserCheck, color: "text-yellow-400", bg: "bg-yellow-500/15" },
  note_added: { icon: MessageSquarePlus, color: "text-green-400", bg: "bg-green-500/15" },
  note_updated: { icon: PencilLine, color: "text-cyan-400", bg: "bg-cyan-500/15" },
  note_deleted: { icon: Minus, color: "text-red-400", bg: "bg-red-500/15" },
  whatsapp_welcome: { icon: MessageCircle, color: "text-green-400", bg: "bg-green-500/15" },
  followup_missed: { icon: AlertTriangle, color: "text-red-400", bg: "bg-red-500/15" },
  inactive_reassigned: { icon: ArrowRightLeft, color: "text-amber-400", bg: "bg-amber-500/15" },
  repeat_enquiry: { icon: Repeat2, color: "text-violet-400", bg: "bg-violet-500/15" },
  repeat_verified: { icon: UserCheck, color: "text-violet-400", bg: "bg-violet-500/15" },
};

const noteSchema = z.object({ content: z.string().min(1, "Note cannot be empty").max(2000) });
type NoteForm = z.infer<typeof noteSchema>;

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: LeadStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${cfg.color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function InfoRow({ icon: Icon, label, value, leadId, leadName, hasWhatsapp }: { icon: React.ElementType; label: string; value?: string | null; leadId?: string; leadName?: string; hasWhatsapp?: boolean }) {
  if (!value) return null;
  const isPhone = label === "Phone";
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 rounded-md bg-muted/50 p-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground break-all">{value}</p>
          {isPhone && (
            <ClickToCall
              phoneNumber={value}
              leadId={leadId}
              leadName={leadName}
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
            />
          )}
          {isPhone && hasWhatsapp && (
            <a
              href={`https://wa.me/${value.replace(/\D/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open WhatsApp"
              className="text-green-500 hover:text-green-600 transition-colors"
            >
              <MessageCircle className="h-4 w-4 fill-green-500/20" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function getUserName(user: User | string | null | undefined): string {
  if (!user) return "—";
  if (typeof user === "string") return user;
  return user.name;
}

function getUserInitials(user: User | string | null | undefined): string {
  const name = getUserName(user);
  return getInitials(name === "—" ? "U" : name);
}

// ─── Notes Panel ─────────────────────────────────────────────────────────────

function NotesPanel({
  leadId,
  notes,
  currentUserId,
  canEdit,
}: {
  leadId: string;
  notes: LeadNote[];
  currentUserId: string;
  canEdit: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addNote = useAddLeadNote();
  const updateNote = useUpdateLeadNote();
  const deleteNote = useDeleteLeadNote();

  const addForm = useForm<NoteForm>({ resolver: zodResolver(noteSchema) });
  const editForm = useForm<NoteForm>({ resolver: zodResolver(noteSchema) });

  function startEdit(note: LeadNote) {
    setEditingId(note._id);
    editForm.setValue("content", note.content);
  }

  function handleAdd(data: NoteForm) {
    addNote.mutate({ leadId, content: data.content }, {
      onSuccess: () => addForm.reset(),
    });
  }

  function handleUpdate(data: NoteForm) {
    if (!editingId) return;
    updateNote.mutate({ leadId, noteId: editingId, content: data.content }, {
      onSuccess: () => setEditingId(null),
    });
  }

  function handleDelete() {
    if (!deleteId) return;
    deleteNote.mutate({ leadId, noteId: deleteId }, {
      onSuccess: () => setDeleteId(null),
    });
  }

  // Auto-grow textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  });

  const sorted = [...notes].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <>
      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note</AlertDialogTitle>
            <AlertDialogDescription>This note will be permanently deleted. Continue?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteNote.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <StickyNote className="h-4 w-4 text-muted-foreground" />
            Notes
            {notes.length > 0 && (
              <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                {notes.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Add new note */}
          {canEdit && (
            <form onSubmit={addForm.handleSubmit(handleAdd)} className="space-y-2">
              <Textarea
                {...addForm.register("content")}
                placeholder="Write a note..."
                className="min-h-[80px] resize-none bg-muted/30 border-border/50 focus:border-primary/50 text-sm"
              />
              {addForm.formState.errors.content && (
                <p className="text-xs text-destructive">{addForm.formState.errors.content.message}</p>
              )}
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={addNote.isPending} className="gap-1.5">
                  {addNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Add Note
                </Button>
              </div>
            </form>
          )}

          {/* Notes list */}
          <AnimatePresence initial={false}>
            {sorted.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="py-8 text-center"
              >
                <StickyNote className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No notes yet</p>
              </motion.div>
            ) : (
              <div className="space-y-3">
                {sorted.map((note) => {
                  const isAuthor = typeof note.author === "object" && note.author !== null
                    ? (note.author as User)._id === currentUserId
                    : note.author === currentUserId;
                  const authorName = getUserName(note.author as User | string);

                  return (
                    <motion.div
                      key={note._id}
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="group rounded-lg overflow-hidden border border-border/40 bg-muted/20 p-4 hover:bg-muted/30 transition-colors"
                    >
                      {editingId === note._id ? (
                        <form onSubmit={editForm.handleSubmit(handleUpdate)} className="space-y-2">
                          <Textarea
                            {...editForm.register("content")}
                            className="min-h-[70px] resize-none bg-background border-border text-sm"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="submit" size="sm" disabled={updateNote.isPending}>
                              {updateNote.isPending
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <CheckCheck className="h-3.5 w-3.5" />}
                              Save
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <Avatar className="h-6 w-6 shrink-0">
                                <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                  {getUserInitials(note.author as User | string)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="text-xs font-medium text-foreground truncate">{authorName}</span>
                              <span className="text-xs text-muted-foreground shrink-0">
                                · {formatDate(note.createdAt)}
                                {note.updatedAt !== note.createdAt && " (edited)"}
                              </span>
                            </div>
                            {(isAuthor || canEdit) && (
                              <div className="flex items-center gap-1 md:opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                {isAuthor && (
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                    onClick={() => startEdit(note)}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                  onClick={() => setDeleteId(note._id)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
                            {note.content}
                          </p>
                        </>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </>
  );
}

// ─── Activity Timeline ────────────────────────────────────────────────────────

function ActivityTimeline({ logs }: { logs: ActivityLog[] }) {
  const sorted = [...logs].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return formatDate(dateStr);
  }

  return (
    <Card className="border-border/50 overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Activity Log
          {logs.length > 0 && (
            <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {logs.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="py-8 text-center">
            <Clock className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-sm text-muted-foreground">No activity yet</p>
          </div>
        ) : (
          <div className="relative space-y-0">
            {/* Vertical line */}
            <div className="absolute left-[19px] top-4 bottom-4 w-px bg-border/50" />

            {sorted.map((log, i) => {
              const cfg = ACTION_CONFIG[log.action] ?? {
                icon: Activity, color: "text-muted-foreground", bg: "bg-muted",
              };
              const Icon = cfg.icon;
              // No performer: the CRM did it on its own (a lead moved on for inactivity).
              const by = log.performedBy ? getUserName(log.performedBy as User | string) : "System";

              return (
                <motion.div
                  key={log._id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="flex gap-4 pb-5 last:pb-0"
                >
                  {/* Icon bubble */}
                  <div className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/50 ${cfg.bg}`}>
                    <Icon className={`h-4 w-4 ${cfg.color}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pt-1.5">
                    <p className="text-sm text-foreground/90 leading-snug">{log.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-xs text-muted-foreground">by <span className="font-medium text-foreground/80">{by}</span></span>
                      <span className="text-xs text-muted-foreground/50">·</span>
                      <span className="text-xs text-muted-foreground">{formatTimeAgo(log.createdAt)}</span>
                    </div>

                    {/* Changes detail */}
                    {log.changes && Object.keys(log.changes).length > 0 && (
                      <div className="mt-2 space-y-1">
                        {Object.entries(log.changes).map(([field, change]) => (
                          <div key={field} className="flex items-center gap-1.5 text-xs">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground capitalize">{field}</span>
                            <span className="text-muted-foreground/60 line-through">{String(change.from || "—")}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-foreground/80 font-medium">{String(change.to || "—")}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();

  // Go back in history so the leads list keeps its search/filters/page state.
  // Falls back to a fresh /leads navigation when there's no history (direct link).
  function backToLeads() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/leads");
    }
  }
  const leadId = params.leadId as string;
  const { user: authUser, hasPermission } = useAuthStore();

  const [editOpen, setEditOpen] = useState(false);

  const { data: lead, isLoading } = useLead(leadId);
  const { data: teamsData } = useTeams({ status: "active", limit: 100 });
  const { data: allCourses = [] } = useAllCourses();
  const teams = teamsData?.data ?? [];

  const updateStatus = useUpdateLeadStatus();
  const updateLead = useUpdateLead();
  const { data: existingStudent } = useStudentByLeadId(lead?._id ?? "");
  const [showStudentModal,  setShowStudentModal]  = useState(false);
  const [lostModalOpen,     setLostModalOpen]     = useState(false);
  const [followupModalOpen, setFollowupModalOpen] = useState(false);
  const [meetingModalOpen,  setMeetingModalOpen]  = useState(false);
  const [pendingLostStatus, setPendingLostStatus] = useState<LeadStatus | null>(null);
  const assignLead = useAssignLead();
  const assignToTeam = useAssignLeadToTeam();
  const transferToTeam = useTransferLeadToTeam();

  const canEdit = hasPermission("leads", "edit");
  const currentUserId = authUser?._id ?? "";

  // ── Access control helpers (computed after lead loads) ────────────────────
  // Super admin: system role named "Super Admin"
  const isSuperAdmin =
    authUser?.role?.isSystemRole === true &&
    authUser?.role?.roleName === "Super Admin";

  // Team leader: current user appears in lead's team.leaders array
  const teamObj = typeof lead?.team === "object" && lead?.team !== null
    ? (lead.team as Team)
    : null;

  const isTeamLeader = !!teamObj?.leaders?.some(
    (l) => (typeof l === "object" && l !== null ? l._id : l) === currentUserId,
  );

  // Can assign/transfer: must be super admin OR team leader of this lead's team
  const canAssignOrTransfer = isSuperAdmin || isTeamLeader;

  // Team members available for assignment (only this team's members)
  const teamMembers: User[] = teamObj?.members
    ? (teamObj.members as User[]).filter((m) => typeof m === "object" && m !== null)
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <p className="text-muted-foreground">Lead not found</p>
        <Button variant="outline" onClick={backToLeads}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Leads
        </Button>
      </div>
    );
  }

  const assignedUser = typeof lead.assignedTo === "object" ? lead.assignedTo as User : null;
  const reporterUser = typeof lead.reporter === "object" ? lead.reporter as User : null;

  return (
    <div className="space-y-6 pb-10">
      {/* Header bar */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between gap-4 flex-wrap"
      >
        <Button variant="ghost" size="sm" onClick={backToLeads} className="gap-2 -ml-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Leads
        </Button>
        {canEdit && (
          <Button onClick={() => setEditOpen(true)} size="sm" variant="outline" className="gap-2">
            <Pencil className="h-3.5 w-3.5" />
            Edit Lead
          </Button>
        )}
      </motion.div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column — Lead info */}
        <div className="space-y-6 lg:col-span-1">

          {/* Lead Info Card */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-lg shrink-0">
                      {getInitials(lead.name)}
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-lg font-bold text-foreground truncate">{lead.name}</h2>
                      {lead.source && (
                        <p className="text-xs text-muted-foreground capitalize">{lead.source}</p>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={lead.status} />
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <InfoRow icon={Mail} label="Email" value={lead.email} />
                <InfoRow icon={Phone} label="Phone" value={lead.phone} leadId={lead._id} leadName={lead.name} hasWhatsapp={lead.hasWhatsapp} />
                <InfoRow icon={Globe} label="Source" value={lead.source} />
                {lead.referredBy && (
                  <InfoRow
                    icon={UsersRound}
                    label="Referred By"
                    value={`${lead.referredBy}${lead.referralType ? ` (${lead.referralType === "employee" ? "Delta employee" : lead.referralType})` : ""}`}
                  />
                )}
                {lead.campaign && (
                  <InfoRow icon={TrendingUp} label="Campaign" value={lead.campaign} />
                )}
                {lead.platform && (
                  <InfoRow icon={Globe} label="Platform" value={lead.platform} />
                )}
                {lead.leadReceivedTime && (
                  <InfoRow icon={Clock} label="Lead Received" value={lead.leadReceivedTime} />
                )}

                {/* Assigned To */}
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-md bg-muted/50 p-1.5">
                    <User2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground mb-1">Assigned To</p>
                    {assignedUser ? (
                      <div className="flex items-center gap-2">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="bg-yellow-500/15 text-yellow-400 text-xs">
                            {getInitials(assignedUser.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{assignedUser.name}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Unassigned</span>
                    )}
                  </div>
                </div>

                {/* Reporter */}
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-md bg-muted/50 p-1.5">
                    <User2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground mb-0.5">Reporter</p>
                    <p className="text-sm font-medium">{getUserName(reporterUser)}</p>
                  </div>
                </div>

                {/* Team */}
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-md bg-muted/50 p-1.5">
                    <UsersRound className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground mb-0.5">Team</p>
                    {teamObj ? (
                      <p className="text-sm font-medium">{teamObj.name}</p>
                    ) : (
                      <span className="text-sm text-muted-foreground italic">No team</span>
                    )}
                  </div>
                </div>

                {/* Course */}
                {lead.course && (
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-md bg-muted/50 p-1.5">
                      <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground mb-0.5">Course</p>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-foreground">
                          {typeof lead.course === "object"
                            ? (lead.course as Course).name
                            : lead.course}
                        </p>
                        {typeof lead.course === "object" && (lead.course as Course).amount != null && (
                          <span className="text-xs text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5">
                            {fmtFull((lead.course as Course).amount)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Selling Amount */}
                {lead.sellingAmount != null && (
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-md bg-primary/10 p-1.5">
                      <CircleDollarSign className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground mb-0.5">Selling Amount</p>
                      <p className="text-sm font-semibold text-primary">{fmtFull(lead.sellingAmount)}</p>
                    </div>
                  </div>
                )}

                {lead.lastContactedAt && (
                  <InfoRow icon={Clock} label="Last Contacted" value={new Date(lead.lastContactedAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " GST"} />
                )}
                {lead.firstContactTime && (
                  <InfoRow icon={Clock} label="First Contact Time" value={new Date(lead.firstContactTime).toLocaleString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " GST"} />
                )}

                {/* New lead insight fields */}
                {(lead.initialLeadResponse || lead.primaryConcern || lead.followupStrategyType) && (
                  <div className="space-y-2 rounded-xl border border-border/40 bg-muted/10 p-3">
                    {lead.initialLeadResponse && (() => {
                      const cfg = INITIAL_RESPONSE_CONFIG.find((c) => c.value === lead.initialLeadResponse);
                      return cfg ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-muted-foreground flex items-center gap-1"><MessageSquare className="h-3 w-3" />Response</span>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span>
                        </div>
                      ) : null;
                    })()}
                    {lead.primaryConcern && (() => {
                      const cfg = PRIMARY_CONCERN_CONFIG.find((c) => c.value === lead.primaryConcern);
                      return cfg ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-muted-foreground flex items-center gap-1"><AlertTriangle className="h-3 w-3" />Concern</span>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span>
                        </div>
                      ) : null;
                    })()}
                    {lead.followupStrategyType && (() => {
                      const cfg = FOLLOWUP_STRATEGY_CONFIG.find((c) => c.value === lead.followupStrategyType);
                      return cfg ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Target className="h-3 w-3" />Strategy</span>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span>
                        </div>
                      ) : null;
                    })()}
                  </div>
                )}

                {lead.lastFollowupDate && (
                  <InfoRow icon={Calendar} label="Last Follow-up" value={new Date(lead.lastFollowupDate).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" })} />
                )}

                {/* Lost details — reason + notes captured when the lead was marked lost */}
                {lead.status === "lost" && (lead.lostReason || lead.lostNotes) && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 space-y-1.5"
                  >
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-400">
                      <XCircle className="h-3.5 w-3.5" /> Lost Details
                    </p>
                    {lead.lostReason && (
                      <p className="text-xs text-foreground">
                        <span className="text-muted-foreground">Reason: </span>
                        <span className="font-medium">{LOST_REASON_LABELS[lead.lostReason] ?? lead.lostReason}</span>
                      </p>
                    )}
                    {lead.lostNotes && (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{lead.lostNotes}</p>
                    )}
                  </motion.div>
                )}
                {/* Demo badges */}
                {(lead.demoScheduled != null || lead.demoAttended != null) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {lead.demoScheduled === true && (
                      <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-400 border border-violet-500/20">✓ Demo Scheduled</span>
                    )}
                    {lead.demoScheduled === false && (
                      <span className="inline-flex items-center rounded-full bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground border border-border">✗ Demo Not Scheduled</span>
                    )}
                    {lead.demoAttended === true && (
                      <span className="inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400 border border-green-500/20">✓ Demo Attended</span>
                    )}
                    {lead.demoAttended === false && (
                      <span className="inline-flex items-center rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 border border-red-500/20">✗ Demo Not Attended</span>
                    )}
                  </div>
                )}

                {/* Exact Concern */}
                {lead.exactConcern && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                  >
                    <p className="text-[11px] font-medium text-amber-400 mb-1.5 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Exact Concern
                    </p>
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{lead.exactConcern}</p>
                  </motion.div>
                )}

                {/* Comments */}
                {lead.comments && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-border/50 bg-muted/20 p-3"
                  >
                    <p className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      Comments
                    </p>
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{lead.comments}</p>
                  </motion.div>
                )}

                <InfoRow icon={Calendar} label="Created" value={formatDate(lead.createdAt)} />
                {/* Handed over since — createdAt is the hand-over; this is when it first came in. */}
                {lead.originalCreatedAt && (
                  <InfoRow icon={Calendar} label="First created" value={formatDate(lead.originalCreatedAt)} />
                )}
                <InfoRow icon={Clock} label="Last Updated" value={formatDate(lead.updatedAt)} />

                {/* Calls — counted from 3CX's calls with this lead (2026-10-14); not edited by hand */}
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/15">
                      <Phone className="h-4 w-4 text-blue-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-blue-300/80">Calls</p>
                      <p className="text-[10px] text-muted-foreground">From 3CX — counted by themselves after each call</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: "Calls", value: lead.callCount ?? 0, cls: "text-blue-400" },
                      { label: "Connected", value: lead.callConnected ?? 0, cls: "text-emerald-400" },
                      { label: "Not connected", value: lead.callNotConnected ?? 0, cls: "text-orange-400" },
                    ].map((c) => (
                      <div key={c.label} className="rounded-lg bg-background/60 px-2 py-1.5">
                        <p className={`text-xl font-bold tabular-nums ${c.cls}`}>{c.value}</p>
                        <p className="text-[10px] text-muted-foreground">{c.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Quick Actions */}
                {canEdit && (
                  <div className="space-y-2 pt-2 border-t border-border/40">
                    {/* Status change — any editor can change status */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Change Status</p>
                      <Select
                        value={lead.status}
                        onValueChange={(val) => {
                          const newStatus = val as LeadStatus;
                          if (newStatus === "lost") {
                            setPendingLostStatus(newStatus);
                            setLostModalOpen(true);
                          } else if (newStatus === "followup") {
                            setFollowupModalOpen(true);
                          } else if (newStatus === "meeting_scheduled") {
                            // When the meeting is — it becomes a reminder
                            setMeetingModalOpen(true);
                          } else if (newStatus === "closed") {
                            /*
                             * Held, not written.
                             *
                             * Shown whether or not this lead is already
                             * enrolled — closing one a second time used to fall
                             * through to a bare status update, so the dialog
                             * never appeared and the close looked like it had
                             * done nothing.
                             *
                             * But the status used to be applied here, before
                             * the form had been seen, so dismissing left a lead
                             * marked closed with no enrolment behind it: a sale
                             * on the board that finance and the LMS have never
                             * heard of. It is applied when the enrolment is
                             * saved and not before.
                             */
                            setShowStudentModal(true);
                          } else {
                            updateStatus.mutate({ id: lead._id, status: newStatus });
                          }
                        }}
                        disabled={updateStatus.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(STATUS_CONFIG) as LeadStatus[]).map((s) => (
                            <SelectItem key={s} value={s} className="text-xs">
                              {STATUS_CONFIG[s].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Course change */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <BookOpen className="h-3 w-3" />
                        Change Course
                      </p>
                      <Select
                        value={
                          lead.course
                            ? typeof lead.course === "object"
                              ? (lead.course as Course)._id
                              : (lead.course as string)
                            : "__none__"
                        }
                        onValueChange={(val) =>
                          updateLead.mutate({
                            id: lead._id,
                            data: { course: val === "__none__" ? null : val },
                          })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          {updateLead.isPending
                            ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span>
                            : <SelectValue placeholder="No course" />
                          }
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">
                            — No course —
                          </SelectItem>
                          {allCourses.map((c) => (
                            <SelectItem key={c._id} value={c._id} className="text-xs">
                              <span className="flex items-center justify-between gap-3 w-full">
                                <span>{c.name}</span>
                                <span className="text-muted-foreground">
                                  {fmtFull(c.amount)}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Selling Amount */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <CircleDollarSign className="h-3 w-3" />
                        Selling Amount
                        <span className="text-[10px] text-muted-foreground/60">(negotiated price)</span>
                      </p>
                      <Input
                        type="number"
                        min={0}
                        className="h-8 text-xs"
                        defaultValue={lead.sellingAmount ?? ""}
                        key={lead.sellingAmount ?? "sa-none"}
                        placeholder="e.g. 15000"
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const newVal = raw === "" ? null : Number(raw);
                          const current = lead.sellingAmount ?? null;
                          if (newVal !== current) {
                            updateLead.mutate({ id: lead._id, data: { sellingAmount: newVal } });
                          }
                        }}
                        disabled={updateLead.isPending}
                      />
                    </div>

                    {/* ─── Lead Insight Fields ─────────────────────────────── */}
                    <div className="pt-1 border-t border-border/30">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mb-2">Lead Insights</p>
                    </div>

                    {/* First Contact Time */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        First Contact Time
                      </p>
                      <Input
                        type="datetime-local"
                        className="h-8 text-xs [color-scheme:dark]"
                        defaultValue={lead.firstContactTime
                          ? new Date(lead.firstContactTime).toLocaleString("sv-SE", { timeZone: "Asia/Dubai" }).slice(0, 16).replace(" ", "T")
                          : ""}
                        key={lead.firstContactTime ?? "fct-none"}
                        onBlur={(e) => {
                          const val = e.target.value;
                          const current = lead.firstContactTime
                            ? new Date(lead.firstContactTime).toLocaleString("sv-SE", { timeZone: "Asia/Dubai" }).slice(0, 16).replace(" ", "T")
                            : "";
                          if (val !== current) {
                            const iso = val ? new Date(`${val}:00+04:00`).toISOString() : null;
                            updateLead.mutate({ id: lead._id, data: { firstContactTime: iso } });
                          }
                        }}
                        disabled={updateLead.isPending}
                      />
                    </div>

                    {/* Initial Lead Response */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        Initial Lead Response
                      </p>
                      <Select
                        value={lead.initialLeadResponse ?? "__none__"}
                        onValueChange={(val) =>
                          updateLead.mutate({ id: lead._id, data: { initialLeadResponse: val === "__none__" ? null : val } })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Not set">
                            {lead.initialLeadResponse ? (() => {
                              const cfg = INITIAL_RESPONSE_CONFIG.find((c) => c.value === lead.initialLeadResponse);
                              return cfg ? <span className={cfg.color}>{cfg.label}</span> : null;
                            })() : <span className="text-muted-foreground">Not set</span>}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Not set —</SelectItem>
                          {INITIAL_RESPONSE_CONFIG.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              <span className={opt.color}>{opt.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Primary Concern */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Primary Concern
                      </p>
                      <Select
                        value={lead.primaryConcern ?? "__none__"}
                        onValueChange={(val) =>
                          updateLead.mutate({ id: lead._id, data: { primaryConcern: val === "__none__" ? null : val } })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Not set">
                            {lead.primaryConcern ? (() => {
                              const cfg = PRIMARY_CONCERN_CONFIG.find((c) => c.value === lead.primaryConcern);
                              return cfg ? <span className={cfg.color}>{cfg.label}</span> : null;
                            })() : <span className="text-muted-foreground">Not set</span>}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Not set —</SelectItem>
                          {PRIMARY_CONCERN_CONFIG.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              <span className={opt.color}>{opt.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Followup Strategy Type */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Target className="h-3 w-3" />
                        Followup Strategy
                      </p>
                      <Select
                        value={lead.followupStrategyType ?? "__none__"}
                        onValueChange={(val) =>
                          updateLead.mutate({ id: lead._id, data: { followupStrategyType: val === "__none__" ? null : val } })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Not set">
                            {lead.followupStrategyType ? (() => {
                              const cfg = FOLLOWUP_STRATEGY_CONFIG.find((c) => c.value === lead.followupStrategyType);
                              return cfg ? <span className={cfg.color}>{cfg.label}</span> : null;
                            })() : <span className="text-muted-foreground">Not set</span>}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Not set —</SelectItem>
                          {FOLLOWUP_STRATEGY_CONFIG.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">
                              <span className={opt.color}>{opt.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Last Follow-up Date */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Last Follow-up Date
                      </p>
                      <Input
                        type="date"
                        className="h-8 text-xs [color-scheme:dark]"
                        defaultValue={lead.lastFollowupDate ? lead.lastFollowupDate.slice(0, 10) : ""}
                        key={lead.lastFollowupDate ?? "none"}
                        onBlur={(e) => {
                          const val = e.target.value;
                          if (val !== (lead.lastFollowupDate?.slice(0, 10) ?? "")) {
                            updateLead.mutate({ id: lead._id, data: { lastFollowupDate: val || null } });
                          }
                        }}
                        disabled={updateLead.isPending}
                      />
                    </div>

                    {/* Demo Scheduled */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Demo Scheduled?</p>
                      <Select
                        value={lead.demoScheduled == null ? "__none__" : lead.demoScheduled ? "true" : "false"}
                        onValueChange={(val) =>
                          updateLead.mutate({ id: lead._id, data: { demoScheduled: val === "__none__" ? null : val === "true" } })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Not set" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Not set —</SelectItem>
                          <SelectItem value="false" className="text-xs">No</SelectItem>
                          <SelectItem value="true" className="text-xs">Yes</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Demo Attended */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Demo Attended?</p>
                      <Select
                        value={lead.demoAttended == null ? "__none__" : lead.demoAttended ? "true" : "false"}
                        onValueChange={(val) =>
                          updateLead.mutate({ id: lead._id, data: { demoAttended: val === "__none__" ? null : val === "true" } })
                        }
                        disabled={updateLead.isPending}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Not set" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs text-muted-foreground">— Not set —</SelectItem>
                          <SelectItem value="false" className="text-xs">No</SelectItem>
                          <SelectItem value="true" className="text-xs">Yes</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Exact Concern */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Exact Concern
                      </p>
                      <Textarea
                        className="text-xs min-h-[70px] resize-none"
                        placeholder="Describe the exact concern..."
                        defaultValue={lead.exactConcern ?? ""}
                        key={`ec-${lead._id}-${lead.updatedAt}`}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val !== (lead.exactConcern ?? "")) {
                            updateLead.mutate({ id: lead._id, data: { exactConcern: val || null } });
                          }
                        }}
                        disabled={updateLead.isPending}
                      />
                    </div>

                    {/* Comments */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        Comments
                      </p>
                      <Textarea
                        className="text-xs min-h-[70px] resize-none"
                        placeholder="Add any comments..."
                        defaultValue={lead.comments ?? ""}
                        key={`cm-${lead._id}-${lead.updatedAt}`}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val !== (lead.comments ?? "")) {
                            updateLead.mutate({ id: lead._id, data: { comments: val || null } });
                          }
                        }}
                        disabled={updateLead.isPending}
                      />
                    </div>

                    {/* Assign to team member — only team leaders / super admin, only if lead has a team */}
                    {canAssignOrTransfer && teamObj && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">Assign To Member</p>
                        {teamMembers.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">No members in this team</p>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline" size="sm"
                                className="w-full justify-between h-8 text-xs"
                                disabled={assignLead.isPending}
                              >
                                {assignedUser ? assignedUser.name : "Select member"}
                                <ChevronDown className="h-3.5 w-3.5 ml-2 text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56 max-h-64 overflow-y-auto">
                              {/* {assignedUser && (
                                <DropdownMenuItem
                                  onClick={() => updateLead.mutate({ id: lead._id, data: { assignedTo: null } })}
                                  className="gap-2 text-muted-foreground"
                                >
                                  <X className="h-4 w-4 text-red-400" />
                                  Unassigned
                                </DropdownMenuItem>
                              )} */}
                              {teamMembers.map((u) => (
                                <DropdownMenuItem
                                  key={u._id}
                                  onClick={() => assignLead.mutate({ id: lead._id, userId: u._id })}
                                  className="gap-2"
                                >
                                  <Avatar className="h-5 w-5">
                                    <AvatarFallback className="text-xs bg-muted">{getInitials(u.name)}</AvatarFallback>
                                  </Avatar>
                                  {u.name}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )}

                    {/* Assign / Transfer Team — only team leaders / super admin */}
                    {canAssignOrTransfer && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">
                          {teamObj ? "Transfer to Team" : "Assign to Team"}
                        </p>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline" size="sm"
                              className="w-full justify-between h-8 text-xs"
                              disabled={assignToTeam.isPending || transferToTeam.isPending}
                            >
                              <span className="flex items-center gap-1.5">
                                {teamObj
                                  ? <ArrowRightLeft className="h-3 w-3" />
                                  : <UsersRound className="h-3 w-3" />}
                                {teamObj ? `Change from ${teamObj.name}` : "Select team"}
                              </span>
                              <ChevronDown className="h-3.5 w-3.5 ml-2 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56 max-h-64 overflow-y-auto">
                            {teams.filter((t) => t._id !== teamObj?._id).map((t) => (
                              <DropdownMenuItem
                                key={t._id}
                                onClick={() =>
                                  teamObj
                                    ? transferToTeam.mutate({ id: lead._id, teamId: t._id })
                                    : assignToTeam.mutate({ id: lead._id, teamId: t._id })
                                }
                                className="gap-2"
                              >
                                <UsersRound className="h-4 w-4 text-muted-foreground" />
                                {t.name}
                              </DropdownMenuItem>
                            ))}
                            {teams.filter((t) => t._id !== teamObj?._id).length === 0 && (
                              <p className="px-3 py-2 text-xs text-muted-foreground">No other teams available</p>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Activity Timeline */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <ActivityTimeline logs={lead.activityLogs ?? []} />
          </motion.div>
        </div>

        {/* Right column — Notes + Reminders */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="lg:col-span-2 space-y-4"
        >
          <NotesPanel
            leadId={lead._id}
            notes={lead.notes ?? []}
            currentUserId={currentUserId}
            canEdit={canEdit}
          />
          <PaymentPanel
            leadId={lead._id}
            leadName={lead.name}
            closed={lead.status === "closed"}
            payments={lead.payments ?? []}
            sellingAmount={lead.sellingAmount ?? undefined}
            courseAmount={
              typeof lead.course === "object" && lead.course
                ? (lead.course as Course).amount
                : undefined
            }
            canEdit={canEdit}
          />
          {/* Their WhatsApp chats, and a box to message them (2026-10-27). */}
          {hasPermission("whatsapp", "view") && <LeadWhatsAppCard leadId={lead._id} />}
          <ReminderPanel
            leadId={lead._id}
            reminders={lead.reminders ?? []}
            canEdit={canEdit}
          />
          <FollowUpPanel
            leadId={lead._id}
            canEdit={canEdit}
            leadInFollowUp={lead.status === "followup"}
          />
          <CallsPanel
            leadId={lead._id}
            phone={lead.phone ?? ""}
            leadName={lead.name}
          />
          {/* <AiChatPanel contextType="lead" contextId={lead._id} /> */}
        </motion.div>
      </div>

      {/* Edit Dialog */}
      <LeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead}
        mode="edit"
      />

      {/* Create Student Modal — fires when status → closed. Shown for a lead
          that is already enrolled too: closing one a second time, after it went
          to follow-up and came back, showed nothing at all. */}
      {showStudentModal && (
        <CreateStudentModal
          open
          lead={lead}
          existingStudent={existingStudent}
          // Away, and the lead keeps the status it had.
          onClose={() => setShowStudentModal(false)}
          onCreated={() => {
            setShowStudentModal(false);
            if (lead.status !== "closed") updateStatus.mutate({ id: lead._id, status: "closed" });
          }}
        />
      )}

      {/* Lost Reason Modal */}
      <LostReasonModal
        open={lostModalOpen}
        leadName={lead.name}
        loading={updateStatus.isPending}
        onConfirm={(reason, notes) => {
          updateStatus.mutate(
            { id: lead._id, status: "lost", lostReason: reason, lostNotes: notes || undefined },
            { onSettled: () => { setLostModalOpen(false); setPendingLostStatus(null); } },
          );
        }}
        onCancel={() => { setLostModalOpen(false); setPendingLostStatus(null); }}
      />

      {/* Follow-up Details Modal — mandatory when status → followup */}
      <FollowupDetailsModal
        open={followupModalOpen}
        leadName={lead.name}
        loading={updateStatus.isPending}
        onConfirm={(d) => {
          updateStatus.mutate(
            { id: lead._id, status: "followup", ...d },
            { onSettled: () => setFollowupModalOpen(false) },
          );
        }}
        onCancel={() => setFollowupModalOpen(false)}
      />

      {/* Meeting time — mandatory when status → meeting_scheduled; becomes a reminder */}
      <MeetingScheduledModal
        open={meetingModalOpen}
        leadName={lead.name}
        loading={updateStatus.isPending}
        onConfirm={(d) => {
          updateStatus.mutate(
            { id: lead._id, status: "meeting_scheduled", ...d },
            { onSuccess: () => setMeetingModalOpen(false) },
          );
        }}
        onCancel={() => setMeetingModalOpen(false)}
      />
    </div>
  );
}
