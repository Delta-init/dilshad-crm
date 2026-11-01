/**
 * Puts the Remote CRM's commission back after it was given another CRM's plan by Root (the user, 2026-11-01: with
 * COMMISSION_FROM_ROOT on and ROOT_ORG_SECRET set to the Sales CRM's secret, Root answered as the Sales CRM — its
 * Sales Manager and excluded logins were copied into these settings, and sales finance approved meanwhile were decided
 * against the Sales CRM's people, teams and courses).
 *
 *   - the settings: the Sales Manager and the logins that earn nothing, named on the command line — or, once this CRM's
 *     secret is right, taken from Root's plan for this CRM (--from-root, which refuses a plan for any other CRM);
 *   - the sales: each one decided wrongly — a line paying somebody who isn't a user here, a hold for an "Unknown user",
 *     or (decided since --since) amounts of 0 on a course that pays commission — goes back to being followed: the
 *     commission sweep asks finance again and decides it afresh, as for any sale.
 *
 * Reads and prints only, unless --write; --write saves the settings and the sales as they were to an undo file first
 * (--undo <file> puts them back). Run it from the API folder on the server:
 *
 *   bun src/scripts/repairRootMixup.ts --sm "<name>" --exclude "<name>,<name>"     # or --exclude none
 *   bun src/scripts/repairRootMixup.ts --from-root
 *     [--since 2026-10-31T20:00:00Z] [--write]
 *   bun src/scripts/repairRootMixup.ts --undo <file>
 */
import "dotenv/config";
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";

const { EJSON } = mongoose.mongo.BSON;
type Id = mongoose.Types.ObjectId;
const REPAIRED = "Being counted again — it was decided against another CRM's plan (2026-11-01)";
/** Stage 3 (commission from Root) could not have been on before this. */
const DEFAULT_SINCE = "2026-10-31T20:00:00Z";

export interface RepairOpts {
  sm?: string;
  exclude?: string;
  fromRoot?: boolean;
  since?: string;
  write: boolean;
  undoFile?: string;
  /** Root's plan for this CRM — given by the checks; else asked of Root (--from-root). */
  rootPlan?: () => Promise<{ salesManager: { id: string } | null; excluded: Array<{ id: string }> }>;
}

