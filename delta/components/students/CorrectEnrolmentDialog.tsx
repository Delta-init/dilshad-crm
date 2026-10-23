"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, BookOpen, Calendar, DollarSign, Gift, Loader2, Mail, MapPin, Phone,
  Send, StickyNote, Undo2, User2, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fmtAcademy } from "@/lib/currency";
import { useAllCourses } from "@/hooks/useCourses";
import { useCorrectEnrolment, useEnrolmentCorrection, type EnrolmentCorrectionStart } from "@/hooks/useEnrolments";
import { useEmailCheck } from "@/hooks/useStudents";
import {
  PaymentRowsEditor, missingInRows, newPaymentRow, rowAmount, rowForeignFields, type PaymentBase, type PaymentRow, rateInputFor } from "@/components/students/PaymentRowsEditor";
import { AcademyBadge } from "@/components/students/AcademyBadge";
import { bangalorePriceOf, feeFor, type Course } from "@/types/course";
import type { FeeStatus, Student } from "@/types/student";
import { ACADEMY_CURRENCY, ACADEMY_LABELS, BASE_CURRENCY, ENROLMENT_LANGUAGES, academyOf, isFinanceEmail } from "@/types/student";

/*
 * Correcting an enrolment finance sent back (the user, 2026-10-05: "if send it
 * back we can edit the course and amount also, all details"). Everything the
 * close took can be changed — the client's name, phone and email, the course,
 * the fee, each payment with its receipt (and, paid in another currency, what
 * was handed over and its rate), the language, the date, the bonus,
 * the notes, and (for whoever may edit students) who closed it and for which
 * team — and saving sends it to finance again in the same step, as the same
 * invoice with the same number. Checked here as the close is, and again by the
 * server.
 */

/** A Select can't hold "" — this stands for "nobody" / "no team". */
const NONE = "__none__";

const idOf = (v: unknown) => (v ? (typeof v === "object" ? String((v as { _id: string })._id) : String(v)) : "");
const nameOf = (v: unknown) => (v && typeof v === "object" ? (v as { name?: string }).name ?? "" : "");

/**
 * The payments as the form starts them: the money the lead holds of its own
 * first — at what it comes to now, with the method and receipt the close gave
 * it — then each payment taken at the close, one in another currency as it was
 * handed over, with its rate and the AED it came to. An enrolment from before
 * payments were listed starts from its one method, one receipt and the rest of
 * what was paid.
 *
 * A Bangalore enrolment's are in INR (`base`): the lead's own money is AED,
 * so its row is the AED with the rate the close took it at, worked out in INR
 * again; cash taken in AED is as it was handed over, with its rate.
 */
function startingRows(s: Student, ownOnLead: number, base: PaymentBase = BASE_CURRENCY): PaymentRow[] {
  const listed = s.payments ?? [];
  const ownWas = listed.find((p) => p.collectedBefore);
  const rows: PaymentRow[] = [];
  // The lead's own money as the close sent it — one row per payment that had its method and receipt (2026-10-23) —
  // while it still comes to what the lead holds (Dubai; a Bangalore one keeps one row with its rate).
  const ownWere = listed.filter((p) => p.collectedBefore);
  const ownWereSum = Math.round(ownWere.reduce((sum, p) => sum + Number(p.amount), 0) * 100);
  if (ownOnLead > 0 && base === BASE_CURRENCY && ownWere.length > 1 && ownWereSum === Math.round(ownOnLead * 100)) {
    rows.push(...ownWere.map((p) => newPaymentRow({ collectedBefore: true, amountInput: String(p.amount), method: p.method, receipt: p.receipt ?? null })));
  } else if (ownOnLead > 0) {
    const rate = base !== BASE_CURRENCY && ownWas?.currency === BASE_CURRENCY ? ownWas.exchangeRate ?? 0 : 0;
    rows.push(newPaymentRow({
      collectedBefore: true, amountInput: String(ownOnLead), method: ownWas?.method ?? "", receipt: ownWas?.receipt ?? null,
      ...(rate > 0 ? { rateInput: String(rate), convertedInput: String(Math.round(ownOnLead * rate * 100) / 100) } : {}),
    }));
  }
  const taken = listed.filter((p) => !p.collectedBefore);
  if (taken.length) {
    rows.push(...taken.map((p) =>
      p.currency && p.currency !== base && p.amountInCurrency && p.exchangeRate
        ? newPaymentRow({
            method: p.method, currency: p.currency, amountInput: String(p.amountInCurrency),
            rateInput: rateInputFor(p.currency, p.exchangeRate, base), convertedInput: String(p.amount), receipt: p.receipt ?? null,
          })
        : newPaymentRow({ method: p.method, currency: base, amountInput: String(p.amount), receipt: p.receipt ?? null }),
    ));
  } else if (!listed.length) {
    const rest = Math.round(((s.paidAmount ?? 0) - ownOnLead) * 100) / 100;
    if (rest > 0) rows.push(newPaymentRow({ method: s.paymentMethod ?? "", currency: base, amountInput: String(rest), receipt: s.paymentReceipt ?? null }));
  }
  return rows.length ? rows : [newPaymentRow({ currency: base })];
}

