/**
 * One-off (the user, 2026-10-30): "when partial payment, the commission will never get to the salesperson until it
 * records full payment … the month it was completed the full payment, that month only he will get the commission".
 * The sweep now holds a part-paid sale until finance has it paid in full, and counts it in that month. Sales it
 * counted before that, while their invoice still owed, are put back to waiting here: not counted, saying what is
 * owed — the sweep counts each again once it is paid in full, in that month.
 *
 * Which: counted (or held) sales closed since 1 October whose invoice finance says still owes. One whose month's
 * commission finance has already approved or paid to somebody on it is left as it is, and listed — taking it back
 * would leave a payout for money no longer earned; that is a call to make by hand.
 *
 * Dry run by default: lists them. With --write it saves them to an undo file first, then puts them back to waiting.
 *
 *   bun scripts/commission-full-payment.ts            # dry run, on the database in MONGODB_URI, asking finance
 *   bun scripts/commission-full-payment.ts --write    # put them back (undo file written first)
 *   bun scripts/commission-full-payment.ts --undo backups/commission-full-payment-<time>.json
 *
 * Run it from backend/ on the server: Bun reads MONGODB_URI and the FINANCE_* settings from the .env there.
 */
import mongoose, { Types } from "mongoose";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CommissionSale } from "../src/models/CommissionSale.js";
import { fetchCommissionPayouts } from "../src/services/financeClient.js";
import { fetchStatusesByOrg } from "../src/services/financeOrgs.js";
import { COUNT_FROM, owedOf, owedReason, type Owed } from "../src/services/commissionService.js";

const { EJSON } = mongoose.mongo.BSON;

export interface Found {
  saleId: string;
  student: string;
  studentName: string;
  closerName: string;
  month: string;
  state: string;
  invoiceNumber: string;
  owed: Owed;
  /** What its lines pay now, all of them. */
  paying: number;
  /** Somebody on it already has the month's commission approved or paid in finance: left alone. */
  paidOut: string[];
}

/** Counted and held sales since COUNT_FROM that finance says still owe; null when finance couldn't be asked. */
export async function partPaidCounted(): Promise<Found[] | null> {
  const sales = await CommissionSale.find({ state: { $in: ["counted", "waiting"] }, saleDate: { $gte: COUNT_FROM } }).lean();
  const found: Found[] = [];
  const payouts = new Map<string, Set<string> | null>();
  for (let i = 0; i < sales.length; i += 200) {
    const batch = sales.slice(i, i + 200);
    const ids = batch.map((s) => String(s.student));
    const statuses = await fetchStatusesByOrg(ids);
    if (!statuses.length && batch.length) return null;
    const statusOf = new Map(statuses.map((st) => [st.externalId, st]));
    for (const s of batch) {
      const st = statusOf.get(String(s.student));
      if (!st || st.status === "void") continue;
      const owed = owedOf(st);
      if (!owed) continue;
      if (!payouts.has(s.month)) {
        try {
          payouts.set(s.month, new Set((await fetchCommissionPayouts(s.month)).map((p) => p.userId)));
        } catch {
          payouts.set(s.month, null);
        }
      }
      const out = payouts.get(s.month);
      if (out === null) return null;
      found.push({
        saleId: String(s._id), student: String(s.student), studentName: s.studentName, closerName: s.closerName, month: s.month,
        state: s.state, invoiceNumber: s.invoiceNumber ?? "", owed, paying: s.lines.reduce((n, l) => n + l.amount, 0),
        paidOut: s.lines.filter((l) => l.amount > 0 && out!.has(String(l.user))).map((l) => l.userName),
      });
    }
  }
  return found;
}

/** Back to waiting for full payment; only if still as found. */
export async function putBack(found: Found[]): Promise<number> {
  let n = 0;
  for (const f of found) {
    if (f.paidOut.length) continue;
    const r = await CommissionSale.updateOne(
      { _id: new Types.ObjectId(f.saleId), state: f.state },
      {
        $set: { state: "progress", reason: owedReason(f.owed), lines: [], owed: f.owed },
        $unset: { countedAt: "", stepsDoneAt: "", team: "", teamName: "" },
      },
    );
    n += r.modifiedCount;
  }
  return n;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const { env } = await import("../src/config/env.js");
  await mongoose.connect(env.MONGODB_URI);
  try {
    const undoAt = args.indexOf("--undo");
    if (undoAt >= 0) {
      const file = args[undoAt + 1];
      if (!file) throw new Error("--undo needs the undo file");
      const docs = EJSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown> & { _id: Types.ObjectId }>;
      let n = 0;
      // Only those still waiting as this put them: one counted since is left as the sweep made it.
      for (const d of docs) n += (await CommissionSale.collection.replaceOne({ _id: d._id, state: "progress", "owed.amount": { $exists: true } }, d)).modifiedCount;
      console.log(`Undo: put back ${n} of ${docs.length}.`);
    } else {
      const found = await partPaidCounted();
      if (!found) throw new Error("Finance didn't answer (or its payouts couldn't be asked) — nothing done. Try again.");
      const doing = found.filter((f) => !f.paidOut.length);
      console.log(`${found.length} sale(s) counted while their invoice still owes:\n`);
      for (const f of found) {
        console.log(`  ${f.month}  ${f.studentName.slice(0, 28).padEnd(28)} ${f.closerName.slice(0, 20).padEnd(20)} ${(f.invoiceNumber || "—").padEnd(9)} owes ${f.owed.currency} ${f.owed.amount} of ${f.owed.total}  · pays AED ${f.paying} now`
          + (f.paidOut.length ? `   LEFT AS IT IS — ${f.month} already approved/paid in finance for ${f.paidOut.join(", ")}` : ""));
      }
      if (!args.includes("--write")) {
        console.log(`\nDry run — nothing changed. Add --write to put these ${doing.length} back to waiting for full payment.`);
      } else if (doing.length) {
        const docs = await CommissionSale.find({ _id: { $in: doing.map((f) => new Types.ObjectId(f.saleId)) } }).lean();
        mkdirSync("backups", { recursive: true });
        const file = `backups/commission-full-payment-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        writeFileSync(file, EJSON.stringify(docs, undefined, 2, { relaxed: false }));
        console.log(`\nPut back to waiting: ${await putBack(doing)} of ${doing.length}. Undo: bun scripts/commission-full-payment.ts --undo ${file}`);
      } else {
        console.log("\nNothing to put back.");
      }
    }
  } catch (e) {
    console.error(`\n${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
