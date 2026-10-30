import type { Query, Schema } from "mongoose";
import { viewAsNote } from "../utils/viewAs.js";

/*
 * A line written on a lead while a Super Admin acts through "View as" (2026-10-30) says so —
 * "Status changed to Lost (by Admin using View as)" — wherever in the app it is written, by a save or an update.
 */
type Log = { description?: string; isNew?: boolean };

const mark = (log: Log | undefined, note: string) => {
  if (log && typeof log.description === "string" && !log.description.endsWith(note)) {
    log.description = `${log.description}${note}`.slice(0, 500);
  }
};

export function noteViewAsOnLogs(schema: Schema): void {
  schema.pre("save", function () {
    const note = viewAsNote();
    if (!note || !this.isModified("activityLogs")) return;
    const logs = (this as unknown as { activityLogs?: Log[] }).activityLogs ?? [];
    for (const l of logs) if (this.isNew || l.isNew) mark(l, note);
  });
  for (const op of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      const note = viewAsNote();
      if (!note) return;
      const u = this.getUpdate() as Record<string, unknown> | null;
      if (!u || Array.isArray(u)) return;
      const push = u.$push as Record<string, unknown> | undefined;
      const v = push?.activityLogs as { $each?: Log[] } | Log | undefined;
      if (!v) return;
      if (Array.isArray((v as { $each?: Log[] }).$each)) for (const l of (v as { $each: Log[] }).$each) mark(l, note);
      else mark(v as Log, note);
    });
  }
}
