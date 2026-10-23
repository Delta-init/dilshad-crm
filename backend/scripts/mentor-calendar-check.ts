/**
 * The mentor calendar's trip to the LMS (services/mentorService.ts), against a stand-in LMS — no database, no .env:
 *
 *   Case 1  happy path   the week is asked for both academies (allAcademies=1, 2026-10-17), with this CRM's academy;
 *                        each mentor comes back with their academy, and cancelled classes come back as they are
 *   Case 2  edge         booking passes allAcademies, so a Bangalore mentor can be booked from here
 *   Case 3  errors       a window past 62 days and to before from: refused before asking the LMS
 *   Case 4  permission   the LMS refusing the secret surfaces as an error, not an empty week
 *   Case 5  time off     each mentor's time off is passed on (none from an older LMS: []), and a booking the LMS
 *                        refuses over it comes back as a 409 with the LMS's own words (2026-10-23)
 *
 *   bun --no-env-file run scripts/mentor-calendar-check.ts
 */
let checks = 0, failures = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const SECRET = "mentor-calendar-check-lms-secret";
const ORG = "6a674c5404d2749585961f20";
const seen: { path: string; query: URLSearchParams; body: any; secret: string }[] = [];
let refuse = false;
const lms = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    seen.push({ path: url.pathname, query: url.searchParams, body, secret: req.headers.get("x-portal-secret") ?? "" });
    if (refuse || req.headers.get("x-portal-secret") !== SECRET) return Response.json({ success: false, message: "Bad secret" }, { status: 401 });
    if (url.pathname === "/api/v1/service/mentors") {
      return Response.json({ success: true, data: { timezone: "Asia/Dubai", from: url.searchParams.get("from"), to: url.searchParams.get("to"), mentors: [
        { id: "m1", name: "Haffisullah Khan", email: "haff@lms.test", shared: false, academy: { id: ORG, name: "Dubai Academy" }, slots: [],
          classes: [{ id: "c1", title: "MBT 1", startsAt: new Date().toISOString(), durationMins: 60, status: "cancelled", booked: 0, capacity: 20, mine: true }],
          timeOff: [{ id: "t1", mentorId: "m1", startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), endsAt: new Date(Date.now() + 2 * 864e5 + 4 * 3600e3).toISOString(), allDay: false, reason: null, createdByName: "Haffisullah Khan" }] },
        { id: "m2", name: "Blr Mentor", email: "blr@lms.test", shared: true, academy: { id: "blr", name: "Bangalore Academy" }, slots: [], classes: [] },
      ] } });
    }
    if (url.pathname === "/api/v1/service/mentor-meetings" && body?.title === "Over time off") {
      return Response.json({ success: false, error: { code: "MENTOR_NOT_AVAILABLE", message: "Haffisullah Khan is not available then — time off Fri 24 Oct, 14:00–18:00 (Dubai time)" } }, { status: 409 });
    }
    if (url.pathname === "/api/v1/service/mentor-meetings") {
      return Response.json({ success: true, data: { meeting: { id: "mt1", title: body?.title, kind: body?.kind, startsAt: body?.scheduledStart, durationMins: 30, attendeeNames: [], bookedByEmail: body?.bookedByEmail, meetingUrl: "" }, linkNote: null } });
    }
    return Response.json({ success: false, message: "Route not found" }, { status: 404 });
  },
});

Object.assign(process.env, {
  JWT_SECRET: "mentor-calendar-check-jwt", JWT_REFRESH_SECRET: "mentor-calendar-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false",
  MONGODB_URI: "mongodb://127.0.0.1:1/mentor-calendar-check-unused",
  LMS_API_URL: `http://127.0.0.1:${lms.port}`, LMS_SERVICE_SECRET: SECRET, LMS_REMOTE_ORG_ID: ORG,
});
const web = await import("web-push").catch(() => null);
if (web) { const v = web.default.generateVAPIDKeys(); Object.assign(process.env, { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey }); }
const { mentorService } = await import("../src/services/mentorService.js");

try {
  console.log("\nCase 1 — the week, both academies");
  const week = await mentorService.schedule({ from: new Date().toISOString() });
  const ask = seen.at(-1)!;
  check("asked the LMS's /mentors with this CRM's secret and academy", ask.path === "/api/v1/service/mentors" && ask.secret === SECRET && ask.query.get("remoteOrgId") === ORG);
  check("…for both academies (allAcademies=1)", ask.query.get("allAcademies") === "1", ask.query.toString());
  check("each mentor comes back with their academy", week.mentors.map((m: any) => m.academy?.name).join() === "Dubai Academy,Bangalore Academy", JSON.stringify(week.mentors.map((m: any) => m.academy)));
  check("a cancelled class is passed on, not dropped", week.mentors[0]?.classes[0]?.status === "cancelled");

  console.log("\nCase 2 — booking another academy's mentor");
  await mentorService.scheduleMeeting({ mentorEmail: "blr@lms.test", title: "Intro call", kind: "client", scheduledStart: new Date(Date.now() + 864e5).toISOString(),
    durationMins: 30, attendees: [{ name: "A client" }], bookedByEmail: "rep@crm.test" });
  const book = seen.at(-1)!;
  check("booking passes allAcademies, with the rest as given", book.path === "/api/v1/service/mentor-meetings" && book.body?.allAcademies === true && book.body?.mentorEmail === "blr@lms.test", JSON.stringify(book.body));

  console.log("\nCase 3 — refused before asking");
  const before = seen.length;
  const err = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e);
  const tooLong = await err(mentorService.schedule({ from: new Date().toISOString(), to: new Date(Date.now() + 70 * 864e5).toISOString() }));
  const backwards = await err(mentorService.schedule({ from: new Date().toISOString(), to: new Date(Date.now() - 864e5).toISOString() }));
  check("over 62 days, and to before from: 400, the LMS not asked", tooLong?.statusCode === 400 && backwards?.statusCode === 400 && seen.length === before);

  console.log("\nCase 4 — the LMS refusing");
  refuse = true;
  const refused = await err(mentorService.schedule({ from: new Date().toISOString() }));
  check("an error, not an empty week", !!refused && !!refused.message, String(refused));

  console.log("\nCase 5 — time off");
  refuse = false;
  const again = await mentorService.schedule({ from: new Date().toISOString() });
  check("a mentor's time off is passed on", (again.mentors[0] as any)?.timeOff?.[0]?.id === "t1" && (again.mentors[0] as any).timeOff[0].allDay === false, JSON.stringify((again.mentors[0] as any)?.timeOff));
  check("…and none from an LMS that sends none: []", Array.isArray((again.mentors[1] as any)?.timeOff) && (again.mentors[1] as any).timeOff.length === 0);
  const over = await err(mentorService.scheduleMeeting({ mentorEmail: "haff@lms.test", title: "Over time off", kind: "client", scheduledStart: new Date(Date.now() + 2 * 864e5 + 3600e3).toISOString(),
    durationMins: 30, attendees: [{ name: "A client" }], bookedByEmail: "rep@crm.test" }));
  check("a booking refused over it: 409 with the LMS's words", over?.statusCode === 409 && /not available then/.test(String(over?.message)), `${over?.statusCode} ${over?.message}`);
} finally {
  lms.stop(true);
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
