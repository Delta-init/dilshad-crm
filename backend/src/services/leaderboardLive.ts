import type { Namespace, Server } from "socket.io";
import { LeaderboardService, dubaiMonthRange, rerankLeaderboard, type Leaderboard, type RankBy } from "./leaderboardService.js";

/**
 * The open leaderboard, live (the owner, 2026-10-15: "display it on a TV — live over the socket, and re-order").
 *
 * Screens join the socket's /public-leaderboard namespace — no sign-in; the main namespace keeps its own token
 * check. While at least one is there, this counts the month's board again and again — every 5 seconds while a count
 * is cheap, less often when it isn't (counting never takes more than about a twentieth of the time, and never waits
 * more than a minute) — and when anything on it has changed, it tells every screen "changed": the month and when,
 * nothing else — no names, no figures. The screens then fetch GET /public/leaderboard, answered from that same count
 * in whatever ranking they show. A screen is also told once as it joins. Nobody watching (for 15 s — a TV reloading
 * comes straight back), nothing runs; and only one count of the watcher's runs at a time, however often screens come
 * and go. Screens never send anything; anything they do send is ignored. One screen per connection, 200 at most.
 *
 * The open board's other answers (another month, or nobody watching) are kept 15 s, the same ones asked for at once
 * are counted once, and at most two are counted at a time.
 */

export const PUBLIC_LEADERBOARD_NAMESPACE = "/public-leaderboard";
export const LEADERBOARD_CHANGED = "leaderboard:changed";
/** The quickest the board is counted again while somebody is watching… */
export const LIVE_EVERY_MS = 5_000;
/** …and the slowest, when counting is slow: the next count waits 20 times as long as the last one took. */
export const LIVE_SLOWEST_MS = 60_000;
const LIVE_PACE = 20;
/** Open to anyone, so capped; a screen turned away still refreshes every 30 s. */
export const MAX_SCREENS = 200;
/** How long the watch goes on after the last screen leaves. */
export const LINGER_MS = 15_000;

const service = new LeaderboardService();

/** The open route counting more than it can: it answers 503 and the screen asks again on its next refresh. */
export class LeaderboardBusyError extends Error {}

/* ── The open board's answers ────────────────────────────────────────────── */

const TTL_MS = 15_000;
const MAX_KEPT = 50;
const MAX_COUNTING = 2;
const MAX_WAITING = 100;
const kept = new Map<string, { at: number; value: Leaderboard }>();
const counting = new Map<string, Promise<Leaderboard>>();
/** Bumped whenever the watcher sees a change: a count started before it can't be kept over the fresh one. */
let generation = 0;

let slotsTaken = 0;
const waitingForSlot: Array<() => void> = [];
function takeSlot(): Promise<void> {
  if (slotsTaken < MAX_COUNTING) {
    slotsTaken++;
    return Promise.resolve();
  }
  if (waitingForSlot.length >= MAX_WAITING) return Promise.reject(new LeaderboardBusyError("The leaderboard is busy — try again in a moment"));
  return new Promise((resolve) => waitingForSlot.push(resolve)); // the slot is handed over by giveSlot
}
function giveSlot(): void {
  const next = waitingForSlot.shift();
  if (next) next();
  else slotsTaken--;
}

/**
 * The open board; this Dubai month when no month is given. While the board is watched live, this month's comes from
 * the watcher's latest count, in any ranking. Otherwise kept 15 s; the same one asked for at once is counted once.
 */
