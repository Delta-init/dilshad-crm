"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, GraduationCap, Phone, Mail, BookOpen, Users, User2,
  Calendar, DollarSign, StickyNote, ExternalLink, Edit2, Loader2,
  CheckCircle2, XCircle, AlertTriangle, Target, MessageSquare, Gift, Undo2, Send, ArrowRightLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtAcademy, fmtUSD } from "@/lib/currency";
import { AcademyBadge } from "@/components/students/AcademyBadge";
import { useStudent, useUpdateStudent } from "@/hooks/useStudents";
import { useEnrolmentCorrection, uaeTime } from "@/hooks/useEnrolments";
import { useAuthStore } from "@/lib/store/authStore";
import { CorrectEnrolmentDialog } from "@/components/students/CorrectEnrolmentDialog";
import { AddClientEmail } from "@/components/students/AddClientEmail";
import { INITIAL_RESPONSE_CONFIG, PRIMARY_CONCERN_CONFIG, FOLLOWUP_STRATEGY_CONFIG } from "@/lib/leadConfig";
import type { Course } from "@/types/course";
import type { User } from "@/types";
import type { StudentStatus, FeeStatus } from "@/types/student";
import { EditStudentModal } from "@/components/students/EditStudentModal";
import { ChangeCourseDialog, CourseChangeBanner, useMayChangeCourse } from "@/components/students/CourseChangeDialog";

const STUDENT_STATUS: Record<StudentStatus, { label: string; color: string }> = {
  active:    { label: "Active",    color: "bg-green-500/15 text-green-400 border-green-500/30"   },
  inactive:  { label: "Inactive",  color: "bg-neutral-500/15 text-neutral-400 border-neutral-500/30"   },
  graduated: { label: "Graduated", color: "bg-violet-500/15 text-violet-400 border-violet-500/30"},
  dropped:   { label: "Dropped",   color: "bg-red-500/15 text-red-400 border-red-500/30"         },
};

const FEE_STATUS: Record<FeeStatus, { label: string; color: string }> = {
  paid:    { label: "Paid",    color: "bg-green-500/15 text-green-400 border-green-500/30"   },
  partial: { label: "Partial", color: "bg-amber-500/15 text-amber-400 border-amber-500/30"  },
  pending: { label: "Pending", color: "bg-red-500/15 text-red-400 border-red-500/30"         },
};

function InfoRow({ icon: Icon, label, value, className }: { icon: React.ElementType; label: string; value?: string | null; className?: string }) {
  if (!value) return null;
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <div className="mt-0.5 rounded-md bg-muted/50 p-1.5 shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
        <p className="text-sm font-medium text-foreground break-words">{value}</p>
      </div>
    </div>
  );
}

function formatIST(iso?: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " GST";
}

