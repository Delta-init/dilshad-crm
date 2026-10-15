"use client";

import { useEffect } from "react";
import { create } from "zustand";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store/authStore";
import { CURRENCIES, useCurrencyStore } from "@/lib/store/currencyStore";
import { getViewAs } from "@/lib/impersonation";
import type { ApiResponse } from "@/types";

/*
 * The currency someone sees amounts in, kept on their account (the user, 2026-10-15: "when I switch device it's not
 * showing that currency") — so it follows them to every device they sign in on. This device keeps its copy
 * (crm_currency) so nothing waits for it, and whose copy it is (crm_currency_user): a choice made on a shared computer
 * is that person's, never the next person's. Only a pick writes to an account, and the account keeps the newest pick
 * by when it was picked: sent at once, a pick is "now" by the server's clock; one that couldn't be saved at once
 * (offline) goes when the app next opens: still as "now" if nothing changed the account meanwhile, else with how long
 * ago it was made, by this device's clock — so a device clock set wrong doesn't matter. Never while viewing the CRM as
 * someone (View as).
 */

const OWNER = "crm_currency_user"; // whose choice this device holds
const PENDING = "crm_currency_pending"; // per person: a pick not on their account yet — { [userId]: { code, at } }
const ASKED = "crm_currency_asked"; // per person: how often "keep it on your account?" was asked — { [userId]: n }
const SEEN = "crm_currency_seen"; // per person: when the account's currency was picked, as this device last saw it
const ASK_AT_MOST = 3;
const DEFAULT = "USD";

interface Prefs {
  currency: string | null;
  currencyAt?: string | null;
  /** On a save: false when a newer pick was already kept (from another device). */
  applied?: boolean;
}
interface Pick {
  code: string;
  /** When it was picked, by this device's clock (ISO) — only its age is ever sent. */
  at: string;
}

/** The longest ago a pick can be sent as made (the server's limit: a year). */
const OLDEST_MS = 366 * 86_400_000;

const offered = (code: unknown): code is string => typeof code === "string" && CURRENCIES.some((c) => c.code === code);
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage off (a private window): this visit only.
  }
};
/** One person's entry in a per-person map kept on this device. */
function readFor<T>(key: string, userId: string): T | undefined {
  try {
    const all = JSON.parse(read(key) ?? "{}") as Record<string, T> | null;
    return all && typeof all === "object" ? all[userId] : undefined;
  } catch {
    return undefined;
  }
}
function writeFor<T>(key: string, userId: string, value: T | undefined): void {
  let all: Record<string, T> = {};
  try {
    const parsed = JSON.parse(read(key) ?? "{}") as Record<string, T> | null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) all = parsed;
  } catch {
    // start again
  }
  if (value === undefined) delete all[userId];
  else all[userId] = value;
  write(key, Object.keys(all).length ? JSON.stringify(all) : null);
}

/** Viewing the CRM as someone (View as): their account, not yours — nothing is read from it or saved to it. */
const asSomeoneElse = (): boolean => Boolean(getViewAs());

/**
 * Redraws the page when the account's currency arrives as the app opens — money is formatted as it's drawn, and most
 * screens don't listen for the currency. Not on a pick (Settings shows it at once), and not while someone is typing:
 * redrawing would throw away what they were writing.
 */
export const useCurrencyRedraw = create<{ key: number; bump: () => void }>((set) => ({
  key: 0,
  bump: () => set((s) => ({ key: s.key + 1 })),
}));
const typing = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
};
function show(code: string): void {
  if (useCurrencyStore.getState().currencyCode === code) return;
  useCurrencyStore.getState().setCurrency(code);
  if (!typing()) useCurrencyRedraw.getState().bump();
}

/**
 * Saves go out one after another, in pick order; the answer is what the account keeps. A late one carries its age by
 * this device's clock — if that clock went back since the pick, the age can't be told, so it goes as a year old: it
 * fills an account that has none and replaces no recent pick. One whose person signed out while it waited, or began
 * viewing as someone, isn't sent — it would land on whoever is signed in now; it stays theirs, for their next visit.
 */
