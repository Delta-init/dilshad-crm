/**
 * The leaderboard a salesperson sees (the user, 2026-10-28: "when a BDE looks, exclude the team leaders and the sales
 * manager"):
 *   Case 1  happy path   a salesperson: no team leaders, no Sales Manager, ranked 1, 2, 3… again
 *   Case 2  edge         a team leader, the Sales Manager and a Super Admin see the whole board; a leader of a switched-off
 *                        team counts as a salesperson again (shown to everyone)
 *   Case 3  errors       a month that isn't one: 400
 *   Case 4  permission   no session 401; a role without the Leaderboard box 403
 *
 * Run by leaderboard-viewer-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "leaderboard-viewer-check-jwt-0123456789", JWT_REFRESH_SECRET: "leaderboard-viewer-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("not a local database");
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");

const admin = new Types.ObjectId(), bde = new Types.ObjectId(), none = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: bde, roleName: "BDE", isSystemRole: false, permissions: { leaderboard: { view: true } } },
  { _id: none, roleName: "No board", isSystemRole: false, permissions: { leaderboard: { view: false } } },
]);
const P: Record<string, Types.ObjectId> = {};
const people: Array<[string, Types.ObjectId]> = [["Root", admin], ["Sam Manager", bde], ["Tara Lead", bde], ["Ann", bde], ["Ben", bde], ["Old Lead", bde], ["Nora", none]];
for (const [name, role] of people) {
  P[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: P[name], name, email: `${name.split(" ")[0].toLowerCase()}@test.local`, password: "x", role, status: "active" });
}
await db.collection("teams").insertMany([
  { _id: new Types.ObjectId(), name: "Falcons", status: "active", leaders: [P["Tara Lead"]], members: [P.Ann, P.Ben], settings: {} },
  { _id: new Types.ObjectId(), name: "Old team", status: "inactive", leaders: [P["Old Lead"]], members: [], settings: {} },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: P["Sam Manager"], excludedUsers: [] });

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const tokenOf = (name: string) => signAccessToken({ userId: String(P[name]), email: `${name.split(" ")[0].toLowerCase()}@test.local`, roleId: String(people.find(([n]) => n === name)![1]) });
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function board(name: string | null, query = "") {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/leaderboard${query}`, { headers: name ? { authorization: `Bearer ${tokenOf(name)}` } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
const names = (b: Json) => ((b.data?.rows ?? []) as Json[]).map((r) => r.name).sort();
const ranks = (b: Json) => ((b.data?.rows ?? []) as Json[]).map((r) => r.rank);

section("Case 1 — a salesperson");
{
  const r = await board("Ann");
  check("no team leader, no Sales Manager — Ann, Ben, Nora and Old Lead (whose team is switched off)", r.status === 200
    && JSON.stringify(names(r.body)) === JSON.stringify(["Ann", "Ben", "Nora", "Old Lead"]), names(r.body));
  check("ranked 1, 2, 3, 4 again", JSON.stringify(ranks(r.body)) === JSON.stringify([1, 2, 3, 4]), ranks(r.body));
  const calls = await board("Ann", "?rankBy=calls");
  check("…ranked by calls too", calls.status === 200 && !names(calls.body).includes("Tara Lead") && !names(calls.body).includes("Sam Manager"), names(calls.body));
}

section("Case 2 — who still sees the whole board");
for (const who of ["Tara Lead", "Sam Manager", "Root"]) {
  const r = await board(who);
  check(`${who}: every salesperson, the leader and the Sales Manager included`, r.status === 200
    && ["Ann", "Ben", "Old Lead", "Sam Manager", "Tara Lead"].every((n) => names(r.body).includes(n)), names(r.body));
}
check("the Super Admin is still not on the board itself", !names((await board("Root")).body).includes("Root"));

section("Case 3 — errors");
check("a month that isn't one: 400", (await board("Ann", "?month=2026-13")).status === 400);

section("Case 4 — permission");
check("no session: 401", (await board(null)).status === 401);
check("a role without the Leaderboard box: 403", (await board("Nora")).status === 403);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
