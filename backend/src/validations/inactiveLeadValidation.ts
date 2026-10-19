import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
/** Query strings arrive as "" when a filter is cleared — that means "no filter". */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === undefined ? undefined : v), schema.optional());

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// GET /inactive-leads
export const listInactiveLeadsQuery = z.object({
  ...paging,
  teamId: optionalQuery(objectId),
  ownerId: optionalQuery(objectId),
  search: optionalQuery(z.string().trim().max(100)),
});

// GET /inactive-leads/moves
export const listLeadMovesQuery = z.object({
  ...paging,
  kind: optionalQuery(z.enum(["automatic", "manual"])),
  teamId: optionalQuery(objectId),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
// GET /inactive-leads/workflow — the Workflow tab: leads that came in over these Dubai days and where they went
export const leadWorkflowQuery = z.object({
  from: optionalQuery(day),
  to: optionalQuery(day),
  teamId: optionalQuery(objectId),
  personId: optionalQuery(objectId),
});

// GET /inactive-leads/workflow/leads — the leads behind one box of the map
export const leadWorkflowLeadsQuery = leadWorkflowQuery.extend({
  box: z.enum(["came", "assigned", "unassigned", "worked", "fresh", "inactive", "moved_auto", "moved_hand", "on_break", "nobody_left", "waiting", "status"]),
  status: optionalQuery(z.string().trim().max(40)),
});

// GET /inactive-leads/people — the Move dialog's people
export const movePeopleQuery = z.object({
  search: optionalQuery(z.string().trim().max(100)),
});

// POST /inactive-leads/reassign — no `to`: each lead goes to the next person in its team.
export const reassignInactiveLeadsSchema = z
  .object({
    leadIds: z.array(objectId).min(1, "Pick at least one lead").max(100, "At most 100 leads at a time"),
    to: objectId.optional(),
  })
  .strict();

export type ReassignInactiveLeadsInput = z.infer<typeof reassignInactiveLeadsSchema>;