const NOT_THEIRS = new Error("Not sent: they're no longer the one signed in");
let queue: Promise<unknown> = Promise.resolve();
function saveToAccount(pick: Pick, late: boolean, userId: string): Promise<Prefs | undefined> {
  const run = queue.then(async () => {
    // Only while they're still signed in, as themselves: sign-out drops the token but keeps the user until a reload.
    if (!read("accessToken") || useAuthStore.getState().user?._id !== userId || asSomeoneElse()) throw NOT_THEIRS;
    const age = Date.now() - Date.parse(pick.at);
    const body = late
      ? { currency: pick.code, pickedAgoMs: age < 0 ? OLDEST_MS : Math.min(OLDEST_MS, age) }
      : { currency: pick.code };
    return (await api.put<ApiResponse<Prefs>>("/auth/preferences", body)).data.data;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Picks made since the app opened — an answer asked for before one is never applied over it. */
let picks = 0;

/**
 * When the app opens: a pick of theirs that couldn't reach the account goes first — as "now" if the account is as this
 * device last saw it (nothing there can be newer), else with its age, and the account keeps whichever was picked later.
 * Otherwise the account's currency. Never picked on the account: a choice this device holds for someone else goes back
 * to the default; one from before choices were kept on accounts (whose, the device can't tell) is offered — "keep it
 * on your account?" — at up to three openings, then stays on this device.
 */
export function useSyncedCurrency(): void {
  const userId = useAuthStore((s) => s.user?._id ?? null);
  useEffect(() => {
    if (!userId || asSomeoneElse()) return;
    let gone = false;
    const picksAtStart = picks;
    void (async () => {
      let saved: string | null;
      try {
        const account = (await api.get<ApiResponse<Prefs>>("/auth/preferences")).data.data;
        if (gone || picks !== picksAtStart) return; // picked meanwhile — that pick is on its way instead
        const pending = readFor<Pick>(PENDING, userId); // read now: another tab may have picked meanwhile
        let kept: Prefs | undefined = account;
        if (pending && offered(pending.code) && !Number.isNaN(Date.parse(pending.at))) {
          // The account as this device last saw it: nothing there is newer, so the pick goes as "now"; else its age.
          const seen = readFor<string | null>(SEEN, userId);
          const unchanged = seen !== undefined && (account?.currencyAt ?? null) === seen;
          kept = await saveToAccount(pending, !unchanged, userId);
          if (readFor<Pick>(PENDING, userId)?.at === pending.at) writeFor<Pick>(PENDING, userId, undefined);
        } else if (pending) {
          writeFor<Pick>(PENDING, userId, undefined); // not one the app offers
        }
        writeFor<string | null>(SEEN, userId, kept?.currencyAt ?? null);
        saved = offered(kept?.currency) ? kept!.currency : null;
      } catch {
        return; // a server without it yet, or offline: this device's choice stands (and a pick still waits)
      }
      if (gone || picks !== picksAtStart) return; // picked meanwhile — the pick wins

      const owner = read(OWNER);
      const here = useCurrencyStore.getState().currencyCode;
      if (saved) {
        show(saved);
      } else if (owner && owner !== userId) {
        show(DEFAULT); // this device's choice is someone else's: not theirs to see, nor to keep
      } else if (!owner && offered(here) && here !== DEFAULT) {
        const asked = Number(readFor<number>(ASKED, userId)) || 0;
        if (asked < ASK_AT_MOST) {
          writeFor<number>(ASKED, userId, asked + 1);
          const code = here;
          toast(`Amounts show in ${code} on this device.`, {
            description: "Keep it on your account, so every device you sign in on shows it?",
            duration: 30_000,
            action: { label: "Keep", onClick: () => chooseCurrency(code) },
          });
          return; // not theirs yet: asked again next time (or until they pick)
        }
      }
      write(OWNER, userId);
    })();
    return () => {
      gone = true;
    };
  }, [userId]);
}

/**
 * Settings → Currency: this device at once, and the account — so every other device shows it too. Until the account
 * has it, it's kept as theirs to send (also if the app closes first); a failure says so.
 */
export function chooseCurrency(code: string): void {
  if (typeof window === "undefined" || !offered(code)) return;
  if (asSomeoneElse()) {
    toast.error("You're viewing the CRM as someone else — change the currency from your own account.");
    return;
  }
  picks++;
  const pick: Pick = { code, at: new Date().toISOString() };
  useCurrencyStore.getState().setCurrency(code);
  const userId = useAuthStore.getState().user?._id ?? null;
  if (!userId) return;
  write(OWNER, userId);
  writeFor<Pick>(PENDING, userId, pick);
  saveToAccount(pick, false, userId)
    .then((kept) => {
      if (kept) writeFor<string | null>(SEEN, userId, kept.currencyAt ?? null);
      const latest = readFor<Pick>(PENDING, userId)?.at === pick.at; // no later pick since
      if (!latest) return;
      writeFor<Pick>(PENDING, userId, undefined);
      // Not kept (a newer pick reached the account first, in the same instant): that one stands — shown, not redrawn,
      // and only to them (not to whoever signed in since).
      const stillThem = useAuthStore.getState().user?._id === userId && !asSomeoneElse();
      if (kept && kept.applied === false && offered(kept.currency) && stillThem) {
        useCurrencyStore.getState().setCurrency(kept.currency);
      }
    })
    .catch((err) => {
      if (err === NOT_THEIRS) return; // they signed out meanwhile: it waits for their next visit
      toast.error("Saved on this device — your account gets it the next time the app can reach it.");
    });
}
