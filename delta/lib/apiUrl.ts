/*
 * The API, called straight from the browser (2026-10-30). Through the site's own /api/v1 (Vercel passing it on)
 * about one call in four never reached the server and came back a 502 after 30 s; the server answers every call
 * made to it directly — as the live socket always has, on this same address. /api/v1 when it isn't set (local).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api/v1").replace(/\/+$/, "");
