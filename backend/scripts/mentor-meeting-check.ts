/**
 * The mentor's meeting on a close (the user, 2026-11-18: "in the close form it shows meeting done by, and which
 * meeting"; the mentor earns commission, taken off the salesperson, TL and Sales Manager) — against a scratch
 * database, a stand-in LMS (its mentor schedule) and a stand-in Root (its commission routes):
 *   1. the held meetings a close offers: the closer's (and the lead's owner's) meetings with a mentor that have taken
 *      place — not upcoming, not staff, not somebody else's — the client's first;
 *   2. the close's answer checked: None; a held meeting (its mentor and day from the LMS); one not held, unknown, or
 *      already on another close refused; the LMS down: kept as sent, unchecked;
 *   3. a close saved with it;
 *   4. Root asked with the meeting: a counted sale's lines and the mentor's fee from Root kept; a held sale settled at
 *      its amounts with its course and meeting; the close form's preview with the mentor picked.
 * Run: scripts/mentor-meeting-check.sh (scratch mongod; nothing reads a .env).
 */
import http from "node:http";
import { Types } from "mongoose";

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
const section = (s: string) => console.log(`\n${s}`);
const j = (v: unknown) => String(JSON.stringify(v) ?? "undefined").slice(0, 500);
async function fails(p: Promise<unknown>): Promise<{ message: string; statusCode?: number } | null> {
  try { await p; return null; } catch (e) { return e as { message: string; statusCode?: number }; }
}
const serve = (handler: (url: URL, body: any, req: http.IncomingMessage) => [number, unknown]) => {
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const [code, b] = handler(new URL(req.url ?? "/", "http://x"), raw ? JSON.parse(raw) : null, req);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    });
  });
  return new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
};

/* ── The stand-in LMS: GET /api/v1/service/mentors — the mentor schedule (cancelled meetings are left out there) ── */
const H = 3_600_000, NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
let lmsDown = false;
const lmsAsked: Array<Record<string, string>> = [];
const meeting = (id: string, kind: string, at: number, attendee: string, by: string, title = `Meeting ${id}`) =>
  ({ id, title, kind, category: "", course: "", startsAt: iso(at), durationMins: 45, attendeeNames: [attendee], bookedByEmail: by });
const MENTORS = [
  {
    id: "anna", name: "Anna Mentor", email: "Anna@Mentors.e2e", shared: false, classes: [], timeOff: [],
    meetings: [
      meeting("mt-held", "client", NOW - 26 * H, "Rahul Kumar", "ria@e2e.test", "Pitch with Rahul"),
      meeting("mt-other", "student", NOW - 50 * H, "Someone Else", "ria@e2e.test"),
      meeting("mt-future", "client", NOW + 5 * H, "Rahul Kumar", "ria@e2e.test"),
      meeting("mt-staff", "staff", NOW - 30 * H, "Team", "ria@e2e.test"),
      meeting("mt-not-mine", "client", NOW - 20 * H, "Rahul Kumar", "zed@e2e.test"),
    ],
  },
  { id: "bo", name: "Bo Mentor", email: "bo@mentors.e2e", shared: false, classes: [], timeOff: [], meetings: [meeting("mt-owner", "client", NOW - 10 * H, "rahul k", "lena@e2e.test")] },
];
const LMS_URL = await serve((url, _b, req) => {
  if (lmsDown) return [503, { success: false, message: "Down" }];
  if (req.headers["x-portal-secret"] !== "lms-e2e-secret") return [401, { success: false, message: "Bad secret" }];
  if (url.pathname !== "/api/v1/service/mentors") return [404, { success: false, message: "Route not found" }];
  lmsAsked.push(Object.fromEntries(url.searchParams));
  return [200, { success: true, message: "Mentors", data: { timezone: "Asia/Dubai", from: url.searchParams.get("from"), to: url.searchParams.get("to"), mentors: MENTORS } }];
});

