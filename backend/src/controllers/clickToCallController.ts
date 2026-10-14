import type { Response, NextFunction } from "express";
import { Types } from "mongoose";
import type { AuthenticatedRequest } from "../types/index.js";
import { Lead } from "../models/Lead.js";
import { User } from "../models/User.js";
import { canWorkLead } from "../services/leadCallService.js";
import { phoneKey, phoneKeysOf } from "../services/callSyncService.js";
import { ThreecxError, threecxConfigured, threecxFetch, threecxPost, threecxSettings } from "../lib/threecx.js";
import { sendSuccess, sendError } from "../utils/response.js";

/* ────────────────────────────────────────────────────────────────────────────
   The Call button through 3CX — Tetra Commission's (backend/src/functions/
   studentCalls.ts there), for leads (2026-10-14).

   A "3CX call": 3CX rings the caller's OWN extension (their 3CX web client or
   app — Call Control makecall from a device signed in on it), they answer, and
   3CX dials the lead. The call window then follows that call on their own
   extension (ringing / calling / connected / ended) and can hang up their own
   leg. Nothing here ever touches another person's extension: the extension is
   always the caller's own, read from their user, never from the request.

   The call itself reaches lead_calls (and the lead's counts) with the call sync,
   like any other call.
──────────────────────────────────────────────────────────────────────────── */

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The caller's 3CX extension — typed on the Users screen, or filled in from 3CX by email. */
async function extensionOf(userId: string): Promise<string> {
  if (!Types.ObjectId.isValid(userId)) return "";
  const me = await User.findById(userId).select("extension").lean<{ extension?: string | null } | null>();
  return str(me?.extension, 10);
}

/** Refusals the web shows as they are: `code` says which, so the call choice can explain it. */
function refuse(res: Response, status: number, code: string, text: string, extra: Record<string, unknown> = {}) {
  sendError(res, text, status, { code, ...extra });
}

/**
 * GET /calls/click-to-call — whether this person's Call buttons can place a 3CX call: 3CX connected and their
 * extension known. `webClientUrl` is where their 3CX web client opens.
 */
export const getClickToCall = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const extension = await extensionOf(req.user!.userId);
    const connected = threecxConfigured();
    sendSuccess(res, "Click to call", {
      enabled: connected && !!extension,
      connected,
      extension,
      webClientUrl: connected ? threecxSettings().url : "",
    });
  } catch (err) {
    next(err);
  }
};

interface Device { device_id?: string | number; user_agent?: string; dn?: string }

/** Which signed-in app 3CX should ring: the web client first, then the desktop app — never the phone app alone (as
 *  the Sales CRM and Tetra Commission: a call placed on it is not one the CRM can follow). */
export function pickDevice(devices: Device[]): Device | null {
  const ua = (d: Device) => String(d?.user_agent ?? "");
  return devices.find((d) => /web|browser|webrtc/i.test(ua(d)))
    ?? devices.find((d) => ua(d) && !/mobile|android|iphone|ios/i.test(ua(d)))
    ?? null;
}

/** 3CX's participant status → the call window's stage. */
export function stageOf(status: string): "ringing" | "calling" | "connected" | "other" {
  if (/connect/i.test(status)) return "connected";
  if (/dial/i.test(status)) return "calling";
  if (/ring/i.test(status)) return "ringing";
  return "other";
}

/** A refusal for every way 3CX Call Control can't be used for this person; null when it can. */
async function callControlFor(req: AuthenticatedRequest, res: Response): Promise<string | null> {
  if (!threecxConfigured()) {
    refuse(res, 409, "not_connected", "3CX is not connected on this server — use Phone call");
    return null;
  }
  const extension = await extensionOf(req.user!.userId);
  if (!extension) {
    refuse(res, 409, "no_extension", "Your 3CX extension is not set — an admin adds it on the Users screen (or it is filled in from 3CX by your email)");
    return null;
  }
  return extension;
}

/**
 * POST /calls/3cx/call { leadId, dial? } — the Call button's "3CX call". Only for a lead the caller's lead list shows
 * (and with Edit on Leads — the route); `dial` must be one of the lead's numbers (the first when none is given).
 * Refused when 3CX isn't connected, the caller has no extension, or nothing is signed in on it.
 */