export async function repairRootMixup(o: RepairOpts): Promise<{ lines: string[]; sales: number; undoFile?: string }> {
  const db = mongoose.connection.db!;
  const users = await db.collection("users").find({}, { projection: { name: 1 } }).toArray();
  const nameOf = new Map(users.map((u) => [String(u._id), String(u.name ?? "")]));
  const named = (id: unknown) => (id ? nameOf.get(String(id)) ?? `not a user here (${String(id)})` : "none");
  const byName = (name: string): Id => {
    const hits = users.filter((u) => String(u.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
    if (hits.length !== 1) throw new Error(hits.length ? `"${name}" is ${hits.length} users here — ${hits.map((u) => String(u._id)).join(", ")}` : `No user named "${name}" here`);
    return hits[0]!._id as Id;
  };

  // The settings as they should be.
  let sm: Id | null;
  let excluded: Id[];
  if (o.fromRoot) {
    const plan = await (o.rootPlan ?? (async () => (await import("../services/rootCommission.js")).rootPlan(new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 7))))();
    const ids = [plan.salesManager?.id, ...plan.excluded.map((p) => p.id)].filter(Boolean) as string[];
    const strangers = ids.filter((id) => !nameOf.has(id));
    if (strangers.length) throw new Error(`Root's plan names people who aren't users here (${strangers.join(", ")}) — it isn't this CRM's plan; nothing changed`);
    sm = plan.salesManager ? new mongoose.Types.ObjectId(plan.salesManager.id) : null;
    excluded = plan.excluded.map((p) => new mongoose.Types.ObjectId(p.id));
  } else {
    if (!o.sm) throw new Error('--sm "<name>": the Sales Manager (or --from-root)');
    if (o.exclude === undefined) throw new Error('--exclude "<name>,<name>": the logins that earn nothing, or --exclude none');
    sm = byName(o.sm);
    excluded = o.exclude.trim().toLowerCase() === "none" ? [] : o.exclude.split(",").map((n) => n.trim()).filter(Boolean).map(byName);
  }
  const settings: any = await db.collection("commissionsettings").findOne({ key: "default" });
  const nowSm = settings?.salesManager ?? null;
  const nowExcluded: unknown[] = settings?.excludedUsers ?? [];
  const settingsChange = String(nowSm) !== String(sm) || JSON.stringify(nowExcluded.map(String).sort()) !== JSON.stringify(excluded.map(String).sort());

  // The sales decided wrongly.
  const since = new Date(o.since ?? DEFAULT_SINCE);
  if (Number.isNaN(since.getTime())) throw new Error("--since: a date and time, like 2026-10-31T20:00:00Z");
  const courses = await db.collection("courses").find({}, { projection: { commission: 1 } }).toArray();
  const pays = new Set(courses.filter((c: any) => (c.commission?.sales ?? 0) + (c.commission?.tl ?? 0) + (c.commission?.sm ?? 0) > 0).map((c) => String(c._id)));
  const decided: any[] = await db.collection("commissionsales").find({ state: { $in: ["counted", "waiting", "excluded"] } }).sort({ saleDate: 1 }).toArray();
  const why = (s: any): string | null => {
    const strangers = (s.lines ?? []).filter((l: any) => l.user && !nameOf.has(String(l.user)));
    if (strangers.length) return `pays ${strangers.map((l: any) => `${l.role} ${l.userName || "?"}`).join(", ")} — not users here`;
    if (/Unknown user/.test(s.reason ?? "")) return `held: ${s.reason}`;
    const at = s.stepsDoneAt ?? s.updatedAt;
    const zero = !((s.plan?.sales ?? 0) + (s.plan?.tl ?? 0) + (s.plan?.sm ?? 0));
    if (at && new Date(at) >= since && zero && pays.has(String(s.course))) return "counted at 0 on a course that pays commission";
    return null;
  };
  const wrong = decided.map((s) => ({ s, why: why(s) })).filter((x) => x.why);

  const lines = [
    `settings: Sales Manager ${named(nowSm)} → ${named(sm)}`,
    `          earn nothing ${nowExcluded.map(named).join(", ") || "no one"} → ${excluded.map(named).join(", ") || "no one"}${settingsChange ? "" : "  (as it is already)"}`,
    "",
    `${wrong.length} sale${wrong.length === 1 ? "" : "s"} to count again:`,
    ...wrong.map(({ s, why: w }) => `  ${s.month} · ${s.invoiceNumber || "no invoice"} · ${s.studentName} · ${s.state} · ${w}`),
  ];
  if (!o.write) return { lines, sales: wrong.length };
  if (!settingsChange && !wrong.length) return { lines: [...lines, "", "nothing to write"], sales: 0 };

  const undoFile = o.undoFile ?? `repair-root-mixup-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, EJSON.stringify({ settings: { salesManager: nowSm, excludedUsers: nowExcluded }, sales: wrong.map((x) => x.s) }, undefined, 2, { relaxed: false }));
  if (!(EJSON.parse(readFileSync(undoFile, "utf8")) as any)?.settings) throw new Error(`The undo file ${undoFile} didn't read back — nothing changed`);
  if (settingsChange) {
    await db.collection("commissionsettings").updateOne({ key: "default" }, { $set: { salesManager: sm, excludedUsers: excluded }, $setOnInsert: { key: "default" } }, { upsert: true });
  }
  for (const { s } of wrong) {
    await db.collection("commissionsales").updateOne(
      { _id: s._id },
      { $set: { state: "progress", reason: REPAIRED, lines: [] }, $unset: { stepsDoneAt: "", countedAt: "", team: "", teamName: "" } },
    );
  }
  return { lines: [...lines, "", "written — the commission sweep decides those sales again within a few minutes"], sales: wrong.length, undoFile };
}

/** Puts the settings and the sales back as they were saved. */
export async function undoRepairRootMixup(file: string): Promise<number> {
  const db = mongoose.connection.db!;
  const saved: any = EJSON.parse(readFileSync(file, "utf8"));
  await db.collection("commissionsettings").updateOne({ key: "default" }, { $set: { salesManager: saved.settings.salesManager ?? null, excludedUsers: saved.settings.excludedUsers ?? [] } });
  for (const s of saved.sales ?? []) await db.collection("commissionsales").replaceOne({ _id: s._id }, s);
  return (saved.sales ?? []).length;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : undefined; };
  await mongoose.connect(process.env.MONGODB_URI!, { authSource: "admin" });
  try {
    if (arg("--undo")) console.log(`Put back the settings and ${await undoRepairRootMixup(arg("--undo")!)} sales from ${arg("--undo")}.`);
    else {
      const write = argv.includes("--write");
      const r = await repairRootMixup({ sm: arg("--sm"), exclude: arg("--exclude"), fromRoot: argv.includes("--from-root"), since: arg("--since"), write });
      for (const l of r.lines) console.log(l);
      if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}`);
      if (!write) console.log("\nNothing written. Check it, then run the same command with --write.");
    }
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
  await mongoose.disconnect();
}
