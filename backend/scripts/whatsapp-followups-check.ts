/**
 * Checks the automatic WhatsApp follow-ups (services/whatsapp/followups.ts; the user, 2026-10-27: "this type of
 * follow-up we need in our CRMs, first the Sales CRM"), on a scratch database, through the API and the job, with a
 * stand-in for WhatsApp:
 *
 *   - Case 1: settings — a Super Admin's only; checked; switching on stamps when.
 *   - Case 2: a quiet chat — step 1 once it is due, with {name}/{salesperson}; marked, logged on the lead; then step 2.
 *   - Case 3: it stops — they answer; a person writes again (starts over); Stop on the lead; Closed; the last step.
 *   - Case 4: only where it should — the lead's own salesperson, a team switched on, linked, written in after it was
 *     switched on, inside the working hours.
 *   - Case 5: gently — one per person a run, the daily limit, a number not on WhatsApp tried again only later.
 *   - Case 6: a step with a file — sent with it, the file kept once.
 *   - Case 7: what people see — the lead card, the chat marks, the recent list.
 *
 * Run by whatsapp-followups-check.sh. Scratch database only.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
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
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), "wa-followups-"));
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "wa-followups-check-jwt", JWT_REFRESH_SECRET: "wa-followups-check-refresh", NODE_ENV: "test",
  RUN_SCHEDULERS: "false", WHATSAPP_MEDIA_DIR: MEDIA, WHATSAPP_SESSION_DIR: path.join(MEDIA, "sessions"),
  R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");
const wa = await import("../src/services/whatsapp/service.js");
const F = await import("../src/services/whatsapp/followups.js");

/* ── People: Titans (Lina leads Sam and Sally) is switched on; Omar's Others team isn't ── */
const perms = { leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false },
  whatsapp: { view: true, create: true, edit: false, delete: false, approve: false, export: false } };
const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: perms },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Root", superRole], ["Lina", salesRole], ["Sam", salesRole], ["Sally", salesRole], ["Omar", salesRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name: name === "Sam" ? "Sam Varghese" : name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const P = (n: string) => people[n]!.id;
const titans = new Types.ObjectId(), others = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: titans, name: "Titans", status: "active", leaders: [P("Lina")], members: [P("Sam"), P("Sally")] },
  { _id: others, name: "Others", status: "active", leaders: [], members: [P("Omar")] },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: null, excludedUsers: [] });
// The working hours are the CRM's defaults: Mon–Sat 10:00–19:00, Dubai.

let n = 0;
const lead = async (name: string, phone: string, owner: string, team: Types.ObjectId, status = "assigned") => {
  const id = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: id, name, phone, assignedTo: P(owner), team, reporter: P(owner), status, activityLogs: [], createdAt: new Date(), updatedAt: new Date() });
  wa.forgetLeads();
  return id;
};
/** A message in a chat, kept as the CRM keeps them (key = the last 9 digits). */
const msg = (owner: string, phone: string, direction: "in" | "out", at: Date, extra: Record<string, unknown> = {}) =>
  db.collection("whatsapp_messages").insertOne({
    owner: P(owner), ownerName: owner, chat: phone, phone, key: phone.slice(-9), jid: `${phone}@s.whatsapp.net`, direction,
    body: direction === "out" ? "Hello from Delta" : "Hi", messageId: `M-${++n}`, senderName: "", sentBy: direction === "out" ? P(owner) : null,
    sentByName: "", lead: null, read: true, media: null, auto: null, at, createdAt: at, ...extra,
  });

/* ── A stand-in WhatsApp for each person ── */
type Sent = { jid: string; content: Record<string, unknown> };
const outbox: Record<string, Sent[]> = {};
function link(name: string) {
  outbox[name] = [];
  let k = 0;
  wa.attachSocketForCheck(String(P(name)), {
    sendMessage: async (jid: string, content: Record<string, unknown>) => { outbox[name]!.push({ jid, content }); return { key: { id: `SENT-${name}-${++k}-${Date.now()}` } }; },
    onWhatsApp: async (phone: string) => [{ exists: !phone.endsWith("0000"), jid: `${phone}@s.whatsapp.net` }],
    updateMediaMessage: async () => undefined,
    user: { id: "971500000001:1@s.whatsapp.net" },
  } as never, "971500000001");
}

