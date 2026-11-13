/**
 * A month's sales given their rupee amounts from the plan kept in Root now (the user, 2026-11-13: "INR payment only
 * gets commission in INR… separate INR commission for each course" — from November's sales on).
 *
 * A sale counted before the rupee amounts were entered in Root — or before this CRM kept them — has none on its
 * lines, so all of it is paid in AED whatever the client paid in. Each of the month's counted or held sales is asked
 * of Root afresh, and ONLY the rupee amounts are taken: a counted sale's lines get theirs (matched by role and
 * person), a held sale the rupee amounts it will settle at. The AED amounts, who earns them, the fee, the payments
 * and when it was counted all stay exactly as they are. A line that pays nothing in AED gets nothing in rupees. A
 * sale Root would now decide differently (another person on a line, or held) is listed and left as it is.
 *
 * Only with COMMISSION_FROM_ROOT on: the rupee amounts are kept in Root. Reads and prints only, unless --write;
 * --write saves the sales as they were to an undo file first (--undo <file> puts them back). Run it from the API
 * folder on the server, after the rupee amounts are entered in Root:
 *
 *   bun src/scripts/recountRupeeCommission.ts                       # this month (UAE), nothing written
 *   bun src/scripts/recountRupeeCommission.ts --month 2026-11 --write
 *   bun src/scripts/recountRupeeCommission.ts --undo <file>
 */
import "dotenv/config";
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { fromRoot, rootResolve } from "../services/rootCommission.js";

const { EJSON } = mongoose.mongo.BSON;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** This month in UAE time, YYYY-MM. */
const thisMonth = () => new Date(Date.now() + 4 * 60 * 60_000).toISOString().slice(0, 7);
const idOf = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const inr = (n: number) => `INR ${n.toLocaleString("en-US")}`;
const ROLE: Record<string, string> = { sales: "Sales", tl: "TL", sm: "SM" };

type Line = { role: string; user: unknown; userName: string; amount: number; amountInr?: number; note?: string };
type Plan = { sales?: number; tl?: number; sm?: number; creditUsd?: number; salesInr?: number; tlInr?: number; smInr?: number };
const planInr = (p: Plan | undefined) => ({ salesInr: num(p?.salesInr), tlInr: num(p?.tlInr), smInr: num(p?.smInr) });
const samePlanInr = (a: Plan | undefined, b: Plan | undefined) => JSON.stringify(planInr(a)) === JSON.stringify(planInr(b));
const planText = (p: Plan | undefined) => { const x = planInr(p); return x.salesInr + x.tlInr + x.smInr > 0 ? `${inr(x.salesInr)} / ${inr(x.tlInr)} / ${inr(x.smInr)}` : "none"; };
/** The plan with these rupee amounts and nothing else changed; none at all: the fields off. */
function withPlanInr(plan: Plan | undefined, next: Plan | undefined): Plan {
  const { salesInr: _a, tlInr: _b, smInr: _c, ...rest } = plan ?? {};
  const x = planInr(next);
  return x.salesInr + x.tlInr + x.smInr > 0 ? { ...rest, ...x } : rest;
}
/** The share of what a sale has received so far that came in rupees, as a percent — what its rupee amounts will pay on. */
function rupeePercent(s: { collections?: Array<{ share?: number; inr?: boolean }> }): number {
  const list = (s.collections ?? []).filter((c) => num(c.share) > 0);
  const all = list.reduce((t, c) => t + num(c.share), 0);
  return all > 0 ? Math.round((list.filter((c) => c.inr === true).reduce((t, c) => t + num(c.share), 0) / all) * 1000) / 10 : 0;
}

