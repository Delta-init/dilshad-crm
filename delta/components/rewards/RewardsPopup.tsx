"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import { Check, Gift, Loader2, Lock, PartyPopper } from "lucide-react";
import { create } from "zustand";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import api from "@/lib/axios";
import { useAuthStore } from "@/lib/store/authStore";
import { getViewAs } from "@/lib/impersonation";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/*
 * Gift rewards (the user, 2026-11-04): "if they close for 50k AED they will get a gift of 2k AED … team leader if
 * their team hits 1 lakh, gifts up to 3k", shown "like an offer pop-up in an e-commerce store" with a spinner.
 *
 * A pop-up with a wheel and a shelf of gifts: how far this month's closing has got, a spin (a teaser until the target
 * is reached), and, once it is, one gift chosen — sent to Root, where the office buys it and hands it over. It opens
 * by itself once a day until the month's gift is chosen, and the first time the target is reached; the gift button in
 * the header opens it any time. Counted and kept by the API (services/rewardsService.ts); nothing here decides.
 */

interface RewardGift { id: string; name: string; category: string; valueAed: number; photo: string | null }
interface RewardClaim { giftId: string; giftName: string; giftValueAed: number; status: string; createdAt: string }
interface MyRewards {
  eligible: boolean;
  month?: string;
  daysLeft?: number;
  role?: "sales" | "tl";
  teamName?: string;
  currency?: "AED" | "INR";
  closed?: number;
  target?: number;
  /** The target in AED, when the CRM counts in another currency. */
  targetAed?: number;
  giftValue?: number;
  reached?: boolean;
  gifts?: RewardGift[];
  claim?: RewardClaim | null;
}