export default function StudentDetailPage() {
  const { studentId } = useParams() as { studentId: string };
  const router = useRouter();

  const { data: student, isLoading, error } = useStudent(studentId);
  const updateMut = useUpdateStudent();

  const [editingNotes, setEditingNotes] = useState(false);
  const [notesVal, setNotesVal] = useState("");
  const [editOpen, setEditOpen] = useState(false);

  /*
   * Whether finance sent this enrolment back — asked only by whoever may act
   * on enrolments, and answered only for the closer or someone who may edit
   * students (anyone else gets nothing, and sees nothing here). Sent back, the
   * whole enrolment can be corrected and sent again from here.
   */
  const { hasPermission } = useAuthStore();
  // Followed while it is on its way to finance, so an email added below turns into "delivered" without a reload.
  const { data: correction } = useEnrolmentCorrection(studentId, hasPermission("enrolments", "edit"), { followDelivery: true });
  const [correctOpen, setCorrectOpen] = useState(false);
  // Change course once finance has it (2026-11-23): the closer their own, whoever edits students any.
  const mayChangeCourse = useMayChangeCourse(
    student?.assignedTo && typeof student.assignedTo === "object" ? (student.assignedTo as User)._id : (student?.assignedTo as string | null | undefined),
  );
  const [courseChangeOpen, setCourseChangeOpen] = useState(false);

  if (isLoading) return (
    <div className="flex items-center justify-center py-32">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
  if (error || !student) return (
    <div className="py-20 text-center">
      <XCircle className="mx-auto h-10 w-10 text-destructive/50 mb-3" />
      <p className="text-muted-foreground">Student not found</p>
      <Button variant="outline" className="mt-4" onClick={() => router.back()}>Go back</Button>
    </div>
  );

  const courseObj   = student.course   && typeof student.course   === "object" ? student.course   as Course : null;
  const assignedObj = student.assignedTo && typeof student.assignedTo === "object" ? student.assignedTo as User : null;
  const teamObj     = student.team     && typeof student.team     === "object" ? (student.team as { _id: string; name: string }) : null;
  const leadObj     = student.leadId   && typeof student.leadId   === "object" ? student.leadId   as { _id: string; name: string } : null;

  const sCfg = STUDENT_STATUS[student.status];
  const fCfg = FEE_STATUS[student.feeStatus];
  const pct  = student.totalFee > 0 ? Math.min(100, (student.paidAmount / student.totalFee) * 100) : 0;

  function quickUpdate(data: Parameters<typeof updateMut.mutate>[0]["data"]) {
    updateMut.mutate({ id: student!._id, data });
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-10">
      {/* Back */}
      <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}>
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-2 -ml-2">
          <ArrowLeft className="h-4 w-4" /> Back to Students
        </Button>
      </motion.div>

      {/* Profile header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
        <Card className="border-border/50 overflow-hidden">
          <div className="absolute inset-0 opacity-5 bg-gradient-to-br from-primary to-violet-600 pointer-events-none" />
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary font-bold text-2xl uppercase border border-primary/20">
                {student.name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h1 className="text-xl font-bold text-foreground">{student.name}</h1>
                    <p className="text-sm text-muted-foreground font-mono mt-0.5">{student.enrollmentNumber}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Which academy it was closed for — its money is in that academy's currency. */}
                    <AcademyBadge academy={student.academy} className="px-3 py-1 text-xs" />
                    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${sCfg.color}`}>{sCfg.label}</span>
                    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${fCfg.color}`}>{fCfg.label}</span>
                    {leadObj && (
                      <Link href={`/leads/${leadObj._id}`} className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors">
                        <ExternalLink className="h-3 w-3" /> View Lead
                      </Link>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setEditOpen(true)}>
                      <Edit2 className="h-3 w-3" /> Edit
                    </Button>
                    {/* In finance: its course changes only this way, approved there. */}
                    {student.financeInvoiceNumber && mayChangeCourse && (
                      <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setCourseChangeOpen(true)}>
                        <ArrowRightLeft className="h-3 w-3" /> Change course
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 mt-3 text-sm text-muted-foreground">
                  {student.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{student.phone}</span>}
                  {student.email && <span className="flex items-center gap-1"><Mail  className="h-3.5 w-3.5" />{student.email}</span>}
                  {courseObj     && <span className="flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" />{courseObj.name}</span>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Sent back by finance: why, and the correction — everything, sent again in one step. */}
      {correction?.sentBack && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex min-w-0 items-start gap-2">
            <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-red-300">
                Finance sent this enrolment back{correction.returnedReason ? `: ${correction.returnedReason}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-red-300/70">
                Correct anything — the course, the fee, the payments and receipts, the client&apos;s details — and it goes back to finance in the same step{correction.invoiceNumber ? `, as ${correction.invoiceNumber}` : ""}.
              </p>
            </div>
          </div>
          <Button size="sm" className="gap-2 shrink-0" onClick={() => setCorrectOpen(true)}>
            <Edit2 className="h-3.5 w-3.5" /> Correct &amp; send again
          </Button>
        </motion.div>
      )}
      {/* A course change asked of finance: waiting, or rejected with why. */}
      <CourseChangeBanner changes={student.courseChanges} academy={student.academy} />
      {/* Never reached finance — it went without the client's email: add it, and it goes again at once. */}
      {correction?.needsClientEmail && <AddClientEmail studentId={student._id} initial={correction.suggestedEmail} />}
      {correction && !correction.sentBack && !correction.resentAt && correction.deliveryStatus === "pending" && (
        <p className="flex items-center gap-1.5 text-xs text-sky-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> On its way to finance…
        </p>
      )}
      {correction && !correction.sentBack && correction.resentAt && (
        <p className="flex items-center gap-1.5 text-xs text-sky-400">
          <Send className="h-3.5 w-3.5" />
          Sent again to finance {uaeTime(correction.resentAt)}
          {(correction.resends ?? 0) > 1 ? ` · ${correction.resends} times` : ""}
          {correction.approvalState === "approved" ? " — approved" : correction.approvalState === "pending" ? " — waiting for approval" : ""}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Fee + Quick edit */}
        <div className="space-y-4">
          {/* Fee card */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-primary" /> Fee Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Total",   value: fmtAcademy(student.totalFee, student.academy),    cls: "text-foreground" },
                    { label: "Paid",    value: fmtAcademy(student.paidAmount, student.academy),   cls: "text-green-400" },
                    { label: "Balance", value: fmtAcademy(student.pendingAmount, student.academy),cls: student.pendingAmount > 0 ? "text-amber-400" : "text-muted-foreground" },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="rounded-lg bg-muted/30 p-2 border border-border/30">
                      <p className={cn("text-sm font-bold tabular-nums", cls)}>{value}</p>
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
                {/* The bonus given at the close: beside the money, never in the balance. */}
                {typeof student.hasBonus === "boolean" && (
                  <div className="flex items-center justify-between rounded-lg border border-border/30 bg-muted/20 px-2.5 py-1.5 text-[11px]">
                    <span className="flex items-center gap-1 text-muted-foreground"><Gift className="h-3 w-3" /> Bonus</span>
                    <span className={cn("font-semibold tabular-nums", student.hasBonus ? "text-violet-400" : "text-muted-foreground")}>
                      {student.hasBonus ? fmtUSD(student.bonusAmount ?? 0) : "None"}
                    </span>
                  </div>
                )}
                {student.totalFee > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground">Progress</span>
                      <span className="font-semibold text-foreground">{pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-green-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: 0.4, duration: 0.7, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Quick edit panel */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Edit2 className="h-4 w-4 text-primary" /> Quick Edit
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Student Status</p>
                  <Select value={student.status} onValueChange={(v) => quickUpdate({ status: v as StudentStatus })} disabled={updateMut.isPending}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STUDENT_STATUS) as StudentStatus[]).map((s) => (
                        <SelectItem key={s} value={s} className="text-xs"><span className={STUDENT_STATUS[s].color.split(" ")[1]}>{STUDENT_STATUS[s].label}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Fee Status</p>
                  <Select value={student.feeStatus} onValueChange={(v) => quickUpdate({ feeStatus: v as FeeStatus })} disabled={updateMut.isPending}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(FEE_STATUS) as FeeStatus[]).map((s) => (
                        <SelectItem key={s} value={s} className="text-xs"><span className={FEE_STATUS[s].color.split(" ")[1]}>{FEE_STATUS[s].label}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1"><Calendar className="h-3 w-3" />Enrollment Date</p>
                  <Input
                    type="date"
                    className="h-8 text-xs [color-scheme:dark]"
                    defaultValue={student.enrollmentDate?.slice(0, 10)}
                    key={student.enrollmentDate}
                    onBlur={(e) => {
                      if (e.target.value && e.target.value !== student.enrollmentDate?.slice(0, 10)) {
                        quickUpdate({ enrollmentDate: new Date(e.target.value).toISOString() } as never);
                      }
                    }}
                    disabled={updateMut.isPending}
                  />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Right: Details */}
        <div className="lg:col-span-2 space-y-4">
          {/* Personal & enrollment */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-primary" /> Student Details
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InfoRow icon={BookOpen}  label="Course"      value={courseObj?.name ?? null} />
                <InfoRow icon={User2}     label="Counsellor"  value={assignedObj?.name ?? null} />
                <InfoRow icon={Users}     label="Team"        value={teamObj?.name ?? null} />
                <InfoRow icon={Calendar}  label="Enrolled"    value={formatIST(student.enrollmentDate)} />
                <InfoRow icon={Phone}     label="Phone"       value={student.phone} />
                <InfoRow icon={Mail}      label="Email"       value={student.email} />
              </CardContent>
            </Card>
          </motion.div>

          {/* Lead insights */}
          {(student.initialLeadResponse || student.primaryConcern || student.followupStrategyType ||
            student.demoScheduled || student.firstContactTime || student.lastFollowupDate) && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
              <Card className="border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Target className="h-4 w-4 text-primary" /> Lead Insights
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {student.initialLeadResponse && (() => {
                    const cfg = INITIAL_RESPONSE_CONFIG.find((c) => c.value === student.initialLeadResponse);
                    return cfg ? (
                      <div className="flex items-center gap-3">
                        <div className="mt-0.5 rounded-md bg-muted/50 p-1.5 shrink-0"><MessageSquare className="h-3.5 w-3.5 text-muted-foreground" /></div>
                        <div><p className="text-[11px] text-muted-foreground mb-1">Initial Response</p><span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span></div>
                      </div>
                    ) : null;
                  })()}
                  {student.primaryConcern && (() => {
                    const cfg = PRIMARY_CONCERN_CONFIG.find((c) => c.value === student.primaryConcern);
                    return cfg ? (
                      <div className="flex items-center gap-3">
                        <div className="mt-0.5 rounded-md bg-muted/50 p-1.5 shrink-0"><AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" /></div>
                        <div><p className="text-[11px] text-muted-foreground mb-1">Primary Concern</p><span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span></div>
                      </div>
                    ) : null;
                  })()}
                  {student.followupStrategyType && (() => {
                    const cfg = FOLLOWUP_STRATEGY_CONFIG.find((c) => c.value === student.followupStrategyType);
                    return cfg ? (
                      <div className="flex items-center gap-3">
                        <div className="mt-0.5 rounded-md bg-muted/50 p-1.5 shrink-0"><Target className="h-3.5 w-3.5 text-muted-foreground" /></div>
                        <div><p className="text-[11px] text-muted-foreground mb-1">Followup Strategy</p><span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span></div>
                      </div>
                    ) : null;
                  })()}
                  {student.demoScheduled !== undefined && (
                    <div className="flex items-center gap-3">
                      <div className="mt-0.5 rounded-md bg-muted/50 p-1.5 shrink-0"><CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" /></div>
                      <div>
                        <p className="text-[11px] text-muted-foreground mb-1">Demo</p>
                        <div className="flex flex-wrap gap-1.5">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${student.demoScheduled ? "bg-violet-500/10 text-violet-400 border-violet-500/20" : "bg-muted/40 text-muted-foreground/50 border-border/30"}`}>
                            {student.demoScheduled ? "✓ Scheduled" : "Not scheduled"}
                          </span>
                          {student.demoScheduled && (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${student.demoAttended ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}`}>
                              {student.demoAttended ? "✓ Attended" : "Not attended"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <InfoRow icon={Calendar} label="First Contact Time" value={formatIST(student.firstContactTime)} />
                  <InfoRow icon={Calendar} label="Last Follow-up"     value={student.lastFollowupDate ? new Date(student.lastFollowupDate).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "2-digit", month: "short", year: "numeric" }) : null} />
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Notes */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
            <Card className="border-border/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span className="flex items-center gap-2"><StickyNote className="h-4 w-4 text-primary" />Notes</span>
                  {!editingNotes && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setNotesVal(student.notes ?? ""); setEditingNotes(true); }}>
                      <Edit2 className="h-3 w-3 mr-1" /> Edit
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {editingNotes ? (
                  <div className="space-y-2">
                    <Textarea value={notesVal} onChange={(e) => setNotesVal(e.target.value)} className="text-sm resize-none min-h-[80px]" />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setEditingNotes(false)}>Cancel</Button>
                      <Button size="sm" disabled={updateMut.isPending} onClick={() => { quickUpdate({ notes: notesVal } as never); setEditingNotes(false); }}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className={cn("text-sm", student.notes ? "text-foreground" : "text-muted-foreground/50 italic")}>
                    {student.notes || "No notes yet"}
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>

      <EditStudentModal open={editOpen} student={student} onClose={() => setEditOpen(false)} />
      {correctOpen && <CorrectEnrolmentDialog studentId={student._id} open onClose={() => setCorrectOpen(false)} />}
      {courseChangeOpen && <ChangeCourseDialog studentId={student._id} name={student.name} onClose={() => setCourseChangeOpen(false)} />}
    </div>
  );
}
