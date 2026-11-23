"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import type { Academy, CourseChange } from "@/types/student";

/*
 * Change course after finance approved the enrolment (the user, 2026-11-23): the course of an enrolled lead is no
 * longer edited — a change is asked of finance (the new course, its fee and why), waits in its Approvals, and once
 * approved the enrolment and the lead move to it. Rejected, it says why.
 */

/** What the Change course dialog starts from — GET /students/:id/course-change. */
export interface CourseChangeInfo {
  /** Whether a change can be asked now; if not, `whyNot` says why (not in finance yet, sent back, one waiting…). */
  canRequest: boolean;
  whyNot: string;
  academy: Academy;
  currency: "AED" | "INR";
  course: { id: string; name: string } | null;
  fee: number;
  paid: number;
  invoice: { number: string; currency: string; totalMinor: number; paidMinor: number; balanceMinor: number } | null;
  changes: CourseChange[];
}

export const courseChangeKey = (studentId: string) => ["students", studentId, "course-change"] as const;

export const useCourseChangeInfo = (studentId: string, enabled = true) =>
  useQuery({
    queryKey: courseChangeKey(studentId),
    queryFn: async () => (await api.get<{ data: CourseChangeInfo }>(`/students/${studentId}/course-change`)).data.data,
    enabled: enabled && !!studentId,
    staleTime: 15_000,
    retry: false,
  });

export const useRequestCourseChange = (studentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { courseId: string; fee: number; reason: string; key: string }) =>
      (await api.post<{ data: CourseChange }>(`/students/${studentId}/course-change`, input)).data.data,
    onSuccess: () => {
      // The student (its page, and by its lead) carries the request now; the lead's banner follows.
      qc.invalidateQueries({ queryKey: ["students"] });
      toast.success("Sent to finance — the course changes once finance approves it");
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "The course change could not be sent"),
  });
};
