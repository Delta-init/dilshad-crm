import { Readable } from "node:stream";
import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import type { AuthenticatedRequest } from "../types/index.js";
import { LeadCall } from "../models/LeadCall.js";
import { leadCallService, canSeeCall, type CallFilters } from "../services/leadCallService.js";
import {
  BACKFILL_DAYS, LINK_TTL_S, callLogPath, checkRecordingLink, getCallSettings, groupRows, leadsByPhone, parseCall, recordingCount,
  recordingPath, recordingSource, syncCalls, syncExtensions,
} from "../services/callSyncService.js";
import { threecxConfigured, threecxFetch, threecxJson, threecxSettings } from "../lib/threecx.js";
import { isSuperAdmin } from "../services/commissionService.js";
import { sendSuccess, sendError } from "../utils/response.js";

/* The 3CX calls (lead_calls): the Calls page, a lead's Calls section and recordings. See leadCallService.ts. */

const viewerOf = (req: AuthenticatedRequest) => ({ userId: req.user!.userId, role: req.user!.role });
const q = (v: unknown) => (typeof v === "string" ? v : undefined);

/** GET /calls/log — the Calls page. `export=1` (the CSV) needs Export on Calls and returns up to 5,000 rows. */
export const getCallLog = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const exporting = req.query.export === "1";
    if (exporting && !isSuperAdmin(req.user!.role) && !req.user!.role?.permissions?.calls?.export) {
      sendError(res, "Access denied: you do not have 'export' permission on 'calls'", 403);
      return;
    }
    const f: CallFilters = {
      preset: q(req.query.preset), from: q(req.query.from), to: q(req.query.to),
      direction: q(req.query.direction), result: q(req.query.result), person: q(req.query.person),
      search: q(req.query.search), sort: q(req.query.sort), order: q(req.query.order),
      page: q(req.query.page), limit: q(req.query.limit),
    };
    const data = await leadCallService.list(viewerOf(req), f, { maxLimit: exporting ? 5000 : 200 });
    sendSuccess(res, "Calls fetched", data);
  } catch (err) {
    next(err);
  }
};

/** GET /calls/log/lead/:leadId — a lead's 3CX calls. */
export const getLeadCallLog = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Lead calls fetched", await leadCallService.forLead(viewerOf(req), req.params.leadId!));
  } catch (err) {
    next(err);
  }
};

/** GET /calls/log/:id/recording-link?index= — a link valid 10 minutes, for whoever may see the call. */
export const getRecordingLink = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id ?? "";
    if (!Types.ObjectId.isValid(id)) { sendError(res, "Call not found", 404); return; }
    const call = await LeadCall.findById(id).lean();
    if (!call) { sendError(res, "Call not found", 404); return; }
    if (!(await canSeeCall(viewerOf(req), call))) { sendError(res, "Access denied: not one of your calls", 403); return; }
    const index = Number.isInteger(Number(req.query.index)) ? Number(req.query.index) : 0;
    if (!recordingSource(call, index)) { sendError(res, "No recording for this call", 404); return; }
    sendSuccess(res, "Recording link", { url: recordingPath(String(call._id), index, req.user!.userId), expiresIn: LINK_TTL_S });
  } catch (err) {
    next(err);
  }
};

const AUDIO_TYPES: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", webm: "audio/webm" };

/**
 * GET /calls/log/recording?c&i&e&u&s — the audio, streamed from 3CX (range requests pass through, so it can be
 * scrubbed). No sign-in header (an <audio> element can't send one): the signed, 10-minute link is the permission.
 */
export const streamRecording = async (req: Request, res: Response): Promise<void> => {
  const params = new URLSearchParams();
  for (const k of ["c", "i", "e", "u", "s"]) params.set(k, typeof req.query[k] === "string" ? (req.query[k] as string) : "");
  const link = checkRecordingLink(params);
  if (!link) { res.status(403).type("text/plain").send("This recording link has expired — play it again from the CRM."); return; }
  const call = await LeadCall.findById(link.callId).lean().catch(() => null);
  const path = recordingSource(call, link.index);
  if (!path) { res.status(404).type("text/plain").send("No recording"); return; }
  const range = req.headers.range;
  let upstream: globalThis.Response;
  try {
    upstream = await threecxFetch(path, { timeoutMs: 180_000, headers: range ? { Range: String(range) } : {} });
  } catch (err) {
    res.status(502).type("text/plain").send(err instanceof Error ? err.message : "3CX did not answer");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(502).type("text/plain").send(`3CX could not give the recording (HTTP ${upstream.status})`);
    return;
  }
  const given = upstream.headers.get("content-type") ?? "";
  const file = (upstream.headers.get("content-disposition") ?? "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? "";
  const ext = (file.split(".").pop() ?? "").toLowerCase();
  res.status(upstream.status);
  res.setHeader("Content-Type", given.startsWith("audio/") ? given : AUDIO_TYPES[ext] ?? "audio/wav");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("Content-Disposition", `inline; filename="call-${link.callId}.${AUDIO_TYPES[ext] ? ext : "wav"}"`);
  // helmet's same-origin default would stop the web app (another origin in production) from playing it.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.end()).pipe(res);
};

/** POST /calls/log/sync — Super Admin: fetch new calls from 3CX now (the first import runs in the background). */
export const syncCallsNow = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!threecxConfigured()) {
      sendError(res, "3CX is not connected — set THREECX_URL, THREECX_CLIENT_ID and THREECX_API_KEY on the server", 400);
      return;
    }
    const s = await getCallSettings();
    const firstImport = `The first import is running — ${BACKFILL_DAYS} days of calls. This can take a few minutes.`;
    if (s.lockUntil && new Date(s.lockUntil).getTime() > Date.now()) {
      sendSuccess(res, s.backfilledAt ? "A sync is already running — new calls show in a minute." : firstImport, { started: true });
      return;
    }
    await syncExtensions().catch(() => null);
    const by = req.user!.email;
    if (!s.backfilledAt) {
      void syncCalls(by);
      sendSuccess(res, firstImport, { started: true });
      return;
    }
    const r = await syncCalls(by);
    if (r.ok) sendSuccess(res, r.inserted ? `${r.inserted} new call(s) with leads` : "Up to date — no new calls with leads", r);
    else sendError(res, r.error || r.skipped || "The sync failed", 400);
  } catch (err) {
    next(err);
  }
};