export const startThreecxCall = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const leadId = str(req.body?.leadId, 40);
    if (!Types.ObjectId.isValid(leadId)) { sendError(res, "leadId is required", 400); return; }
    const lead = await Lead.findById(leadId).select("name phone").lean<{ _id: Types.ObjectId; name?: string; phone?: string } | null>();
    if (!lead) { sendError(res, "Lead not found", 404); return; }
    if (!(await canWorkLead({ userId: req.user!.userId, role: req.user!.role }, lead._id))) {
      refuse(res, 403, "not_yours", "You can call only leads in your own lead list");
      return;
    }
    const extension = await callControlFor(req, res);
    if (!extension) return;

    const numbers = String(lead.phone ?? "").split(/[\n\r/,;|]+| - /).map((n) => n.trim()).filter((n) => phoneKey(n));
    const asked = str(req.body?.dial, 24);
    const raw = asked || numbers[0] || "";
    const dial = raw.replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(dial) || !phoneKeysOf(lead.phone).includes(phoneKey(dial))) {
      sendError(res, "That number is not on this lead", 400);
      return;
    }

    const ext = encodeURIComponent(extension);
    const webClientUrl = threecxSettings().url;
    const state = await threecxFetch(`/callcontrol/${ext}`, { timeoutMs: 15_000 });
    if (!state.ok) {
      await state.body?.cancel();
      sendError(res, state.status === 404 ? `3CX has no extension ${extension}`
        : state.status === 403 ? `3CX does not let the CRM control extension ${extension} — check the API client's Call Control access in 3CX`
        : `3CX could not look up extension ${extension} (HTTP ${state.status})`, 502);
      return;
    }
    const dn = (await state.json().catch(() => null)) as { devices?: Device[] } | null;
    const device = pickDevice(Array.isArray(dn?.devices) ? dn!.devices : []);
    if (!device) {
      refuse(res, 409, "no_device",
        `Your 3CX web client or desktop app is not open on extension ${extension} (the phone app alone can't take it) — open your 3CX app or web client, let it use the microphone, then call again`,
        { webClientUrl });
      return;
    }

    // That device by itself; the extension as a whole if 3CX will not take the device (it still rings the app).
    let r = await threecxPost(`/callcontrol/${ext}/devices/${encodeURIComponent(String(device.device_id ?? ""))}/makecall`, { destination: dial, timeout: 30 });
    if (!r.ok && r.status !== 403) {
      await r.body?.cancel();
      r = await threecxPost(`/callcontrol/${ext}/makecall`, { destination: dial, timeout: 30 });
    }
    const out = (await r.json().catch(() => null)) as { finalstatus?: string; reason?: string; reasontext?: string; result?: { id?: number; callid?: number } } | null;
    if (!r.ok || /fail/i.test(String(out?.finalstatus ?? ""))) {
      const said = String(out?.reasontext || out?.reason || "").trim();
      sendError(res, `3CX could not place the call — ${r.status === 403 ? `the API client may not control extension ${extension}`
        : r.status === 424 ? "your 3CX app did not answer 3CX" : said || `HTTP ${r.status}`}`, 502);
      return;
    }
    const app = String(device.user_agent ?? "") || "3CX app";
    sendSuccess(res, `Calling ${lead.name || dial} through 3CX`, {
      extension, dial, device: app, leadId: String(lead._id), leadName: lead.name ?? "",
      callId: out?.result?.callid ?? null, participantId: out?.result?.id ?? null,
    });
  } catch (err) {
    if (err instanceof ThreecxError) { sendError(res, message(err), 502); return; }
    next(err);
  }
};

interface Participant { id?: number; status?: string; callid?: number; party_caller_id?: string; party_caller_name?: string; party_dn?: string }

/**
 * GET /calls/3cx/state?callId=&dial= — the call window: this call on the caller's OWN extension as 3CX has it now.
 * `participant` null = no such call there (not started yet, or ended).
 */
export const getMyCallState = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const extension = await callControlFor(req, res);
    if (!extension) return;
    const callId = Number(req.query.callId) || 0;
    const key = phoneKey(str(req.query.dial, 24));
    const r = await threecxFetch(`/callcontrol/${encodeURIComponent(extension)}`, { timeoutMs: 10_000 });
    if (!r.ok) {
      await r.body?.cancel();
      sendError(res, `3CX could not look up extension ${extension} (HTTP ${r.status})`, 502);
      return;
    }
    const dn = (await r.json().catch(() => null)) as { participants?: Participant[]; devices?: Device[] } | null;
    const parts = Array.isArray(dn?.participants) ? dn!.participants : [];
    // This call: by its 3CX call id, else by the lead's number, else the only one there is.
    const mine = parts.find((p) => callId && Number(p?.callid) === callId)
      ?? parts.find((p) => key && [p?.party_caller_id, p?.party_dn].some((n) => phoneKey(String(n ?? "")) === key))
      ?? (parts.length === 1 ? parts[0] : null);
    sendSuccess(res, "Call state", {
      extension,
      devices: (Array.isArray(dn?.devices) ? dn!.devices : []).map((d) => String(d?.user_agent ?? "")).filter(Boolean),
      participant: mine ? {
        id: mine.id ?? null,
        status: String(mine.status ?? ""),
        stage: stageOf(String(mine.status ?? "")),
        callId: mine.callid ?? null,
        party: String(mine.party_caller_name || mine.party_caller_id || mine.party_dn || ""),
      } : null,
    });
  } catch (err) {
    if (err instanceof ThreecxError) { sendError(res, message(err), 502); return; }
    next(err);
  }
};

/**
 * POST /calls/3cx/hang-up { participantId } — drops the caller's own leg of a call (3CX "drop"), only when that
 * participant is on their own extension right now.
 */
export const hangUpMyCall = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = Number(req.body?.participantId);
    if (!Number.isInteger(id) || id <= 0) { sendError(res, "participantId is required", 400); return; }
    const extension = await callControlFor(req, res);
    if (!extension) return;
    const ext = encodeURIComponent(extension);
    const look = await threecxFetch(`/callcontrol/${ext}`, { timeoutMs: 10_000 });
    if (!look.ok) {
      await look.body?.cancel();
      sendError(res, `3CX could not look up extension ${extension} (HTTP ${look.status})`, 502);
      return;
    }
    const dn = (await look.json().catch(() => null)) as { participants?: Participant[] } | null;
    if (!(Array.isArray(dn?.participants) ? dn!.participants : []).some((p) => Number(p?.id) === id)) {
      sendError(res, "That call is not on your extension (it may have ended already)", 404);
      return;
    }
    const r = await threecxPost(`/callcontrol/${ext}/participants/${id}/drop`, {});
    const out = (await r.json().catch(() => null)) as { reason?: string; reasontext?: string } | null;
    if (!r.ok) {
      sendError(res, `3CX could not hang up — ${String(out?.reasontext || out?.reason || "").trim() || `HTTP ${r.status}`}`, 502);
      return;
    }
    sendSuccess(res, "Hung up", { ok: true });
  } catch (err) {
    if (err instanceof ThreecxError) { sendError(res, message(err), 502); return; }
    next(err);
  }
};
