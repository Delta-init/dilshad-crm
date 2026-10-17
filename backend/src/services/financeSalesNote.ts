import { FinanceHandover } from "../models/FinanceHandover.js";
import { Student } from "../models/Student.js";
import { financeConfigured, sendSalesNote } from "./financeClient.js";
import { orgOfHandover } from "./financeOrgs.js";

/**
 * The note written at the close, kept in step with finance (the owner,
 * 2026-10-17: "when any note is added in the sales portal it needs to show on
 * finance"). Finance keeps it beside the enrolment for the people approving
 * it, never on the client's invoice.
 *
 * Whenever the note changes here:
 *   - what the queue will send — or resend after a correction — carries it;
 *   - an enrolment finance already has is told straight away, through its own
 *     call that changes only the note;
 *   - if finance cannot be reached it is marked, and the worker tries again.
 */

const RETRY_BATCH = 20;

/** The note as it is now on the student, ready to send. */
async function noteOf(studentId: unknown): Promise<string> {
  const student = await Student.findById(studentId).select("notes").lean<{ notes?: string } | null>();
  return (student?.notes ?? "").trim();
}

/** Bring finance up to date with one enrolment's note. Never throws. */
export async function syncSalesNote(studentId: string): Promise<void> {
  try {
    const row = await FinanceHandover.findOne({ studentId });
    if (!row) return; // not handed over yet: the close builds it from the student, note included
    const note = await noteOf(studentId);
    row.set("payload", { ...(row.payload as Record<string, unknown>), salesNote: note });
    row.markModified("payload");
    if (row.status === "sent" && financeConfigured()) {
      try {
        await sendSalesNote(String(studentId), note, orgOfHandover(row));
        row.set({ salesNotePending: false, salesNoteSyncedAt: new Date() });
      } catch (err) {
        row.set({ salesNotePending: true });
        console.error(`[finance] sales note for student ${studentId} not delivered yet: ${(err as Error).message}`);
      }
    }
    await row.save();
  } catch (err) {
    console.error(`[finance] sales note for student ${studentId} failed`, err);
  }
}

/** Retry the notes finance has not taken yet. Run by the finance worker. */
export async function drainSalesNotes(): Promise<void> {
  if (!financeConfigured()) return;
  const rows = await FinanceHandover.find({ status: "sent", salesNotePending: true })
    .sort({ updatedAt: 1 })
    .limit(RETRY_BATCH);
  for (const row of rows) {
    try {
      await sendSalesNote(String(row.studentId), await noteOf(row.studentId), orgOfHandover(row));
      row.set({ salesNotePending: false, salesNoteSyncedAt: new Date() });
      await row.save();
    } catch (err) {
      console.error(`[finance] sales note for student ${String(row.studentId)} still not delivered: ${(err as Error).message}`);
    }
  }
}
