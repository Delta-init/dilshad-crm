"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensor, useSensors, useDroppable, useDraggable,
  closestCenter, rectIntersection, pointerWithin,
  type DragStartEvent, type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, arrayMove, horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRouter } from "next/navigation";
import {
  Eye, Loader2, Phone, Mail, User2, ExternalLink,
  Calendar, Clock, BookOpen, Users, StickyNote, Bell, PhoneOff, PhoneCall, X,
  Pencil, CreditCard, MoreHorizontal, AlarmClock, MessageSquarePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import {
  useLeads, useUpdateLeadStatus,
  useAddLeadNote, useLead,
} from "@/hooks/useLeads";
import { useAddPayment } from "@/hooks/usePayments";
import { useAddReminder } from "@/hooks/useReminders";
import { getInitials, formatDate } from "@/lib/utils";
import type { Lead, LeadFilters, LeadNote } from "@/types/lead";
import type { LeadStatus } from "@/lib/statusConfig";
import type { User } from "@/types";
import type { Course } from "@/types/course";
import type { Team } from "@/types/team";
import LeadDialog from "@/components/leads/LeadDialog";
import { LostReasonModal } from "@/components/leads/LostReasonModal";
import { FollowupDetailsModal } from "@/components/leads/FollowupDetailsModal";
import { MeetingScheduledModal } from "@/components/leads/MeetingScheduledModal";
import { CloseLeadDialog } from "@/components/students/CloseLeadDialog";
import { ClickToCall } from "@/components/leads/ClickToCall";
import { fmtFull, getCurrencySymbol } from "@/lib/currency";
import { INITIAL_RESPONSE_CONFIG, PRIMARY_CONCERN_CONFIG, FOLLOWUP_STRATEGY_CONFIG } from "@/lib/leadConfig";

import { LEAD_STATUSES, STATUS_META } from "@/lib/statusConfig";
import { toGstDateISO } from "@/lib/utils";

// ─── Config ───────────────────────────────────────────────────────────────────

const KANBAN_STATUSES: LeadStatus[] = [...LEAD_STATUSES] as LeadStatus[];

const STATUS_LABELS = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, STATUS_META[s].label]),
) as Record<LeadStatus, string>;

const STATUS_STYLE = Object.fromEntries(
  LEAD_STATUSES.map((s) => [s, {
    header:   STATUS_META[s].header,
    border:   STATUS_META[s].border,
    dot:      STATUS_META[s].dot,
    dropZone: STATUS_META[s].dropZone,
    badge:    STATUS_META[s].badge,
  }]),
) as Record<LeadStatus, { header: string; border: string; dot: string; dropZone: string; badge: string }>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUserName(user: User | string | null | undefined): string {
  if (!user) return "";
  return typeof user === "object" ? user.name : user;
}

// ─── Mobile detection ────────────────────────────────────────────────────────

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

// ─── Quick Payment Dialog (responsive) ────────────────────────────────────────