export async function recountRupees(o: { month?: string; write: boolean; undoFile?: string }): Promise<{ lines: string[]; count: number; undoFile?: string }> {
  if (!fromRoot()) throw new Error("COMMISSION_FROM_ROOT is off here: this CRM counts with its own plan, and the rupee amounts are kept in Root. Nothing was read.");
  const month = o.month?.trim() || thisMonth();
  if (!MONTH.test(month)) throw new Error(`--month is YYYY-MM, not "${month}"`);
  const sales = mongoose.connection.db!.collection("commissionsales");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found: any[] = await sales.find({ month, state: { $in: ["counted", "waiting"] } }).sort({ saleDate: 1 }).toArray();

  const out: string[] = [`${month} · ${found.length} counted or held sale${found.length === 1 ? "" : "s"}`, ""];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changes: Array<{ sale: any; set: Record<string, unknown> }> = [];
  let unchanged = 0, left = 0;
  for (const s of found) {
    const head = `${s.invoiceNumber || "no invoice"} · ${s.studentName || "—"} · ${s.courseName || "no course"} · ${s.closerName || "no closer"}`;
    if (!s.course) { out.push(`${head}: no course on the sale — left as it is`); left++; continue; }
    const r = await rootResolve({ closer: idOf(s.closer), team: idOf(s.team), course: idOf(s.course) });
    if (s.state === "waiting") {
      // Held: who earns it is decided once it settles; only the rupee amounts it settles at move.
      if (samePlanInr(s.plan, r.plan)) { unchanged++; continue; }
      out.push(`${head} (held: ${s.reason || "waiting"}): settles in rupees at ${planText(s.plan)} → ${planText(r.plan)}`);
      changes.push({ sale: s, set: { plan: withPlanInr(s.plan, r.plan) } });
      continue;
    }
    if (r.state !== "counted") { out.push(`${head}: Root would hold it now (${r.reason}) — left as it is`); left++; continue; }
    const was: Line[] = s.lines ?? [];
    const unmatched = was.filter((x) => !r.lines.some((l) => l.role === x.role && idOf(l.user) === idOf(x.user)));
    if (unmatched.length) {
      out.push(`${head}: Root would now pay ${unmatched.map((x) => `the ${ROLE[x.role] ?? x.role} line`).join(" and ")} to somebody else — left as it is`);
      left++;
      continue;
    }
    const diff: string[] = [];
    const lines = was.map((x) => {
      const now = r.lines.find((l) => l.role === x.role && idOf(l.user) === idOf(x.user))!;
      // A line the rules paid nothing in AED pays nothing in rupees.
      const next = num(x.amount) > 0 || num(now.amount) === 0 ? num(now.amountInr) : 0;
      const before = num(x.amountInr);
      if (next !== before) diff.push(`${ROLE[x.role] ?? x.role} ${x.userName} ${before ? inr(before) : "none"} → ${next ? inr(next) : "none"}`);
      const { amountInr: _old, ...rest } = x;
      return next > 0 ? { ...rest, amountInr: next } : rest;
    });
    if (!diff.length && samePlanInr(s.plan, r.plan)) { unchanged++; continue; }
    const pct = rupeePercent(s);
    out.push(`${head}: ${diff.join(" · ") || "the plan's rupee amounts only"} — ${pct}% paid in rupees so far${(s.owedShare ?? 0) > 0 ? ", earned once the client pays in full" : ""}`);
    changes.push({ sale: s, set: { lines, plan: withPlanInr(s.plan, r.plan) } });
  }

  const count = changes.length;
  if (count || left) out.push("");
  out.push(`${count} sale${count === 1 ? "" : "s"} to give rupee amounts, ${unchanged} already as Root has them${left ? `, ${left} left as they are` : ""}`);
  if (!found.length) out.push(`No counted or held sales in ${month}.`);
  else if (!count) out.push("Nothing to change — are the courses' rupee amounts entered in Root yet?");
  if (count) {
    out.push("Only the rupee amounts change: the AED amounts and who earns them stay as counted.");
    out.push("A month finance has approved already keeps what was approved; its CRM commission page shows the person as changed.");
  }
  if (!o.write || !count) return { lines: out, count };

  const undoFile = o.undoFile ?? `recount-rupee-commission-undo-${month}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, EJSON.stringify(changes.map((c) => c.sale), undefined, 2, { relaxed: false }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((EJSON.parse(readFileSync(undoFile, "utf8")) as any[])?.length !== count) throw new Error(`The undo file ${undoFile} didn't read back — nothing changed`);
  for (const c of changes) await sales.updateOne({ _id: c.sale._id }, { $set: c.set });
  return { lines: [...out, "", "written"], count, undoFile };
}

/** Puts the sales back as they were saved. */
export async function undoRecountRupees(file: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saved: any[] = EJSON.parse(readFileSync(file, "utf8"));
  for (const s of saved) await mongoose.connection.db!.collection("commissionsales").replaceOne({ _id: s._id }, s);
  return saved.length;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  await mongoose.connect(process.env.MONGODB_URI!, { authSource: "admin" });
  try {
    if (arg("--undo")) console.log(`Put back ${await undoRecountRupees(arg("--undo"))} sales from ${arg("--undo")}.`);
    else {
      const write = argv.includes("--write");
      const r = await recountRupees({ month: arg("--month"), write });
      for (const l of r.lines) console.log(l);
      if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}`);
      if (!write && r.count) console.log("\nNothing written. To change them: the same command with --write.");
    }
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
  await mongoose.disconnect();
}
