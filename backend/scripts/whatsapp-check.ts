/**
 * Checks the WhatsApp integration (the user, 2026-10-27: "the CS Portal's WhatsApp — we need it here also"),
 * on a scratch database, through the API, with a stand-in for WhatsApp (a real phone can't be linked here):
 *
 *   - Case 1: linking — off in a process that doesn't run the timed jobs; who may link; who is listed for whom.
 *   - Case 2: a message comes in — kept under its owner, matched to the lead by its number's last 9 digits; a
 *     replayed one is one; a number no lead has writing in becomes a lead (AI Academy, the WhatsApp's owner); one
 *     sent from the phone is kept as theirs.
 *   - Case 3: unread — counted, the new ones since the last ask, and read by its owner only.
 *   - Case 4: sending — from your own linked WhatsApp only, to a number on WhatsApp; kept, matched to the lead.
 *   - Case 5: who reads whose chats — the owner; their team leader; the Sales Manager; nobody else.
 *   - Case 6: a chat that is no lead's — linked to a lead you may see (later messages follow), or made a lead.
 *   - Case 7: the lead page's card — the lead's chats you may read, and its numbers.
 *   - Case 8: photos and files, voice notes — kept on disk, on short-lived signed links.
 *   - Case 9: no WhatsApp access — refused.
 *   - Case 10: past chats handed over at linking — kept as read, nobody told, files fetched (one WhatsApp no longer
 *     has: a line saying so), never a follow-up.
 *   - Case 11: names, catch-up and older messages — contacts' names on chats and new leads (a "WhatsApp +…" lead
 *     renamed); messages WhatsApp catches up on kept as they are; "Load older messages" asks the phone; the follow-ups
 *     summary for everyone.
 *   - Case 12: a number that is no lead's writing in (2026-10-28) — a lead at once: their name, source WhatsApp, the
 *     owner's, in the AI Academy team, the owner told; once only, however many messages or WhatsApps; not for one the
 *     salesperson wrote first, a past chat, a catch-up from days ago, a group, or a number already a lead.
 *   - Case 13: Forward — text, a photo with its caption, a voice note as a voice note; to several chats; marked
 *     forwarded; only a message you may read; a file no longer kept, not linked, bad input — refused.
 *   - Case 14: the saved messages — the first reply's parts and the follow-up steps listed for everyone; one sent now
 *     with {name} filled, marked which, a person's message (not automatic); a file with it; a gone one refused; the
 *     whole first reply at once, in order.
 *   - Case 16: sending quickly — a chat going on isn't checked with WhatsApp again; a new number once; not on WhatsApp
 *     still refused; a lead added meanwhile still found.
 *   - Case 15: "Load older messages for all chats" — the phone asked for each chat, newest first, one at a time in
 *     the background; one run at a time; not linked, or no chats — refused.
 *
 * Run by whatsapp-check.sh. Scratch database only.
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

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-"));
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "whatsapp-check-jwt", JWT_REFRESH_SECRET: "whatsapp-check-refresh", NODE_ENV: "test",
  RUN_SCHEDULERS: "false", WHATSAPP_MEDIA_DIR: MEDIA, WHATSAPP_SESSION_DIR: path.join(MEDIA, "sessions"),
  R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { signAccessToken } = await import("../src/utils/jwt.js");
const wa = await import("../src/services/whatsapp/service.js");
const { WhatsAppMessage } = await import("../src/models/WhatsAppMessage.js");

/* ── People: a team (Lina leads Sam and Sally), Omar elsewhere, Mona the Sales Manager, Nora without WhatsApp ── */
const perms = (wa: boolean) => ({
  leads: { view: true, create: true, edit: true, delete: false, approve: false, export: false },
  // Without it the role would get WhatsApp's open default: switched off, as a role someone unticked.
  whatsapp: { view: wa, create: wa, edit: false, delete: false, approve: false, export: false },
});
const superRole = new Types.ObjectId(), salesRole = new Types.ObjectId(), noWaRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: salesRole, roleName: "Sales Staff", isSystemRole: false, permissions: perms(true) },
  { _id: noWaRole, roleName: "No WhatsApp", isSystemRole: false, permissions: perms(false) },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Root", superRole], ["Lina", salesRole], ["Sam", salesRole], ["Sally", salesRole], ["Omar", salesRole], ["Mona", salesRole], ["Nora", noWaRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const P = (n: string) => people[n]!.id;
const titans = new Types.ObjectId(), others = new Types.ObjectId(), aiAcademy = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: titans, name: "Titans", status: "active", leaders: [P("Lina")], members: [P("Sam"), P("Sally")] },
  { _id: others, name: "Others", status: "active", leaders: [], members: [P("Omar")] },
  // Where new WhatsApp leads go (2026-10-28) — written as the team may be named.
  { _id: aiAcademy, name: " AI ACADEMY ", status: "active", leaders: [], members: [] },
]);
await db.collection("commissionsettings").insertOne({ key: "default", salesManager: P("Mona"), excludedUsers: [] });

/* ── Leads ── */
const lead = async (name: string, phone: string, owner: string, team: Types.ObjectId) => {
  const id = new Types.ObjectId();
  await db.collection("leads").insertOne({ _id: id, name, phone, assignedTo: P(owner), team, reporter: P(owner), status: "assigned", createdAt: new Date(), updatedAt: new Date() });
  return String(id);
};
const asha = await lead("Asha Thomas", "+971 50 123 4567", "Sam", titans);
const omarLead = await lead("Bilal Khan", "0559876543", "Omar", others);

