/**
 * Checks the enrolment workflow this CRM gives the Root portal (GET
 * /service/enrolment-flow, 2026-10-14), on a scratch database, through the
 * API with the portal secret, against a stand-in finance:
 *
 *   - the secret;
 *   - every close at the step it stands at, as My Enrolments works it out, and
 *     whom that waits on: not sent yet / with finance (finance), sent back (its
 *     closer), the LMS, no CS yet (the CS manager), the welcome and the MT5 to
 *     log (the CS, by name), the bonus (a broker admin);
 *   - finished ones (every step done, or not needed — not Forex) only counted;
 *   - the closer with their email, the course, the invoice.
 *
 * Run by enrolment-flow-check.sh. Scratch database only.
 */
import crypto from "node:crypto";
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

/* ── A stand-in finance answering the status call ── */
const FIN_SECRET = "enrolment-flow-check-finance-secret";
const status = new Map<string, Record<string, unknown>>();
const fin = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text();
    const ts = req.headers.get("x-delta-timestamp") ?? "", nonce = req.headers.get("x-delta-nonce") ?? "";
    const canonical = ["POST", url.pathname, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
    if (req.headers.get("x-delta-signature") !== crypto.createHmac("sha256", FIN_SECRET).update(canonical).digest("hex")) return Response.json({}, { status: 401 });
    if (url.pathname !== "/api/v1/integrations/enrolments/status") return Response.json({}, { status: 404 });
    const body = JSON.parse(raw);
    return Response.json({ data: (body.externalIds as string[]).map((id) => status.get(id)).filter(Boolean) });
  },
});

const SECRET = "enrolment-flow-check-root-secret";
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "enrolment-flow-check-jwt", JWT_REFRESH_SECRET: "enrolment-flow-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false",
  ROOT_ERP_SECRET: SECRET, FINANCE_API_URL: `http://127.0.0.1:${fin.port}`, FINANCE_CLIENT_ID: "flow-check",
  FINANCE_INTEGRATION_SECRET: FIN_SECRET, FINANCE_ORG_ID: "org-dubai", FINANCE_ORG_ID_BANGALORE: "org-bangalore",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const sally = new Types.ObjectId();
await db.collection("users").insertOne({ _id: sally, name: "Sally Sales", email: "Sally@Test.Local", password: "x", status: "active" });
const course = new Types.ObjectId();
await db.collection("courses").insertOne({ _id: course, name: "Market Breakout", amount: 1000 });

let n = 0;
const base = (o: Record<string, unknown> = {}) => ({
  invoiceNumber: `IN-${String(n).padStart(5, "0")}`, invoiceId: `inv${n}`, status: "partial", approval: "approved", returnedReason: "", issueDate: "2026-10-01",
  currency: "AED", totalMinor: 100000, amountPaidMinor: 40000, balanceMinor: 60000,
  lms: { state: "created", courses: ["MBT"] },
  commission: { state: "sent", cs: "Cee One", team: "Falcons", onboarded: { done: true, at: "2026-10-02T10:00:00Z", by: "Cee One" }, bonus: { state: "none" } },
  ...o,
});
/** A close; `fin` is finance's answer (none: not answered / not there). */
async function close(handover: Record<string, unknown>, finAnswer: Record<string, unknown> | null) {
  n++;
  const _id = new Types.ObjectId();
  await db.collection("students").insertOne({
    _id, enrollmentNumber: `ENR-${n}`, name: `Client ${n}`, leadId: new Types.ObjectId(), assignedTo: sally, course, team: null,
    totalFee: 1000, enrollmentDate: new Date("2026-10-01T08:00:00Z"), academy: "dubai", status: "active",
  });
  await db.collection("financehandovers").insertOne({ studentId: _id, payload: {}, academy: "dubai", financeOrgId: "org-dubai", attempts: 1, ...handover });
  if (finAnswer) status.set(String(_id), { externalId: String(_id), ...base(finAnswer) });
  return String(_id);
}
const queued = await close({ status: "pending" }, null);
const withFinance = await close({ status: "sent" }, { approval: "pending", lms: null, commission: null });
const sentBack = await close({ status: "sent", approvalState: "returned" }, { approval: "returned", returnedReason: "Wrong fee", lms: null, commission: null });
const lms = await close({ status: "sent" }, { lms: { state: "waiting", courses: [] }, commission: null });
const noCs = await close({ status: "sent" }, { commission: { state: "sent", cs: "", onboarded: { done: false }, bonus: { state: "none" } } });
const welcome = await close({ status: "sent" }, { commission: { state: "sent", cs: "Cee One", onboarded: { done: false }, bonus: { state: "none" } } });
const broker = await close({ status: "sent" }, { commission: { state: "sent", cs: "Cee Two", onboarded: { done: true }, bonus: { state: "pending", amount: 500, currency: "USD" } } });
const mt5 = await close({ status: "sent" }, { commission: { state: "sent", cs: "Cee Two", onboarded: { done: true }, bonus: { state: "not_requested", amount: 500, currency: "USD" } } });
await close({ status: "sent" }, {});                                                                       // every step done
await close({ status: "sent" }, { commission: { state: "skipped", detail: "Not a Forex course" } });          // done: not Forex

const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const get = async (secret: string | null = SECRET) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/service/enrolment-flow`, { headers: secret ? { "x-portal-secret": secret } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { data?: any } };
};

try {
  check("no secret, a wrong one: 401", (await get(null)).status === 401 && (await get("nope")).status === 401);
  const r = await get();
  const d = r.body.data;
  const of = new Map<string, any>((d?.open ?? []).map((x: any) => [x.id, x]));
  const who = (id: string) => `${of.get(id)?.stage}/${of.get(id)?.stageState}/${of.get(id)?.waitingOn?.role}/${of.get(id)?.waitingOn?.name}`;
  check("10 closes: 8 unfinished, 2 finished (all done; not Forex)", r.status === 200 && d.total === 10 && d.finished === 2 && d.open.length === 8 && d.financeAnswered === true, JSON.stringify(d).slice(0, 300));
  check("not sent yet, and with finance: waiting on finance", who(queued) === "finance/waiting/finance/" && who(withFinance) === "finance/waiting/finance/", `${who(queued)} ${who(withFinance)}`);
  check("sent back: on its closer, with finance's reason", who(sentBack) === "finance/failed/salesperson/Sally Sales" && /Wrong fee/.test(of.get(sentBack)?.detail ?? ""), who(sentBack));
  check("the LMS", who(lms) === "lms/waiting/lms/", who(lms));
  check("in Tetra Commission with no CS yet: the CS manager", who(noCs) === "cs/waiting/cs_manager/", who(noCs));
  check("the welcome: their CS by name", who(welcome) === "onboarded/waiting/cs/Cee One", who(welcome));
  check("the bonus: a broker admin; the MT5 not logged: their CS", who(broker) === "bonus/waiting/broker_admin/" && who(mt5) === "bonus/waiting/cs/Cee Two", `${who(broker)} ${who(mt5)}`);
  const x = of.get(welcome);
  check("a close: its closer with email, course, invoice, steps", x?.closedBy?.name === "Sally Sales" && x.closedBy.email === "sally@test.local" && x.course === "Market Breakout"
    && /^IN-/.test(x.invoiceNumber) && x.steps.length === 5 && x.steps.map((s: any) => s.state).join() === "done,done,done,waiting,done", JSON.stringify(x));
} finally {
  server.close();
  fin.stop(true);
  await mongoose.disconnect();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
