import type { Schema, Query, Document } from "mongoose";

/**
 * A next follow-up date belongs to the follow-up (the user, 2026-10-20: leads moved on to MIA, Not connected… kept
 * their September follow-up date and showed as overdue in Today's Follow-ups every day). When a lead's status changes to
 * anything but Follow Up, its next follow-up date and the missed-warning stamp for it go — unless that same change sets
 * a new date. Setting Follow Up again sets a fresh one; a hand-over to a new owner clears it too (leadHandOver.ts).
 *
 * On the model, like the hand-over, so every path that changes a status follows it: the status button, the edit form,
 * bulk changes, closing, the mover, imports. Writes made straight to the collection are the one way round it.
 */
type LeadDoc = Document & { status?: string };

/** Clears these with a status change away from Follow Up. */
export const FOLLOW_UP_DATE_FIELDS = { nextFollowUpAt: null, missedFollowUpWarnedAt: null };

export function followUpDateOnStatus(schema: Schema): void {
  schema.pre("save", function (this: LeadDoc) {
    if (this.isNew || !this.isModified("status") || this.status === "followup" || this.isModified("nextFollowUpAt")) return;
    this.set(FOLLOW_UP_DATE_FIELDS);
  });

  // updateOne / updateMany / findOneAndUpdate (findByIdAndUpdate) that set a status.
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      const update = this.getUpdate();
      if (!update || Array.isArray(update)) return;
      const u = update as Record<string, unknown>;
      const set = (u.$set ?? {}) as Record<string, unknown>;
      const status = set.status ?? u.status;
      if (typeof status !== "string" || status === "followup") return;
      const unset = (u.$unset ?? {}) as Record<string, unknown>;
      if ("nextFollowUpAt" in set || "nextFollowUpAt" in u || "nextFollowUpAt" in unset) return;
      this.setUpdate({ ...u, $set: { ...set, ...FOLLOW_UP_DATE_FIELDS } });
    });
  }
}
