import type { EnrolmentStatus } from "./financeClient.js";

/*
 * An enrolment's journey after the close, in five steps (the user, 2026-10-04):
 *
 *   1. Finance approved   accounts approved the enrolment
 *   2. LMS account        the student's LMS account exists, on the course
 *   3. CS assigned        CS Portal gave them a CS
 *   4. Onboarded          their CS sent the welcome
 *   5. MT5 bonus          a broker admin approved the bonus promised at the
 *                         close — approved by itself when none was promised
 *
 * Shown on every My Enrolments card and on the enrolment's own page, green /
 * yellow / red; and a sale's commission counts only once all five are done
 * (commissionService). Worked out from finance's answer for the enrolment —
 * which carries the LMS and CS Portal's side — and the outbox's own
 * record, for what happened before finance had it. A course CS Portal
 * does not take (not Forex) skips steps 3–5: there is nobody there to do them.
 */

export type StepState = "done" | "waiting" | "failed" | "unknown" | "skipped";
export type StepKey = "finance" | "lms" | "cs" | "onboarded" | "bonus";

export interface EnrolmentStep {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
  /** When it happened, and who did it, where that is known. */
  at?: string;
  by?: string;
}

/** What the outbox knows of the enrolment, for before finance had it. */
export interface HandoverLike {
  status?: string;
  lastError?: string | null;
  approvedAt?: Date | string | null;
  /** When it was last sent again after a send-back. */
  resentAt?: Date | string | null;
}