/* ── The stand-in Root: /api/v1/service/commission/{plan,resolve} ── */
const rootAsked: any[] = [];
let ids: Record<string, Types.ObjectId> = {};
const ROOT_URL = await serve((url, body, req) => {
  if (req.headers["x-org-secret"] !== "root-e2e-secret") return [401, { success: false, message: "Invalid service credential" }];
  const which = url.pathname.replace("/api/v1/service/commission/", "");
  if (which === "plan") {
    return [200, { success: true, message: "ok", data: {
      portal: "remote", tlRule: "zero_if_sm", tlSlab: true, tlPaidOnOwnClose: true, salesManager: { id: String(ids.Sam), name: "Sam" }, excluded: [],
      courses: [], month: "2026-11", slabsFrom: "2000-01",
      slabs: { sales: [{ name: "Base", target: 0, salary: 2000, percent: 0 }], tl: [{ name: "Base", target: 0, salary: 4000, percent: 50 }], sm: [{ name: "Base", target: 0, salary: 5000, percent: 50 }] },
    } }];
  }
  if (which !== "resolve") return [404, { success: false, message: "Route not found" }];
  rootAsked.push(body);
  const a = body.amounts ?? { sales: 230, tl: 85, sm: 100, creditUsd: 500 };
  const m = body.meeting;
  const ln = (role: string, who: string, amount: number, cut: number) => ({ role, user: String(ids[who]), userName: who, amount: amount - (m ? cut : 0), ...(m ? { mentorCut: cut, note: `Mentor's meeting −AED ${cut}` } : {}) });
  return [200, { success: true, message: "ok", data: {
    state: "counted", reason: "", team: String(ids.TEAM), teamName: "Gladiators", plan: { creditUsd: 0, ...a },
    lines: [ln("sales", "Ria", a.sales, 25), ln("tl", "Lena", a.tl, 5), ln("sm", "Sam", a.sm, 5)],
    ...(m ? { mentor: { email: m.mentorEmail, name: m.mentorName ?? "", meetingId: m.meetingId ?? "", at: m.at ?? "", amount: 35, plan: { mentor: 35, sales: 25, tl: 5, sm: 5 } } } : {}),
  } }];
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "mentor-meeting-check-jwt-0123456789", JWT_REFRESH_SECRET: "mentor-meeting-check-refresh-0123456789", NODE_ENV: "test", RUN_SCHEDULERS: "false",
  FINANCE_API_URL: "", FINANCE_CLIENT_ID: "", FINANCE_INTEGRATION_SECRET: "", FINANCE_ORG_ID: "", FINANCE_ORG_ID_BANGALORE: "",
  LMS_API_URL: LMS_URL, LMS_SERVICE_SECRET: "lms-e2e-secret", LMS_REMOTE_ORG_ID: String(new Types.ObjectId()),
  COMMISSION_FROM_ROOT: "on", ROOT_ERP_API_URL: `${ROOT_URL}/`, ROOT_ORG_SECRET: "root-e2e-secret",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1" && mongoose.connection.host !== "localhost") { console.error("Refusing: not local"); process.exit(1); }
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const role = { _id: new Types.ObjectId(), roleName: "Super Admin", isSystemRole: true };
await db.collection("roles").insertOne({ ...role, permissions: {} });
ids = {};
for (const name of ["Sam", "Lena", "Ria"]) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@e2e.test`, role: role._id, status: "active" });
}
ids.TEAM = new Types.ObjectId();
await db.collection("teams").insertOne({ _id: ids.TEAM, name: "Gladiators", status: "active", leaders: [ids.Lena], members: [ids.Ria] });
const MBT = new Types.ObjectId();
await db.collection("courses").insertOne({ _id: MBT, name: "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", amount: 2250, status: "active", commission: { sales: 230, tl: 85, sm: 100, creditUsd: 500 } });
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: ids.Sam, excludedUsers: [] });

const { mentorService, isClientMeeting } = await import("../src/services/mentorService.js");
const { StudentService } = await import("../src/services/studentService.js");
const commission = await import("../src/services/commissionService.js");
await import("../src/models/Team.js"); await import("../src/models/Course.js"); await import("../src/models/User.js"); await import("../src/models/Lead.js");
const svc = new StudentService();

section("1. The held meetings a close offers");
let held = await mentorService.heldMeetings({ bookers: ["Ria@e2e.test"], clientName: "Rahul Kumar" });
check("the closer's meetings with a mentor that have taken place: the client's first, then the newest — not upcoming, staff or somebody else's",
  held.map((m) => m.id).join(",") === "mt-held,mt-other" && held[0]!.client && !held[1]!.client, j(held.map((m) => [m.id, m.client])));
check("…each with its mentor (the email as the LMS has it, lower case)", held[0]!.mentor.email === "anna@mentors.e2e" && held[0]!.mentor.name === "Anna Mentor", j(held[0]));
check("…asked of the LMS for the last 60 days to now", lmsAsked.length > 0 && Math.abs(Date.parse(lmsAsked.at(-1)!.to!) - Date.now()) < 60_000
  && Math.round((Date.parse(lmsAsked.at(-1)!.to!) - Date.parse(lmsAsked.at(-1)!.from!)) / 86_400_000) === 60, j(lmsAsked.at(-1)));
held = await mentorService.heldMeetings({ bookers: ["ria@e2e.test", "lena@e2e.test"], clientName: "Rahul Kumar" });
check("with the lead's owner too: their meeting with the client is offered", held.map((m) => m.id).join(",") === "mt-owner,mt-held,mt-other", j(held.map((m) => m.id)));
check("whose meeting it was: a name that holds the other, letters only", isClientMeeting(["RAHUL  KUMAR."], "Rahul Kumar") && isClientMeeting(["rahul k"], "Rahul Kumar")
  && !isClientMeeting(["Someone Else"], "Rahul Kumar") && !isClientMeeting(["Al"], "Al"));
check("nobody to ask about: none", (await mentorService.heldMeetings({ bookers: [""], clientName: "x" })).length === 0);

section("2. The close's answer, checked");
const who = { performedBy: String(ids.Ria), assignedTo: String(ids.Ria), clientName: "Rahul Kumar" };
check("None: kept as none", JSON.stringify(await svc.closeMeeting({ none: true }, who)) === JSON.stringify({ none: true }));
check("no answer (a form from before it): nothing", (await svc.closeMeeting(undefined, who)) === undefined);
const kept = await svc.closeMeeting({ meetingId: "mt-held", mentorEmail: "forged@x.test" }, who);
check("a held meeting: its mentor and day from the LMS, not the form — checked", kept?.mentorEmail === "anna@mentors.e2e" && kept.mentorName === "Anna Mentor"
  && kept.meetingId === "mt-held" && kept.checked === true && kept.at instanceof Date && kept.title === "Pitch with Rahul", j(kept));
let f = await fails(svc.closeMeeting({ meetingId: "mt-future" }, who));
check("an upcoming meeting: refused", f?.statusCode === 422 && /held meetings/.test(f.message), j(f));
f = await fails(svc.closeMeeting({ meetingId: "mt-not-mine" }, who));
check("somebody else's: refused", f?.statusCode === 422, j(f));
f = await fails(svc.closeMeeting({}, who));
check("neither None nor a meeting: refused", f?.statusCode === 422 && /None/.test(f.message), j(f));
const owner = await svc.closeMeeting({ meetingId: "mt-owner" }, { performedBy: String(ids.Ria), assignedTo: String(ids.Lena), clientName: "Rahul Kumar" });
check("the lead's owner's meeting, when somebody else closes it: taken", owner?.mentorEmail === "bo@mentors.e2e" && owner.checked === true, j(owner));
lmsDown = true;
const unchecked = await svc.closeMeeting({ meetingId: "mt-held", mentorEmail: "Anna@Mentors.e2e", mentorName: "Anna Mentor", at: iso(NOW - 26 * H) }, who);
check("the LMS down: kept as the form sent it, marked unchecked", unchecked?.checked === false && unchecked.mentorEmail === "anna@mentors.e2e" && unchecked.meetingId === "mt-held", j(unchecked));
f = await fails(svc.closeMeeting({ meetingId: "mt-held" }, who));
check("…but not without the mentor: 503, try again", f?.statusCode === 503, j(f));
lmsDown = false;

section("3. A close saved with it");
const receipt = { name: "r.jpg", url: "https://files.example.com/enrolment-receipts/l1/r.jpg", key: "enrolment-receipts/l1/r.jpg", size: 1, mimeType: "image/jpeg" };
const lead = new Types.ObjectId();
await db.collection("leads").insertOne({ _id: lead, name: "Rahul Kumar", phone: "+971500000001", assignedTo: ids.Ria, status: "assigned" });
const closeWith = (mentorMeeting: unknown, email: string, leadId = String(lead)) => svc.createStudent({
  leadId, name: "Rahul Kumar", email, language: "Malayalam", paymentMethod: "tabby", paymentReceipt: receipt,
  totalFee: 2250, paidAmount: 2250, hasBonus: false, course: String(MBT), team: String(ids.TEAM), assignedTo: String(ids.Ria), mentorMeeting,
} as never, String(ids.Ria));
await closeWith({ meetingId: "mt-held" }, "rahul.kumar@example.com");
const saved = await db.collection("students").findOne({ $or: [{ leadId: lead }, { leadId: String(lead) }] });
check("the student keeps who held it", saved?.mentorMeeting?.mentorEmail === "anna@mentors.e2e" && saved.mentorMeeting.meetingId === "mt-held" && saved.mentorMeeting.checked === true, j(saved?.mentorMeeting));
f = await fails(closeWith({ meetingId: "mt-held" }, "second.client@example.com", String(new Types.ObjectId())));
check("the same meeting on another close: refused — one meeting, one sale", f?.statusCode === 409 && /one meeting, one sale/.test(f.message), j(f));
await closeWith({ none: true }, "third.client@example.com", String(new Types.ObjectId()));
check("None saved as none", (await db.collection("students").findOne({ email: "third.client@example.com" }))?.mentorMeeting?.none === true);
await closeWith(undefined, "fourth.client@example.com", String(new Types.ObjectId()));
check("a form from before it: saved without one", !(await db.collection("students").findOne({ email: "fourth.client@example.com" }))?.mentorMeeting);

section("4. Root asked with the meeting");
const config = await commission.loadConfig();
const plan = commission.planOf({ commission: { sales: 230, tl: 85, sm: 100 } });
let r = await commission.resolveSale({ closer: ids.Ria, saleTeam: ids.TEAM, plan, course: MBT, meeting: saved!.mentorMeeting }, config);
let asked = rootAsked.at(-1);
check("Root is asked with the meeting: the mentor, the meeting and its day", asked.meeting?.mentorEmail === "anna@mentors.e2e" && asked.meeting.mentorName === "Anna Mentor"
  && asked.meeting.meetingId === "mt-held" && Boolean(asked.meeting.at) && asked.course === String(MBT) && !asked.amounts, j(asked));
check("…Root's lines kept with what came off each, and the mentor's fee", r.lines.map((l) => `${l.role}:${l.amount}:${l.mentorCut}`).join(" ") === "sales:205:25 tl:80:5 sm:95:5"
  && r.mentor?.amount === 35 && r.mentor.email === "anna@mentors.e2e", j(r));
r = await commission.resolveSale({ closer: ids.Ria, saleTeam: ids.TEAM, plan, course: MBT, meeting: { none: true } }, config);
check("None: Root is asked with no meeting, nothing comes off", !rootAsked.at(-1).meeting && !r.mentor && r.lines[0]!.amount === 230, j(rootAsked.at(-1)));
r = await commission.resolveSale({ closer: ids.Ria, saleTeam: ids.TEAM, plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0 }, course: MBT, held: true, meeting: saved!.mentorMeeting }, config);
asked = rootAsked.at(-1);
check("a held sale: at the amounts it was held at, with its course and meeting for the fee", asked.amounts?.sales === 200 && asked.course === String(MBT) && asked.meeting?.mentorEmail === "anna@mentors.e2e"
  && r.lines[0]!.amount === 175, j(asked));
r = await commission.resolveSale({ closer: ids.Ria, saleTeam: ids.TEAM, plan: { sales: 200, tl: 70, sm: 90, creditUsd: 0 } }, config);
check("…one with no course (as before): at its amounts, no meeting", rootAsked.at(-1).amounts?.sales === 200 && !rootAsked.at(-1).course && !rootAsked.at(-1).meeting, j(rootAsked.at(-1)));
check("meetingInput: none, no answer, or no mentor — nothing; a mentor — the email lower case", commission.meetingInput({ none: true }) === null && commission.meetingInput(null) === null
  && commission.meetingInput({ meetingId: "x" }) === null && commission.meetingInput({ mentorEmail: " A@B.test ", meetingId: "x" })?.mentorEmail === "a@b.test");
const viewer = { userId: String(ids.Ria), role } as never;
const pv = await new commission.CommissionService().preview({ course: String(MBT), team: String(ids.TEAM), closer: String(ids.Ria), mentor: "anna@mentors.e2e" }, viewer);
check("the close form's preview with the mentor picked: the fee off the lines, the mentor's 35", pv.mentorFee === 35 && rootAsked.at(-1).meeting?.mentorEmail === "anna@mentors.e2e"
  && pv.lines.some((l: { mentorCut: number }) => l.mentorCut === 25), j(pv));
const pv2 = await new commission.CommissionService().preview({ course: String(MBT), team: String(ids.TEAM), closer: String(ids.Ria) }, viewer);
check("…none picked: as before", pv2.mentorFee === 0 && !rootAsked.at(-1).meeting, j(pv2));

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
