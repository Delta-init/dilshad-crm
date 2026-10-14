import { useSyncExternalStore } from "react";
import { fmtAcademy } from "@/lib/currency";
import { getActiveCurrency } from "@/lib/store/currencyStore";

/*
 * A closed sale, celebrated on every screen signed in to the CRM (the user,
 * 2026-10-15), the free way: a sparkle made here with WebAudio and the
 * browser's own voice (speechSynthesis), so there are no audio files and
 * nothing is paid for. The server sends "sale:closed" the moment a close is
 * saved (saleAnnouncement.ts there), and SaleCelebration shows it.
 *
 * The sound and voice can be muted per device; the pop-up always shows. With
 * the CRM open in several tabs only one of them speaks, the one on screen
 * when there is one.
 */

export const SALE_CLOSED_EVENT = "sale:closed";
/** The bell's test: the same pop-up, sound and voice, on this device only. */
export const SALE_TEST_EVENT = "crm:sale-closed-test";

export interface SaleClosed {
  /** The enrolment's id. */
  id: string;
  /** Who closed it: the lead's salesperson. */
  closer: string;
  student: string;
  courses: string[];
  /** The course fee, in the academy's currency. */
  amount: number;
  academy: "dubai" | "bangalore";
  at: string;
  /** From the bell's test: plays even when muted, and every tab says it. */
  test?: boolean;
}

/** A payload to show, or null. An older server may send less than this. */
export function asSale(v: unknown): SaleClosed | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  return {
    id: o.id,
    closer: text(o.closer),
    student: text(o.student),
    courses: Array.isArray(o.courses) ? o.courses.map(text).filter(Boolean) : [],
    amount: Math.max(0, Number(o.amount) || 0),
    academy: o.academy === "bangalore" ? "bangalore" : "dubai",
    at: text(o.at) || new Date().toISOString(),
    test: o.test === true,
  };
}

// ── What it says ──────────────────────────────────────────────────────────────

const CURRENCY_WORDS: Record<string, string> = {
  USD: "dollars", INR: "rupees", AED: "dirhams", EUR: "euros", GBP: "pounds", SAR: "riyals",
  CAD: "Canadian dollars", AUD: "Australian dollars", SGD: "Singapore dollars", JPY: "yen", MYR: "ringgit",
};

/**
 * The fee as the screen shows it, and as the voice says it. A Bangalore close
 * is in rupees; any other uses the screen's currency, as everywhere else. Null
 * when there is no fee.
 */
export function saleMoney(sale: SaleClosed): { shown: string; spoken: string } | null {
  if (!(sale.amount > 0)) return null;
  const code = sale.academy === "bangalore" ? "INR" : getActiveCurrency().code;
  // Grouped in thousands, which every English voice reads as a number.
  const plain = sale.amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return { shown: fmtAcademy(sale.amount, sale.academy), spoken: `${plain} ${CURRENCY_WORDS[code] ?? code}` };
}

/** "A", "A and B", "A, B and C". */
function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Sale closed by Abhin! John Mathew enrolled in Forex Mastery, for 5,500 dollars. Congratulations!" */
export function spokenLine(sale: SaleClosed): string {
  const money = saleMoney(sale);
  const courses = listed(sale.courses);
  let line = sale.closer ? `Sale closed by ${sale.closer}! ` : "Sale closed! ";
  line += `${sale.student || "A new student"} enrolled${courses ? ` in ${courses}` : ""}`;
  if (money) line += `, for ${money.spoken}`;
  return `${line}. Congratulations!`;
}

// ── Mute, per device ──────────────────────────────────────────────────────────

const SOUND_KEY = "crm_sale_sound";
const SOUND_CHANGED = "crm:sale-sound";
/** Muted in this tab, for a browser that keeps nothing (a private window). */
let mutedHere = false;

export function saleSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return !mutedHere;
  }
}