function QuickPaymentDialog({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paidAt, setPaidAt] = useState(() => toGstDateISO(new Date()));
  const addPayment = useAddPayment(lead._id);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    addPayment.mutate(
      { amount: amt, note: note || undefined, paidAt: `${paidAt}T00:00:00+04:00` },
      { onSuccess: () => { onClose(); setAmount(""); setNote(""); } },
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onClose}>
      <ResponsiveDialogContent desktopClassName="max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4 text-teal-400" />
            Add Payment — {lead.name}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 px-4 sm:px-0 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount ({getCurrencySymbol().trim()}) *</Label>
            <Input type="number" min="1" placeholder="5000" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Date</Label>
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} className="h-9 [color-scheme:dark]" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Textarea placeholder="Payment note…" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[60px] resize-none text-sm" />
          </div>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" className="flex-1" disabled={addPayment.isPending}>
              {addPayment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Save Payment
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ─── Quick Reminder Dialog (responsive) ──────────────────────────────────────

function QuickReminderDialog({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const addReminder = useAddReminder(lead._id);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!remindAt) return;
    addReminder.mutate(
      { title: title || undefined, note: note || undefined, remindAt: `${remindAt}:00+04:00` },
      { onSuccess: () => { onClose(); setTitle(""); setNote(""); setRemindAt(""); } },
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onClose}>
      <ResponsiveDialogContent desktopClassName="max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-base">
            <AlarmClock className="h-4 w-4 text-violet-400" />
            Add Reminder — {lead.name}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 px-4 sm:px-0 pt-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Remind At *</Label>
            <Input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} className="h-9 [color-scheme:dark]" required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Title (optional)</Label>
            <Input placeholder="Call back, Follow up…" value={title} onChange={(e) => setTitle(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Textarea placeholder="Reminder note…" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[60px] resize-none text-sm" />
          </div>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" className="flex-1" disabled={addReminder.isPending}>
              {addReminder.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Set Reminder
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ─── Quick Notes Dialog (responsive) — add note + view existing ───────────────

function QuickNotesDialog({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const [content, setContent] = useState("");
  const { data: fullLead, isLoading } = useLead(open ? lead._id : "");
  const addNote = useAddLeadNote();

  const notes: LeadNote[] = (fullLead?.notes ?? []).slice().reverse();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    addNote.mutate(
      { leadId: lead._id, content: content.trim() },
      { onSuccess: () => setContent("") },
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onClose}>
      <ResponsiveDialogContent desktopClassName="max-w-md" height="auto">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-base">
            <StickyNote className="h-4 w-4 text-blue-400" />
            Notes — {lead.name}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <div className="px-4 sm:px-0 space-y-4 pb-2">
          {/* Add note form */}
          <form onSubmit={handleSubmit} className="space-y-2">
            <Textarea
              placeholder="Write a note…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[72px] resize-none text-sm"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={addNote.isPending || !content.trim()}>
                {addNote.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                Add Note
              </Button>
            </div>
          </form>

          {/* Existing notes */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Previous Notes {notes.length > 0 && `(${notes.length})`}
            </p>

            {isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div key={i} className="h-14 rounded-lg bg-muted/40 animate-pulse" />
                ))}
              </div>
            ) : notes.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                <StickyNote className="h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No notes yet</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[260px] overflow-y-auto pr-0.5">
                <AnimatePresence initial={false}>
                  {notes.map((note) => {
                    const authorName = typeof note.author === "object"
                      ? (note.author as User).name
                      : "Unknown";
                    return (
                      <motion.div
                        key={note._id}
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-1"
                      >
                        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                          {note.content}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-medium text-primary/80 bg-primary/10 rounded px-1.5 py-0.5">
                            {authorName}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(note.createdAt).toLocaleString("en-AE", {
                              timeZone: "Asia/Dubai",
                              day: "2-digit", month: "short", year: "numeric",
                              hour: "2-digit", minute: "2-digit", hour12: true,
                            })}
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>

        <ResponsiveDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} className="w-full sm:w-auto">
            Close
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ─── Kanban Actions Menu — dropdown on desktop, bottom sheet on mobile ────────

interface KanbanActionsMenuProps {
  lead: Lead;
  onEdit: (lead: Lead) => void;
  onAddPayment: (lead: Lead) => void;
  onAddReminder: (lead: Lead) => void;
  onAddNote: (lead: Lead) => void;
}

function KanbanActionsMenu({ lead, onEdit, onAddPayment, onAddReminder, onAddNote }: KanbanActionsMenuProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const triggerBtn = (
    <button
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        if (isMobile) setSheetOpen(true);
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md
        text-muted-foreground hover:text-foreground hover:bg-muted transition-colors
        sm:opacity-0 sm:group-hover:opacity-100 opacity-100"
      title="Actions"
    >
      <MoreHorizontal className="h-3.5 w-3.5" />
    </button>
  );

  // Mobile — bottom sheet
  if (isMobile) {
    const mobileActions = [
      { icon: Pencil,           label: "Edit Lead",    color: "text-foreground",    onClick: () => onEdit(lead)           },
      { icon: CreditCard,       label: "Add Payment",  color: "text-teal-400",      onClick: () => onAddPayment(lead)     },
      { icon: AlarmClock,       label: "Add Reminder", color: "text-violet-400",    onClick: () => onAddReminder(lead)    },
      { icon: MessageSquarePlus, label: "Notes",       color: "text-blue-400",      onClick: () => onAddNote(lead)        },
    ];

    return (
      <>
        {triggerBtn}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            hideClose
            className="p-0 rounded-t-2xl max-h-[60dvh] overflow-hidden"
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </div>

            {/* lead name header */}
            <div className="px-5 py-2.5 border-b border-border/50">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                  {getInitials(lead.name)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{lead.name}</p>
                  <p className="text-[11px] text-muted-foreground">{lead.phone}</p>
                </div>
              </div>
            </div>

            {/* action rows */}
            <div className="px-2 py-2 pb-[max(env(safe-area-inset-bottom),12px)]">
              {mobileActions.map(({ icon: Icon, label, color, onClick }) => (
                <button
                  key={label}
                  onClick={() => { setSheetOpen(false); onClick(); }}
                  className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5
                    text-left hover:bg-muted/60 active:bg-muted transition-colors"
                >
                  <Icon className={`h-4.5 w-4.5 shrink-0 ${color}`} style={{ width: 18, height: 18 }} />
                  <span className="text-sm font-medium text-foreground">{label}</span>
                </button>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop — dropdown
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {triggerBtn}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => onEdit(lead)} className="gap-2 text-xs">
          <Pencil className="h-3.5 w-3.5" /> Edit Lead
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onAddPayment(lead)} className="gap-2 text-xs">
          <CreditCard className="h-3.5 w-3.5 text-teal-400" /> Add Payment
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAddReminder(lead)} className="gap-2 text-xs">
          <AlarmClock className="h-3.5 w-3.5 text-violet-400" /> Add Reminder
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAddNote(lead)} className="gap-2 text-xs">
          <MessageSquarePlus className="h-3.5 w-3.5 text-blue-400" /> Notes
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Lead Preview Popup ───────────────────────────────────────────────────────

export interface LeadPreviewProps {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
}

function LeadPreviewBody({
  lead,
  onClose,
  onViewFull,
}: {
  lead: Lead;
  onClose: () => void;
  onViewFull: () => void;
}) {
  const style = STATUS_STYLE[lead.status];
  const teamObj    = typeof lead.team   === "object" ? lead.team   as Team   : null;
  const courseObj  = typeof lead.course === "object" ? lead.course as Course : null;
  const assignedName = getUserName(lead.assignedTo as User | string | null);

  function Row({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value?: string | null }) {
    if (!value) return null;
    return (
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
          <p className="text-sm font-medium text-foreground break-all">{value}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="relative px-5 pt-5 pb-4 border-b border-border/50">
        <DialogHeader>
          <div className="flex items-center gap-3 pr-8">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-base">
              {getInitials(lead.name)}
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold leading-tight truncate">
                {lead.name}
              </DialogTitle>
              {lead.source && (
                <p className="text-xs text-muted-foreground capitalize mt-0.5">{lead.source}</p>
              )}
            </div>
          </div>
        </DialogHeader>
        <div className="mt-3">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${style.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {STATUS_LABELS[lead.status]}
          </span>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3 overflow-y-auto max-h-[55vh]">
        <Row icon={Phone}    label="Phone"        value={lead.phone} />
        <Row icon={Mail}     label="Email"        value={lead.email} />
        <Row icon={User2}    label="Assigned To"  value={assignedName || "Unassigned"} />
        <Row icon={Users}    label="Team"         value={teamObj?.name} />
        <Row icon={BookOpen} label="Course"
          value={courseObj
            ? `${courseObj.name}${courseObj.amount != null ? ` · ${fmtFull(courseObj.amount)}` : ""}`
            : undefined}
        />
        {lead.lastFollowupDate && (
          <Row icon={Calendar} label="Last Follow-up"
            value={new Date(lead.lastFollowupDate).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" })}
          />
        )}
        <Row icon={Calendar} label="Created"      value={formatDate(lead.createdAt)} />
        <Row icon={Clock}    label="Last Updated" value={formatDate(lead.updatedAt)} />
        {lead.assignedAt && (
          <Row icon={Clock} label="Assigned At"
            value={new Date(lead.assignedAt).toLocaleString("en-AE", {
              timeZone: "Asia/Dubai", day: "2-digit", month: "short",
              year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
            }) + " GST"}
          />
        )}
        {/* Demo badges */}
        {(lead.demoScheduled || lead.demoAttended) && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {lead.demoScheduled && (
              <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-400 border border-violet-500/20">Demo Scheduled</span>
            )}
            {lead.demoAttended && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400 border border-green-500/20">Demo Attended</span>
            )}
          </div>
        )}
        {/* Lead insight badges */}
        {(lead.initialLeadResponse || lead.primaryConcern || lead.followupStrategyType) && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {lead.initialLeadResponse && (() => {
              const cfg = INITIAL_RESPONSE_CONFIG.find((c) => c.value === lead.initialLeadResponse);
              return cfg ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
            {lead.primaryConcern && (() => {
              const cfg = PRIMARY_CONCERN_CONFIG.find((c) => c.value === lead.primaryConcern);
              return cfg ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
            {lead.followupStrategyType && (() => {
              const cfg = FOLLOWUP_STRATEGY_CONFIG.find((c) => c.value === lead.followupStrategyType);
              return cfg ? <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
          </div>
        )}
        <div className="grid grid-cols-5 gap-2 pt-1">
          {[
            { icon: StickyNote, label: "Notes",     value: lead.notes?.length ?? 0,    color: "text-blue-400"   },
            { icon: Bell,       label: "Reminders", value: lead.reminders?.length ?? 0, color: "text-violet-400" },
            { icon: Phone,      label: "Calls",     value: lead.callCount ?? 0,         color: "text-sky-400"    },
            { icon: PhoneCall,  label: "Connected", value: lead.callConnected ?? 0,     color: "text-emerald-400" },
            { icon: PhoneOff,   label: "Not conn.", value: lead.callNotConnected ?? 0,  color: "text-orange-400" },
          ].map(({ icon: Icon, label, value, color }) => (
            <div key={label} className="flex flex-col items-center gap-1 rounded-xl border border-border/40 bg-muted/20 py-2.5">
              <Icon className={`h-4 w-4 ${color}`} />
              <span className="text-sm font-bold text-foreground">{value}</span>
              <span className="text-[10px] text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 border-t border-border/50 flex items-center gap-3">
        <Button variant="outline" size="sm" className="flex-1" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" className="flex-1 gap-2" onClick={onViewFull}>
          <ExternalLink className="h-3.5 w-3.5" />
          View Full Lead
        </Button>
      </div>
    </>
  );
}

export function LeadPreviewPopup({ lead, open, onClose }: LeadPreviewProps) {
  const router = useRouter();
  const isMobile = useIsMobile();

  if (!lead) return null;

  function handleViewFull() {
    onClose();
    router.push(`/leads/${lead!._id}`);
  }

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onClose}>
        <SheetContent
          side="bottom"
          hideClose
          className="p-0 rounded-t-2xl max-h-[90dvh] overflow-hidden gap-0 flex flex-col"
        >
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <LeadPreviewBody lead={lead} onClose={onClose} onViewFull={handleViewFull} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm w-full p-0 gap-0 overflow-hidden">
        <LeadPreviewBody lead={lead} onClose={onClose} onViewFull={handleViewFull} />
      </DialogContent>
    </Dialog>
  );
}

// ─── Drag ghost components (shown in DragOverlay) ────────────────────────────

function KanbanCardGhost({ lead }: { lead: Lead }) {
  const style = STATUS_STYLE[lead.status];
  const assignedName = getUserName(lead.assignedTo as User | string | null);
  return (
    <div className={`relative rounded-xl border bg-card shadow-2xl select-none overflow-hidden w-[232px] rotate-[1.5deg] ${style.border}`}>
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${style.dot}`} />
      <div className="p-3 pl-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold">
            {getInitials(lead.name)}
          </div>
          <p className="flex-1 text-sm font-semibold text-foreground truncate">{lead.name}</p>
        </div>
        {lead.phone && (
          <div className="flex items-center gap-1.5">
            <Phone className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            <span className="text-[11px] font-mono text-muted-foreground">{lead.phone}</span>
          </div>
        )}
        {assignedName && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground shrink-0">
              {getInitials(assignedName)}
            </div>
            <span className="text-[11px] text-muted-foreground truncate">{assignedName}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function KanbanColumnGhost({ status, count }: { status: LeadStatus; count: number }) {
  const style = STATUS_STYLE[status];
  return (
    <div className="flex flex-col w-[240px] opacity-95 rotate-[1deg] shadow-2xl">
      <div className={`flex items-center justify-between gap-2 rounded-t-xl px-3 py-2.5 ${style.header}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
          <span className="text-xs font-semibold">{STATUS_LABELS[status]}</span>
        </div>
        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold bg-black/10">{count}</span>
      </div>
      <div className="rounded-b-xl border-x border-b border-border/40 bg-muted/20 p-2" style={{ minHeight: 80 }} />
    </div>
  );
}

// ─── Kanban Card ─────────────────────────────────────────────────────────────

interface KanbanCardProps {
  lead: Lead;
  columnStatus: LeadStatus;
  canEdit: boolean;
  onPreview: (lead: Lead) => void;
  onEdit: (lead: Lead) => void;
  onAddPayment: (lead: Lead) => void;
  onAddReminder: (lead: Lead) => void;
  onAddNote: (lead: Lead) => void;
}

function KanbanCard({
  lead, columnStatus, canEdit,
  onPreview, onEdit, onAddPayment, onAddReminder, onAddNote,
}: KanbanCardProps) {
  const style = STATUS_STYLE[lead.status];
  const assignedName = getUserName(lead.assignedTo as User | string | null);

  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: lead._id,
    data: { type: "card", columnStatus },
  });

  return (
    <motion.div
      ref={setNodeRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isDragging ? 0.3 : 1, y: 0, scale: isDragging ? 0.97 : 1 }}
      exit={{ opacity: 0, scale: 0.93, transition: { duration: 0.12 } }}
      transition={{ duration: 0.15 }}
      {...listeners}
      {...attributes}
      className={`group relative rounded-xl border bg-card shadow-sm cursor-grab active:cursor-grabbing
        hover:shadow-md hover:-translate-y-0.5 transition-shadow duration-150 select-none overflow-hidden
        ${style.border}`}
      style={{ touchAction: "none" }}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${style.dot}`} />

      <div className="p-3 pl-4">
        {/* Top row — avatar + name + actions */}
        <div className="flex items-start gap-2 mb-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-[11px] font-bold mt-0.5">
            {getInitials(lead.name)}
          </div>
          <p className="flex-1 text-sm font-semibold text-foreground leading-tight break-words min-w-0">
            {lead.name}
          </p>
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Eye — preview */}
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPreview(lead); }}
              className="flex h-6 w-6 items-center justify-center rounded-md
                text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors
                sm:opacity-0 sm:group-hover:opacity-100 opacity-100"
              title="Quick view"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>

            {/* Actions menu */}
            {canEdit && (
              <KanbanActionsMenu
                lead={lead}
                onEdit={onEdit}
                onAddPayment={onAddPayment}
                onAddReminder={onAddReminder}
                onAddNote={onAddNote}
              />
            )}
          </div>
        </div>

        {/* Phone */}
        {lead.phone && (
          <div className="flex items-center gap-1.5 mb-2">
            <Phone className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            <span className="text-[11px] font-mono text-muted-foreground">{lead.phone}</span>
            <ClickToCall phoneNumber={lead.phone} leadId={lead._id} leadName={lead.name} size="icon" variant="ghost" className="ml-auto h-6 w-6" />
          </div>
        )}

        {/* Demo badges */}
        {(lead.demoScheduled || lead.demoAttended) && (
          <div className="flex items-center gap-1 mb-1.5 flex-wrap">
            {lead.demoScheduled && (
              <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">Demo</span>
            )}
            {lead.demoAttended && (
              <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[9px] font-medium text-green-400">Attended</span>
            )}
          </div>
        )}

        {/* Lead insight chips */}
        {(lead.initialLeadResponse || lead.primaryConcern || lead.followupStrategyType) && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {lead.initialLeadResponse && (() => {
              const cfg = INITIAL_RESPONSE_CONFIG.find((c) => c.value === lead.initialLeadResponse);
              return cfg ? <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
            {lead.primaryConcern && (() => {
              const cfg = PRIMARY_CONCERN_CONFIG.find((c) => c.value === lead.primaryConcern);
              return cfg ? <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
            {lead.followupStrategyType && (() => {
              const cfg = FOLLOWUP_STRATEGY_CONFIG.find((c) => c.value === lead.followupStrategyType);
              return cfg ? <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span> : null;
            })()}
          </div>
        )}

        {/* Bottom — assigned + CNC */}
        <div className="flex items-center justify-between gap-2 mt-1">
          {assignedName ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground shrink-0">
                {getInitials(assignedName)}
              </div>
              <span className="text-[11px] text-muted-foreground truncate">{assignedName}</span>
            </div>
          ) : (
            <span className="text-[11px] text-muted-foreground/40">Unassigned</span>
          )}
          <div className="flex items-center gap-2 shrink-0">
            {/* From 3CX: calls · connected · not connected */}
            {(lead.callCount ?? 0) > 0 && (
              <div className="flex items-center gap-0.5" title={`${lead.callCount} calls through 3CX — ${lead.callConnected ?? 0} connected, ${lead.callNotConnected ?? 0} not connected`}>
                <Phone className="h-3 w-3 text-sky-400" />
                <span className="text-[11px] font-bold text-sky-400">{lead.callCount}</span>
              </div>
            )}
            {(lead.callConnected ?? 0) > 0 && (
              <div className="flex items-center gap-0.5" title="Connected">
                <PhoneCall className="h-3 w-3 text-emerald-400" />
                <span className="text-[11px] font-bold text-emerald-400">{lead.callConnected}</span>
              </div>
            )}
            {(lead.callNotConnected ?? 0) > 0 && (
              <div className="flex items-center gap-0.5" title="Not connected">
                <PhoneOff className="h-3 w-3 text-orange-400" />
                <span className="text-[11px] font-bold text-orange-400">{lead.callNotConnected}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Kanban Column ────────────────────────────────────────────────────────────

interface KanbanColumnProps {
  status: LeadStatus;
  leads: Lead[];
  localOverrides: Record<string, LeadStatus>;
  canEdit: boolean;
  onPreview: (lead: Lead) => void;
  onEdit: (lead: Lead) => void;
  onAddPayment: (lead: Lead) => void;
  onAddReminder: (lead: Lead) => void;
  onAddNote: (lead: Lead) => void;
}

function KanbanColumn({
  status, leads, localOverrides, canEdit,
  onPreview, onEdit, onAddPayment, onAddReminder, onAddNote,
}: KanbanColumnProps) {
  const style = STATUS_STYLE[status];

  // Column sortable (drag to reorder columns)
  const {
    attributes, listeners, setNodeRef: setSortRef,
    transform, transition, isDragging: isColDragging,
  } = useSortable({ id: `col:${status}`, data: { type: "column", status } });

  // Drop zone for cards
  const { setNodeRef: setDropRef, isOver: isCardOver } = useDroppable({
    id: `zone:${status}`,
    data: { type: "drop-zone", columnStatus: status },
  });

  const colStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isColDragging ? 0.4 : 1,
    zIndex: isColDragging ? 50 : undefined,
  };

  return (
    <div
      ref={setSortRef}
      style={colStyle}
      className="flex flex-col w-[240px] sm:w-[220px] shrink-0 h-full snap-start"
    >
      {/* Header — drag handle for column reorder */}
      <div
        {...attributes}
        {...listeners}
        className={`flex items-center justify-between gap-2 rounded-t-xl px-3 py-2.5 cursor-grab active:cursor-grabbing select-none ${style.header}`}
        style={{ touchAction: "none" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
          <span className="text-xs font-semibold truncate">{STATUS_LABELS[status]}</span>
        </div>
        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums shrink-0 bg-black/10">
          {leads.length}
        </span>
      </div>

      {/* Body — drop zone */}
      <div
        ref={setDropRef}
        className={`flex-1 rounded-b-xl border-x border-b p-2 space-y-2 overflow-y-auto
          transition-all duration-150
          ${isCardOver
            ? `${style.dropZone} border-2 ring-1 ring-inset`
            : "border-border/40 bg-muted/8"
          }`}
        style={{ maxHeight: "calc(100dvh - 320px)", minHeight: "120px" }}
      >
        <AnimatePresence initial={false}>
          {leads.map((lead) => (
            <KanbanCard
              key={lead._id}
              lead={{ ...lead, status: localOverrides[lead._id] ?? lead.status }}
              columnStatus={status}
              canEdit={canEdit}
              onPreview={onPreview}
              onEdit={onEdit}
              onAddPayment={onAddPayment}
              onAddReminder={onAddReminder}
              onAddNote={onAddNote}
            />
          ))}
        </AnimatePresence>

        <AnimatePresence>
          {leads.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={`flex items-center justify-center py-8 text-xs rounded-lg border border-dashed transition-colors
                ${isCardOver
                  ? "border-current text-current opacity-70"
                  : "border-border/30 text-muted-foreground/40"
                }`}
            >
              {isCardOver ? "↓ Drop here" : "No leads"}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

// Custom collision: columns collide with columns, cards collide with drop zones
const kanbanCollision: CollisionDetection = (args) => {
  const { active, droppableContainers } = args;
  if (active.data.current?.type === "column") {
    const cols = droppableContainers.filter((c) => String(c.id).startsWith("col:"));
    return closestCenter({ ...args, droppableContainers: cols });
  }
  const zones = droppableContainers.filter((c) => String(c.id).startsWith("zone:"));
  const pointer = pointerWithin({ ...args, droppableContainers: zones });
  return pointer.length > 0 ? pointer : rectIntersection({ ...args, droppableContainers: zones });
};

export interface KanbanBoardProps {
  filters: LeadFilters;
  canEdit: boolean;
}

export function KanbanBoard({ filters, canEdit }: KanbanBoardProps) {
  const [columnOrder, setColumnOrder]       = useState<LeadStatus[]>(KANBAN_STATUSES);
  const [localOverrides, setLocalOverrides] = useState<Record<string, LeadStatus>>({});
  const [activeCardId, setActiveCardId]     = useState<string | null>(null);
  const [activeColStatus, setActiveColStatus] = useState<LeadStatus | null>(null);
  const [previewLead, setPreviewLead]       = useState<Lead | null>(null);
  const [editLead, setEditLead]             = useState<Lead | null>(null);
  const [paymentLead, setPaymentLead]       = useState<Lead | null>(null);
  const [reminderLead, setReminderLead]     = useState<Lead | null>(null);
  const [noteLead, setNoteLead]             = useState<Lead | null>(null);
  const [lostModalLead, setLostModalLead]   = useState<{ leadId: string; name: string } | null>(null);
  const [followupModalLead, setFollowupModalLead] = useState<{ leadId: string; name: string } | null>(null);
  const [meetingModalLead,  setMeetingModalLead]  = useState<{ leadId: string; name: string } | null>(null);
  /** A card dropped on Closed, waiting for its enrolment before it moves. */
  const [closeLead, setCloseLead] = useState<Lead | null>(null);

  const { mutate: updateStatus, isPending: statusPending } = useUpdateLeadStatus();

  const { data, isLoading } = useLeads({ ...filters, page: 1, limit: 500 });
  const allLeads = data?.data ?? [];

  const grouped = columnOrder.reduce<Record<LeadStatus, Lead[]>>((acc, s) => {
    acc[s] = []; return acc;
  }, {} as Record<LeadStatus, Lead[]>);
  for (const lead of allLeads) {
    const eff = localOverrides[lead._id] ?? lead.status;
    if (grouped[eff]) grouped[eff].push(lead);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const activeCard = activeCardId ? allLeads.find((l) => l._id === activeCardId) ?? null : null;

  function handleDragStart(e: DragStartEvent) {
    if (e.active.data.current?.type === "card")   setActiveCardId(e.active.id as string);
    if (e.active.data.current?.type === "column") setActiveColStatus(e.active.data.current.status as LeadStatus);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveCardId(null);
    setActiveColStatus(null);
    if (!over) return;

    const activeType = active.data.current?.type;
    const overId = String(over.id);

    // Column reorder
    if (activeType === "column" && overId.startsWith("col:")) {
      const fromStatus = active.data.current!.status as LeadStatus;
      const toStatus   = overId.replace("col:", "") as LeadStatus;
      if (fromStatus !== toStatus) {
        setColumnOrder((prev) =>
          arrayMove(prev, prev.indexOf(fromStatus), prev.indexOf(toStatus)),
        );
      }
      return;
    }

    // Card → drop zone
    if (activeType === "card" && overId.startsWith("zone:")) {
      const leadId       = active.id as string;
      const targetStatus = overId.replace("zone:", "") as LeadStatus;
      const lead = allLeads.find((l) => l._id === leadId);
      if (!lead) return;
      const currentStatus = localOverrides[leadId] ?? lead.status;
      if (currentStatus === targetStatus) return;

      if (targetStatus === "lost") {
        // Don't apply optimistic update yet — wait for reason
        setLostModalLead({ leadId, name: lead.name });
        return;
      }

      if (targetStatus === "followup") {
        // Mandatory follow-up details before the move applies
        setFollowupModalLead({ leadId, name: lead.name });
        return;
      }

      if (targetStatus === "meeting_scheduled") {
        // The meeting time first — it becomes a reminder
        setMeetingModalLead({ leadId, name: lead.name });
        return;
      }

      if (targetStatus === "closed") {
        // The enrolment first: the card moves only once it is saved.
        setCloseLead(lead);
        return;
      }

      setLocalOverrides((prev) => ({ ...prev, [leadId]: targetStatus }));
      updateStatus(
        { id: leadId, status: targetStatus },
        {
          onSuccess: () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
          onError:   () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
        },
      );
    }
  }

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4 pt-1 snap-x snap-mandatory">
        {KANBAN_STATUSES.slice(0, 7).map((s) => {
          const style = STATUS_STYLE[s];
          return (
            <div key={s} className="w-[240px] sm:w-[220px] shrink-0 snap-start animate-pulse">
              <div className={`h-9 rounded-t-xl ${style.header} opacity-60`} />
              <div className="rounded-b-xl border border-border/30 bg-muted/10 p-2 space-y-2" style={{ height: 180 }}>
                <div className="h-[76px] rounded-lg bg-muted/50" />
                <div className="h-[60px] rounded-lg bg-muted/40" />
              </div>
            </div>
          );
        })}
        <div className="flex items-center px-2 text-muted-foreground/30 shrink-0">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={kanbanCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        autoScroll={{ threshold: { x: 0.15, y: 0.15 }, acceleration: 20, interval: 5 }}
      >
        <SortableContext
          items={columnOrder.map((s) => `col:${s}`)}
          strategy={horizontalListSortingStrategy}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
            className="flex gap-3 overflow-x-auto pb-4 pt-1 snap-x snap-mandatory sm:snap-none"
            style={{ scrollbarWidth: "thin", scrollbarColor: "hsl(var(--border)) transparent" }}
          >
            {columnOrder.map((status, i) => (
              <motion.div
                key={status}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.025 }}
                className="flex flex-col h-full"
              >
                <KanbanColumn
                  status={status}
                  leads={grouped[status]}
                  localOverrides={localOverrides}
                  canEdit={canEdit}
                  onPreview={setPreviewLead}
                  onEdit={setEditLead}
                  onAddPayment={setPaymentLead}
                  onAddReminder={setReminderLead}
                  onAddNote={setNoteLead}
                />
              </motion.div>
            ))}
          </motion.div>
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.18,0.67,0.6,1.22)" }}>
          {activeCard      ? <KanbanCardGhost lead={activeCard} /> : null}
          {activeColStatus ? <KanbanColumnGhost status={activeColStatus} count={grouped[activeColStatus]?.length ?? 0} /> : null}
        </DragOverlay>
      </DndContext>

      {/* Lead Preview */}
      <LeadPreviewPopup lead={previewLead} open={!!previewLead} onClose={() => setPreviewLead(null)} />

      {/* Edit Lead */}
      <LeadDialog
        open={!!editLead}
        onOpenChange={(o) => { if (!o) setEditLead(null); }}
        lead={editLead}
        mode="edit"
      />

      {paymentLead && (
        <QuickPaymentDialog lead={paymentLead} open={!!paymentLead} onClose={() => setPaymentLead(null)} />
      )}
      {reminderLead && (
        <QuickReminderDialog lead={reminderLead} open={!!reminderLead} onClose={() => setReminderLead(null)} />
      )}
      {noteLead && (
        <QuickNotesDialog lead={noteLead} open={!!noteLead} onClose={() => setNoteLead(null)} />
      )}

      {/* Lost reason modal — fires when a card is dragged to the Lost column */}
      <LostReasonModal
        open={!!lostModalLead}
        leadName={lostModalLead?.name}
        loading={statusPending}
        onConfirm={(reason, notes) => {
          if (!lostModalLead) return;
          const { leadId } = lostModalLead;
          setLocalOverrides((prev) => ({ ...prev, [leadId]: "lost" }));
          updateStatus(
            { id: leadId, status: "lost", lostReason: reason, lostNotes: notes || undefined },
            {
              onSuccess: () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
              onError:   () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
              onSettled: () => setLostModalLead(null),
            },
          );
        }}
        onCancel={() => setLostModalLead(null)}
      />

      {/* Follow-up details modal — fires when a card is dragged to Follow Up */}
      <FollowupDetailsModal
        open={!!followupModalLead}
        leadName={followupModalLead?.name}
        loading={statusPending}
        onConfirm={(d) => {
          if (!followupModalLead) return;
          const { leadId } = followupModalLead;
          setLocalOverrides((prev) => ({ ...prev, [leadId]: "followup" }));
          updateStatus(
            { id: leadId, status: "followup", ...d },
            {
              onSuccess: () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
              onError:   () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
              onSettled: () => setFollowupModalLead(null),
            },
          );
        }}
        onCancel={() => setFollowupModalLead(null)}
      />

      {/* Meeting time — fires when a card is dragged to Meeting Scheduled */}
      <MeetingScheduledModal
        open={!!meetingModalLead}
        leadName={meetingModalLead?.name}
        loading={statusPending}
        onConfirm={(d) => {
          if (!meetingModalLead) return;
          const { leadId } = meetingModalLead;
          setLocalOverrides((prev) => ({ ...prev, [leadId]: "meeting_scheduled" }));
          updateStatus(
            { id: leadId, status: "meeting_scheduled", ...d },
            {
              onSuccess: () => {
                setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; });
                setMeetingModalLead(null);
              },
              onError: () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
            },
          );
        }}
        onCancel={() => setMeetingModalLead(null)}
      />

      {/* Enrolment — fires when a card is dragged to Closed. Dismissed, the
          card stays where it was: a closed lead with no enrolment is a sale
          finance, the LMS and CS Portal never hear of. */}
      {closeLead && (
        <CloseLeadDialog
          key={closeLead._id}
          lead={closeLead}
          onClose={() => setCloseLead(null)}
          onClosed={() => {
            const leadId = closeLead._id;
            setCloseLead(null);
            setLocalOverrides((prev) => ({ ...prev, [leadId]: "closed" }));
            updateStatus(
              { id: leadId, status: "closed" },
              {
                onSuccess: () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
                onError:   () => setLocalOverrides((p) => { const n = { ...p }; delete n[leadId]; return n; }),
              },
            );
          }}
        />
      )}
    </>
  );
}
