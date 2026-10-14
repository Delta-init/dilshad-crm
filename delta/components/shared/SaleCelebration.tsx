"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { PartyPopper, Volume2, VolumeX, X } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";
import {
  SALE_CLOSED_EVENT,
  SALE_TEST_EVENT,
  announce,
  asSale,
  saleMoney,
  setSaleSoundOn,
  useSaleSoundOn,
  voiceBusy,
  warmUpVoices,
  type SaleClosed,
} from "@/lib/saleAnnouncement";

/*
 * Every close, celebrated on every screen signed in to the CRM (the user,
 * 2026-10-15). It shows in the middle of the screen with glitter: who closed
 * it, the student, the course and the fee. A sparkle plays and the browser's
 * voice says the same (lib/saleAnnouncement.ts). One at a time: closes that
 * land together wait their turn. Click outside it, press Esc, or wait, and it
 * goes.
 */

/** On screen at least this long, and until the voice has finished. */
const SHOW_MS = 8000;
/** Never longer than this, even mid-sentence. */
const MAX_MS = 15_000;
/** Closes arriving together beyond this many are not queued. */
const WAITING_MAX = 5;

export function SaleCelebration() {
  const socket = useSocket();
  const [current, setCurrent] = useState<SaleClosed | null>(null);
  const [mounted, setMounted] = useState(false);
  const shown = useRef<SaleClosed | null>(null);
  const waiting = useRef<SaleClosed[]>([]);
  const busy = useRef(false);
  const seen = useRef(new Map<string, number>());

  const showNext = useCallback(() => {
    const next = waiting.current.shift() ?? null;
    busy.current = next !== null;
    shown.current = next;
    setCurrent(next);
  }, []);

  const close = useCallback(() => {
    if (!shown.current) return;
    shown.current = null;
    setCurrent(null);
    // The next one once this has left the screen.
    window.setTimeout(showNext, 450);
  }, [showNext]);

  const receive = useCallback(
    (raw: unknown) => {
      const sale = asSale(raw);
      if (!sale) return;
      const now = Date.now();
      seen.current.forEach((at, id) => {
        if (now - at > 5 * 60_000) seen.current.delete(id);
      });
      if (seen.current.has(sale.id)) return;
      seen.current.set(sale.id, now);
      if (waiting.current.length >= WAITING_MAX) return;
      waiting.current.push(sale);
      if (!busy.current) showNext();
    },
    [showNext],
  );

  useEffect(() => {
    setMounted(true);
    warmUpVoices();
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on(SALE_CLOSED_EVENT, receive);
    return () => {
      socket.off(SALE_CLOSED_EVENT, receive);
    };
  }, [socket, receive]);

  useEffect(() => {
    const onTest = (e: Event) => receive((e as CustomEvent<unknown>).detail);
    window.addEventListener(SALE_TEST_EVENT, onTest);
    return () => window.removeEventListener(SALE_TEST_EVENT, onTest);
  }, [receive]);

  // The sparkle and the voice, stopped when it leaves the screen.
  useEffect(() => (current ? announce(current) : undefined), [current]);

  // Away on its own: after SHOW_MS, once the voice is done, and by MAX_MS at the latest.
  useEffect(() => {
    if (!current) return;
    const shownAt = Date.now();
    let timer = 0;
    const check = () => {
      const age = Date.now() - shownAt;
      if (age < MAX_MS && (age < SHOW_MS || voiceBusy())) timer = window.setTimeout(check, 400);
      else close();
    };
    timer = window.setTimeout(check, SHOW_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [current, close]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>{current && <Celebration key={current.id} sale={current} onClose={close} />}</AnimatePresence>,
    document.body,
  );
}

// ── The pop-up ────────────────────────────────────────────────────────────────

function Celebration({ sale, onClose }: { sale: SaleClosed; onClose: () => void }) {
  const still = useReducedMotion();
  // Leaving: never in the way of a click, even while a background tab holds its fade-out.
  const present = useIsPresent();
  const soundOn = useSaleSoundOn();
  const money = saleMoney(sale);
  const closer = sale.closer || "The team";

  return (
    <motion.div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
      style={{ pointerEvents: present ? "auto" : "none" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{ duration: 0.25 }}
      onClick={onClose}
      role="status"
      aria-live="polite"
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" />

      <motion.div
        className="relative w-full max-w-md"
        initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 24 }}
        animate={still ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={still ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12, transition: { duration: 0.2 } }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute -inset-1 rounded-[28px] bg-gradient-to-r from-amber-400 via-pink-500 to-violet-500 opacity-70 blur-xl" />
        <div className="relative overflow-hidden rounded-3xl border border-amber-300/50 bg-card px-6 pb-6 pt-7 text-center shadow-2xl sm:px-8">
          {!still && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/30 to-transparent dark:via-white/10"
              initial={{ x: "-100%" }}
              animate={{ x: "450%" }}
              transition={{ duration: 1.6, delay: 0.35, repeat: Infinity, repeatDelay: 1.6, ease: "easeInOut" }}
            />
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>

          <motion.div
            className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 via-amber-500 to-pink-500 shadow-lg shadow-amber-500/30"
            animate={still ? undefined : { rotate: [0, -14, 12, -8, 6, 0], scale: [1, 1.15, 1] }}
            transition={{ duration: 1.2, delay: 0.25 }}
          >
            <PartyPopper className="h-8 w-8 text-white" />
          </motion.div>

          <p className="text-xs font-bold uppercase tracking-[0.3em] text-amber-600 dark:text-amber-400">Sale closed</p>
          <p className="mt-2 line-clamp-2 break-words bg-gradient-to-r from-amber-500 via-orange-500 to-pink-500 bg-clip-text pb-1 text-3xl font-extrabold leading-tight text-transparent">
            {closer}
          </p>
          <p className="text-sm text-muted-foreground">closed</p>
          <p className="mt-1 line-clamp-2 break-words text-xl font-semibold leading-snug text-foreground">{sale.student || "A new student"}</p>

          {sale.courses.length > 0 && (
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {sale.courses.map((c) => (
                <span key={c} className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  {c}
                </span>
              ))}
            </div>
          )}

          {money && (
            <motion.p
              className="mt-4 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 bg-clip-text pb-1 text-4xl font-black tabular-nums text-transparent dark:from-amber-300 dark:via-yellow-400 dark:to-amber-500"
              initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
              animate={still ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              transition={{ delay: 0.35, type: "spring", stiffness: 300, damping: 14 }}
            >
              {money.shown}
            </motion.p>
          )}

          <div className="mt-5 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <button
              type="button"
              onClick={() => setSaleSoundOn(!soundOn)}
              className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              {soundOn ? "Mute on this device" : "Muted on this device: turn sound on"}
            </button>
            {sale.test && <span className="rounded bg-muted px-1.5 py-0.5">Test</span>}
          </div>

          <motion.div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-1 origin-left bg-gradient-to-r from-amber-400 via-pink-500 to-violet-500"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: SHOW_MS / 1000, ease: "linear" }}
          />
        </div>
      </motion.div>

      {!still && <Glitter />}
    </motion.div>
  );
}

// ── The glitter ───────────────────────────────────────────────────────────────

const GLITTER = ["#FFD700", "#FBBF24", "#F59E0B", "#FDE68A", "#F472B6", "#EC4899", "#A78BFA", "#8B5CF6", "#22D3EE", "#FFFFFF"];

/** 0 a scrap of confetti, 1 a glitter dot, 2 a twinkling star. */
interface Bit {
  kind: 0 | 1 | 2;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  angle: number;
  spin: number;
  age: number;
  ttl: number;
}

/** A burst out of the middle, glitter raining down, and stars twinkling around the card, on one canvas over the screen. */
function Glitter() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener("resize", fit);

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const colour = () => GLITTER[Math.floor(Math.random() * GLITTER.length)];
    const bits: Bit[] = [];
    const add = (b: Pick<Bit, "kind" | "x" | "y" | "vx" | "vy"> & Partial<Bit>) =>
      bits.push({ size: rnd(5, 10), color: colour(), angle: rnd(0, Math.PI * 2), spin: rnd(-0.2, 0.2), age: 0, ttl: rnd(2400, 4400), ...b });

    for (let i = 0; i < 120; i++) {
      const a = rnd(0, Math.PI * 2);
      const v = rnd(3, 13);
      add({ kind: i % 3 === 0 ? 1 : 0, x: w / 2, y: h / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3 });
    }

    const start = performance.now();
    let last = start;
    let raf = 0;
    const frame = (now: number) => {
      const step = Math.min(50, now - last) / 16.7;
      last = now;
      const t = now - start;
      if (t < 3200) {
        for (let i = 0; i < 2; i++) add({ kind: Math.random() < 0.35 ? 1 : 0, x: rnd(0, w), y: -10, vx: rnd(-1, 1), vy: rnd(1.5, 3.5) });
      }
      if (t < 6500 && Math.random() < 0.5) {
        add({
          kind: 2, x: w / 2 + rnd(-280, 280), y: h / 2 + rnd(-240, 240), vx: 0, vy: 0,
          size: rnd(5, 13), ttl: rnd(500, 1100), color: Math.random() < 0.6 ? "#FFF7CC" : colour(),
        });
      }

      g.clearRect(0, 0, w, h);
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        b.age += step * 16.7;
        if (b.age > b.ttl || b.y > h + 30) {
          bits.splice(i, 1);
          continue;
        }
        const fade = Math.min(1, (b.ttl - b.age) / 500);
        if (b.kind === 2) {
          twinkle(g, b.x, b.y, b.size * Math.sin((b.age / b.ttl) * Math.PI), b.color, fade);
          continue;
        }
        b.vy = Math.min(b.vy + 0.12 * step, 6);
        b.vx *= Math.pow(0.985, step);
        b.x += (b.vx + Math.sin((b.age + b.size * 100) / 300) * 0.6) * step;
        b.y += b.vy * step;
        b.angle += b.spin * step;
        g.fillStyle = b.color;
        if (b.kind === 1) {
          // Catches the light now and then.
          g.globalAlpha = fade * (0.5 + 0.5 * Math.abs(Math.sin(b.age / 90)));
          g.beginPath();
          g.arc(b.x, b.y, b.size / 3.2, 0, Math.PI * 2);
          g.fill();
        } else {
          g.globalAlpha = fade;
          g.save();
          g.translate(b.x, b.y);
          g.rotate(b.angle);
          g.scale(1, Math.cos(b.age / 120 + b.size));
          g.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
          g.restore();
        }
      }
      g.globalAlpha = 1;
      if (t < 9000 || bits.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/** A four-pointed star with a soft glow. */
function twinkle(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  if (r <= 0) return;
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = r * 1.5;
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.quadraticCurveTo(x, y, x, y + r);
  g.quadraticCurveTo(x, y, x - r, y);
  g.quadraticCurveTo(x, y, x, y - r);
  g.fill();
  g.restore();
}