/* ── A stand-in WhatsApp ── */
type Sent = { jid: string; content: Record<string, unknown> };
function fakeSock(sent: Sent[]) {
  let n = 0;
  return {
    sendMessage: async (jid: string, content: Record<string, unknown>) => { sent.push({ jid, content }); return { key: { id: `SENT-${++n}-${Date.now()}` } }; },
    onWhatsApp: async (phone: string) => [{ exists: !phone.endsWith("0000"), jid: `${phone}@s.whatsapp.net` }],
    updateMediaMessage: async () => undefined,
    user: { id: "971500000001:1@s.whatsapp.net" },
  } as never;
}
const samSent: Sent[] = [];
const incoming = (owner: string, from: string, body: string, opts: { id?: string; fromMe?: boolean; name?: string } = {}) =>
  wa.receive({ id: String(P(owner)), name: owner }, fakeSock([]), {
    key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: !!opts.fromMe, id: opts.id ?? `IN-${Math.random().toString(36).slice(2)}` },
    message: { conversation: body }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: opts.name ?? "",
  } as never);

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
async function form(p: string, who: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Uint8Array }): Promise<Answer> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, { method: "POST", headers: { authorization: `Bearer ${token(who)}` }, body: fd });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
const chatsOf = async (who: string, owner = "") => (await call("GET", `/whatsapp/chats${owner ? `?ownerId=${P(owner)}` : ""}`, who));

