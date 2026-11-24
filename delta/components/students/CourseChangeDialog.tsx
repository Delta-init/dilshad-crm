"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRightLeft, Clock, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogHeader, ResponsiveDialogTitle,
  ResponsiveDialogDescription, ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog";
import { cn } from "@/lib/utils";
import { fmtAcademy } from "@/lib/currency";
import { useAuthStore } from "@/lib/store/authStore";
import { useAllCourses } from "@/hooks/useCourses";
import { useCourseChangeInfo, useRequestCourseChange } from "@/hooks/useCourseChange";
import { bangalorePriceOf } from "@/types/course";
import type { CourseChange } from "@/types/student";

/*
 * Change course after finance approved the enrolment (the user, 2026-11-23). A closed, approved lead was reopened, put
 * on a cheaper course and closed again — finance never heard, and the lead said "100% paid". The course of an enrolled
 * lead is read only now; a change goes to finance (the new course, its fee and why) and waits in its Approvals.
 * Approved, the enrolment and the lead move to it and the activity says so; rejected, the banner says why.
 */

const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
/** The request's id — a UUID, which is what the server takes. */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`);

/** Whether this person may ask for a course change on this close — as Correct it: the closer their own, whoever edits students any. */
export function useMayChangeCourse(closerId: string | null | undefined): boolean {
  const { user, hasPermission } = useAuthStore();
  return hasPermission("students", "edit") || (hasPermission("enrolments", "edit") && !!closerId && closerId === user?._id);
}

/** The latest course change, where it stands: waiting for finance, or rejected with finance's reason. Approved shows in the activity. */
export function CourseChangeBanner({ changes, academy, className }: { changes?: CourseChange[] | null; academy?: string | null; className?: string }) {
  const last = changes?.length ? changes[changes.length - 1] : null;
  if (!last || last.status === "approved") return null;
  const waiting = last.status === "pending";
  return (
    <div className={cn(
      "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
      waiting ? "border-blue-500/30 bg-blue-500/5 text-blue-300" : "border-red-500/30 bg-red-500/5 text-red-300",
      className,
    )}>
      {waiting ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span>
        {waiting
          ? <>Course change to <b>{last.courseName}</b> ({fmtAcademy(last.fee, academy)}) — waiting for finance</>
          : <>Course change to <b>{last.courseName}</b> rejected by finance{last.rejectReason ? `: ${last.rejectReason}` : ""}</>}
      </span>
    </div>
  );
}

/**
 * What the server said when the dialog couldn't be filled (2026-11-24: Draw's website had the dialog before its server
 * had the route, and the dialog sat empty and greyed out, saying nothing). "Route not found" is a server from before
 * course changes.
 */
function infoProblem(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: string } }; message?: string } | null;
  const said = e?.response?.data?.message || e?.message || "no answer";
  if (e?.response?.status === 404 && /route not found/i.test(said)) {
    return "this CRM's server hasn't been updated for course changes yet — it needs deploying.";
  }
  if (!e?.response) return `the CRM's server couldn't be reached (${said}).`;
  return said;
}

/**
 * The Change course dialog: the new course (its fee filled in from the course, and editable), why, what is paid so
 * far and what would be left. Whether it can be asked at all comes from the server, which asks finance.
 */
export function ChangeCourseDialog({ studentId, name, onClose }: { studentId: string; name: string; onClose: () => void }) {
  const { data: info, isLoading, error: infoError, isFetching, refetch } = useCourseChangeInfo(studentId);
  const { data: courses = [] } = useAllCourses();
  const send = useRequestCourseChange(studentId);
  // One id for this request while the dialog is open: Send pressed twice, or again after a timeout, is one request.
  const [key] = useState(newKey);
  const [courseId, setCourseId] = useState("");
  const [feeInput, setFeeInput] = useState("");
  const [reason, setReason] = useState("");

  const academy = info?.academy ?? "dubai";
  const money = (n: number) => fmtAcademy(n, academy);
  const fee = Number(feeInput);
  const paid = info?.paid ?? 0;
  const picked = courses.find((c) => c._id === courseId);
  const sameAsNow = !!info?.course && courseId === info.course.id && Math.round(fee * 100) === Math.round((info?.fee ?? 0) * 100);
  const problem = !feeInput ? ""
    : !(fee > 0) ? "Enter the new fee"
    : Math.abs(fee * 100 - Math.round(fee * 100)) > 1e-6 ? "At most 2 decimals"
    : Math.round(fee * 100) < Math.round(paid * 100) ? `${money(paid)} is already paid — the new fee can't be less`
    : sameAsNow ? "That is the course and fee it has now"
    : "";
  const ready = !!info?.canRequest && !!courseId && fee > 0 && !problem && reason.trim().length >= 3;

  return (
    <ResponsiveDialog open onOpenChange={(o) => { if (!o && !send.isPending) onClose(); }}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2"><ArrowRightLeft className="h-4 w-4 text-primary" /> Change course — {name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {info?.course ? `Now ${info.course.name} at ${money(info.fee)}` : "The course"}{info?.invoice?.number ? ` · ${info.invoice.number}` : ""}.
            {" "}Finance approves the change; then the invoice, the enrolment and the lead move to the new course.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-4 px-4 sm:px-0">
          {isLoading && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking finance…</p>}
          {!info && !isLoading && infoError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Couldn&apos;t get this enrolment from the server: {infoProblem(infoError)}{" "}
                <button type="button" className="underline disabled:opacity-50" disabled={isFetching} onClick={() => refetch()}>
                  {isFetching ? "Trying…" : "Try again"}
                </button>
              </span>
            </div>
          )}
          {info && !info.canRequest && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {info.whyNot || "A course change can't be asked for right now."}
                {/not in finance yet/i.test(info.whyNot) && <> <Link href={`/students/${studentId}`} className="underline">Open the enrolment</Link>.</>}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>New course</Label>
            <Select
              value={courseId || undefined}
              onValueChange={(v) => {
                setCourseId(v);
                // The fee follows the course just chosen — in the academy's money — and can be changed.
                const c = courses.find((x) => x._id === v);
                const price = academy === "bangalore" ? bangalorePriceOf(c) : c?.amount ?? 0;
                setFeeInput(price > 0 ? String(price) : "");
              }}
              disabled={!info?.canRequest}
            >
              <SelectTrigger><SelectValue placeholder="Choose the course" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => {
                  const price = academy === "bangalore" ? bangalorePriceOf(c) : c.amount;
                  return <SelectItem key={c._id} value={c._id}>{c.name}{price ? ` · ${money(price)}` : ""}</SelectItem>;
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cc-fee">New fee ({info?.currency ?? "AED"})</Label>
            <Input id="cc-fee" type="number" inputMode="decimal" min={0} step="0.01" value={feeInput} disabled={!info?.canRequest}
              onChange={(e) => setFeeInput(e.target.value)} placeholder={picked ? "The agreed fee" : "Choose the course first"} />
            {problem && <p className="text-[11px] text-red-400">{problem}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/50 bg-muted/30 p-3 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Paid so far</p>
              <p className="font-semibold text-green-400">{money(paid)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Left after the change</p>
              <p className="font-semibold text-amber-400">{fee > 0 ? money(Math.max(0, fee - paid)) : "—"}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cc-reason">Why (required)</Label>
            <Textarea id="cc-reason" rows={3} maxLength={500} value={reason} disabled={!info?.canRequest}
              onChange={(e) => setReason(e.target.value)} placeholder="What was agreed with the client, for finance" />
          </div>
        </div>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={send.isPending}>Cancel</Button>
          <Button
            className="gap-2"
            disabled={!ready || send.isPending}
            onClick={() => send.mutate({ courseId, fee, reason: reason.trim(), key }, { onSuccess: onClose })}
          >
            {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {send.isPending ? "Sending…" : "Send to finance"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