export async function getPublicLeaderboard(month: string | undefined, rankBy: RankBy): Promise<Leaderboard> {
  const watched = latestWatched();
  if (watched && (month === undefined || month === watched.month)) return rerankLeaderboard(watched, rankBy);

  const key = `${month ?? dubaiMonthRange().month}|${rankBy}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const already = counting.get(key);
  if (already) return already;

  const startedIn = generation;
  const at = Date.now();
  const count = (async () => {
    await takeSlot();
    try {
      return await service.getLeaderboard(month, rankBy);
    } finally {
      giveSlot();
    }
  })();
  counting.set(key, count);
  try {
    const value = await count;
    if (startedIn === generation) keep(key, at, value); // not if the board changed while this was counted
    return value;
  } finally {
    counting.delete(key);
  }
}

function keep(key: string, at: number, value: Leaderboard): void {
  for (const [k, v] of kept) if (Date.now() - v.at >= TTL_MS) kept.delete(k);
  kept.delete(key);
  while (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value as string); // the oldest first
  kept.set(key, { at, value });
}

/* ── Watching ────────────────────────────────────────────────────────────── */

let timer: ReturnType<typeof setTimeout> | null = null;
let linger: ReturnType<typeof setTimeout> | null = null;
let watching = false;
/** The watcher's count under way — shared by every watch, so coming and going can't start counts side by side. */
let watcherCount: Promise<Leaderboard> | null = null;
/** A look from a watch that has since stopped changes nothing. */
let watch = 0;
/** The board as last counted by the watcher, and when; how long until the next count. */
let latest: { board: Leaderboard; at: number } | null = null;
let nextInMs = LIVE_EVERY_MS;
/** The board as last seen, as one string; empty until the first look of a watch. */
let lastSeen = "";
/** What the screens were last told — a screen joining a running watch is told it too. */
let lastTold: { month: string; at: string } | null = null;
let lastWarned = 0;

/** The watcher's count of this month, while it is current (and the month hasn't turned since). */
function latestWatched(): Leaderboard | null {
  if (!watching || !latest) return null;
  if (Date.now() - latest.at > nextInMs + LIVE_EVERY_MS) return null;
  if (latest.board.month !== dubaiMonthRange().month) return null;
  return latest.board;
}

/** Everything a screen shows, in one string — two looks compare in one go. */
function signatureOf(board: Leaderboard): string {
  const rows = [...board.rows]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map((r) => [
      r.userId, r.name, r.revenue, r.closings, r.followUps, r.calls, r.connected, r.talkSeconds,
      r.callsToday, r.connectedToday, r.talkSecondsToday, Object.entries(r.leadCounts).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  return JSON.stringify([board.month, rows]);
}

async function look(nsp: Namespace, thisWatch: number): Promise<void> {
  const started = Date.now();
  try {
    watcherCount ??= service.getLeaderboard(undefined, "revenue").finally(() => {
      watcherCount = null;
    });
    const board = await watcherCount;
    if (thisWatch !== watch) return;
    latest = { board, at: Date.now() };
    const seen = signatureOf(board);
    // The first look of a watch says "changed" too: what the screens were sent may be up to 15 s old.
    if (seen !== lastSeen) {
      generation++;
      kept.clear();
      lastSeen = seen;
      lastTold = { month: board.month, at: board.updatedAt };
      nsp.emit(LEADERBOARD_CHANGED, lastTold);
    }
  } catch (err) {
    if (Date.now() - lastWarned > 60_000) {
      lastWarned = Date.now();
      console.warn("⚠️  Live leaderboard: couldn't count the board —", err instanceof Error ? err.message : err);
    }
  } finally {
    if (thisWatch === watch && watching) {
      nextInMs = Math.min(LIVE_SLOWEST_MS, Math.max(LIVE_EVERY_MS, (Date.now() - started) * LIVE_PACE));
      timer = setTimeout(() => void look(nsp, thisWatch), nextInMs);
    }
  }
}

function startWatching(nsp: Namespace): void {
  if (watching) return;
  watching = true;
  watch++;
  latest = null;
  lastSeen = "";
  lastTold = null;
  nextInMs = LIVE_EVERY_MS;
  void look(nsp, watch);
}

function stopWatching(): void {
  if (!watching) return;
  watching = false;
  watch++;
  if (timer) clearTimeout(timer);
  timer = null;
  latest = null;
  lastSeen = "";
  lastTold = null;
}

/** For the checks: who is watching, who is still joining, and how often the board is counted. */
export function liveLeaderboardState(): { screens: number; joining: number; watching: boolean; everyMs: number } {
  return { screens: namespace?.sockets.size ?? 0, joining: joining.size, watching, everyMs: nextInMs };
}

let namespace: Namespace | null = null;
/** Connections whose screen passed the door but isn't in yet — they count towards the cap too. */
const joining = new Set<object>();
/** Each joining connection's "gone before it got in" listener, taken off once it's in. */
const onCloseOf = new WeakMap<object, () => void>();

/** Opens the /public-leaderboard namespace on the CRM's socket server. */
export function startLeaderboardLive(io: Server): Namespace {
  const nsp = io.of(PUBLIC_LEADERBOARD_NAMESPACE);
  namespace = nsp;
  nsp.use((socket, next) => {
    const conn = socket.conn;
    // One screen per connection: a pile of joins in one request can't fill the namespace.
    if (joining.has(conn) || [...nsp.sockets.values()].some((s) => s.conn === conn)) {
      next(new Error("This connection already has a screen"));
      return;
    }
    if (nsp.sockets.size + joining.size >= MAX_SCREENS) {
      next(new Error("Too many screens — this one refreshes every 30 seconds instead"));
      return;
    }
    joining.add(conn);
    const gone = () => {
      joining.delete(conn);
      onCloseOf.delete(conn);
    };
    onCloseOf.set(conn, gone);
    conn.once("close", gone); // gone before it got in
    next();
  });
  nsp.on("connection", (socket) => {
    joining.delete(socket.conn);
    const gone = onCloseOf.get(socket.conn);
    if (gone) {
      socket.conn.off("close", gone);
      onCloseOf.delete(socket.conn);
    }
    if (linger) {
      clearTimeout(linger);
      linger = null;
    }
    // Joining a running watch: told now. Joining before its first look has finished: that look tells everyone.
    if (lastTold) socket.emit(LEADERBOARD_CHANGED, lastTold);
    startWatching(nsp);
    // Gone from the namespace by the time this runs. The last one gone: watch a little longer — a TV reloading comes
    // straight back, and coming and going can't restart the counting.
    socket.on("disconnect", () => {
      if (nsp.sockets.size > 0) return;
      if (linger) clearTimeout(linger);
      linger = setTimeout(() => {
        linger = null;
        if (nsp.sockets.size === 0) stopWatching();
      }, LINGER_MS);
    });
  });
  return nsp;
}