try {
  section("Case 1 — linking");
  let r = await call("GET", "/whatsapp/status", "Sam");
  check("Sam: not linked, may link, lists nobody else (only his own chats)", r.status === 200 && r.body.data?.me?.status === "disconnected" && r.body.data?.canLink === true && r.body.data?.owners?.length === 0, j(r.body));
  check("…switched off in a process that doesn't run the timed jobs", r.body.data?.enabled === false);
  r = await call("POST", "/whatsapp/connect", "Sam");
  check("…so linking is refused here, saying so", r.status === 503 && /switched off/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("GET", "/whatsapp/status", "Lina");
  const linaSees = (r.body.data?.owners ?? []).map((o: any) => o.name).sort();
  check("Lina (team leader): lists her team — herself, Sam and Sally — not Omar", j(linaSees) === j(["Lina", "Sally", "Sam"]), j(linaSees));
  r = await call("GET", "/whatsapp/status", "Mona");
  check("Mona (Sales Manager): lists everyone", (r.body.data?.owners ?? []).length === 7, j((r.body.data?.owners ?? []).map((o: any) => o.name)));

  section("Case 2 — a message comes in");
  await incoming("Sam", "971501234567", "Hi, about the course", { id: "IN-1", name: "Asha" });
  await incoming("Sam", "971501234567", "Hi, about the course", { id: "IN-1", name: "Asha" });
  let c = await chatsOf("Sam");
  const ashaChat = c.body.data?.chats?.find((x: any) => x.chat === "971501234567");
  check("kept under Sam, matched to the lead by its last 9 digits (the record says +971 50 123 4567)", ashaChat?.lead?.id === asha && ashaChat.name === "Asha Thomas" && ashaChat.unread === 1, j(ashaChat));
  check("…the same WhatsApp message twice (a reconnect replays them) is one", ashaChat?.count === 1, j(ashaChat));
  await incoming("Sam", "971522222222", "Hello? price?", { name: "Stranger" });
  c = await chatsOf("Sam");
  const stranger = c.body.data?.chats?.find((x: any) => x.chat === "971522222222");
  check("a number no lead has, writing in: made a lead at once — named as on WhatsApp, Sam's", stranger?.lead?.name === "Stranger" && stranger.lead.owner === "Sam" && stranger.whatsappName === "Stranger", j(stranger));
  await incoming("Sam", "971501234567", "Sure, sending details", { fromMe: true });
  c = await chatsOf("Sam");
  check("one sent from his phone is kept, as his, already read", c.body.data?.chats?.find((x: any) => x.chat === "971501234567")?.last?.direction === "out"
    && (await WhatsAppMessage.findOne({ body: "Sure, sending details" }).lean())?.sentByName === "From their phone");

  section("Case 3 — unread");
  const before = new Date(Date.now() - 1000).toISOString();
  r = await call("GET", `/whatsapp/unread?since=${encodeURIComponent(before)}`, "Sam");
  check("Sam has 2 unread, and the new ones since he last asked", r.body.data?.unread === 2 && r.body.data?.messages?.length === 2 && r.body.data.messages.some((m: any) => m.name === "Asha Thomas"), j(r.body.data));
  r = await call("POST", "/whatsapp/read", "Lina", { chat: "971501234567" });
  check("Lina reading it leaves it unread for Sam", r.status === 200 && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === 2);
  r = await call("POST", "/whatsapp/read", "Sam", { chat: "971501234567" });
  check("Sam opening it reads it", r.body.data?.marked === 1 && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === 1);

  section("Case 4 — sending");
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "0501234567", text: "Welcome!" });
  check("not linked: refused, saying where to link", r.status === 409 && /not linked/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  wa.attachSocketForCheck(String(P("Sam")), fakeSock(samSent), "971500000001");
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "0501234567", text: "Welcome!" });
  const out = await WhatsAppMessage.findOne({ body: "Welcome!" }).lean();
  check("linked: sent from his WhatsApp to the number with its country code, kept under the lead's chat", r.status === 200 && r.body.data?.chat === "971501234567"
    && samSent.at(-1)?.jid === "971501234567@s.whatsapp.net" && String(out?.lead) === asha && out?.sentByName === "Sam", `${r.status} ${r.body.message} ${j(out)}`);
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971500000000", text: "x" });
  check("a number not on WhatsApp: refused", r.status === 400 && /not on WhatsApp/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
  r = await call("POST", "/whatsapp/send", "Sally", { chat: "971501234567", text: "x" });
  check("Sally isn't linked: she can't send from Sam's", r.status === 409, `${r.status}`);

  section("Case 5 — who reads whose chats");
  r = await chatsOf("Lina", "Sam");
  check("Lina (his team leader) reads Sam's — read only", r.status === 200 && r.body.data?.chats?.length === 2 && r.body.data?.canSend === false, `${r.status} ${j(r.body.data?.canSend)}`);
  check("Mona (Sales Manager) reads Sam's", (await chatsOf("Mona", "Sam")).status === 200);
  check("Root (Super Admin) reads Sam's", (await chatsOf("Root", "Sam")).status === 200);
  r = await chatsOf("Omar", "Sam");
  check("Omar (another team) doesn't", r.status === 403, `${r.status}`);
  check("…nor Sally Lina's (a team member doesn't read her leader's)", (await chatsOf("Sally", "Lina")).status === 403);
  r = await call("GET", `/whatsapp/messages?ownerId=${P("Sam")}&chat=971501234567`, "Lina");
  check("the chat's messages, oldest first, for Lina", r.status === 200 && r.body.data?.messages?.length === 3 && r.body.data.messages[0].body === "Hi, about the course", j(r.body.data?.messages?.map((m: any) => m.body)));

  section("Case 6 — a chat that is no lead's");
  r = await call("POST", "/whatsapp/link", "Sam", { chat: "971522222222", leadId: omarLead });
  check("Sam can't link it to Omar's lead (not his to see)", r.status === 403, `${r.status} ${r.body.message}`);
  r = await call("GET", "/whatsapp/lead-options?search=asha", "Sam");
  check("the leads he may link to, by name", r.status === 200 && r.body.data?.length === 1 && r.body.data[0].id === asha, j(r.body.data));
  r = await call("GET", "/whatsapp/lead-options?search=055 987 6543", "Sam");
  check("…Omar's lead isn't among them, typed as a number", r.status === 200 && r.body.data?.length === 0, j(r.body.data));
  r = await call("GET", "/whatsapp/lead-options?search=055 987 6543", "Mona");
  check("…for Mona it is (spaces and all)", r.body.data?.[0]?.id === omarLead, j(r.body.data));
  r = await call("POST", "/whatsapp/link", "Sam", { chat: "971522222222", leadId: asha });
  check("linked to Asha's lead: the chat shows under her", r.status === 200 && (await chatsOf("Sam")).body.data?.chats?.find((x: any) => x.chat === "971522222222")?.lead?.id === asha);
  await incoming("Sam", "971522222222", "It's her brother here", { name: "Stranger" });
  check("…and a later message from that number follows", String((await WhatsAppMessage.findOne({ body: "It's her brother here" }).lean())?.lead) === asha);
  // A chat Sam started from his phone is no lead's until someone makes it one: Make a lead, by hand.
  await incoming("Sam", "971533333333", "Hi, Delta here", { fromMe: true });
  check("a chat Sam started himself (from his phone) is not made a lead", !(await db.collection("leads").findOne({ phone: "+971533333333" })));
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971533333333", name: "Rahul Nair" });
  const made = await db.collection("leads").findOne({ phone: "+971533333333" });
  check("Make a lead by hand: its number, the name given, source WhatsApp, held by Sam", r.status === 201 && made?.name === "Rahul Nair" && String(made?.source).toLowerCase() === "whatsapp" && String(made?.assignedTo) === String(P("Sam"))
    && (await chatsOf("Sam")).body.data?.chats?.find((x: any) => x.chat === "971533333333")?.lead?.id === String(made?._id), `${r.status} ${r.body.message} ${j(made)}`);
  await incoming("Sam", "971559876543", "Bilal again", { name: "Bilal" });
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971559876543" });
  check("a number that is a lead after all: linked to it, not made twice", r.status === 200 && r.body.data?.existed === true && r.body.data?.lead?.id === omarLead
    && (await db.collection("leads").countDocuments({ phone: { $regex: "9876543" } })) === 1, `${r.status} ${j(r.body.data)}`);

  section("Case 7 — the lead page's card");
  r = await call("GET", `/whatsapp/lead/${asha}`, "Sam");
  const t = r.body.data?.threads ?? [];
  check("Sam sees his chats with Asha — her number and the one linked to her", r.status === 200 && t.length === 2 && t.every((x: any) => x.ownerId === String(P("Sam"))), j(t.map((x: any) => [x.chat, x.messages.length])));
  check("…her numbers, ready for WhatsApp; he can send", j(r.body.data?.numbers) === j(["971501234567"]) && r.body.data?.canSend === true, j(r.body.data?.numbers));
  r = await call("GET", `/whatsapp/lead/${asha}`, "Omar");
  check("Omar opening her lead sees none of Sam's chats", r.status === 200 && r.body.data?.threads?.length === 0 && r.body.data?.canSend === false, j(r.body.data?.threads));
  r = await call("GET", `/whatsapp/lead/${asha}`, "Lina");
  check("Lina sees Sam's, read only", r.body.data?.threads?.length === 2 && r.body.data?.canSend === false);

  section("Case 8 — photos, files and voice notes");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", caption: "The brochure" }, { name: "brochure.png", type: "image/png", bytes: png });
  check("a photo: sent as an image with its caption, kept", r.status === 200 && (samSent.at(-1)?.content as any)?.image && (samSent.at(-1)?.content as any)?.caption === "The brochure", `${r.status} ${r.body.message}`);
  const ogg = new Uint8Array(Buffer.from("OggS-fake-voice"));
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", voice: "1" }, { name: "voice-note.ogg", type: "audio/ogg", bytes: ogg });
  check("a voice note recorded in the CRM: sent as one (ptt)", r.status === 200 && (samSent.at(-1)?.content as any)?.ptt === true, `${r.status} ${r.body.message}`);
  // An "AUDIO-….m4a.mp4" — an MP4 with a sound track only, which a browser calls a video: it goes as audio.
  const mp4 = (kind: string) => new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypM4A "), Buffer.alloc(8),
    Buffer.from([0, 0, 0, 0x21]), Buffer.from("hdlr"), Buffer.alloc(8), Buffer.from(kind), Buffer.alloc(13)]));
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", caption: "" }, { name: "AUDIO-2026-10-24-11-20-03.m4a.mp4", type: "video/mp4", bytes: mp4("soun") });
  check("a sound-only MP4 (\"….m4a.mp4\"): sent as audio, not a video", r.status === 200 && (samSent.at(-1)?.content as any)?.audio && (samSent.at(-1)?.content as any)?.mimetype === "audio/mp4" && !(samSent.at(-1)?.content as any)?.video, j(Object.keys(samSent.at(-1)?.content ?? {})));
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", caption: "Class clip" }, { name: "clip.mp4", type: "video/mp4", bytes: mp4("vide") });
  check("…an MP4 with a picture: still a video", r.status === 200 && (samSent.at(-1)?.content as any)?.video !== undefined, j(Object.keys(samSent.at(-1)?.content ?? {})));
  r = await call("GET", `/whatsapp/messages?chat=971501234567`, "Sam");
  const photo = r.body.data?.messages?.find((m: any) => m.media?.type === "image");
  const got = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`) : null;
  check("its signed link opens the photo, with no sign-in", !!got && got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(Buffer.from(png)), `${got?.status} ${photo?.media?.url}`);
  check("…with its length, and parts of it on request", got?.headers.get("content-length") === String(png.length) && got?.headers.get("accept-ranges") === "bytes", j([...(got?.headers ?? [])]));
  const part = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: "bytes=2-5" } }) : null;
  const partBytes = part ? Buffer.from(await part.arrayBuffer()) : Buffer.alloc(0);
  check("…a part: 206, those bytes, which part of how many", part?.status === 206 && part.headers.get("content-range") === `bytes 2-5/${png.length}` && partBytes.equals(Buffer.from(png.slice(2, 6))), `${part?.status} ${part?.headers.get("content-range")}`);
  const tail = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: "bytes=-4" } }) : null;
  check("…the last 4 bytes", tail?.status === 206 && Buffer.from(await tail!.arrayBuffer()).equals(Buffer.from(png.slice(-4))));
  const beyond = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url}`, { headers: { range: `bytes=${png.length + 10}-` } }) : null;
  check("…a part past the end: 416", beyond?.status === 416, `${beyond?.status}`);
  const again = (await call("GET", `/whatsapp/messages?chat=971501234567`, "Sam")).body.data?.messages?.find((m: any) => m.id === photo?.id);
  check("asked again, the same link — an audio or video playing isn't reloaded", !!again && again.media.url === photo.media.url, `${again?.media?.url} vs ${photo?.media?.url}`);
  const tampered = photo ? await fetch(`http://127.0.0.1:${port}${photo.media.url.replace(/s=[^&]+/, "s=xxxx")}`) : null;
  check("…a link someone changed opens nothing", tampered?.status === 404, `${tampered?.status}`);
  const old = photo ? photo.media.url.replace(/e=\d+/, `e=${Math.floor(Date.now() / 1000) - 10}`) : "";
  const expired = old ? await fetch(`http://127.0.0.1:${port}${old}`) : null;
  check("…an expired one says so (or opens nothing)", expired?.status === 410 || expired?.status === 404, `${expired?.status}`);

  section("Case 9 — no WhatsApp access");
  check("Nora's role has no WhatsApp: the page is refused", (await call("GET", "/whatsapp/status", "Nora")).status === 403);
  check("…and sending", (await call("POST", "/whatsapp/send", "Nora", { chat: "971501234567", text: "x" })).status === 403);
  check("no token: refused", (await fetch(`http://127.0.0.1:${port}/api/v1/whatsapp/status`)).status === 401);

  section("Case 10 — past chats handed over at linking");
  const unreadBefore = (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread;
  const past = (id: string, message: Record<string, unknown>, opts: { fromMe?: boolean; daysAgo?: number } = {}) =>
    wa.receive({ id: String(P("Sam")), name: "Sam" }, fakeSock([]), {
      key: { remoteJid: "971501234567@s.whatsapp.net", fromMe: !!opts.fromMe, id },
      message, messageTimestamp: Math.floor(Date.now() / 1000) - (opts.daysAgo ?? 30) * 86400, pushName: "Asha",
    } as never, { history: true });
  await past("PAST-1", { conversation: "Hi, I saw your ad last month" });
  await past("PAST-2", { conversation: "Sure — here are the details" }, { fromMe: true, daysAgo: 29 });
  await past("PAST-3", { imageMessage: { mimetype: "image/jpeg", caption: "Fee structure" } }, { daysAgo: 28 });
  await past("PAST-4", { documentMessage: { mimetype: "application/pdf", fileName: "brochure.pdf" } }, { daysAgo: 28 });
  await past("PAST-5", { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } }, { daysAgo: 27 });
  await past("PAST-1", { conversation: "Hi, I saw your ad last month" });   // handed over twice
  const kept = await WhatsAppMessage.find({ owner: P("Sam"), messageId: /^PAST-/ }).sort({ at: 1 }).lean();
  check("kept once each, under the lead, marked as past", kept.length === 5 && kept.every((m) => m.history === true && String(m.lead) === asha), j(kept.map((m) => [m.messageId, m.history, String(m.lead)])));
  check("…as read: the unread count doesn't move", (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === unreadBefore && kept.every((m) => m.read === true));
  check("…their old date kept, and who wrote", kept[0]!.direction === "in" && kept[1]!.direction === "out" && kept[0]!.at.getTime() < Date.now() - 29 * 86400_000);
  // The stand-in WhatsApp has no files to hand over: each is tried, and said so when it can't be fetched.
  check("an old photo it couldn't fetch: a line saying so, with its caption", kept[2]!.body === "📷 Photo (older — couldn't be fetched): Fee structure" && kept[2]!.media === null, j(kept[2]));
  check("an old document: the same, its name once", kept[3]!.body === "📄 brochure.pdf (older — couldn't be fetched)" && kept[3]!.media === null, j(kept[3]));
  check("an old voice note: the same", kept[4]!.body === "🎤 Voice note (older — couldn't be fetched)" && kept[4]!.media === null, j(kept[4]));
  const { chainOf } = await import("../src/services/whatsapp/followups.js");
  const chain = chainOf([{ _id: new Types.ObjectId(), direction: "out", at: new Date(), chat: "x", history: true }] as never,
    { enabled: true, startedAt: new Date(Date.now() - 365 * 86400_000), teams: [], dailyLimit: 60, steps: [{ waitMinutes: 60, text: "x", file: null }], updatedByName: "", updatedAt: null }, { at: null, byName: "" });
  check("a past chat never starts an automatic follow-up", chain?.state === "before", j(chain));

  section("Case 11 — names, catch-up and older messages");
  const { WhatsAppContact } = await import("../src/models/WhatsAppMessage.js");
  await incoming("Sam", "971544444444", "Hello?", { name: "" });
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971544444444" });
  const nameless = r.body.data?.lead;
  check("a lead made before any name was known: \"WhatsApp +…\" (made as it wrote in; Make a lead finds it)", r.status === 200 && r.body.data?.existed === true && nameless?.name === "WhatsApp +971544444444", j(r.body));
  await wa.keepContacts({ id: String(P("Sam")), name: "Sam" }, [{ id: "971544444444@s.whatsapp.net", name: "Priya (Dubai Mall)", notify: "Priya" }, { id: "x@g.us", name: "A group" }]);
  const pc = await WhatsAppContact.findOne({ owner: P("Sam"), key: "544444444" }).lean();
  check("a contact's names kept by number (a group's ignored)", pc?.name === "Priya (Dubai Mall)" && pc?.notify === "Priya" && (await WhatsAppContact.countDocuments({})) >= 1, j(pc));
  const renamed = await db.collection("leads").findOne({ _id: new Types.ObjectId(nameless?.id) });
  check("…the \"WhatsApp +…\" lead takes the name saved in the phone", renamed?.name === "Priya (Dubai Mall)", j(renamed?.name));
  await incoming("Sam", "971566666666", "Info please", { name: "" });
  await wa.keepContacts({ id: String(P("Sam")), name: "Sam" }, [{ id: "971566666666@s.whatsapp.net", notify: "Karthik" }]);
  let ch = (await chatsOf("Sam")).body.data?.chats?.find((c: any) => c.chat === "971566666666");
  check("a chat made a lead with no name yet: called by their WhatsApp name once it is known", ch?.name === "Karthik", j(ch));
  check("…and its \"WhatsApp +…\" lead takes that name", ch?.lead?.name === "Karthik", j(ch?.lead));
  await incoming("Sam", "971577777777", "Hi there", { name: "Meera" });
  ch = (await chatsOf("Sam")).body.data?.chats?.find((c: any) => c.chat === "971577777777");
  check("a name a message carries is kept too", ch?.name === "Meera" && (await WhatsAppContact.findOne({ owner: P("Sam"), key: "577777777" }).lean())?.notify === "Meera", j(ch));
  const unreadNow = (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread;
  await wa.receive({ id: String(P("Sam")), name: "Sam" }, fakeSock([]), {
    key: { remoteJid: "971577777777@s.whatsapp.net", fromMe: false, id: "CATCHUP-1" }, message: { conversation: "Sent while you were away" },
    messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Meera",
  } as never, { quiet: true });
  const cu = await WhatsAppMessage.findOne({ owner: P("Sam"), messageId: "CATCHUP-1" }).lean();
  check("one WhatsApp catches up on: kept as it is — unread, not a past one", cu?.read === false && !cu?.history && (await call("GET", "/whatsapp/unread", "Sam")).body.data?.unread === unreadNow + 1, j(cu));
  const asked: unknown[] = [];
  const histSock = Object.assign(fakeSock(samSent) as object, { fetchMessageHistory: async (...a: unknown[]) => { asked.push(a); return "REQ-1"; } });
  wa.attachSocketForCheck(String(P("Sam")), histSock as never, "971500000001");
  r = await call("POST", "/whatsapp/history", "Sam", { chat: "971501234567" });
  const first = await WhatsAppMessage.findOne({ owner: P("Sam"), chat: "971501234567", messageId: { $gt: "" } }).sort({ at: 1 }).lean();
  const a0 = asked[0] as [number, { remoteJid: string; id: string; fromMe: boolean }, number] | undefined;
  check("Load older messages: the phone is asked for 50 before the oldest kept", r.status === 200 && a0?.[0] === 50 && a0[1].id === first?.messageId && a0[1].remoteJid === first?.jid && a0[2] === Math.floor(first!.at.getTime() / 1000), j({ r: r.body, a0, first: first?.messageId }));
  r = await call("POST", "/whatsapp/history", "Sam", { chat: "971599999999" });
  check("…a chat with nothing in it: said so", r.status === 409, j(r.body));
  wa.attachSocketForCheck(String(P("Sam")), null);
  r = await call("POST", "/whatsapp/history", "Sam", { chat: "971501234567" });
  check("…not linked: refused", r.status === 409 && /not linked/i.test(r.body.message ?? ""), j(r.body));
  wa.attachSocketForCheck(String(P("Sam")), fakeSock(samSent), "971500000001");
  r = await call("GET", "/whatsapp/followups/summary", "Sam");
  check("follow-ups summary for a salesperson: off, his team, the steps, not his to edit", r.status === 200 && r.body.data?.enabled === false && r.body.data.canEdit === false
    && r.body.data.myTeams?.[0]?.name === "Titans" && r.body.data.steps?.length === 5, j(r.body.data));
  r = await call("GET", "/whatsapp/followups/summary", "Root");
  check("…a Super Admin may edit", r.status === 200 && r.body.data?.canEdit === true);

  section("Case 12 — a number that is no lead's, writing in");
  await incoming("Omar", "971588888881", "Hi, I saw your ad", { name: "Zara Ali" });
  let zara = await db.collection("leads").findOne({ phone: "+971588888881" });
  check("a lead at once: their WhatsApp name, source WhatsApp, Omar's, Assigned", zara?.name === "Zara Ali" && zara?.source === "WhatsApp" && String(zara?.assignedTo) === String(P("Omar")) && zara?.status === "assigned" && zara?.assignedAt instanceof Date, j(zara));
  check("…in the AI Academy team (found however it is written)", String(zara?.team) === String(aiAcademy), j(zara?.team));
  check("…says how it came", /wrote to Omar's WhatsApp/.test(zara?.activityLogs?.[0]?.description ?? "") && String(zara?.reporter) === String(P("Omar")), j(zara?.activityLogs));
  const zaraMsg = await WhatsAppMessage.findOne({ owner: P("Omar"), chat: "971588888881" }).lean();
  check("…the message that came is under that lead", String(zaraMsg?.lead) === String(zara?._id), j(zaraMsg?.lead));
  await incoming("Omar", "971588888881", "Are you there?", { name: "Zara Ali" });
  check("writing again makes no second lead", (await db.collection("leads").countDocuments({ phone: "+971588888881" })) === 1);
  await Promise.all([
    incoming("Sam", "971588888882", "Price?", { name: "Twin" }),
    incoming("Omar", "971588888882", "Price?", { name: "Twin" }),
    incoming("Sam", "971588888882", "Hello??", { name: "Twin" }),
  ]);
  check("the same new number to two WhatsApps at the same moment: one lead", (await db.collection("leads").countDocuments({ phone: "+971588888882" })) === 1);
  await db.collection("leads").insertOne({ _id: new Types.ObjectId(), name: "Fresh Lead", phone: "+971 58 999 0001", assignedTo: P("Sally"), team: titans, reporter: P("Sally"), status: "assigned", createdAt: new Date(), updatedAt: new Date() });
  await incoming("Sam", "971589990001", "Hi again", { name: "Fresh" });
  check("a number that became a lead a moment ago (the list not yet caught up): no second lead", (await db.collection("leads").countDocuments({ phone: { $in: ["+971 58 999 0001", "+971589990001"] } })) === 1);
  await wa.receive({ id: String(P("Sam")), name: "Sam" }, fakeSock([]), {
    key: { remoteJid: "971588888883@s.whatsapp.net", fromMe: false, id: "PAST-NEW-1" }, message: { conversation: "old chat" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 86400 * 30, pushName: "Old",
  } as never, { history: true });
  check("a past chat handed over at linking: not made a lead", !(await db.collection("leads").findOne({ phone: "+971588888883" })));
  await wa.receive({ id: String(P("Sam")), name: "Sam" }, fakeSock([]), {
    key: { remoteJid: "971588888884@s.whatsapp.net", fromMe: false, id: "CATCHUP-OLD-1" }, message: { conversation: "from three days ago" },
    messageTimestamp: Math.floor(Date.now() / 1000) - 86400 * 3, pushName: "Late",
  } as never, { quiet: true });
  check("a catch-up from days ago: not made a lead", !(await db.collection("leads").findOne({ phone: "+971588888884" })));
  await wa.receive({ id: String(P("Sam")), name: "Sam" }, fakeSock([]), {
    key: { remoteJid: "12036300000001@g.us", fromMe: false, id: "GROUP-1", participant: "971588888885@s.whatsapp.net" }, message: { conversation: "group hello" },
    messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Grouper",
  } as never);
  check("a group: not made a lead", !(await db.collection("leads").findOne({ phone: "+971588888885" })));
  await incoming("Sam", "971559876543", "Hello it's Bilal", { name: "Bilal" });
  check("a number already a lead (another format, someone else's): no new lead", (await db.collection("leads").countDocuments({ name: { $in: ["Bilal", "Bilal Khan"] } })) === 1);

  section("Case 13 — Forward");
  const fwdSent: Sent[] = [];
  wa.attachSocketForCheck(String(P("Sam")), fakeSock(fwdSent), "971500000001");
  const textMsg = await WhatsAppMessage.findOne({ owner: P("Sam"), messageId: "IN-1" }).lean();
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(textMsg?._id), chats: ["971577777777", "971522222222"] });
  check("a text to two chats: sent to both, from Sam's WhatsApp", r.status === 200 && fwdSent.length === 2 && fwdSent.every((x) => (x.content as any).text === "Hi, about the course") && r.body.data?.results?.every((x: any) => x.ok), j(r.body));
  const fwdKept = await WhatsAppMessage.find({ owner: P("Sam"), forwarded: true }).lean();
  check("…kept, marked forwarded", fwdKept.length === 2 && fwdKept.every((m) => m.direction === "out" && m.body === "Hi, about the course"), j(fwdKept.map((m) => m.chat)));
  const shown = (await call("GET", "/whatsapp/messages?chat=971577777777", "Sam")).body.data?.messages?.at(-1);
  check("…and the chat shows it as forwarded", shown?.forwarded === true && shown?.saved === null, j(shown));
  const fwdPng = new Uint8Array(Buffer.from("PNG-fake-photo"));
  r = await form("/whatsapp/send-file", "Sam", { chat: "971501234567", caption: "Course brochure" }, { name: "brochure.png", type: "image/png", bytes: fwdPng });
  const fwdPhoto = await WhatsAppMessage.findOne({ owner: P("Sam"), body: "Course brochure" }).sort({ at: -1 }).lean();
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(fwdPhoto?._id), chats: ["971577777777"] });
  const photoOut = fwdSent[0]?.content as any;
  check("a photo: sent as a photo with its caption", r.status === 200 && Buffer.isBuffer(photoOut?.image) && photoOut.image.toString() === "PNG-fake-photo" && photoOut.caption === "Course brochure", j({ s: r.status, c: photoOut?.caption }));
  const voiceMsg = await WhatsAppMessage.findOne({ owner: P("Sam"), body: wa.LABEL.ptt }).lean();
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(voiceMsg?._id), chats: ["971577777777"] });
  check("a voice note: sent as a voice note", r.status === 200 && (fwdSent[0]?.content as any)?.ptt === true, j({ s: r.status, b: r.body.message }));
  const omarMsg = await WhatsAppMessage.findOne({ owner: P("Omar") }).lean();
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(omarMsg?._id), chats: ["971577777777"] });
  check("someone else's message you may not read: not found", r.status === 404, j(r.body));
  r = await call("POST", "/whatsapp/forward", "Lina", { messageId: String(textMsg?._id), chats: ["971577777777"] });
  check("Sam's team leader may read it, but forwards from her own WhatsApp — not linked: refused", r.status === 400 && /not linked/i.test(r.body.message ?? ""), j(r.body));
  await WhatsAppMessage.updateOne({ _id: fwdPhoto!._id }, { $set: { "media.file": "gone/none.png" } });
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(fwdPhoto?._id), chats: ["971577777777"] });
  check("a file no longer kept: said so", r.status === 400 && /no longer kept/i.test(r.body.message ?? ""), j(r.body));
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: "nope", chats: ["971577777777"] });
  const r2 = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(textMsg?._id), chats: [] });
  const r3 = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(textMsg?._id), chats: Array.from({ length: 11 }, (_, i) => `9715000${String(1000 + i)}`) });
  check("bad input: a bad id, no chats, more than 10 — refused", r.status === 400 && r2.status === 400 && r3.status === 400, `${r.status} ${r2.status} ${r3.status}`);
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/forward", "Sam", { messageId: String(textMsg?._id), chats: ["971577777777", "971500000000"] });
  check("one chat not on WhatsApp: the rest still go, each answered", r.status === 200 && fwdSent.length === 1 && r.body.data?.results?.[1]?.ok === false, j(r.body));
  r = await call("POST", "/whatsapp/forward", "Nora", { messageId: String(textMsg?._id), chats: ["971577777777"] });
  check("no WhatsApp access: refused", r.status === 403, j(r.body));

  section("Case 14 — the saved messages, sent by hand");
  const { WhatsAppFollowupSettings } = await import("../src/models/WhatsAppFollowupSettings.js");
  const { followupSettings } = await import("../src/services/whatsapp/followups.js");
  fs.mkdirSync(path.join(MEDIA, "followups"), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, "followups", "intro.ogg"), "OggS-fake-intro");
  await WhatsAppFollowupSettings.updateOne({ key: "default" }, { $set: {
    key: "default", enabled: false, teams: [], dailyLimit: 60,
    steps: [{ waitMinutes: 240, text: "Hi {name}, just checking you saw my message. — {salesperson}", file: null }, { waitMinutes: 1440, text: "Hi {name}, would a call help?", file: null }],
    firstReply: { enabled: false, startedAt: null, items: [
      { text: "Hi {name}! Thanks for writing to Delta.", file: null, voice: false },
      { text: "Listen to this", file: { file: "followups/intro.ogg", name: "intro.ogg", mime: "audio/ogg", size: 15 }, voice: true },
    ] },
  } }, { upsert: true });
  await followupSettings(true);
  r = await call("GET", "/whatsapp/saved-messages", "Sam");
  const list = r.body.data as any[];
  check("listed for a salesperson: the first reply's 2 parts, then the 2 follow-up steps", r.status === 200 && list?.length === 4 && list[0].id === "first_reply:1" && list[1].voice === true && list[1].file?.name === "intro.ogg"
    && list[2].id === "followup:1" && /after 4 hours/.test(list[2].label) && /after 1 day/.test(list[3].label), j(list));
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971501234567", id: "followup:1" });
  const savedOut = await WhatsAppMessage.findOne({ owner: P("Sam"), "saved.kind": "followup" }).lean();
  check("a follow-up step sent now: {name} and {salesperson} filled in", r.status === 200 && (fwdSent[0]?.content as any)?.text === "Hi Asha, just checking you saw my message. — Sam", j({ r: r.body, c: fwdSent[0]?.content }));
  check("…kept as Sam's own message, marked which, not automatic", savedOut?.saved?.step === 1 && !savedOut?.auto && savedOut?.sentByName === "Sam", j(savedOut));
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971588888882", id: "first_reply:2" });
  check("a part with a voice note: the voice note, then its words", r.status === 200 && r.body.data?.parts === 2 && (fwdSent[0]?.content as any)?.ptt === true && (fwdSent[1]?.content as any)?.text === "Listen to this", j({ r: r.body, n: fwdSent.length }));
  r = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971577777777", id: "first_reply:1" });
  check("{name} from the WhatsApp name where there is no lead's", r.status === 200 && (fwdSent.at(-1)?.content as any)?.text === "Hi Meera! Thanks for writing to Delta.", j(fwdSent.at(-1)?.content));
  r = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971501234567", id: "followup:9" });
  const r4 = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971501234567", id: "something" });
  check("a step that isn't there: 404; a made-up id: 400", r.status === 404 && r4.status === 400, `${r.status} ${r4.status}`);
  fwdSent.length = 0;
  r = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971501234567", id: "first_reply:all" });
  const allKept = await WhatsAppMessage.find({ owner: P("Sam"), chat: "971501234567", "saved.kind": "first_reply" }).sort({ at: 1, _id: 1 }).lean();
  check("the whole first reply: every part in order — the text, then the voice note and its words", r.status === 200 && r.body.data?.parts === 3 && fwdSent.length === 3
    && (fwdSent[0]?.content as any)?.text === "Hi Asha! Thanks for writing to Delta." && (fwdSent[1]?.content as any)?.ptt === true && (fwdSent[2]?.content as any)?.text === "Listen to this", j({ r: r.body, n: fwdSent.length }));
  check("…each marked as its part, a person's message", allKept.map((m) => m.saved?.step).join() === "1,2,2" && allKept.every((m) => !m.auto), j(allKept.map((m) => m.saved)));
  const r5 = await call("POST", "/whatsapp/send-saved", "Sam", { chat: "971501234567", id: "followup:all" });
  check("\"all\" is for the first reply only: 400", r5.status === 400, String(r5.status));
  r = await call("GET", "/whatsapp/saved-messages", "Nora");
  check("no WhatsApp access: refused", r.status === 403);

  section("Case 15 — older messages for all chats");
  const askedAll: Array<{ jid: string; id: string }> = [];
  const allSock = Object.assign(fakeSock([]) as object, { fetchMessageHistory: async (_n: number, k: { remoteJid: string; id: string }) => { askedAll.push({ jid: k.remoteJid, id: k.id }); return "REQ"; } });
  wa.attachSocketForCheck(String(P("Sam")), allSock as never, "971500000001");
  const samChats = (await WhatsAppMessage.aggregate([{ $match: { owner: P("Sam"), messageId: { $gt: "" }, jid: { $gt: "" } } }, { $group: { _id: "$chat", last: { $max: "$at" } } }, { $sort: { last: -1 } }])) as Array<{ _id: string }>;
  const started = await wa.fetchOlderForAll(String(P("Sam")), { gapMs: 20 });
  check("asks about each of Sam's chats (answer: how many, how long)", started.chats === samChats.length && started.chats > 3 && started.seconds >= 1, j(started));
  let secondRun: unknown = null;
  try { await wa.fetchOlderForAll(String(P("Sam")), { gapMs: 20 }); } catch (e) { secondRun = e; }
  check("one run at a time: a second press while it runs is refused (409)", (secondRun as { statusCode?: number })?.statusCode === 409 && /Already asking/.test((secondRun as Error)?.message ?? ""), j((secondRun as Error)?.message));
  for (let i = 0; i < 200 && askedAll.length < samChats.length; i++) await new Promise((res) => setTimeout(res, 20));
  await new Promise((res) => setTimeout(res, 60));
  const firstAsked = await WhatsAppMessage.findOne({ owner: P("Sam"), chat: samChats[0]!._id, messageId: { $gt: "" }, jid: { $gt: "" } }).sort({ at: 1, _id: 1 }).lean();
  check("…the phone asked once per chat, newest chat first, from its oldest message", askedAll.length === samChats.length && askedAll[0]?.id === firstAsked?.messageId, j({ n: askedAll.length, of: samChats.length, first: askedAll[0] }));
  r = await call("POST", "/whatsapp/history-all", "Sam");
  check("through the API once the run is over: started again", r.status === 200 && r.body.data?.chats === samChats.length, j(r.body));
  r = await call("POST", "/whatsapp/history-all", "Sam");
  check("…and pressed again at once: still going (409)", r.status === 409, j(r.body));
  r = await call("POST", "/whatsapp/history-all", "Sally");
  check("not linked: refused", r.status === 409 && /not linked/i.test(r.body.message ?? ""), j(r.body));
  wa.attachSocketForCheck(String(P("Sally")), fakeSock([]), "971500000002");
  r = await call("POST", "/whatsapp/history-all", "Sally");
  check("linked but no chats yet: said so", r.status === 409 && /No chats yet/.test(r.body.message ?? ""), j(r.body));
  wa.attachSocketForCheck(String(P("Sally")), null);
  r = await call("POST", "/whatsapp/history-all", "Nora");
  check("no WhatsApp access: refused", r.status === 403);
  wa.attachSocketForCheck(String(P("Sam")), null);   // ends the API's run (it stops once unlinked)

  section("Case 16 — sending without asking WhatsApp again (2026-10-29: messages took long to go)");
  const asks: string[] = [];
  const quickSent: Sent[] = [];
  const quickSock = Object.assign(fakeSock(quickSent) as object, { onWhatsApp: async (phone: string) => { asks.push(phone); return [{ exists: !phone.endsWith("0000"), jid: `${phone}@s.whatsapp.net` }]; } });
  wa.attachSocketForCheck(String(P("Sam")), quickSock as never, "971500000001");
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971501234567", text: "Quick one" });
  check("a chat already going on: sent without asking WhatsApp whether the number is on it", r.status === 200 && asks.length === 0 && quickSent.length === 1, j({ s: r.status, asks }));
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971503214321", text: "A new number" });
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971503214321", text: "And again" });
  check("a new number: asked once, then known", r.status === 200 && asks.filter((x) => x === "971503214321").length === 1, j(asks));
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971503210000", text: "Not on it" });
  check("a number not on WhatsApp: still said so", r.status === 400 && /not on WhatsApp/.test(r.body.message ?? ""), j(r.body));
  const ml = await db.collection("leads").insertOne({ name: "Late Comer", phone: "+971 50 777 1234", assignedTo: P("Sam"), team: titans, reporter: P("Sam"), status: "assigned", createdAt: new Date(), updatedAt: new Date() });
  wa.forgetLeads();
  r = await call("POST", "/whatsapp/send", "Sam", { chat: "971507771234", text: "Hello Late Comer" });
  const lateMsg = await WhatsAppMessage.findOne({ owner: P("Sam"), body: "Hello Late Comer" }).lean();
  check("a lead added meanwhile (list told to read again): the message is under it", String(lateMsg?.lead) === String(ml.insertedId), j(lateMsg?.lead));
  wa.attachSocketForCheck(String(P("Sam")), null);
} finally {
  server.close();
  await mongoose.disconnect();
  fs.rmSync(MEDIA, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