const DAY_MS = 86_400_000;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * POST /calls/log/test — Super Admin: the 3CX connection step by step, as in CS Portal (2026-10-14): the
 * settings, signing in, 3CX's users and extensions, the last 24 hours of the call log and one recording — with a
 * few rows as 3CX sends them and as they were read. Nothing in 3CX changes; empty extensions are filled in from
 * 3CX by email, as Sync now does.
 */
export const testThreecx = async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const steps: { name: string; ok: boolean; detail: string }[] = [];
    const done = (extra: Record<string, unknown> = {}) =>
      sendSuccess(res, steps.every((x) => x.ok) ? "3CX is connected" : "3CX is not fully connected", { ok: steps.every((x) => x.ok), steps, ...extra });
    if (!threecxConfigured()) {
      steps.push({ name: "Settings", ok: false, detail: "THREECX_URL, THREECX_CLIENT_ID and THREECX_API_KEY are not all set on the server" });
      done();
      return;
    }
    const cfg = threecxSettings();
    steps.push({ name: "Settings", ok: true, detail: `${cfg.url} · client ${cfg.clientId}` });

    try {
      const r = await threecxFetch("/xapi/v1/Defs?$select=Id", { timeoutMs: 30_000 });
      const version = r.headers.get("x-3cx-version") ?? "";
      await r.body?.cancel();
      steps.push({ name: "Sign in", ok: r.ok, detail: r.ok ? `Connected${version ? ` — 3CX ${version}` : ""}` : `HTTP ${r.status}` });
      if (!r.ok) { done(); return; }
    } catch (err) {
      steps.push({ name: "Sign in", ok: false, detail: errText(err) });
      done();
      return;
    }

    try {
      const r = await syncExtensions();
      steps.push({ name: "Extensions", ok: true, detail: `${r.threecxUsers} 3CX users; ${r.matched} matched to CRM users by email${r.updated ? `, ${r.updated} extension(s) filled in` : ""}` });
    } catch (err) {
      steps.push({ name: "Extensions", ok: false, detail: errText(err) });
    }

    let sample: unknown[] = [];
    let parsed: (NonNullable<ReturnType<typeof parseCall>> & { lead: string | null })[] = [];
    try {
      const to = Date.now();
      // The newest 200 rows: a busy day has more, and the oldest would say nothing about now.
      const data = await threecxJson<{ value?: Record<string, unknown>[] }>(callLogPath(to - DAY_MS, to, 0, 200).replace("StartTime%20asc", "StartTime%20desc"));
      const rows = Array.isArray(data?.value) ? data.value : [];
      const groups = groupRows(rows);
      const leads = await leadsByPhone();
      const calls = groups.map((g) => parseCall(g, (k) => leads.has(k))).filter((c): c is NonNullable<typeof c> => !!c);
      steps.push({
        name: "Call log",
        ok: true,
        detail: `${rows.length} rows in the last 24 hours → ${groups.length} calls, ${calls.length} with leads (${calls.filter((c) => recordingCount(c)).length} recorded)`,
      });
      sample = rows.slice(0, 3);
      parsed = calls.slice(0, 5).map((c) => ({ ...c, lead: leads.get(c.numberKey)?.[0]?.name ?? null }));
    } catch (err) {
      steps.push({ name: "Call log", ok: false, detail: errText(err) });
    }

    const recorded = parsed.find((c) => recordingCount(c));
    if (recorded) {
      try {
        const r = await threecxFetch(recordingSource(recorded, 0), { timeoutMs: 60_000, headers: { Range: "bytes=0-1023" } });
        await r.body?.cancel();
        steps.push({ name: "Recordings", ok: r.ok, detail: r.ok ? `A recording opened (${r.headers.get("content-type") || "audio"})` : `HTTP ${r.status}` });
      } catch (err) {
        steps.push({ name: "Recordings", ok: false, detail: errText(err) });
      }
    } else {
      steps.push({ name: "Recordings", ok: true, detail: "No recorded call with a lead in the last 24 hours to try" });
    }
    done({ sample, parsed });
  } catch (err) {
    next(err);
  }
};
