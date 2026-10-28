/**
 * Checks the WhatsApp integration (the user, 2026-10-27: "the commission portal's WhatsApp — we need it here also"),
 * on a scratch database, through the API, with a stand-in for WhatsApp (a real phone can't be linked here):
 *
 *   - Case 1: linking — off in a process that doesn't run the timed jobs; who may link; who is listed for whom.
 *   - Case 2: a message comes in — kept under its owner, matched to the lead by its number's last 9 digits; a
 *     replayed one is one; a number no lead has is a chat with no lead; one sent from the phone is kept as theirs.
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
const titans = new Types.ObjectId(), others = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: titans, name: "Titans", status: "active", leaders: [P("Lina")], members: [P("Sam"), P("Sally")] },
  { _id: others, name: "Others", status: "active", leaders: [], members: [P("Omar")] },
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
  check("a number no lead has: a chat with no lead, named as on WhatsApp", stranger?.lead === null && stranger.name === "Stranger" && stranger.whatsappName === "Stranger", j(stranger));
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
  await incoming("Sam", "971533333333", "I want to join", { name: "Rahul Nair" });
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971533333333" });
  const made = await db.collection("leads").findOne({ phone: "+971533333333" });
  check("a lead made of a chat: its number, their WhatsApp name, source WhatsApp, held by Sam", r.status === 201 && made?.name === "Rahul Nair" && String(made?.source).toLowerCase() === "whatsapp" && String(made?.assignedTo) === String(P("Sam"))
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
  check("a lead made before any name was known: \"WhatsApp +…\"", r.status === 201 && nameless?.name === "WhatsApp +971544444444", j(r.body));
  await wa.keepContacts({ id: String(P("Sam")), name: "Sam" }, [{ id: "971544444444@s.whatsapp.net", name: "Priya (Dubai Mall)", notify: "Priya" }, { id: "x@g.us", name: "A group" }]);
  const pc = await WhatsAppContact.findOne({ owner: P("Sam"), key: "544444444" }).lean();
  check("a contact's names kept by number (a group's ignored)", pc?.name === "Priya (Dubai Mall)" && pc?.notify === "Priya" && (await WhatsAppContact.countDocuments({})) >= 1, j(pc));
  const renamed = await db.collection("leads").findOne({ _id: new Types.ObjectId(nameless?.id) });
  check("…the \"WhatsApp +…\" lead takes the name saved in the phone", renamed?.name === "Priya (Dubai Mall)", j(renamed?.name));
  await incoming("Sam", "971566666666", "Info please", { name: "" });
  await wa.keepContacts({ id: String(P("Sam")), name: "Sam" }, [{ id: "971566666666@s.whatsapp.net", notify: "Karthik" }]);
  let ch = (await chatsOf("Sam")).body.data?.chats?.find((c: any) => c.chat === "971566666666");
  check("a chat that is no lead's: called by their WhatsApp name", ch?.name === "Karthik" && ch?.lead === null, j(ch));
  r = await call("POST", "/whatsapp/create-lead", "Sam", { chat: "971566666666" });
  check("…and a lead made of it takes that name", r.status === 201 && r.body.data?.lead?.name === "Karthik", j(r.body));
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
} finally {
  server.close();
  await mongoose.disconnect();
  fs.rmSync(MEDIA, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
