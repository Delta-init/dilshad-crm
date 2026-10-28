"use client";

import { useEffect, useState } from "react";
import { CreateStudentModal } from "@/components/students/CreateStudentModal";
import { useStudentByLeadId } from "@/hooks/useStudents";
import { useLead } from "@/hooks/useLeads";
import type { Lead } from "@/types/lead";

/*
 * Closing a lead goes through its enrolment.
 *
 * A closed lead is a sale, and finance, the LMS and CS Portal hear about
 * a sale only through the enrolment taken here — the course, the fee, what was
 * paid, the receipt, whether a bonus was given. A lead that reaches "closed"
 * any other way is one none of them ever learn of. So every way of closing —
 * the status menu, a card dropped on Closed, several leads at once — opens
 * this dialog, and only saving it closes the lead.
 */

interface CloseLeadDialogProps {
  lead: Lead;
  /** "2 of 5" when this is one of several being closed together. */
  progress?: string;
  /** Dismissed: the lead keeps the status it had. */
  onClose: () => void;
  /** The enrolment is saved: now the lead may be closed. */
  onClosed: () => void;
}

/**
 * The enrolment dialog for one lead — for a lead that already has an
 * enrolment too, which it then shows rather than skipping.
 *
 * Mount it with `key={lead._id}`: the dialog takes its starting values from
 * the lead when it mounts, so a new lead needs a new one.
 */
export function CloseLeadDialog({ lead, progress, onClose, onClosed }: CloseLeadDialogProps) {
  const { data: existingStudent, isLoading } = useStudentByLeadId(lead._id);
  if (isLoading) return null;
  return (
    <CreateStudentModal
      open
      lead={lead}
      existingStudent={existingStudent}
      progress={progress}
      onClose={onClose}
      onCreated={onClosed}
    />
  );
}

interface CloseLeadsQueueProps {
  leadIds: string[];
  /**
   * Marks one lead closed once its enrolment is saved — through whichever
   * route the screen already uses for status, so a team leader closes through
   * the team's own permission rather than one they may not have.
   */
  markClosed: (leadId: string) => Promise<unknown>;
  /** All of them seen: how many were closed, and how many were skipped. */
  onDone: (result: { closed: number; skipped: number }) => void;
}

/**
 * Several leads closed together, one enrolment after another.
 *
 * Each lead is fetched fresh, so the dialog sees its payments and course as
 * they are now rather than as a list page last loaded them. A dialog that is
 * dismissed skips that lead — it is not closed — and the next one opens.
 */
export function CloseLeadsQueue({ leadIds, markClosed, onDone }: CloseLeadsQueueProps) {
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(0);
  const leadId = leadIds[index] ?? "";
  const { data: lead, isLoading, isError } = useLead(leadId);

  function next(wasClosed: boolean) {
    const total = closed + (wasClosed ? 1 : 0);
    if (index + 1 >= leadIds.length) {
      onDone({ closed: total, skipped: leadIds.length - total });
      return;
    }
    setClosed(total);
    setIndex(index + 1);
  }

  // A lead that can no longer be loaded — deleted since it was selected — is
  // skipped rather than holding up the rest.
  useEffect(() => {
    if (isError) next(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError, leadId]);

  if (!leadId || isLoading || isError || !lead) return null;

  return (
    <CloseLeadDialog
      key={lead._id}
      lead={lead}
      progress={leadIds.length > 1 ? `${index + 1} of ${leadIds.length}` : undefined}
      onClose={() => next(false)}
      onClosed={() => {
        markClosed(lead._id).then(() => next(true), () => next(false));
      }}
    />
  );
}
