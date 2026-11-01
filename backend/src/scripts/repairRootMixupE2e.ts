/**
 * src/scripts/repairRootMixup.ts against a scratch database, set up as the Remote CRM was found on 2026-11-01 — its
 * Sales Manager and excluded logins another CRM's people, sales decided against another CRM's plan:
 *
 *   1. the dry run: the settings before → after by name, the sales decided wrongly (paying people who aren't users
 *      here, held for an "Unknown user", counted at 0 since --since on a course that pays) and nothing else; nothing
 *      written;
 *   2. a name that isn't a user, no --exclude: refused; --from-root with another CRM's plan refused, with this CRM's taken;
 *   3. --write: the settings put right, those sales back to being followed (lines cleared, not done), the rest untouched;
 *      run again: nothing left;
 *   4. the undo file puts the settings and the sales back exactly.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:<port>/crm-root-mixup-e2e bun --no-env-file src/scripts/repairRootMixupE2e.ts
 */
import mongoose from "mongoose";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error("Refusing: MONGODB_URI must be a scratch e2e database on 127.0.0.1"); process.exit(1); }
const { repairRootMixup, undoRepairRootMixup } = await import("./repairRootMixup.js");
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); } else { fail++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); } };
const show = (v: unknown) => JSON.stringify(v).slice(0, 500);
const refused = async (p: Promise<unknown>, like: RegExp) => { try { await p; return false; } catch (e) { return like.test((e as Error).message); } };

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const id = () => new mongoose.Types.ObjectId();
const u = { dilshad: id(), nusra: id(), fidha: id(), test: id(), superadmin: id() };
await db.collection("users").insertMany([
  { _id: u.dilshad, name: "dilshad" }, { _id: u.nusra, name: "nusra" }, { _id: u.fidha, name: "fidha" }, { _id: u.test, name: "test" }, { _id: u.superadmin, name: "super admin" },
]);
// Another CRM's people, as copied in.
const other = { abrar: id(), rootUser: id(), superadmin: id(), developer: id() };
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: other.abrar, excludedUsers: [other.rootUser, other.superadmin, other.developer] });
const C1 = id(), FREE = id();
await db.collection("courses").insertMany([{ _id: C1, name: "COURSE 1", commission: { sales: 230, tl: 85, sm: 100 } }, { _id: FREE, name: "Free webinar" }]);
const after = new Date("2026-11-01T01:00:00Z"), before = new Date("2026-10-20T08:00:00Z");
const line = (role: string, user: mongoose.Types.ObjectId, userName: string, amount: number) => ({ role, user, userName, amount });
let n = 0;
const sale = (o: object) => ({ _id: id(), student: id(), studentName: `Student ${++n}`, invoiceNumber: `IN-0${n}`, course: C1, courseName: "COURSE 1", month: "2026-10", saleDate: before, ...o });
const S = {
  foreignSm: sale({ state: "counted", stepsDoneAt: after, plan: { sales: 230, tl: 85, sm: 100 }, lines: [line("sales", u.nusra, "nusra", 230), line("sm", other.abrar, "Abrar Ahamed", 100)] }),
  unknownHold: sale({ state: "waiting", stepsDoneAt: after, reason: "Unknown user isn't in a team", plan: { sales: 0, tl: 0, sm: 0 }, lines: [] }),
  zeroAfter: sale({ state: "counted", stepsDoneAt: after, plan: { sales: 0, tl: 0, sm: 0 }, lines: [line("sales", u.fidha, "fidha", 0), line("sm", u.dilshad, "dilshad", 0)] }),
  good: sale({ state: "counted", stepsDoneAt: after, plan: { sales: 230, tl: 85, sm: 100 }, lines: [line("sales", u.nusra, "nusra", 230), line("sm", u.dilshad, "dilshad", 100)] }),
  freeCourse: sale({ state: "counted", stepsDoneAt: after, course: FREE, courseName: "Free webinar", plan: { sales: 0, tl: 0, sm: 0 }, lines: [line("sales", u.fidha, "fidha", 0)] }),
  zeroBefore: sale({ state: "counted", stepsDoneAt: before, plan: { sales: 0, tl: 0, sm: 0 }, lines: [line("sales", u.fidha, "fidha", 0)] }),
  reversed: sale({ state: "reversed", stepsDoneAt: after, plan: { sales: 230, tl: 85, sm: 100 }, lines: [line("sm", other.abrar, "Abrar Ahamed", 100)] }),
};
await db.collection("commissionsales").insertMany(Object.values(S));
const snap = async () => JSON.stringify({ s: await db.collection("commissionsettings").findOne({ key: "default" }), sales: await db.collection("commissionsales").find().sort({ invoiceNumber: 1 }).toArray() });
const start = await snap();
const byNames = { sm: "dilshad", exclude: "test, super admin" };