/* ── The API ── */
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const token = (name: string) => signAccessToken({ userId: String(people[name]!.id), email: `${name.toLowerCase()}@test.local`, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: any; message?: string } };
async function call(method: string, p: string, who: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token(who)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}

/** The first working moment (Mon–Sat 10:00–19:00 Dubai) at or after `t`. */
function work(t: number): Date {
  for (let x = Math.ceil(t / 60_000) * 60_000; ; x += 15 * 60_000) {
    const d = new Date(x + 4 * 3600_000);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (d.getUTCDay() !== 0 && mins >= 600 && mins < 1140) return new Date(x);
  }
}
const H = 3600_000, D = 24 * H;
const run = async (at: Date) => { F.resetFollowupPacingForCheck(); return F.runFollowups(at); };
const autos = async (owner: string, phone: string) => (await db.collection("whatsapp_messages").find({ owner: P(owner), key: phone.slice(-9), "auto.kind": "followup" }).sort({ at: 1 }).toArray()) as any[];
const textOf = (s: Sent | undefined) => String(s?.content?.text ?? s?.content?.caption ?? "");

try {
  section("Case 1 — settings");
  let r = await call("GET", "/whatsapp/followups/settings", "Sam");
  check("a salesperson can't open them", r.status === 403);
  r = await call("GET", "/whatsapp/followups/settings", "Root");
  check("a Super Admin: off, the five default steps (4h, 1d, 3d, 7d, 14d), every team to pick", r.status === 200 && r.body.data.enabled === false
    && j(r.body.data.steps.map((s: any) => s.waitMinutes)) === j([240, 1440, 4320, 10080, 20160]) && r.body.data.allTeams.length === 2, j(r.body.data));
  const steps = r.body.data.steps;
  r = await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps: [{ waitMinutes: 10, text: "x" }] });
  check("a step 10 minutes after: refused", r.status === 400 && /30 minutes/.test(r.body.message ?? ""), j(r.body));
  r = await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps: [{ waitMinutes: 60, text: "  " }] });
  check("a step with no words: refused", r.status === 400 && /write its message/.test(r.body.message ?? ""));
  r = await call("PUT", "/whatsapp/followups/settings", "Sam", { enabled: true, teams: [], steps });
  check("a salesperson can't save them", r.status === 403);
  r = await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps });
  check("switched on for Titans: when is stamped", r.status === 200 && r.body.data.enabled === true && r.body.data.startedAt && j(r.body.data.teams) === j([String(titans)]) && r.body.data.updatedByName === "Root", j(r.body.data));
  const started = new Date(r.body.data.startedAt);
  r = await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps });
  check("saved again while on: the time it was switched on stays", new Date(r.body.data.startedAt).getTime() === started.getTime());
  // The chats below were written in after it was switched on: move that back a week, as if it had been on a while.
  await db.collection("whatsapp_followup_settings").updateOne({ key: "default" }, { $set: { startedAt: new Date(Date.now() - 7 * D) } });

  section("Case 2 — a quiet chat");
  link("Sam");
  const asha = await lead("Asha Thomas", "+971 50 123 4567", "Sam", titans);
  await msg("Sam", "971501234567", "in", new Date(Date.now() - 6 * H));
  await msg("Sam", "971501234567", "out", new Date(Date.now() - 5 * H));   // Sam answered 5 hours ago; nothing since
  let t = work(Date.now());
  let res = await run(t);
  let sent = outbox.Sam!;
  check("step 1 is sent (4 hours after Sam's message)", res.sent === 1 && sent.length === 1 && sent[0]!.jid === "971501234567@s.whatsapp.net", j(res));
  check("…its words, with her first name and his", textOf(sent[0]) === "Hi Asha, just checking you saw my message. Happy to answer any questions about the course. — Sam", textOf(sent[0]));
  let a = await autos("Sam", "971501234567");
  check("…kept in the chat, marked step 1 of 5, as an automatic follow-up", a.length === 1 && a[0].auto.step === 1 && a[0].auto.of === 5 && a[0].sentByName === "Auto follow-up", j(a));
  const logged = (await db.collection("leads").findOne({ _id: asha }))!.activityLogs as any[];
  check("…and logged on the lead", logged.some((l) => l.action === "whatsapp_followup" && /follow-up 1 of 5/.test(l.description)), j(logged));
  res = await run(work(t.getTime() + 2 * H));
  check("two hours on: nothing (step 2 waits a day after step 1)", res.sent === 0 && outbox.Sam!.length === 1, j(res));
  res = await run(work(Date.now() + D + 5 * 60_000));
  check("a day on: step 2", res.sent === 1 && outbox.Sam!.length === 2 && /quick call/.test(textOf(outbox.Sam![1])), textOf(outbox.Sam![1]));

  section("Case 3 — it stops");
  const tick = () => new Promise((ok) => setTimeout(ok, 1100));   // WhatsApp times are whole seconds
  await tick();
  await wa.receive({ id: String(P("Sam")), name: "Sam Varghese" }, outbox as never, {
    key: { remoteJid: "971501234567@s.whatsapp.net", fromMe: false, id: "REPLY-1" }, message: { conversation: "Sorry, busy — call me Friday" },
    messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Asha",
  } as never);
  await tick();
  res = await run(work(Date.now() + 10 * D));
  check("she answers: nothing more, however long", res.sent === 0 && outbox.Sam!.length === 2, j(res));
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971501234567", text: "Sure, I'll call Friday" });
  res = await run(work(Date.now() + 5 * H));
  check("Sam writes again and she goes quiet: it starts over at step 1", r.status === 200 && res.sent === 1 && outbox.Sam!.length === 4 && /just checking/.test(textOf(outbox.Sam![3])), j({ r: r.status, res, last: textOf(outbox.Sam![3]) }));
  r = await call("POST", `/whatsapp/followups/lead/${asha}/stop`, "Omar");
  check("Omar (another team) can't stop it on her", r.status === 403);
  r = await call("POST", `/whatsapp/followups/lead/${asha}/stop`, "Lina");
  check("her team leader stops it: the card says so, and who", r.status === 200 && r.body.data.followup.state === "stopped" && r.body.data.followup.byName === "Lina", j(r.body.data));
  res = await run(work(Date.now() + 3 * D));
  check("…nothing is sent while stopped", res.sent === 0 && outbox.Sam!.length === 4);
  r = await call("POST", `/whatsapp/followups/lead/${asha}/resume`, "Sam");
  res = await run(work(Date.now() + 3 * D));
  check("resumed: it goes on from where it was (step 2)", r.status === 200 && res.sent === 1 && /quick call/.test(textOf(outbox.Sam![4])), textOf(outbox.Sam![4]));
  await db.collection("leads").updateOne({ _id: asha }, { $set: { status: "closed" } });
  res = await run(work(Date.now() + 10 * D));
  check("she's Closed: no more", res.sent === 0);
  await db.collection("leads").updateOne({ _id: asha }, { $set: { status: "followup" } });
  // Each step after the one before (the stand-in keeps them at the real time): 3 days, 7 days, 14 days — then nothing.
  for (const days of [4, 8, 15, 30]) await run(work(Date.now() + days * D));
  a = await autos("Sam", "971501234567");
  const last = a.slice(-3).map((m) => m.auto.step);
  check("left alone: on to step 5, the last — and then nothing", j(last) === j([3, 4, 5]) && /last follow-up/.test(String(a.at(-1).body)), j(a.map((m) => m.auto.step)));
  r = await call("GET", `/whatsapp/lead/${asha}`, "Sam");
  check("…the card: all sent", r.body.data?.followup?.state === "done" && r.body.data.followup.sent === 5, j(r.body.data?.followup));

  section("Case 4 — only where it should");
  link("Sally"); link("Omar"); link("Lina");
  const before = { Sally: 0, Omar: 0, Lina: 0 };
  const omarLead = await lead("Bilal Khan", "0559876543", "Omar", others);
  await msg("Omar", "971559876543", "out", new Date(Date.now() - 5 * H));
  const samLead = await lead("Chen Li", "+971 52 111 2222", "Sam", titans);
  await msg("Lina", "971521112222", "out", new Date(Date.now() - 5 * H));        // Lina wrote to Sam's lead from her WhatsApp
  const old = await lead("Dana Old", "+971 52 333 4444", "Sally", titans);
  await msg("Sally", "971523334444", "out", new Date(Date.now() - 9 * D));        // before it was switched on
  const lost = await lead("Eve Lost", "+971 52 555 6666", "Sally", titans, "lost");
  await msg("Sally", "971525556666", "out", new Date(Date.now() - 5 * H));
  const unknown = "971527778888";
  await msg("Sally", unknown, "out", new Date(Date.now() - 5 * H));               // a number no lead has
  res = await run(work(Date.now() + 5 * 60_000));
  check("nothing goes: another team's lead, a chat on someone else's WhatsApp, before it was on, Lost, no lead",
    res.sent === 0 && outbox.Sally!.length === before.Sally && outbox.Omar!.length === before.Omar && outbox.Lina!.length === before.Lina, j({ res, s: outbox.Sally!.length, o: outbox.Omar!.length, l: outbox.Lina!.length }));
  void omarLead; void samLead; void old; void lost;
  const fay = await lead("Fay Quiet", "+971 52 999 1111", "Sally", titans);
  await msg("Sally", "971529991111", "out", new Date(Date.now() - 5 * H));
  wa.attachSocketForCheck(String(P("Sally")), null);
  res = await run(work(Date.now() + 5 * 60_000));
  check("Sally's WhatsApp not linked: nothing for her lead", res.sent === 0);
  link("Sally");
  // A Sunday, after it's due.
  let sunday = new Date(Date.now() + 5 * 60_000);
  while (new Date(sunday.getTime() + 4 * H).getUTCDay() !== 0) sunday = new Date(sunday.getTime() + H);
  res = await run(new Date(sunday.getTime() - (sunday.getTime() + 4 * H) % D + 12 * H));
  check("a Sunday: outside the working hours — nothing", res.sent === 0 && res.skipped === "outside working hours", j(res));
  res = await run(work(Date.now() + 5 * 60_000));
  check("linked again, in working hours: her step 1 goes", res.sent === 1 && outbox.Sally!.length === 1 && /Hi Fay/.test(textOf(outbox.Sally![0])), j(res));

  section("Case 5 — gently");
  await lead("Gia One", "+971 54 100 0001", "Sally", titans);
  await msg("Sally", "971541000001", "out", new Date(Date.now() - 5 * H));
  await lead("Hana Two", "+971 54 100 0002", "Sally", titans);
  await msg("Sally", "971541000002", "out", new Date(Date.now() - 5 * H));
  F.resetFollowupPacingForCheck();
  t = work(Date.now() + 5 * 60_000);
  res = await F.runFollowups(t);
  const r2 = await F.runFollowups(new Date(t.getTime() + 30_000));
  check("two due for Sally: one a run, and not again within a minute", res.sent === 1 && r2.sent === 0 && outbox.Sally!.length === 2, j({ res, r2 }));
  const r3 = await F.runFollowups(new Date(t.getTime() + 2 * 60_000 + 1000));
  check("…the other after the gap", r3.sent === 1 && outbox.Sally!.length === 3, j(r3));
  await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 1, steps });
  await lead("Ivy Three", "+971 54 100 0003", "Sally", titans);
  await msg("Sally", "971541000003", "out", new Date(Date.now() - 5 * H));
  const day = work(Date.now() + 5 * 60_000);
  await msg("Sally", "971549999999", "out", new Date(day.getTime() - 60_000), { auto: { kind: "followup", step: 1, of: 5 } });   // one already that day
  res = await run(day);
  check("the daily limit (1) reached: nothing more for her that day", res.sent === 0 && outbox.Sally!.length === 3, j(res));
  await db.collection("whatsapp_messages").deleteMany({ owner: P("Sally"), key: "549999999" });
  await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps });
  await db.collection("whatsapp_messages").deleteMany({ owner: P("Sally"), key: "971541000003".slice(-9) });
  await lead("Not On WA", "+971 54 200 0000", "Sally", titans);                  // the stand-in says …0000 is not on WhatsApp
  await msg("Sally", "971542000000", "out", new Date(Date.now() - 5 * H));
  F.resetFollowupPacingForCheck();
  t = work(Date.now() + 5 * 60_000);
  res = await F.runFollowups(t);
  const again = await F.runFollowups(new Date(t.getTime() + 3 * 60_000));
  check("a number not on WhatsApp: not sent, and not tried again a few minutes later", res.sent === 0 && res.failed === 1 && again.sent === 0 && again.failed === 0, j({ res, again }));

  await db.collection("whatsapp_messages").deleteMany({ owner: P("Sally"), key: "542000000" });

  section("Case 6 — a step with a file");
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }), "intro.mp4");
  let up = await fetch(`http://127.0.0.1:${port}/api/v1/whatsapp/followups/file`, { method: "POST", headers: { authorization: `Bearer ${token("Sam")}` }, body: fd });
  check("a salesperson can't upload one", up.status === 403);
  const bad = new FormData();
  bad.append("file", new Blob([new Uint8Array([1])], { type: "application/x-msdownload" }), "x.exe");
  up = await fetch(`http://127.0.0.1:${port}/api/v1/whatsapp/followups/file`, { method: "POST", headers: { authorization: `Bearer ${token("Root")}` }, body: bad });
  check("a program: refused", up.status === 400);
  up = await fetch(`http://127.0.0.1:${port}/api/v1/whatsapp/followups/file`, { method: "POST", headers: { authorization: `Bearer ${token("Root")}` }, body: fd });
  const file = ((await up.json()) as any).data;
  check("a video: kept under followups/", up.status === 201 && /^followups\/[\w-]+\.mp4$/.test(file.file) && fs.existsSync(path.join(MEDIA, file.file)), j(file));
  const withFile = steps.map((s: any, i: number) => (i === 0 ? { ...s, file } : s));
  r = await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: true, teams: [String(titans)], dailyLimit: 60, steps: withFile });
  check("…put on step 1", r.status === 200 && r.body.data.steps[0].file?.file === file.file);
  await lead("Jo Video", "+971 56 300 0001", "Sally", titans);
  await msg("Sally", "971563000001", "out", new Date(Date.now() - 5 * H));
  const filesBefore = fs.readdirSync(MEDIA, { recursive: true }).length;
  res = await run(work(Date.now() + 5 * 60_000));
  const v = outbox.Sally!.at(-1)!;
  check("step 1 goes as the video, the words as its caption", res.sent === 1 && v.content.video !== undefined && /Hi Jo/.test(String(v.content.caption)), j({ res, keys: Object.keys(v.content) }));
  const kept = (await autos("Sally", "971563000001"))[0];
  check("…kept pointing at the one file — no copy made", kept?.media?.file === file.file && fs.readdirSync(MEDIA, { recursive: true }).length === filesBefore, j(kept?.media));

  section("Case 7 — what people see");
  r = await call("GET", `/whatsapp/lead/${fay}`, "Sally");
  const fc = r.body.data?.followup;
  check("Fay's card: step 2 of 5 next, when, from Sally's WhatsApp (linked)", fc?.state === "waiting" && fc.step === 2 && fc.of === 5 && !!fc.nextAt && fc.ownerName === "Sally" && fc.linked === true, j(fc));
  r = await call("GET", `/whatsapp/lead/${omarLead}`, "Omar");
  check("a lead on a team not switched on: off", r.body.data?.followup?.state === "off" && r.body.data.followup.on === false, j(r.body.data?.followup));
  r = await call("GET", `/whatsapp/messages?chat=971501234567`, "Sam");
  const marked = (r.body.data?.messages ?? []).filter((m: any) => m.auto);
  check("in the chat, each automatic one says which step", marked.length === 7 && marked[0].auto.step === 1 && marked[0].auto.of === 5, j(marked.map((m: any) => m.auto)));
  r = await call("GET", "/whatsapp/followups/recent", "Lina");
  check("recent: her team leader sees her people's, newest first, with the lead", r.status === 200 && r.body.data.length >= 8 && r.body.data[0].lead?.name && r.body.data.every((x: any) => [String(P("Sam")), String(P("Sally"))].includes(x.ownerId)), j(r.body.data?.slice(0, 2)));
  r = await call("GET", "/whatsapp/followups/recent", "Omar");
  check("…Omar: none of theirs", r.status === 200 && r.body.data.length === 0, j(r.body.data));

  await call("PUT", "/whatsapp/followups/settings", "Root", { enabled: false, teams: [String(titans)], dailyLimit: 60, steps });
  await lead("Kay Off", "+971 56 300 0002", "Sally", titans);
  await msg("Sally", "971563000002", "out", new Date(Date.now() - 5 * H));
  res = await run(work(Date.now() + 5 * 60_000));
  check("switched off: nothing at all", res.sent === 0 && res.skipped === "off", j(res));
} finally {
  server.close();
  await mongoose.disconnect();
  fs.rmSync(MEDIA, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
