import { FinanceHandover } from "../models/FinanceHandover.js";
import { Student } from "../models/Student.js";
import { financeConfigured, sendEnrolment } from "./financeClient.js";
import { fetchStatusesByOrg, orgOfHandover } from "./financeOrgs.js";
import { sweepCommission } from "./commissionService.js";
import { drainSalesNotes } from "./financeSalesNote.js";
import { env } from "../config/env.js";

/**
 * Delivers queued enrolments to Delta Finance.
 *
 * Never in the request that created the student, because the whole point of
 * the outbox is that closing a lead does not wait for another server. A
 * finance outage delays an invoice; it does not stop a sale.
 *
 * Sent straight after it is queued (kickFinanceHandover), in the background,
 * so finance has it within a second or two; the timer is the safety net that
 * retries whatever that could not deliver.
 */

const INTERVAL_MS = 60_000;
const BATCH = 10;

/**
 * How long to wait after each failure: a minute, then four, then nine, up to a
 * quarter of an hour. Long enough that a restart is not hammered, short enough
 * that an outage clears on its own soon after it ends — capped at an hour, an
 * enrolment could sit for most of one after finance was already back.
 */
function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, attempts * attempts * 60_000);
}

/** Nothing here may throw: an unhandled rejection in a timer kills the process. */
export async function drainFinanceHandovers(): Promise<void> {
  if (!financeConfigured()) return;

  const due = await FinanceHandover.find({
    status: "pending",
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(BATCH);

  for (const row of due) {
    try {
      // To the organization of the academy it was closed for, as written on the
      // row at the close — Dubai's for a row from before academies.
      const result = await sendEnrolment(row.payload, orgOfHandover(row));
      row.set({
        status: "sent",
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        flags: result.flags ?? [],
        sentAt: new Date(),
        lastError: undefined,
        // It went with the note as it was queued — nothing left to catch up on.
        salesNotePending: false,
      });
      await row.save();

      // Shown on the student, so somebody looking at the enrolment can see
      // where it went without opening finance.
      await Student.updateOne(
        { _id: row.studentId },
        {
          $set: {
            financeInvoiceId: result.invoiceId,
            financeInvoiceNumber: result.invoiceNumber,
            financeSyncedAt: new Date(),
          },
        },
      );

      if (result.flags?.length) {
        console.warn(
          `[finance] ${result.invoiceNumber} needs attention: ${result.flags.join(" ")}`,
        );
      }
    } catch (err) {
      const permanent = Boolean((err as { permanent?: boolean }).permanent);
      const attempts = (row.attempts ?? 0) + 1;
      row.set({
        attempts,
        lastError: (err as Error).message?.slice(0, 500),
        // Permanent failures stop rather than retrying forever. Somebody has to
        // look at them, and a queue that retries a malformed payload every
        // minute buries the ones that would have worked.
        status: permanent ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      });
      await row.save();
      console.error(`[finance] handover for student ${String(row.studentId)} failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Ask finance what became of the enrolments it took.
 *
 * Delivered is not decided: `status: "sent"` says only that the enrolment
 * arrived. An approver still has to accept it, and may send it back with a
 * reason the counsellor has to act on — and nobody is going to find that out by
 * refreshing a screen they have no reason to open.
 *
 * Polled rather than pushed. Finance could call back, but that would mean a new
 * inbound door on this application and a second shared secret to hold; this
 * direction is already open, already signed, and a minute late costs nothing
 * against a send-back that waits for somebody to notice.
 *
 * Only rows that have been delivered and not yet settled: approved is the end
 * of the story, and a row already known to be returned is asked about again
 * only because a resubmission may have moved it on.
 */
const OUTCOME_BATCH = 100;

export async function pollFinanceOutcomes(): Promise<void> {
  if (!financeConfigured()) return;

  const rows = await FinanceHandover.find({
    status: "sent",
    approvalState: { $in: ["unknown", "pending", "returned"] },
  })
    .sort({ checkedAt: 1 })
    .limit(OUTCOME_BATCH);
  if (rows.length === 0) return;

  // Each asked of the organization it was billed in (Dubai's or Bangalore's).
  const statuses = await fetchStatusesByOrg(
    rows.map((r) => String(r.studentId)),
    new Map(rows.map((r) => [String(r.studentId), orgOfHandover(r)])),
  );
  if (statuses.length === 0) return;               // finance unreachable; ask again next time
  const byId = new Map(statuses.map((st) => [st.externalId, st]));

  for (const row of rows) {
    const st = byId.get(String(row.studentId));
    row.set("checkedAt", new Date());
    if (!st) { await row.save(); continue; }

    const was = row.approvalState;
    row.set("approvalState", st.approval || "unknown");
    row.set("returnedReason", st.returnedReason ?? "");
    if (st.invoiceNumber) row.set("invoiceNumber", st.invoiceNumber);

    // The moment it was approved, for commission. Rows already approved never
    // come back to this poll, so only approvals seen from now on get one.
    const settled = st.approval === "approved" || st.approval === "not_required";
    if (settled && !row.get("approvedAt")) row.set("approvedAt", new Date());

    /*
     * A new send-back. Stamped only on the transition, so that correcting an
     * enrolment and having it sent back a second time is a second event with
     * its own reason, while a row that simply sits returned is not re-announced
     * every minute.
     */
    const newlyReturned = st.approval === "returned" && was !== "returned";
    if (newlyReturned) {
      row.set("returnedAt", new Date());
      row.set("returnedNotifiedAt", undefined);
    }

    try {
      await row.save();
    } catch (err) {
      console.error("[finance] could not record an outcome", err);
      continue;                                   // unsaved: tell nobody yet
    }

    /*
     * Told once, and only after the row is safely saved.
     *
     * The other order — notify, then save — sends the notice again on every
     * sweep if the save keeps failing. This way the worst case is a send-back
     * recorded and not announced, which the enrolments tab still shows,
     * against a counsellor's phone buzzing once a minute about the same thing.
     */
    if (newlyReturned) {
      try {
        const { Student } = await import("../models/Student.js");
        const student = await Student.findById(row.studentId).select("name assignedTo").lean();
        if (student?.assignedTo) {
          const { notifyEnrolmentReturned } = await import("./pushService.js");
          await notifyEnrolmentReturned(
            String(student.assignedTo),
            String(row.studentId),
            student.name ?? "An enrolment",
            row.returnedReason ?? "",
          );
          row.set("returnedNotifiedAt", new Date());
          await row.save();
        }
      } catch (err) {
        console.error("[finance] could not tell anybody about a send-back", err);
      }
    }
  }
}

/*
 * One delivery pass at a time in this process, whether the timer or a kick
 * started it. A kick that lands while a pass is running asks for one more, so
 * the enrolment it queued goes out now rather than on the next tick.
 */
let draining = false;
let again = false;

async function drainNow(): Promise<void> {
  if (draining) {
    again = true;
    return;
  }
  draining = true;
  try {
    do {
      again = false;
      await drainFinanceHandovers();
    } while (again);
    // Sales notes changed after their enrolment went, that finance has not taken yet.
    await drainSalesNotes();
  } catch (err) {
    console.error("[finance] handover sweep failed", err);
  } finally {
    draining = false;
  }
}

/**
 * Deliver what was just queued, now, in the background. Called after an
 * enrolment is queued; never awaited by the request and never throws. Anything
 * it cannot deliver stays pending for the timer to retry.
 */
export function kickFinanceHandover(): void {
  if (!financeConfigured()) return;
  setImmediate(() => void drainNow());
}

export function startFinanceHandoverWorker(): void {
  if (!financeConfigured()) {
    console.log("[finance] integration not configured — enrolments will not be handed over");
    return;
  }
  console.log("[finance] handover worker started");
  // Not on the first tick: give the process a moment to finish starting.
  setInterval(() => {
    void drainNow();
    // Commission after the outcomes, so an approval seen this minute is
    // recorded this minute rather than the next. Inside the RUN_SCHEDULERS
    // gate, unlike the handover: a local copy pointed at real data must not
    // write people's pay with code that is not deployed.
    void pollFinanceOutcomes()
      .catch((err) => console.error("[finance] outcome sweep failed", err))
      .then(() => (env.RUN_SCHEDULERS ? sweepCommission() : undefined));
  }, INTERVAL_MS);
}