/** "5 Oct, 3:42 pm", in the UAE, where the sales are made — put together from parts, which read the same on every runtime. */
const UAE_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
function dubai(v: Date | string): string {
  const p = Object.fromEntries(UAE_TIME.formatToParts(new Date(v)).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toLowerCase()}`.trim();
}

const LABEL: Record<StepKey, string> = {
  finance: "Finance approved",
  lms: "LMS account",
  cs: "CS assigned",
  onboarded: "Onboarded",
  bonus: "MT5 bonus",
};

const step = (key: StepKey, state: StepState, more: Partial<EnrolmentStep> = {}): EnrolmentStep => ({
  key,
  label: LABEL[key],
  state,
  ...Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined && v !== "")),
});

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : undefined);
const money = (amount?: number, currency?: string) =>
  amount ? (currency === "USD" || !currency ? `$${amount.toLocaleString("en-US")}` : `${currency} ${amount.toLocaleString("en-US")}`) : "";

export function stepsOf(st: EnrolmentStatus | null | undefined, h?: HandoverLike | null): EnrolmentStep[] {
  // 1 — finance. Sent again after a send-back says so, and when (the user, 2026-10-05).
  const resent = h?.resentAt ? `Sent again ${dubai(h.resentAt)}` : "";
  // On its way back to finance — which says "returned" until it arrives.
  const resending = h?.status === "pending" && Boolean(resent);
  let finance: EnrolmentStep;
  if (resending) {
    finance = step("finance", "waiting", { detail: `${resent} — on its way to finance`, at: iso(h?.resentAt) });
  } else if (!st) {
    finance = h?.status === "failed"
      ? step("finance", "failed", { detail: `Couldn't be sent to finance${h.lastError ? ` — ${h.lastError}` : ""}` })
      : h?.status === "sent"
        ? step("finance", "unknown", { detail: "Finance didn't answer — asked again shortly" })
        : step("finance", "waiting", { detail: "Not sent to finance yet" });
  } else if (st.status === "void") {
    finance = step("finance", "failed", { detail: "The invoice was voided" });
  } else if (st.approval === "approved" || st.approval === "not_required") {
    finance = step("finance", "done", { detail: st.invoiceNumber ? `Invoice ${st.invoiceNumber}` : undefined, at: iso(h?.approvedAt) });
  } else if (st.approval === "returned") {
    finance = h?.status === "failed" && resent
      ? step("finance", "failed", { detail: `${resent}, but finance didn't take it${h.lastError ? ` — ${h.lastError}` : ""}` })
      : step("finance", "failed", { detail: `Sent back${st.returnedReason ? `: ${st.returnedReason}` : ""} — correct it and send it again` });
  } else {
    finance = step("finance", "waiting", {
      detail: resent ? `${resent} — waiting for accounts to approve it` : "Waiting for accounts to approve it",
      at: iso(h?.resentAt),
    });
  }
  const approved = finance.state === "done";

  // 2 — the LMS
  const lms = st?.lms;
  const lmsStep = !approved
    ? step("lms", "waiting", { detail: "After finance approves it" })
    : !lms
      ? step("lms", "waiting", { detail: "On its way to the LMS" })
      : lms.state === "created"
      ? step("lms", "done", { detail: `New LMS account${lms.courses.length ? ` — ${lms.courses.join(", ")}` : ""}` })
      : lms.state === "existing"
        ? step("lms", "done", { detail: `Had an LMS account — ${lms.courses.length ? lms.courses.join(", ") : "the course"} added` })
        : lms.state === "waiting"
          ? step("lms", "waiting", { detail: lms.detail || "On its way to the LMS" })
          : step("lms", "failed", { detail: lms.detail || "The LMS turned it down" });

  // 3 — CS Portal's CS
  const c = st?.commission;
  const sent = c?.state === "sent";
  if (c?.state === "skipped") {
    const skipped = (key: StepKey) => step(key, "skipped", { detail: c.detail || "Not a Forex course — not needed" });
    return [finance, lmsStep, skipped("cs"), skipped("onboarded"), skipped("bonus")];
  }
  let cs: EnrolmentStep;
  if (lmsStep.state !== "done" || !c) cs = step("cs", "waiting", { detail: "After the LMS" });
  else if (sent && /no longer/i.test(c.detail ?? "")) cs = step("cs", "failed", { detail: "No longer in CS Portal" });
  else if (sent && c.cs) cs = step("cs", "done", { detail: `${c.cs}${c.team ? ` · ${c.team}` : ""}` });
  else if (sent) cs = step("cs", "waiting", { detail: "In Delta Open Students — no CS yet" });
  else if (c.state === "failed" || c.state === "not_sent") cs = step("cs", "failed", { detail: c.detail || "Not sent to CS Portal" });
  else cs = step("cs", "waiting", { detail: c.detail || "On its way to CS Portal" });

  // 4 — onboarded (their welcome went)
  let onboarded: EnrolmentStep;
  if (!sent) onboarded = step("onboarded", "waiting", { detail: "After CS Portal has them" });
  else if (!c?.onboarded) onboarded = step("onboarded", "unknown", { detail: "CS Portal didn't say — asked again shortly" });
  else if (c.onboarded.done) onboarded = step("onboarded", "done", { at: c.onboarded.at, by: c.onboarded.by, detail: "Welcome sent" });
  else onboarded = step("onboarded", "waiting", { detail: "Their CS hasn't sent the welcome yet" });

  // 5 — the MT5 bonus, approved by a broker admin
  const b = c?.bonus;
  let bonus: EnrolmentStep;
  if (!sent) bonus = step("bonus", "waiting", { detail: "After CS Portal has them" });
  else if (!b || b.state === "unknown") {
    bonus = step("bonus", "unknown", { detail: b ? `CS Portal has no record of the ${money(b.amount, b.currency) || "bonus"} promised` : "CS Portal didn't say — asked again shortly" });
  } else if (b.state === "none") bonus = step("bonus", "done", { detail: "No bonus promised — nothing to approve" });
  else if (b.state === "approved") bonus = step("bonus", "done", { at: b.at, by: b.by, detail: `${money(b.amount, b.currency)} approved`.trim() });
  else if (b.state === "pending") bonus = step("bonus", "waiting", { at: b.at, detail: `${money(b.amount, b.currency)} — onboarding verification pending, waiting for a broker admin`.replace(/^ — /, "") });
  else if (b.state === "not_requested") bonus = step("bonus", "waiting", { detail: `${money(b.amount, b.currency)} — not raised yet: their CS logs the student's MT5 first`.replace(/^ — /, "") });
  else bonus = step("bonus", "failed", { at: b.at, by: b.by, detail: `Rejected${b.reason ? `: ${b.reason}` : ""} — their CS can submit it again` });

  return [finance, lmsStep, cs, onboarded, bonus];
}

/** Every step done — or not needed. */
export const allDone = (steps: EnrolmentStep[]) => steps.every((s) => s.state === "done" || s.state === "skipped");

/** The first step not done yet, as a sentence: "Next step: MT5 bonus — …" / "Stopped at: MT5 bonus — …". */
export function waitingOn(steps: EnrolmentStep[]): string {
  const s = steps.find((x) => x.state !== "done" && x.state !== "skipped");
  if (!s) return "";
  return `${s.state === "failed" ? "Stopped at" : "Next step"}: ${s.label}${s.detail ? ` — ${s.detail}` : ""}`;
}