export function setSaleSoundOn(on: boolean): void {
  mutedHere = !on;
  try {
    if (on) localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, "off");
  } catch {
    /* kept for this tab only */
  }
  if (!on) stopVoice();
  window.dispatchEvent(new Event(SOUND_CHANGED));
}

function onSoundChange(cb: () => void): () => void {
  const fromOtherTab = (e: StorageEvent) => {
    if (e.key === SOUND_KEY || e.key === null) cb();
  };
  window.addEventListener(SOUND_CHANGED, cb);
  window.addEventListener("storage", fromOtherTab);
  return () => {
    window.removeEventListener(SOUND_CHANGED, cb);
    window.removeEventListener("storage", fromOtherTab);
  };
}

/** Whether sale sound and voice are on for this device, kept current. */
export function useSaleSoundOn(): boolean {
  return useSyncExternalStore(onSoundChange, saleSoundOn, () => true);
}

// ── The sparkle ───────────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

// Browsers keep a page silent until somebody clicks or types on it: start the
// sound then, once, so a close that comes later can be heard.
if (typeof window !== "undefined") {
  const wake = () => {
    audio();
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
  };
  window.addEventListener("pointerdown", wake, true);
  window.addEventListener("keydown", wake, true);
}

/** A glassy "ting": a sine with two quiet overtones, struck and left to ring. */
function ting(ac: AudioContext, out: AudioNode, freq: number, at: number, level: number, ring: number): void {
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(level, at + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, at + ring);
  env.connect(out);
  for (const [mult, part] of [[1, 1], [2.76, 0.22], [5.4, 0.07]] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    gain.gain.value = part;
    osc.connect(gain).connect(env);
    osc.start(at);
    osc.stop(at + ring + 0.05);
  }
}

/**
 * The glitter sound: a quick harp-like run up a pentatonic scale, then a
 * scatter of high twinkles, with a short echo for shimmer. Returns how long to
 * wait before the voice, in ms (0 when this browser has no sound).
 */
export function playSparkle(): number {
  const ac = audio();
  if (!ac) return 0;
  const t0 = ac.currentTime + 0.03;
  const master = ac.createDynamicsCompressor();
  master.connect(ac.destination);
  const out = ac.createGain();
  out.gain.value = 0.9;
  out.connect(master);
  const echo = ac.createDelay(0.5);
  echo.delayTime.value = 0.11;
  const feedback = ac.createGain();
  feedback.gain.value = 0.32;
  const wet = ac.createGain();
  wet.gain.value = 0.3;
  out.connect(echo);
  echo.connect(feedback).connect(echo);
  echo.connect(wet).connect(master);

  const run = [1046.5, 1174.66, 1318.51, 1567.98, 1760, 2093, 2349.32, 2637.02, 3135.96, 3520, 4186.01];
  run.forEach((f, i) => ting(ac, out, f, t0 + i * 0.042, 0.2, 0.5));
  const top = [2093, 2637.02, 3135.96, 3520, 4186.01, 5274.04];
  for (let i = 0; i < 10; i++) {
    const f = top[Math.floor(Math.random() * top.length)];
    ting(ac, out, f, t0 + 0.42 + i * 0.075 + Math.random() * 0.03, 0.09 + Math.random() * 0.05, 0.35);
  }
  // Let go of it once it has rung out.
  window.setTimeout(() => {
    for (const node of [out, echo, feedback, wet, master]) node.disconnect();
  }, 3000);
  return 1100;
}

// ── The voice ─────────────────────────────────────────────────────────────────

let voices: SpeechSynthesisVoice[] = [];

function loadVoices(): void {
  try {
    voices = window.speechSynthesis.getVoices();
  } catch {
    voices = [];
  }
}