interface Props {
  studentId: string;
  open: boolean;
  onClose: () => void;
}

export function CorrectEnrolmentDialog({ studentId, open, onClose }: Props) {
  const { data, isLoading, error } = useEnrolmentCorrection(studentId, open);
  const failure = (error as { response?: { data?: { message?: string } } } | null)?.response?.data?.message;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0 gap-0">
        {data?.sentBack ? (
          // Mounted once the starting point is in, so the form starts from it.
          <CorrectionForm key={data.student._id} studentId={studentId} start={data} onClose={onClose} />
        ) : (
          <div className="px-5 py-6">
            <DialogHeader>
              <DialogTitle className="text-base font-bold">Correct enrolment</DialogTitle>
            </DialogHeader>
            {isLoading || (!data && !error) ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                {data
                  ? "Finance hasn't sent this enrolment back, so there is nothing to correct. A change once it is approved goes through finance."
                  : failure ?? "Couldn't load this enrolment."}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CorrectionForm({ studentId, start, onClose }: { studentId: string; start: EnrolmentCorrectionStart; onClose: () => void }) {
  const s = start.student;
  const { data: courses = [], isLoading: coursesLoading } = useAllCourses();
  const correct = useCorrectEnrolment();

  // The academy it was closed for — fixed: the money below is in its currency.
  const academy = start.academy ?? academyOf(s);
  const base = ACADEMY_CURRENCY[academy];
  const fmt = (n: number) => fmtAcademy(n, academy);
  const priceOf = (c: Course | null | undefined) => feeFor(c, academy);

  // The client
  const [name, setName] = useState(s.name ?? "");
  const [phone, setPhone] = useState(s.phone ?? "");
  const [email, setEmail] = useState(s.email ?? "");
  /*
   * One email, one client (2026-10-10): finance keeps a customer by email, so an
   * email another client here holds — a student, or a lead that is a different
   * person — is refused; kept, a shared one would rename the client finance
   * filed it under. Said under the field, from when the form opens.
   */
  const emailNow = email.trim().toLowerCase();
  const emailCheck = useEmailCheck(isFinanceEmail(email) ? emailNow : "", { studentId });
  /** A correction the server refused as another client's email — said on the field while it is the one typed. */
  const [refusedTaken, setRefusedTaken] = useState<{ email: string; message: string } | null>(null);
  const takenBy = isFinanceEmail(email) ? emailCheck.taken ?? (refusedTaken?.email === emailNow ? refusedTaken : null) : null;

  // The course, and the fee that follows it — and can be argued with.
  const studentCourse = s.course && typeof s.course === "object" ? (s.course as Course) : null;
  const [courseId, setCourseId] = useState(idOf(s.course));
  const courseOptions = studentCourse && !courses.some((c) => c._id === studentCourse._id) ? [studentCourse, ...courses] : courses;
  const [feeInput, setFeeInput] = useState(String(s.totalFee ?? ""));
  const feeOk = feeInput.trim() !== "" && Number.isFinite(Number(feeInput)) && Number(feeInput) >= 0;
  const totalFee = feeOk ? Number(feeInput) : 0;

  // Each payment, with its receipt; the lead's own money first, its amount fixed.
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() => startingRows(s, start.ownOnLead, base));
  const paidAmount = paymentRows.reduce((t, r) => t + rowAmount(r, base), 0);
  const pending = Math.max(0, totalFee - paidAmount);
  /** Collected more than the fee: taken (the owner, 2026-10-06) and said so in amber, not refused. */
  const overFee = Math.round(paidAmount * 100) > Math.round(totalFee * 100);
  const overBy = Math.max(0, paidAmount - totalFee);
  const uploading = paymentRows.some((r) => r.uploading);

  const computedFeeStatus: FeeStatus =
    totalFee <= 0 || paidAmount <= 0 ? "pending" : paidAmount >= totalFee ? "paid" : "partial";
  const [feeStatus, setFeeStatus] = useState<FeeStatus>(s.feeStatus ?? computedFeeStatus);
  const [feeStatusTouched, setFeeStatusTouched] = useState(false);
  // Follows the numbers until somebody sets it by hand, as at the close.
  const effectiveFeeStatus = feeStatusTouched ? feeStatus : computedFeeStatus;

  const [enrollmentDate, setEnrollmentDate] = useState((s.enrollmentDate ?? new Date().toISOString()).slice(0, 10));
  const [language, setLanguage] = useState<string>(s.language ?? "");
  const [notes, setNotes] = useState(s.notes ?? "");

  // The bonus: answered, and kept beside the money — never in the balance.
  const [bonusChoice, setBonusChoice] = useState<"" | "yes" | "no">(s.hasBonus === true ? "yes" : s.hasBonus === false ? "no" : "");
  const [bonusInput, setBonusInput] = useState(s.hasBonus ? String(s.bonusAmount || "") : "");
  const bonusAmount = Math.max(0, Number(bonusInput) || 0);
  const bonusAmountMissing = bonusChoice === "yes" && !(Math.round(bonusAmount * 100) > 0);

  // Who closed it, and for which team: only whoever may edit students moves a sale.
  const [closerId, setCloserId] = useState(idOf(s.assignedTo));
  const [teamId, setTeamId] = useState(idOf(s.team));
  const withCurrent = (list: { _id: string; name: string }[] | undefined, id: string, name: string) =>
    id && !(list ?? []).some((x) => x._id === id) ? [{ _id: id, name: name || "As it was" }, ...(list ?? [])] : list ?? [];
  const counsellors = withCurrent(start.counsellors, idOf(s.assignedTo), nameOf(s.assignedTo));
  const teams = withCurrent(start.teams, idOf(s.team), nameOf(s.team));

  /** A Bangalore enrolment moved onto a course with no Bangalore price: the server refuses it, so it is said here first. */
  const pickedCourse = courseOptions.find((c) => c._id === courseId) ?? null;
  const noBangalorePrice = academy === "bangalore" && Boolean(pickedCourse) && bangalorePriceOf(pickedCourse) <= 0;

  const missing = [
    !name.trim() && "the client's name",
    !phone.trim() && "the client's phone",
    !isFinanceEmail(email) && "the client's email",
    takenBy && "the client's own email",
    !courseId && "a course",
    noBangalorePrice && "a course with a Bangalore price",
    !feeOk && "the fee",
    !language && "language",
    ...missingInRows(paymentRows, base),
    !bonusChoice && "whether a bonus was given",
    bonusAmountMissing && "the bonus amount",
  ].filter(Boolean) as string[];

  function save() {
    // Every payment dated the day of the enrolment, as at the close.
    const on = new Date(enrollmentDate).toISOString();
    correct.mutate(
      {
        id: studentId,
        data: {
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          course: courseId,
          ...(start.mayMove ? { assignedTo: closerId || null, team: teamId || null } : {}),
          enrollmentDate: on,
          feeStatus: effectiveFeeStatus,
          totalFee,
          paidAmount,
          notes,
          language,
          payments: paymentRows.map((r) => ({
            method: r.method,
            amount: rowAmount(r, base),
            receipt: r.receipt,
            paidAt: on,
            ...(r.collectedBefore ? { collectedBefore: true } : {}),
            // Paid in another currency: what was handed over, and the rate — `amount` is in the academy's (AED or INR).
            ...rowForeignFields(r, base),
          })),
          hasBonus: bonusChoice === "yes",
          bonusAmount: bonusChoice === "yes" ? bonusAmount : 0,
        },
      },
      {
        onSuccess: onClose,
        onError: (err: unknown) => {
          // Already in a toast; one refused as another client's email is said under the field too.
          const res = (err as { response?: { status?: number; data?: { message?: string } } })?.response;
          if (res?.status === 409 && /already used by/i.test(res.data?.message ?? "")) setRefusedTaken({ email: emailNow, message: res.data!.message! });
        },
      },
    );
  }

  const label = "text-xs text-muted-foreground flex items-center gap-1";

  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/50 bg-card px-5 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
            <Undo2 className="h-5 w-5 text-red-400" />
          </div>
          <div className="min-w-0">
            <DialogHeader>
              <DialogTitle className="text-base font-bold">Correct enrolment</DialogTitle>
            </DialogHeader>
            <p className="truncate text-xs text-muted-foreground">
              {[s.name, s.enrollmentNumber, start.invoiceNumber].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Why it came back */}
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
          <Undo2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-xs text-red-300">Sent back{start.returnedReason ? `: ${start.returnedReason}` : " — no reason was given"}</p>
            <p className="mt-0.5 text-[10px] text-red-300/70">
              Change anything below. Saving sends it to finance again{start.invoiceNumber ? ` as ${start.invoiceNumber}` : ""} — the same invoice, the same number.
            </p>
          </div>
        </div>

        {/* The client */}
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Client</p>
          <div className="space-y-1">
            <p className={label}><User2 className="h-3 w-3" /> Name *</p>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" aria-label="Client name" />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <p className={label}><Phone className="h-3 w-3" /> Phone *</p>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-8 text-xs" aria-label="Client phone" />
            </div>
            <div className="space-y-1">
              <p className={label}><Mail className="h-3 w-3" /> Email *</p>
              <Input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-8 text-xs" aria-label="Client email"
                aria-invalid={Boolean(takenBy) || (email.trim() !== "" && !isFinanceEmail(email))}
              />
            </div>
          </div>
          {email.trim() !== "" && !isFinanceEmail(email) && (
            <p className="text-[10px] text-amber-400">Finance needs a working email to invoice the client.</p>
          )}
          {/* The server's words: whose it is (never their phone), and that this client's own is needed. */}
          {takenBy && <p className="text-[10px] text-red-600 dark:text-red-400">{takenBy.message}</p>}
        </section>

        {/* The academy: shown, not changed — a correction keeps the close's. */}
        <section className="flex items-center gap-2 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3" /> Academy <AcademyBadge academy={academy} />
          <span className="text-[10px]">Fixed at the close{academy === "bangalore" ? " — in ₹ INR, billed in Bangalore's finance" : ""}.</span>
        </section>

        {/* The course and the money */}
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Course &amp; fee</p>
          <div className="space-y-1">
            <p className={label}><BookOpen className="h-3 w-3" /> Course *</p>
            <Select
              value={courseId}
              onValueChange={(v) => {
                setCourseId(v);
                // The fee follows the course just chosen — its price for this academy — rather than leaving the old number under a new name.
                const c = courseOptions.find((x) => x._id === v);
                if (priceOf(c)) setFeeInput(String(priceOf(c)));
              }}
              disabled={coursesLoading}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={coursesLoading ? "Loading courses…" : "Select a course"} />
              </SelectTrigger>
              <SelectContent>
                {courseOptions.map((c) => (
                  <SelectItem key={c._id} value={c._id} className="text-xs">
                    {c.name}{priceOf(c) ? ` · ${fmt(priceOf(c))}` : academy === "bangalore" ? ` · no ${ACADEMY_LABELS.bangalore} price` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {noBangalorePrice && (
              <p className="flex items-start gap-1.5 text-[10px] text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {pickedCourse?.name} has no Bangalore price — choose a course sold in Bangalore, or set its price on Courses → Map.
              </p>
            )}
          </div>
          <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-card p-2 border border-border/30">
                <p className="text-sm font-bold text-foreground">{fmt(totalFee)}</p>
                <p className="text-[10px] text-muted-foreground">Total Fee</p>
              </div>
              <div className="rounded-lg bg-card p-2 border border-border/30">
                <p className="text-sm font-bold text-green-400">{fmt(paidAmount)}</p>
                <p className="text-[10px] text-muted-foreground">Paid</p>
              </div>
              <div className="rounded-lg bg-card p-2 border border-border/30">
                <p className={cn("text-sm font-bold", pending > 0 ? "text-amber-400" : "text-green-400")}>{fmt(pending)}</p>
                <p className="text-[10px] text-muted-foreground">Balance</p>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Total fee{academy === "bangalore" ? " (₹ INR)" : ""} *</p>
              <Input
                type="number" min="0" step="0.01" value={feeInput}
                onChange={(e) => setFeeInput(e.target.value)}
                placeholder="0" className="h-8 text-xs" aria-label="Total fee"
              />
            </div>
            {overFee && (
              <p className="text-[11px] font-medium text-amber-400">
                Collected ({fmt(paidAmount)}) is {fmt(overBy)} more than the fee ({fmt(totalFee)}) — fine if it was taken: it goes to finance as collected.
              </p>
            )}
          </div>
        </section>

        {/* Each payment, with its receipt */}
        <section className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Payments * <span className="text-[10px]">— one for each way the client paid, each with its receipt</span>
          </p>
          <PaymentRowsEditor leadId={idOf(s.leadId)} rows={paymentRows} onChange={setPaymentRows} base={base} />
          {paymentRows.some((r) => r.collectedBefore) && (
            <p className="text-[10px] text-muted-foreground">
              The amount already on the lead is what its own payments come to — change those on the lead, then open this again.
            </p>
          )}
        </section>

        {/* The bonus */}
        <section className="space-y-1.5">
          <p className={label}><Gift className="h-3 w-3" /> Bonus given? *</p>
          <div className="flex items-center gap-2">
            {(["no", "yes"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setBonusChoice(choice)}
                className={cn(
                  "h-8 rounded-md border px-3 text-xs font-medium transition-colors",
                  bonusChoice === choice
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {choice === "yes" ? "Yes" : "No"}
              </button>
            ))}
            <AnimatePresence>
              {bonusChoice === "yes" && (
                <motion.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} className="flex-1">
                  <Input
                    type="number" min="0" step="0.01" value={bonusInput}
                    onChange={(e) => setBonusInput(e.target.value)}
                    placeholder="Bonus amount (USD $)" className="h-8 text-xs" aria-label="Bonus amount"
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* The rest of the enrolment */}
        <section className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Enrolment</p>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Language *</p>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Taught in…" />
              </SelectTrigger>
              <SelectContent>
                {ENROLMENT_LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className={label}><Calendar className="h-3 w-3" /> Enrollment Date</p>
              <Input
                type="date" value={enrollmentDate}
                onChange={(e) => setEnrollmentDate(e.target.value)}
                className="h-8 text-xs [color-scheme:dark]"
              />
            </div>
            <div className="space-y-1">
              <p className={label}><DollarSign className="h-3 w-3" /> Fee Status</p>
              <Select value={effectiveFeeStatus} onValueChange={(v) => { setFeeStatus(v as FeeStatus); setFeeStatusTouched(true); }}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid" className="text-xs"><span className="text-green-400">Paid</span></SelectItem>
                  <SelectItem value="partial" className="text-xs"><span className="text-amber-400">Partial</span></SelectItem>
                  <SelectItem value="pending" className="text-xs"><span className="text-muted-foreground">Pending</span></SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {start.mayMove ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className={label}><User2 className="h-3 w-3" /> Closed by</p>
                <Select value={closerId || NONE} onValueChange={(v) => setCloserId(v === NONE ? "" : v)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE} className="text-xs text-muted-foreground">Nobody</SelectItem>
                    {counsellors.map((u) => (
                      <SelectItem key={u._id} value={u._id} className="text-xs">{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className={label}><Users className="h-3 w-3" /> Team</p>
                <Select value={teamId || NONE} onValueChange={(v) => setTeamId(v === NONE ? "" : v)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE} className="text-xs text-muted-foreground">No team</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t._id} value={t._id} className="text-xs">{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Closed by <span className="font-medium text-foreground">{nameOf(s.assignedTo) || "—"}</span>
              {nameOf(s.team) ? <> · <span className="font-medium text-foreground">{nameOf(s.team)}</span></> : null}
              <span className="block text-[10px]">Moving a sale to someone else is for whoever may edit students.</span>
            </p>
          )}
          <div className="space-y-1">
            <p className={label}><StickyNote className="h-3 w-3" /> Notes (optional)</p>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything finance should know about the correction…"
              className="resize-none text-xs min-h-[64px]"
              rows={2}
            />
          </div>
        </section>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border/50 bg-card px-5 py-3">
        <span className={cn("text-[11px]", !missing.length && overFee ? "text-amber-400" : "text-muted-foreground")}>
          {missing.length
            ? `Still needed: ${missing.join(", ")}.`
            : emailCheck.checking
              ? "Checking the client's email…"
              : overFee
                ? `Collected is ${fmt(overBy)} more than the fee — it goes to finance as collected.`
                : "Saved, and sent to finance again in the same step."}
        </span>
        <Button
          size="sm"
          className="gap-2 shrink-0"
          onClick={save}
          disabled={correct.isPending || missing.length > 0 || uploading || emailCheck.checking}
        >
          {correct.isPending
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…</>
            : <><Send className="h-3.5 w-3.5" /> Save &amp; send again</>}
        </Button>
      </div>
    </>
  );
}