console.log("\nCase 1 — the dry run");
let r = await repairRootMixup({ ...byNames, write: false });
check("the settings: another CRM's Sales Manager and logins → dilshad; test and super admin",
  r.lines[0]!.includes(`not a user here (${other.abrar})`) && r.lines[0]!.endsWith("→ dilshad") && /→ test, super admin$/.test(r.lines[1]!), show(r.lines.slice(0, 2)));
check("the sales decided wrongly — paying another CRM's manager, held for an Unknown user, counted at 0 since — and only those (3)", r.sales === 3
  && r.lines.some((l) => /IN-01 .*pays sm Abrar Ahamed — not users here/.test(l)) && r.lines.some((l) => /IN-02 .*held: Unknown user/.test(l))
  && r.lines.some((l) => /IN-03 .*counted at 0 on a course that pays commission/.test(l)), show(r.lines));
check("…nothing written", (await snap()) === start);

console.log("\nCase 2 — refused");
check("a name that isn't a user here", await refused(repairRootMixup({ sm: "Abrar", exclude: "none", write: false }), /No user named "Abrar"/));
check("no --exclude", await refused(repairRootMixup({ sm: "dilshad", write: false }), /--exclude/));
check("--from-root with another CRM's plan", await refused(repairRootMixup({ fromRoot: true, write: false, rootPlan: async () => ({ salesManager: { id: String(other.abrar) }, excluded: [] }) }), /isn't this CRM's plan/));
r = await repairRootMixup({ fromRoot: true, write: false, rootPlan: async () => ({ salesManager: { id: String(u.dilshad) }, excluded: [{ id: String(u.test) }, { id: String(u.superadmin) }] }) });
check("--from-root with this CRM's plan: the same settings and sales", r.lines[0]!.endsWith("→ dilshad") && /→ test, super admin$/.test(r.lines[1]!) && r.sales === 3, show(r.lines.slice(0, 2)));
check("…nothing written", (await snap()) === start);

console.log("\nCase 3 — --write");
const undoFile = join(mkdtempSync(join(tmpdir(), "root-mixup-")), "undo.json");
r = await repairRootMixup({ ...byNames, write: true, undoFile });
const st: any = await db.collection("commissionsettings").findOne({ key: "default" });
check("the settings: dilshad the Sales Manager; test and super admin earn nothing", String(st.salesManager) === String(u.dilshad)
  && st.excludedUsers.map(String).sort().join() === [String(u.test), String(u.superadmin)].sort().join(), show(st));
const get = (k: keyof typeof S) => db.collection("commissionsales").findOne({ _id: S[k]._id }) as Promise<any>;
const re = await Promise.all([get("foreignSm"), get("unknownHold"), get("zeroAfter")]);
check("those 3 sales back to being followed: progress, lines cleared, not done, said why", re.every((s) => s.state === "progress" && s.lines.length === 0 && !("stepsDoneAt" in s) && /another CRM's plan/.test(s.reason)), show(re));
const kept = await Promise.all([get("good"), get("freeCourse"), get("zeroBefore"), get("reversed")]);
check("the rest untouched: a right one, a course paying nothing, one decided before, a reversed one",
  JSON.stringify(kept) === JSON.stringify([S.good, S.freeCourse, S.zeroBefore, S.reversed]), show(kept));
r = await repairRootMixup({ ...byNames, write: true });
check("run again: the settings as they are, no sales left", r.sales === 0 && r.lines.some((l) => /as it is already/.test(l)) && r.lines.at(-1) === "nothing to write", show(r.lines));

console.log("\nCase 4 — undo");
const back = await undoRepairRootMixup(undoFile);
check("the undo file puts the settings and the 3 sales back exactly, dates as dates", back === 3 && (await snap()) === start
  && (await get("foreignSm")).stepsDoneAt instanceof Date, String(back));

await mongoose.disconnect();
console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass}/${pass + fail} checks passed\x1b[0m`);
process.exit(fail ? 1 : 0);
