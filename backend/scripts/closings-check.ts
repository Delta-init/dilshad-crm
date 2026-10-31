/**
 * Checks that a closing lands on the day it actually happened.
 *
 * `enrollmentDate` is an instant. Which business day it belongs to is a local
 * question, and Dubai is UTC+4 — so a sale closed at 00:30 on the 19th is
 * 20:30 on the 18th in UTC, and a naive grouping files it under the wrong day
 * and quietly takes a closing off the day somebody is measured on. The same
 * class of fault as the comp-off bug: a date read in the wrong zone.
 *
 * This inserts closings either side of a Dubai midnight and checks which day
 * each one comes back under. Scratch database only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();

const { Student } = await import("../src/models/Student.js");
const { StudentService } = await import("../src/services/studentService.js");
const svc = new StudentService();

const team = new Types.ObjectId();
const user = new Types.ObjectId();
await mongoose.connection.db!.collection("teams").insertOne({ _id: team, name: "Alpha" });
await mongoose.connection.db!.collection("users").insertOne({ _id: user, name: "Riya" });

/** A closing at an exact instant. */
async function close(name: string, iso: string, fee: number, paid = 0) {
  // What was paid, on the lead and on the day of the close: "collected" is the money received in the period
  // (2026-10-31), read from the lead's payments.
  const leadId = new Types.ObjectId();
  await mongoose.connection.db!.collection("leads").insertOne({ _id: leadId, name, payments: paid > 0 ? [{ amount: paid, paidAt: new Date(iso) }] : [] });
  await Student.create({
    name,
    leadId,
    enrollmentNumber: `EN-${name}`,
    enrollmentDate: new Date(iso),
    team, assignedTo: user,
    totalFee: fee, paidAmount: paid, pendingAmount: fee - paid,
  });
}

// Dubai is UTC+4. These four instants are two Dubai days.
await close("LateOn18",  "2026-09-18T19:59:00Z", 1000);       // 23:59 Dubai on the 18th
await close("JustAfter", "2026-09-18T20:01:00Z", 2000, 500);  // 00:01 Dubai on the 19th
await close("Midday19",  "2026-09-19T08:00:00Z", 3000, 3000); // 12:00 Dubai on the 19th
await close("LateOn19",  "2026-09-19T19:30:00Z", 4000);       // 23:30 Dubai on the 19th

const res = await svc.listDailyClosings({ dateFrom: "2026-09-18", dateTo: "2026-09-19" });
const byDate = new Map(res.days.map((d: { date: string }) => [d.date, d]));

console.log("\n\x1b[1mBucketing a closing into its Dubai day\x1b[0m");
const d18 = byDate.get("2026-09-18") as { count: number; totalFee: number } | undefined;
const d19 = byDate.get("2026-09-19") as { count: number; totalFee: number; paidAmount: number } | undefined;

check("23:59 Dubai stays on the 18th", d18?.count === 1, `the 18th has ${d18?.count}`);
check("00:01 Dubai counts on the 19th", d19?.count === 3, `the 19th has ${d19?.count}`);
check("...so nothing slid into the wrong day", res.days.length === 2, `${res.days.length} days`);
check("the 18th totals only its own closing", d18?.totalFee === 1000, `got ${d18?.totalFee}`);
check("the 19th totals the other three", d19?.totalFee === 9000, `got ${d19?.totalFee}`);
check("...and sums what was collected", d19?.paidAmount === 3500, `got ${d19?.paidAmount}`);

console.log("\n\x1b[1mThe range, read as local days\x1b[0m");
const only18 = await svc.listDailyClosings({ dateFrom: "2026-09-18", dateTo: "2026-09-18" });
check("asking for the 18th gets the 18th alone", only18.days.length === 1 && only18.days[0].date === "2026-09-18",
  JSON.stringify(only18.days.map((d: { date: string }) => d.date)));
check("...and not the closing 2 minutes later", only18.totals.count === 1, `got ${only18.totals.count}`);

const only19 = await svc.listDailyClosings({ dateFrom: "2026-09-19", dateTo: "2026-09-19" });
check("asking for the 19th gets all three", only19.totals.count === 3, `got ${only19.totals.count}`);

console.log("\n\x1b[1mWhat the page shows beside the days\x1b[0m");
check("newest day first", res.days[0].date === "2026-09-19", `got ${res.days[0].date}`);
check("the period totals every closing", res.totals.count === 4, `got ${res.totals.count}`);
check("...and their whole value", res.totals.totalFee === 10000, `got ${res.totals.totalFee}`);
check("the leaderboard names the closer", res.leaderboard[0]?.name === "Riya", JSON.stringify(res.leaderboard));
check("...with all four against them", res.leaderboard[0]?.count === 4, `got ${res.leaderboard[0]?.count}`);
check("a day carries its enrolments", (d19 as unknown as { enrolments: unknown[] })?.enrolments?.length === 3);
check("...naming the course and closer",
  ((d19 as unknown as { enrolments: { closedByName: string }[] }).enrolments[0].closedByName) === "Riya");

console.log("\n\x1b[1mFiltering\x1b[0m");
const otherTeam = await svc.listDailyClosings({ team: String(new Types.ObjectId()) });
check("another team sees none of it", otherTeam.totals.count === 0, `got ${otherTeam.totals.count}`);
const thisTeam = await svc.listDailyClosings({ team: String(team) });
check("this team sees all of it", thisTeam.totals.count === 4, `got ${thisTeam.totals.count}`);
const otherUser = await svc.listDailyClosings({ user: String(new Types.ObjectId()) });
check("somebody else's closings are not yours", otherUser.totals.count === 0, `got ${otherUser.totals.count}`);

await mongoose.disconnect();
console.log("");
if (failures) { console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`); process.exit(1); }
console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
