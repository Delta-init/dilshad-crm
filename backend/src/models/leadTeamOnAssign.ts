import { Types, type Document, type Query, type Schema } from "mongoose";
import { Team } from "./Team.js";

/**
 * A lead given to someone goes to their team (the owner, 2026-11-02: "if it's assigned to him it will auto assign to
 * the team also" — a team leader's own leads, filed under another team, were nowhere on their Leads page). Unless it
 * is already in one of their teams, it moves to a team they lead, else the first they are a member of; someone in no
 * active team leaves it where it is. An update that names the team itself is followed as it is.
 *
 * Every way a lead gets an owner (assign, the team split, auto-assign, bulk, a reassign, the WhatsApp leads) — on the
 * model, as leadHandOver.ts. Not a raw collection write or insertMany (an import keeps the team it was given).
 */

const idOf = (v: unknown): string | null => (v == null ? null : String((v as { _id?: unknown })._id ?? v));

/** Their active teams, and the one a lead given to them goes to — one they lead first. */
async function teamsOf(owner: string): Promise<{ all: string[]; home: Types.ObjectId | null }> {
  if (!Types.ObjectId.isValid(owner)) return { all: [], home: null };
  const me = new Types.ObjectId(owner);
  const teams = await Team.find({ status: { $ne: "inactive" }, $or: [{ leaders: me }, { members: me }] })
    .select("_id leaders").sort({ createdAt: 1, _id: 1 }).lean<{ _id: Types.ObjectId; leaders?: unknown[] }[]>();
  const led = teams.find((t) => (t.leaders ?? []).some((l) => idOf(l) === owner));
  return { all: teams.map((t) => String(t._id)), home: (led ?? teams[0])?._id ?? null };
}

type LeadDoc = Document & { assignedTo?: unknown; team?: unknown };
type TeamQuery = Query<unknown, unknown> & { _teamOnAssign?: { owner: string; ids: Types.ObjectId[] } };

/** The owner an update gives, unless it names the team too (then that team stands). */
function ownerGiven(update: unknown): string | null {
  if (!update || Array.isArray(update)) return null;
  const u = update as Record<string, unknown>;
  const set = (u.$set ?? {}) as Record<string, unknown>;
  if ("team" in set || "team" in u) return null;
  return idOf(set.assignedTo ?? u.assignedTo);
}

export function teamOnAssign(schema: Schema): void {
  schema.pre("save", async function (this: LeadDoc) {
    const owner = idOf(this.assignedTo);
    if (!owner) return;
    // A new lead: only when it came with no team. Later: when the owner changes and the team wasn't set with it.
    if (this.isNew ? this.team != null : !this.isModified("assignedTo") || this.isModified("team")) return;
    const { all, home } = await teamsOf(owner);
    if (home && !all.includes(String(idOf(this.team)))) this.team = home;
  });

  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(op, async function (this: TeamQuery) {
      const owner = ownerGiven(this.getUpdate());
      if (!owner) return;
      const leads = (await this.model.find(this.getFilter()).select("_id").limit(op === "updateMany" ? 0 : 1).lean()) as { _id: Types.ObjectId }[];
      if (leads.length) this._teamOnAssign = { owner, ids: leads.map((l) => l._id) };
    });
    schema.post(op, async function (this: TeamQuery) {
      const given = this._teamOnAssign;
      if (!given) return;
      this._teamOnAssign = undefined;
      const { all, home } = await teamsOf(given.owner);
      if (!home) return;
      // Straight to the collection: those of these leads now theirs, not already in one of their teams.
      await this.model.collection.updateMany(
        { _id: { $in: given.ids }, assignedTo: new Types.ObjectId(given.owner), team: { $nin: all.map((t) => new Types.ObjectId(t)) } },
        { $set: { team: home } },
      );
    });
  }
}
