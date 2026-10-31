import type { PipelineStage } from "mongoose";

/*
 * A Closed lead with no enrolment is a closing too (the owner, 2026-10-31: the AI Academy's students, marked Closed
 * from the academy's list — "the closing count needs to show"). It counts on the day it was marked Closed: its latest
 * activity line that set the status to closed (else when it last changed). A lead with an enrolment — dropped or not —
 * is counted by its enrolment, never here, so nothing is counted twice.
 */

/** For Lead.aggregate: each person's Closed leads with no enrolment, marked Closed within `range` — `{ _id: assignedTo, n }`. */
export function closingsWithoutEnrolment(range: { $gte: Date; $lt: Date }): PipelineStage[] {
  return [
    { $match: { status: "closed", assignedTo: { $ne: null } } },
    { $lookup: { from: "students", localField: "_id", foreignField: "leadId", as: "_enrolled", pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }] } },
    { $match: { _enrolled: { $size: 0 } } },
    {
      $project: {
        assignedTo: 1,
        closedAt: {
          $ifNull: [
            {
              $max: {
                $map: {
                  input: { $filter: { input: { $ifNull: ["$activityLogs", []] }, as: "a", cond: { $eq: ["$$a.changes.status.to", "closed"] } } },
                  as: "a",
                  in: "$$a.createdAt",
                },
              },
            },
            "$updatedAt",
          ],
        },
      },
    },
    { $match: { closedAt: range } },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ];
}

/** Two `{ _id, n }` lists added together, by `_id`. */
export function addCounts<T extends { _id: unknown; n: number }>(a: T[], b: T[]): T[] {
  const sum = new Map<string, T>();
  for (const r of [...a, ...b]) {
    const k = String(r._id);
    const had = sum.get(k);
    sum.set(k, had ? { ...had, n: had.n + r.n } : { ...r });
  }
  return [...sum.values()];
}
