"use client";
import { useEffect, useRef } from "react";
import { toast } from "@/lib/toast";
import { useMyReminders } from "@/hooks/useReminders";
import { useSocket } from "@/hooks/useSocket";

// ─── localStorage-backed deduplication ───────────────────────────────────────
// Keys survive page refreshes; stale entries (> 25 hours) are pruned on load.

const LS_KEY = "crm_notified_reminders";
const TTL_MS = 25 * 60 * 60 * 1000; // 25 hours

/*
 * One alert per reminder per time: the key carries the time it was due, so a reminder moved to a new time alerts again
 * at that time (2026-10-22 — moved ones used to stay silent).
 */
const alertKey = (id: string, remindAt: string | Date | undefined, kind: "now" | "soon") => {
  const at = remindAt ? new Date(remindAt).getTime() : NaN;
  return Number.isFinite(at) ? `${id}@${at}:${kind}` : `${id}:${kind}`;
};

interface NotifRecord {
  key: string;   // "<id>@<due ms>:now" | "<id>@<due ms>:soon"
  ts:  number;   // Date.now() when it was stored
}

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const records: NotifRecord[] = JSON.parse(raw);
    const cutoff = Date.now() - TTL_MS;
    const fresh  = records.filter((r) => r.ts > cutoff);
    // Persist pruned list back
    if (fresh.length !== records.length) {
      localStorage.setItem(LS_KEY, JSON.stringify(fresh));
    }
    return new Set(fresh.map((r) => r.key));
  } catch {
    return new Set();
  }
}

function markNotified(key: string): void {
  try {
    const raw     = localStorage.getItem(LS_KEY);
    const records: NotifRecord[] = raw ? JSON.parse(raw) : [];
    records.push({ key, ts: Date.now() });
    localStorage.setItem(LS_KEY, JSON.stringify(records));
  } catch {
    // localStorage unavailable — degrade gracefully
  }
}

// ─── browser notification helper ─────────────────────────────────────────────

function requestBrowserPermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function fireBrowserNotification(title: string, body: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  // Android Chrome requires ServiceWorker path; desktop allows new Notification()
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, icon: "/favicon.ico" }))
      .catch(() => null);
    return;
  }
  try {
    new Notification(title, { body, icon: "/favicon.ico" });
  } catch {
    // unsupported — ignore
  }
}

// ─── main hook ────────────────────────────────────────────────────────────────

const THIRTY_MIN_MS = 30 * 60 * 1000;

export function useReminderNotifications() {
  const { data: reminders = [] } = useMyReminders();
  const socket   = useSocket();

  // In-memory set is the fast path; localStorage is the persistent truth.
  const notified = useRef<Set<string>>(new Set());

  // ── Initialise from localStorage on mount ──────────────────────────────────
  useEffect(() => {
    notified.current = loadNotified();
    requestBrowserPermission();
  }, []);

  // ── Socket: server-pushed reminder events (work even after page refresh) ──
  useEffect(() => {
    if (!socket) return;

    // ── reminder:due  (server scheduler fires this when the time arrives) ────
    const onDue = (payload: {
      reminderId: string;
      leadId:     string;
      leadName:   string;
      title:      string;
      body:       string;
      remindAt?:  string;
    }) => {
      const key = alertKey(payload.reminderId, payload.remindAt, "now");
      if (notified.current.has(key)) return;
      notified.current.add(key);
      markNotified(key);

      toast.warning(`⏰ Reminder: ${payload.title}`, {
        description: payload.leadName || undefined,
        duration: 10_000,
      });
      fireBrowserNotification(`⏰ ${payload.title}`, payload.body);
    };

    // ── reminder:warning  (server fires this ~30 min before due time) ────────
    const onWarning = (payload: {
      reminderId: string;
      leadId:     string;
      leadName:   string;
      title:      string;
      body:       string;
      minsLeft:   number;
      remindAt?:  string;
    }) => {
      const key = alertKey(payload.reminderId, payload.remindAt, "soon");
      if (notified.current.has(key)) return;
      notified.current.add(key);
      markNotified(key);

      toast.info(`🔔 Upcoming: ${payload.title}`, {
        description: payload.leadName
          ? `${payload.leadName} — in ${payload.minsLeft} min`
          : `In ${payload.minsLeft} min`,
        duration: 8_000,
      });
      fireBrowserNotification(`🔔 ${payload.title} in ${payload.minsLeft} min`, payload.body);
    };

    socket.on("reminder:due",     onDue);
    socket.on("reminder:warning", onWarning);

    return () => {
      socket.off("reminder:due",     onDue);
      socket.off("reminder:warning", onWarning);
    };
  }, [socket]);

  // ── Polling fallback — catches reminders while app is open ────────────────
  // Fires in addition to the socket path; deduplication prevents double toasts.
  useEffect(() => {
    if (!reminders.length) return;

    const now = Date.now();

    for (const r of reminders) {
      if (r.isDone) continue;

      const diff    = new Date(r.remindAt).getTime() - now;
      const label   = r.title ?? "Reminder";
      const leadName = (r as { lead?: { name?: string } }).lead?.name ?? "";

      // Overdue
      const nowKey = alertKey(r._id, r.remindAt, "now"), soonKey = alertKey(r._id, r.remindAt, "soon");
      if (diff <= 0 && !notified.current.has(nowKey)) {
        const key  = nowKey;
        notified.current.add(key);
        markNotified(key);

        const body = leadName ? `${label} — ${leadName}` : label;
        toast.warning(`⏰ Reminder: ${label}`, {
          description: leadName || undefined,
          duration: 8_000,
        });
        fireBrowserNotification(`⏰ ${label}`, body);
      }

      // Due within 30 min
      if (diff > 0 && diff <= THIRTY_MIN_MS && !notified.current.has(soonKey)) {
        const key  = soonKey;
        notified.current.add(key);
        markNotified(key);

        const mins = Math.ceil(diff / 60_000);
        const body = leadName
          ? `${label} — ${leadName} (in ${mins} min)`
          : `${label} (in ${mins} min)`;
        toast.info(`🔔 Upcoming: ${label}`, {
          description: leadName ? `${leadName} — in ${mins} min` : `In ${mins} min`,
          duration: 6_000,
        });
        fireBrowserNotification(`🔔 ${label} in ${mins} min`, body);
      }
    }
  }, [reminders]);
}
