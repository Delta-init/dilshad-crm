import type { Schema, Query, Document, Types } from "mongoose";
import { FOLLOW_UP_DATE_FIELDS } from "./leadFollowUpDate.js";

/**
 * A lead given to someone arrives as a new lead for them (the owner,
 * 2026-10-09): its created date becomes the moment it was handed over, so it
 * sits in their Today's Leads, and its status goes back to Assigned. The first
 * created date is kept once, in originalCreatedAt; notes, calls, follow-ups and
 * the activity log stay as they were.
 *
 * A hand-over is a lead getting a different owner — assign, the team split,
 * auto-assign, bulk assign, a member reassign, an Inactive Leads reassign — or
 * moving to a different team, where it is new for that team's queue until the
 * split gives it to someone (its status is then left as the transfer set it).
 * This lives on the model, not in each of those paths, so all of them follow it.
 *
 * Not a hand-over: a lead created already assigned (an import keeps its
 * dates), the same owner or team set again, unassigning, and a closed or lost
 * lead, whose status is tied to its enrolment, commission or reason.
 */
const KEEPS_ITS_STATUS = new Set(["closed", "lost"]);

type LeadDoc = Document & {
  assignedTo?: Types.ObjectId | null;
  team?: Types.ObjectId | null;
  status?: string;
  createdAt?: Date;
  originalCreatedAt?: Date | null;
};

type Stale = { _id: Types.ObjectId; assignedTo?: unknown; team?: unknown; status?: string };
type HandOverQuery = Query<unknown, unknown> & { _handOver?: { ids: Types.ObjectId[]; owned: boolean } };

/** An id as a string, whether the field holds an id or a populated document. */
const idOf = (v: unknown): string | null =>
  v == null ? null : String((v as { _id?: unknown })._id ?? v);

/** The owner and team an update sets (null/absent = none given; unassigning is not a hand-over). */
function givenIn(update: unknown): { owner: string | null; team: string | null } {
  if (!update || Array.isArray(update)) return { owner: null, team: null };
  const u = update as Record<string, unknown>;
  const set = (u.$set ?? {}) as Record<string, unknown>;
  return { owner: idOf(set.assignedTo ?? u.assignedTo), team: idOf(set.team ?? u.team) };
}

export function handOverOnAssign(schema: Schema): void {
  // Owner and team as loaded, to tell a hand-over from the same value being set again.
  schema.post("init", function (this: LeadDoc) {
    this.$locals.ownerAtLoad = idOf(this.assignedTo);
    this.$locals.teamAtLoad = idOf(this.team);
  });

  schema.pre("save", function (this: LeadDoc) {
    if (this.isNew || KEEPS_ITS_STATUS.has(String(this.status))) return;
    const owner = idOf(this.assignedTo);
    const team = idOf(this.team);
    const newOwner = this.isModified("assignedTo") && owner !== null && owner !== this.$locals.ownerAtLoad;
    const newTeam = this.isModified("team") && team !== null && team !== this.$locals.teamAtLoad;
    if (!newOwner && !newTeam) return;
    if (!this.originalCreatedAt) this.originalCreatedAt = this.createdAt;
    this.createdAt = new Date();
    if (owner) this.status = "assigned";
  });

  // updateOne / updateMany / findOneAndUpdate (findByIdAndUpdate) that set an owner or a team.
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(op, async function (this: HandOverQuery) {
      const { owner, team } = givenIn(this.getUpdate());
      if (!owner && !team) return;
      const leads = (await this.model
        .find(this.getFilter())
        .select("_id assignedTo team status")
        .limit(op === "updateMany" ? 0 : 1)
        .lean()) as Stale[];
      const ids = leads
        .filter((l) => !KEEPS_ITS_STATUS.has(String(l.status)))
        .filter((l) => (owner && idOf(l.assignedTo) !== owner) || (team && idOf(l.team) !== team))
        .map((l) => l._id);
      if (ids.length) this._handOver = { ids, owned: owner !== null };
    });
    schema.post(op, async function (this: HandOverQuery) {
      const handOver = this._handOver;
      if (!handOver) return;
      this._handOver = undefined;
      // Straight to the collection: the update's own timestamps would drop a createdAt.
      await this.model.collection.updateMany({ _id: { $in: handOver.ids } }, [
        {
          $set: {
            originalCreatedAt: { $ifNull: ["$originalCreatedAt", "$createdAt"] },
            createdAt: "$$NOW",
            // A new owner: back to Assigned, and the old owner's follow-up date goes with it (leadFollowUpDate.ts).
            ...(handOver.owned ? { status: "assigned", ...FOLLOW_UP_DATE_FIELDS } : {}),
          },
        },
      ]);
    });
  }
}
