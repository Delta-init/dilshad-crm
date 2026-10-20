import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/* ────────────────────────────────────────────────────────────────────────────
   The HRMS's signed integration API (/api/v1/integrations/…), as the Root
   portal and Tetra Commission call it: X-Delta-Client, -Timestamp, -Nonce and
   -Signature — an HMAC of METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n
   sha256(body), byte for byte the HRMS's (a mismatch is a blanket 401). hrmsGet
   reads; hrmsPost / hrmsDelete below book and cancel meeting rooms.
──────────────────────────────────────────────────────────────────────────── */

const TIMEOUT_MS = 8_000;
const apiUrl = () => env.HRMS_API_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");

export const hrmsConfigured = (): boolean => !!(env.HRMS_API_URL && env.HRMS_CLIENT_ID && env.HRMS_INTEGRATION_SECRET);

/** One signed GET; the answer's `data`. Throws with a sentence fit to show. */
export async function hrmsGet<T>(path: string, query: Record<string, string>): Promise<T> {
  // Signed as fetched: the path with its query, built once.
  const signedPath = `/api/v1/integrations${path}?${new URLSearchParams(query).toString()}`;
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const canonical = ["GET", signedPath, timestamp, nonce, createHash("sha256").update("").digest("hex")].join("\n");
  const signature = createHmac("sha256", env.HRMS_INTEGRATION_SECRET).update(canonical).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${signedPath}`, {
      headers: { "X-Delta-Client": env.HRMS_CLIENT_ID, "X-Delta-Timestamp": timestamp, "X-Delta-Nonce": nonce, "X-Delta-Signature": signature },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The HRMS could not be reached");
  }
  if (res.status === 401) throw new Error("The HRMS refused this server's credentials (HRMS_CLIENT_ID / HRMS_INTEGRATION_SECRET)");
  if (res.status === 404) throw new Error("The HRMS does not answer this yet — its server needs the new code");
  if (!res.ok) throw new Error(`The HRMS answered ${res.status}`);
  // A page that isn't the HRMS's API (a maintenance page, the wrong HRMS_API_URL) must read as "can't say", not as
  // an HRMS that knows nobody.
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  if (!body || typeof body !== "object" || !("data" in body)) throw new Error("The HRMS's answer wasn't its API — check HRMS_API_URL");
  return body.data as T;
}

/* ── Writes, and reads whose refusals matter (meeting rooms, 2026-10-19) ─────
   hrmsGet above turns every refusal into one sentence of its own; the meeting
   rooms need the HRMS's own answer instead — "Meeting Room 1 is already booked
   then (Sales CRM · Jalwa)" is the HRMS's to say. A 4xx comes back as an
   HrmsError carrying the HRMS's status and message; the HRMS out of reach or
   failing is a 503; its refusing this server's signature is a 502 (never a
   401, which the web would read as the person's own session ending). The body
   signed is the exact JSON string sent. */

/** A refusal from the HRMS, or the HRMS out of reach: `status` and `message` are fit to pass on as they are. */
export class HrmsError extends Error {
  readonly statusCode: number;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HrmsError";
    this.statusCode = status;
  }
}

function signedHeaders(method: string, signedPath: string, rawBody: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const canonical = [method, signedPath, timestamp, nonce, createHash("sha256").update(rawBody).digest("hex")].join("\n");
  return {
    "X-Delta-Client": env.HRMS_CLIENT_ID,
    "X-Delta-Timestamp": timestamp,
    "X-Delta-Nonce": nonce,
    "X-Delta-Signature": createHmac("sha256", env.HRMS_INTEGRATION_SECRET).update(canonical).digest("hex"),
  };
}

/** One signed request; the answer's `data`. Throws an HrmsError (see above). */
export async function hrmsRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const signedPath = `/api/v1/integrations${path}${qs ? `?${qs}` : ""}`;
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${signedPath}`, {
      method,
      headers: { ...signedHeaders(method, signedPath, rawBody), ...(rawBody ? { "Content-Type": "application/json" } : {}) },
      ...(rawBody ? { body: rawBody } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HrmsError("The HRMS could not be reached — try again in a moment", 503);
  }
  const answer = (await res.json().catch(() => null)) as { data?: T; message?: unknown } | null;
  const said = answer && typeof answer.message === "string" && answer.message.trim() ? answer.message.trim() : "";
  if (res.status === 401) throw new HrmsError("The HRMS refused this server's credentials (HRMS_CLIENT_ID / HRMS_INTEGRATION_SECRET)", 502);
  if (res.status >= 500) throw new HrmsError(`The HRMS isn't answering right now (${res.status}) — try again in a moment`, 503);
  if (!res.ok) throw new HrmsError(said || `The HRMS refused this (${res.status})`, res.status);
  if (!answer || typeof answer !== "object" || !("data" in answer)) throw new HrmsError("The HRMS's answer wasn't its API — check HRMS_API_URL", 502);
  return answer.data as T;
}

/** A signed POST of `body` (as JSON); the answer's `data`. */
export const hrmsPost = <T>(path: string, body: unknown, query: Record<string, string> = {}): Promise<T> =>
  hrmsRequest<T>("POST", path, query, body);

/** A signed DELETE; the answer's `data`. */
export const hrmsDelete = <T>(path: string, query: Record<string, string>): Promise<T> =>
  hrmsRequest<T>("DELETE", path, query);