const useRewardsUi = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function useMyRewards() {
  const signedIn = useAuthStore((s) => Boolean(s.accessToken));
  return useQuery({
    queryKey: ["rewards", "me"],
    queryFn: async () => (await api.get<{ data: MyRewards }>("/rewards/me")).data.data,
    enabled: signedIn,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

const money = (n: number, currency: string = "AED") =>
  currency === "INR" ? `₹${Math.round(n).toLocaleString("en-IN")}` : `AED ${Math.round(n).toLocaleString("en-US")}`;
const monthName = (month?: string) =>
  month ? new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" }) : "This month";
const photoUrl = (photo: string | null) => (photo ? `${(api.defaults.baseURL ?? "").replace(/\/+$/, "")}/${photo}` : null);
/** A super admin viewing the CRM as somebody: nothing opens by itself, and only the person can choose their gift. */
const isViewingAs = () => Boolean(getViewAs());

const STATUS: Record<string, string> = { requested: "Requested", ordered: "Ordered", handed_over: "Handed over", cancelled: "Cancelled" };
const STEPS = ["requested", "ordered", "handed_over"];

/** The gift button in the header: there for anybody who can earn a gift, with a dot while one waits to be chosen. */
export function RewardsButton() {
  const { data } = useMyRewards();
  const setOpen = useRewardsUi((s) => s.setOpen);
  if (!data?.eligible) return null;
  const waiting = Boolean(data.reached && !data.claim);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={waiting ? "Gift rewards: your gift is waiting" : "Gift rewards"}
      title="Gift rewards"
      className="relative flex h-9 w-9 items-center justify-center rounded-lg text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
    >
      <Gift className="h-[18px] w-[18px]" />
      {waiting && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500" />}
    </button>
  );
}

/** The pop-up, mounted once in the dashboard layout. */
export function RewardsPopup() {
  const { data } = useMyRewards();
  const { open, setOpen } = useRewardsUi();
  const userId = useAuthStore((s) => s.user?._id ?? "");

  // By itself: the first time the target is reached in a month, and once a day while the month's gift isn't chosen.
  // Never while a super admin is viewing as somebody, and never over another dialog (it waits for another day).
  useEffect(() => {
    if (!data?.eligible || data.claim || !userId || isViewingAs()) return;
    const timer = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]')) return;
      const today = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
      const dayKey = `crm_rewards_day:${userId}`;
      const reachedKey = `crm_rewards_reached:${userId}:${data.month}`;
      try {
        if (data.reached && !localStorage.getItem(reachedKey)) {
          localStorage.setItem(reachedKey, "1");
          localStorage.setItem(dayKey, today);
          setOpen(true);
        } else if (localStorage.getItem(dayKey) !== today) {
          localStorage.setItem(dayKey, today);
          setOpen(true);
        }
      } catch {
        /* storage blocked: it opens from the gift button only */
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [data?.eligible, data?.reached, data?.claim, data?.month, userId, setOpen]);

  if (!data?.eligible) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-5xl gap-0 overflow-y-auto p-0">
        <RewardsBody data={data} />
      </DialogContent>
    </Dialog>
  );
}

function RewardsBody({ data }: { data: MyRewards }) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const gifts = data.gifts ?? [];
  const currency = data.currency ?? "AED";
  const closed = data.closed ?? 0;
  const target = data.target ?? 0;
  const reached = Boolean(data.reached);
  const claim = data.claim ?? null;
  const tl = data.role === "tl";
  const month = monthName(data.month);
  const viewingAs = isViewingAs();
  const canChoose = reached && !claim && !viewingAs;

  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [landed, setLanded] = useState<RewardGift | null>(null);
  const [choosing, setChoosing] = useState<RewardGift | null>(null);
  const confetti = useRef<HTMLCanvasElement>(null);
  const wheelBox = useRef<HTMLDivElement>(null);

  const choose = useMutation({
    mutationFn: async (giftId: string) => (await api.post<{ data: RewardClaim }>("/rewards/claim", { giftId })).data.data,
    onSuccess: (c) => {
      setChoosing(null);
      setLanded(null);
      qc.invalidateQueries({ queryKey: ["rewards", "me"] });
      toast.success(`${c.giftName} is yours. The office will be in touch to hand it over.`);
      burst();
    },
    onError: (e: unknown) => {
      const said = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(said ?? "That gift couldn't be chosen. Try again.");
    },
  });

  function burst() {
    const c = confetti.current;
    if (!c || reduce) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const box = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = box.width * dpr;
    c.height = box.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const wb = wheelBox.current?.getBoundingClientRect();
    const ox = wb ? wb.left - box.left + wb.width / 2 : box.width / 2;
    const oy = wb ? wb.top - box.top + wb.height / 2 : 160;
    const colors = ["#f59e0b", "#e11d48", "#7c3aed", "#fcd34d", "#ffffff"];
    const bits = Array.from({ length: 140 }, (_, k) => {
      const a = Math.random() * Math.PI * 2;
      const v = 3 + Math.random() * 9;
      return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, s: 4 + Math.random() * 5, c: colors[k % colors.length]!, r: Math.random() * 6, life: 0 };
    });
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(40, now - last) / 16.7;
      last = now;
      ctx.clearRect(0, 0, box.width, box.height);
      let alive = 0;
      for (const b of bits) {
        b.life += dt;
        if (b.life > 110) continue;
        alive++;
        b.vy += 0.22 * dt; b.vx *= 0.99; b.x += b.vx * dt; b.y += b.vy * dt; b.r += 0.15 * dt;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - b.life / 110);
        ctx.translate(b.x, b.y);
        ctx.rotate(b.r);
        ctx.fillStyle = b.c;
        ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        ctx.restore();
      }
      if (alive) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, box.width, box.height);
    };
    requestAnimationFrame(frame);
  }

  function spin() {
    if (spinning || gifts.length < 2 || claim) return;
    setLanded(null);
    setChoosing(null);
    setSpinning(true);
    const step = 360 / gifts.length;
    const i = Math.floor(Math.random() * gifts.length);
    const goal = 360 - (i * step + step / 2);
    const now = ((rotation % 360) + 360) % 360;
    setRotation(rotation + 360 * 5 + ((goal - now + 360) % 360));
    window.setTimeout(() => {
      setSpinning(false);
      setLanded(gifts[i]!);
      if (reached) burst();
    }, reduce ? 50 : 4500);
  }

  const pct = target > 0 ? Math.min(100, (closed / target) * 100) : 0;
  const left = Math.max(0, target - closed);

  return (
    <div className="relative grid md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <canvas ref={confetti} aria-hidden className="pointer-events-none absolute inset-0 z-20 h-full w-full" />

      {/* The wheel */}
      <div className="grid content-start justify-items-center gap-4 border-b border-border bg-violet-500/[0.06] px-5 py-6 md:border-b-0 md:border-r">
        <div ref={wheelBox} className="relative aspect-square w-full max-w-[270px]">
          <svg viewBox="0 0 26 32" aria-hidden className="absolute left-1/2 top-[-6px] z-10 h-8 w-[26px] -translate-x-1/2">
            <path d="M13 31 2 6a11 11 0 1 1 22 0z" fill="#e11d48" stroke="white" strokeWidth="2" />
          </svg>
          <Wheel gifts={gifts} rotation={rotation} />
          <button
            type="button"
            onClick={spin}
            disabled={spinning || Boolean(claim) || gifts.length < 2}
            className="absolute inset-0 m-auto h-20 w-20 rounded-full border-4 border-background bg-amber-400 text-base font-bold text-amber-950 shadow-md transition-transform hover:scale-105 disabled:hover:scale-100"
          >
            {claim ? <Check className="mx-auto h-7 w-7" /> : spinning ? "…" : "Spin"}
          </button>
        </div>

        {landed && !claim ? (
          <div className="w-full max-w-[270px] space-y-2 rounded-xl border border-border bg-card p-3 text-sm" aria-live="polite">
            <p className="text-muted-foreground">{reached ? "You won" : "You'd win"}</p>
            <p className="text-base font-semibold">{landed.name}</p>
            {canChoose ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setChoosing(landed)}>Choose this gift</Button>
                <Button size="sm" variant="outline" onClick={() => setLanded(null)}>Pick another</Button>
              </div>
            ) : reached ? (
              <p className="text-muted-foreground">Only the person you&apos;re viewing as can choose their gift.</p>
            ) : (
              <p className="text-muted-foreground">
                Close {money(left, currency)} more {tl ? "as a team " : ""}this month to make it yours.
              </p>
            )}
          </div>
        ) : (
          <p className="max-w-[260px] text-center text-sm text-muted-foreground">
            {claim
              ? "Your gift for the month is chosen."
              : reached
                ? "Spin for your gift, or choose one from the shelf."
                : "Try a spin to see what you could take home."}
          </p>
        )}
      </div>

      {/* The offer */}
      <div className="grid min-w-0 content-start gap-5 px-5 py-6 sm:px-7">
        <div className="pr-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">{month} rewards</p>
          <DialogTitle className="mt-1 text-2xl font-bold leading-tight sm:text-[28px]">
            {tl ? (
              <>Your team closes <span className="text-amber-600 dark:text-amber-400">{money(target, currency)}</span> this month, you take home gifts worth up to <span className="text-amber-600 dark:text-amber-400">AED {(data.giftValue ?? 0).toLocaleString("en-US")}</span></>
            ) : (
              <>Close <span className="text-amber-600 dark:text-amber-400">{money(target, currency)}</span> this month, take home a gift worth up to <span className="text-amber-600 dark:text-amber-400">AED {(data.giftValue ?? 0).toLocaleString("en-US")}</span></>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">This month&apos;s target, how far you&apos;ve got, and the gifts you can choose from.</DialogDescription>
          {currency !== "AED" && data.targetAed ? (
            <p className="mt-1 text-xs text-muted-foreground">The target is AED {Math.round(data.targetAed).toLocaleString("en-US")} in rupees.</p>
          ) : null}
        </div>

        <div className={cn("grid gap-2 rounded-xl p-4", reached ? "bg-emerald-500/10" : "bg-amber-500/10")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm text-muted-foreground">
            <span>{tl ? `${data.teamName || "Your team"}'s closings in ${month}` : `Your closings in ${month}`}</span>
            <span><b className="text-lg font-bold tabular-nums text-foreground">{money(closed, currency)}</b> of {money(target, currency)}</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full border border-border bg-background">
            <div className={cn("h-full rounded-full transition-[width] duration-700", reached ? "bg-emerald-500" : "bg-amber-400")} style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <p className={cn("text-sm font-semibold", reached ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
            {reached ? "Target reached. Your gift is unlocked." : `${money(left, currency)} to go · ${data.daysLeft ?? 0} days left`}
          </p>
        </div>

        {claim && (
          <div className="grid gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
            <p className="flex items-center gap-2 font-semibold"><PartyPopper className="h-4 w-4 text-emerald-600" />Your {month} gift: {claim.giftName}</p>
            {claim.status === "cancelled" ? (
              <p className="text-sm text-muted-foreground">The office cancelled this one. Ask them about choosing another.</p>
            ) : (
              <ol className="flex flex-wrap items-center gap-2 text-xs">
                {STEPS.map((s, i) => {
                  const done = STEPS.indexOf(claim.status) >= i;
                  return (
                    <li key={s} className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1", done ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground")}>
                      {done && <Check className="h-3 w-3" />}{STATUS[s]}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}

        {choosing && !claim && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert">
            <span>Choose <b>{choosing.name}</b> as your {month} gift? You can&apos;t change it after.</span>
            <span className="flex gap-2">
              <Button size="sm" onClick={() => choose.mutate(choosing.id)} disabled={choose.isPending}>
                {choose.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Yes, choose it
              </Button>
              <Button size="sm" variant="outline" onClick={() => setChoosing(null)} disabled={choose.isPending}>Back</Button>
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{claim ? "The gifts this month" : "Pick your gift"}</h3>
          <span className="text-sm text-muted-foreground">Any one gift up to AED {(data.giftValue ?? 0).toLocaleString("en-US")}</span>
        </div>
        {gifts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">The gift shelf is being stocked. Check back soon.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {gifts.map((g) => {
              const src = photoUrl(g.photo);
              const mine = claim?.giftId === g.id;
              const hit = landed?.id === g.id && !claim;
              return (
                <article
                  key={g.id}
                  className={cn(
                    "grid grid-rows-[auto_1fr] overflow-hidden rounded-xl border bg-card transition-all",
                    mine ? "border-emerald-500 ring-2 ring-emerald-500/30" : hit ? "-translate-y-0.5 border-amber-400 ring-2 ring-amber-400/30" : "border-border",
                  )}
                >
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={g.name} loading="lazy" className="aspect-[4/3] h-auto w-full object-cover" />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-muted"><Gift className="h-8 w-8 text-muted-foreground" /></div>
                  )}
                  <div className="grid content-start gap-0.5 p-2.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{g.category}</span>
                    <span className="text-sm font-semibold leading-snug">{g.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">Worth AED {g.valueAed.toLocaleString("en-US")}</span>
                    {!claim && (
                      canChoose ? (
                        <Button size="sm" variant="outline" className="mt-1.5 justify-self-start" onClick={() => setChoosing(g)}>Choose this gift</Button>
                      ) : reached ? null : (
                        <span className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" />Unlocks at the target</span>
                      )
                    )}
                    {mine && <span className="mt-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Your gift</span>}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          One gift a person a month. The office buys it and hands it over; you&apos;ll see where it is here.
        </p>
      </div>
    </div>
  );
}

const SEGMENT_FILLS = ["#7c3aed", "#f59e0b", "#e11d48"];
const SEGMENT_INKS = ["#ffffff", "#451a03", "#ffffff"];

/** The wheel: one slice a gift, turned by `rotation` degrees. */
function Wheel({ gifts, rotation }: { gifts: RewardGift[]; rotation: number }) {
  const n = Math.max(gifts.length, 1);
  const step = 360 / n;
  const r = 146;
  const pt = (deg: number, rad: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [150 + rad * Math.cos(a), 150 + rad * Math.sin(a)] as const;
  };
  const short = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
  return (
    <svg viewBox="0 0 300 300" role="img" aria-label="Gift wheel" className="h-full w-full">
      <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: "150px 150px", transition: "transform 4.4s cubic-bezier(0.15, 0.7, 0.1, 1)" }}>
        <circle cx="150" cy="150" r="149" fill="white" />
        {gifts.map((g, i) => {
          const a0 = i * step;
          const [x0, y0] = pt(a0, r);
          const [x1, y1] = pt(a0 + step, r);
          const mid = a0 + step / 2;
          const [tx, ty] = pt(mid, 96);
          const k = n % 3 === 1 && i === n - 1 ? 1 : i % 3;
          return (
            <g key={g.id}>
              <path d={`M150 150 L${x0} ${y0} A${r} ${r} 0 ${step > 180 ? 1 : 0} 1 ${x1} ${y1} Z`} fill={SEGMENT_FILLS[k]} stroke="white" strokeWidth="2" />
              <text x={tx} y={ty} fill={SEGMENT_INKS[k]} fontSize="11.5" fontWeight="600" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${mid - 90} ${tx} ${ty})`}>
                {short(g.category)}
              </text>
            </g>
          );
        })}
        <circle cx="150" cy="150" r="146" fill="none" stroke="#f59e0b" strokeWidth="4" />
      </g>
    </svg>
  );
}
