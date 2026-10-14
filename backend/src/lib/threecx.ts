/* ────────────────────────────────────────────────────────────────────────────
   The 3CX API (XAPI, V20) for the call sync — Tetra Commission's client
   (backend/src/lib/threecx.ts there), adapted.

   Sign in with the API client (client credentials, token valid an hour), then
   plain GETs — and, since 2026-10-14, the Call button's Call Control requests
   (threecxPost: makecall on the caller's own extension, and dropping their own
   leg of a call). Nothing else changes anything on the phone system.

   Connected only when THREECX_URL, THREECX_CLIENT_ID and THREECX_API_KEY are
   all set — read from the environment each time, with no defaults, so a copy
   of the CRM run without them never reaches the real 3CX. (The older
   click-to-call / journal code in callController.ts keeps its own client.)
──────────────────────────────────────────────────────────────────────────── */

export function threecxSettings(): { url: string; clientId: string; apiKey: string } {
  return {
    url: (process.env.THREECX_URL ?? "").trim().replace(/\/+$/, ""),
    clientId: (process.env.THREECX_CLIENT_ID ?? "").trim(),
    apiKey: (process.env.THREECX_API_KEY ?? "").trim(),
  };
}

export const threecxConfigured = (): boolean => {
  const s = threecxSettings();
  return !!(s.url && s.clientId && s.apiKey);
};

export class ThreecxError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

let token: { value: string; until: number; for: string } | null = null;

async function getToken(fresh = false): Promise<string> {
  const s = threecxSettings();
  const who = `${s.url}|${s.clientId}`;
  if (!fresh && token && token.for === who && Date.now() < token.until) return token.value;
  let res: Response;
  try {
    res = await fetch(`${s.url}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId, client_secret: s.apiKey }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ThreecxError(`Could not reach 3CX at ${s.url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new ThreecxError(
      res.status === 400 || res.status === 401 ? "3CX refused the API client ID / key" : `3CX sign-in failed (HTTP ${res.status})`,
      res.status,
    );
  }
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) throw new ThreecxError("3CX gave no access token");
  const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  token = { value: String(data.access_token), until: Date.now() + Math.max(60, seconds - 60) * 1000, for: who };
  return token.value;
}

/** A request on the 3CX API (`path` starts with /xapi/… or /callcontrol/…; GET unless told). Signs in again once if
 *  the token was refused. */
export async function threecxFetch(
  path: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Response> {
  if (!threecxConfigured()) throw new ThreecxError("3CX is not connected (THREECX_URL / THREECX_CLIENT_ID / THREECX_API_KEY)");
  const { url } = threecxSettings();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: { Authorization: `Bearer ${await getToken(attempt > 0)}`, ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      if (err instanceof ThreecxError) throw err;
      throw new ThreecxError(`3CX did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401 && attempt === 0) continue;
    return res;
  }
}

/** A GET that must return JSON; a clear error otherwise (403 = the API client's role is too low). */
export async function threecxJson<T = unknown>(path: string, timeoutMs = 120_000): Promise<T> {
  const res = await threecxFetch(path, { timeoutMs });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const what = path.split("?")[0]!.replace(/\(.*$/, "");
    throw new ThreecxError(
      res.status === 403
        ? `3CX refused ${what} (403) — give the API client the System Owner role`
        : `3CX ${what} failed (HTTP ${res.status})${body ? `: ${body}` : ""}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/** A JSON POST (Call Control: makecall, drop). */
export async function threecxPost(path: string, payload: unknown, timeoutMs = 30_000): Promise<Response> {
  return threecxFetch(path, { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" }, timeoutMs });
}