/** Ask for the voices early: Chrome lists them a moment after the page loads. */
export function warmUpVoices(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  loadVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

/** The joke and robot voices a Mac lists beside the real ones: never chosen. */
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Princess|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

/** Voices by name, best first: Chrome's, then a Mac's own, then Windows' own. */
const NAMED = [
  "Google UK English Female", "Google US English", "Google UK English Male",
  "Samantha", "Ava", "Allison", "Susan", "Zoe", "Daniel", "Karen", "Moira", "Tessa", "Serena",
  "Microsoft Zira", "Microsoft David", "Microsoft Mark", "Microsoft Heera", "Microsoft Ravi",
];

/** Best first; the first test any voice passes picks it. */
const PREFERRED: ((v: SpeechSynthesisVoice) => boolean)[] = [
  (v) => /^en[-_]IN/i.test(v.lang) && /natural/i.test(v.name), // Edge's neural Indian English
  (v) => /natural/i.test(v.name), // any neural voice (Edge)
  (v) => /premium|enhanced/i.test(v.name), // a Mac's downloaded voices
  ...NAMED.map((name) => (v: SpeechSynthesisVoice) => v.name.startsWith(name)),
  (v) => /^en[-_]IN/i.test(v.lang),
  (v) => v.default,
  () => true,
];

/** The best English voice on this device. Null leaves it to the browser. */
function bestVoice(): SpeechSynthesisVoice | null {
  if (!voices.length) loadVoices();
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  for (const test of PREFERRED) {
    const found = english.find(test);
    if (found) return found;
  }
  return null;
}

/** Says it in the browser's own voice. Free: nothing leaves the device. */
export function say(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = bestVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "en-US";
  }
  utterance.rate = 0.98;
  utterance.pitch = 1.05;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
}

export function stopVoice(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* no voice here */
  }
}

export function voiceBusy(): boolean {
  try {
    return Boolean(window.speechSynthesis?.speaking);
  } catch {
    return false;
  }
}

// ── One tab says it ───────────────────────────────────────────────────────────

const SAID = "crm_sale_said:";
const TAB = Math.random().toString(36).slice(2);
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Whether this tab is the one to say it. With the CRM open in several tabs
 * only one speaks: the one on screen goes first, the others a moment later and
 * stand down. Agreed through localStorage. When there is none, every tab says it.
 */
async function claimToSay(id: string): Promise<boolean> {
  await sleep(document.visibilityState === "visible" ? Math.random() * 40 : 300 + Math.random() * 200);
  try {
    const key = SAID + id;
    if (localStorage.getItem(key)) return false;
    const mine = `${TAB}:${Date.now()}`;
    localStorage.setItem(key, mine);
    // Two tabs that wrote at once: the last write stands.
    await sleep(60);
    const won = localStorage.getItem(key) === mine;
    forgetOldClaims();
    return won;
  } catch {
    return true;
  }
}

function forgetOldClaims(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.startsWith(SAID)) continue;
    const at = Number(localStorage.getItem(key)?.split(":")[1]);
    if (!(at > cutoff)) localStorage.removeItem(key);
  }
}

/**
 * The sparkle, then the voice, for a sale on screen. Nothing when muted; a test
 * always plays. Returns a stop, for when it leaves the screen.
 */
export function announce(sale: SaleClosed): () => void {
  let stopped = false;
  let voiceTimer: number | undefined;
  const allowed = () => !stopped && (sale.test || saleSoundOn());
  void (async () => {
    if (!allowed()) return;
    if (!sale.test && !(await claimToSay(sale.id))) return;
    if (!allowed()) return;
    voiceTimer = window.setTimeout(() => {
      if (allowed()) say(spokenLine(sale));
    }, playSparkle());
  })();
  return () => {
    stopped = true;
    window.clearTimeout(voiceTimer);
    stopVoice();
  };
}

/** The bell's test: a made-up close, shown and said on this device only. */
export function testSaleAnnouncement(closer: string): void {
  const sale: SaleClosed = {
    id: `test-${Date.now()}`,
    closer: closer || "You",
    student: "Test Student",
    courses: ["Sample Course"],
    amount: 5500,
    academy: "dubai",
    at: new Date().toISOString(),
    test: true,
  };
  window.dispatchEvent(new CustomEvent(SALE_TEST_EVENT, { detail: sale }));
}
