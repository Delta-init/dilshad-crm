import { User } from "../models/User.js";

/**
 * A closed sale, told to everybody signed in to this CRM the moment it is
 * closed (the user, 2026-10-15). Every open screen shows it in the middle with
 * glitter, plays a sparkle, and the browser's own voice says who closed whom,
 * on which course, for how much. All of it runs in the browser, so nothing is
 * paid for.
 *
 * It goes out on the socket only, to whoever is signed in at that moment. It
 * is not stored or pushed, so there is nothing to catch up on later. That is
 * why it never throws and the close never waits for it: the sale is saved
 * before this starts, and a missing celebration must not cost the sale.
 */

export const SALE_CLOSED_EVENT = "sale:closed";

export interface SaleClosed {
  /** The enrolment's id, so each close is announced once however many tabs hear it. */
  id: string;
  /** Who closed it: the salesperson the lead is assigned to, as the reports credit it. */
  closer: string;
  student: string;
  courses: string[];
  /** The course fee, in the academy's currency. */
  amount: number;
  academy: "dubai" | "bangalore";
  at: string;
}

/** The enrolment as createStudent returns it, with course and assignedTo populated. */
interface ClosedStudent {
  _id: unknown;
  name?: unknown;
  course?: unknown;
  assignedTo?: unknown;
  totalFee?: unknown;
  academy?: unknown;
}

const nameOf = (v: unknown): string =>
  v && typeof v === "object" && "name" in v ? String((v as { name?: unknown }).name ?? "").trim() : "";

/** What every screen is told. closedBy is used only when the lead has no salesperson. */
export function saleClosedOf(student: ClosedStudent, closedBy = ""): SaleClosed {
  const course = nameOf(student.course);
  return {
    id: String(student._id),
    closer: nameOf(student.assignedTo) || closedBy.trim(),
    student: String(student.name ?? "").trim(),
    courses: course ? [course] : [],
    amount: Math.max(0, Number(student.totalFee) || 0),
    academy: student.academy === "bangalore" ? "bangalore" : "dubai",
    at: new Date().toISOString(),
  };
}

/**
 * Tells every signed-in screen about a close. The close does not wait for it
 * and it never throws. The closer is the lead's salesperson; when the lead has
 * none, it is whoever pressed close.
 */
export function announceSaleClosed(student: ClosedStudent | null | undefined, performedBy?: string): void {
  if (!student) return;
  void (async () => {
    let closedBy = "";
    if (!nameOf(student.assignedTo) && performedBy) {
      const who = await User.findById(performedBy).select("name").lean<{ name?: string } | null>().catch(() => null);
      closedBy = who?.name ?? "";
    }
    // Loaded here, not at the top: the socket brings the server's config with
    // it, and scripts that load the student service run without that config.
    const { emitToAll } = await import("../socket.js");
    emitToAll(SALE_CLOSED_EVENT, saleClosedOf(student, closedBy));
  })().catch((err) => console.warn("⚠️ Sale announcement not sent:", err instanceof Error ? err.message : err));
}
