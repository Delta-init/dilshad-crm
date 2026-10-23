"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell, BellOff, X, CheckCircle2, UserCheck, UserPlus,
  MessageCircle, StickyNote, ExternalLink, Loader2,
  ArrowRightLeft, AlertTriangle, Coffee, CalendarClock, CalendarX2, Repeat2,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store/authStore";
import { getViewAs } from "@/lib/impersonation";
import { usePushNotification } from "@/hooks/usePushNotification";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toast } from "@/lib/toast";
import { NotificationTests } from "@/components/notifications/NotificationTests";
import {
  useNotifications, useMarkAllNotificationsRead, useDeleteNotification, useClearNotifications,
} from "@/hooks/useNotifications";
import type { AppNotificationDTO } from "@/types/notification";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AppNotification {
  id: string;
  type: "lead_assigned" | "team_message" | "status_changed" | "note_added" | string;
  title: string;
  body: string;
  url?: string;
  createdAt: string;
  read: boolean;
  /** Kept on the server (it has a stored id): reading, dismissing and clearing it stick. */
  stored?: boolean;
}

/** Newest first, one of each id, at most 50. */
function mergeNotifications(a: AppNotification[], b: AppNotification[]): AppNotification[] {
  const byId = new Map<string, AppNotification>();
  for (const n of [...a, ...b]) if (!byId.has(n.id)) byId.set(n.id, n);
  return Array.from(byId.values())
    .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())
    .slice(0, 50);
}

const fromStored = (n: AppNotificationDTO): AppNotification => ({ ...n, url: n.url || undefined, stored: true });

const TYPE_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  lead_assigned:  { icon: UserCheck,     color: "text-teal-400",   bg: "bg-teal-500/15"   },
  new_lead:       { icon: UserPlus,      color: "text-sky-400",    bg: "bg-sky-500/15"    },
  team_message:   { icon: MessageCircle, color: "text-blue-400",   bg: "bg-blue-500/15"   },
  status_changed: { icon: CheckCircle2,  color: "text-violet-400", bg: "bg-violet-500/15" },
  note_added:     { icon: StickyNote,    color: "text-green-400",  bg: "bg-green-500/15"  },
  inactive_lead_moved:  { icon: ArrowRightLeft, color: "text-amber-400", bg: "bg-amber-500/15" },
  repeat_lead:          { icon: Repeat2,        color: "text-violet-400", bg: "bg-violet-500/15" },
  inactive_leads_moved: { icon: ArrowRightLeft, color: "text-amber-400", bg: "bg-amber-500/15" },
  inactive_leads_stuck: { icon: AlertTriangle,  color: "text-red-400",   bg: "bg-red-500/15"   },
  idle_self:            { icon: Coffee,         color: "text-amber-400", bg: "bg-amber-500/15" },
  idle_alert:           { icon: Coffee,         color: "text-amber-400", bg: "bg-amber-500/15" },
  meeting_scheduled:    { icon: CalendarClock,  color: "text-primary",   bg: "bg-primary/15"   },
  meeting_updated:      { icon: CalendarClock,  color: "text-primary",   bg: "bg-primary/15"   },
  meeting_reminder:     { icon: CalendarClock,  color: "text-primary",   bg: "bg-primary/15"   },
  meeting_cancelled:    { icon: CalendarX2,     color: "text-red-400",   bg: "bg-red-500/15"   },
};
const DEFAULT_TYPE = { icon: Bell, color: "text-primary", bg: "bg-primary/15" };

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Shared notification list content ──────────────────────────────────────────

interface NotificationContentProps {
  notifications: AppNotification[];
  unread: number;
  isSubscribed: boolean;
  permission: string;
  pushLoading: boolean;
  requestPermission: () => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  onClose: () => void;
  /** When true, wraps list in a ScrollArea (used inside Drawer) */
  scrollable?: boolean;
}

function NotificationContent({
  notifications, unread, isSubscribed, permission,
  pushLoading, requestPermission, markAllRead,
  dismiss, clearAll, onClose, scrollable,
}: NotificationContentProps) {
  const list = (
    <div className="divide-y divide-border/40">
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="rounded-full bg-muted/50 p-4">
            <Bell className="h-7 w-7 text-muted-foreground/30" />
          </div>
          <p className="text-sm text-muted-foreground">No notifications yet</p>
          {!isSubscribed && permission !== "denied" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5 mt-1"
              disabled={pushLoading}
              onClick={requestPermission}
            >
              {pushLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
              Enable push
            </Button>
          )}
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {notifications.map((notif) => {
            const cfg = TYPE_CONFIG[notif.type] ?? DEFAULT_TYPE;
            const Icon = cfg.icon;
            return (
              <motion.div
                key={notif.id}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12, height: 0, marginTop: 0, paddingTop: 0, paddingBottom: 0 }}
                transition={{ duration: 0.18 }}
                className={`flex items-start gap-3 px-4 py-3.5 hover:bg-muted/20 transition-colors group ${!notif.read ? "bg-primary/5" : ""}`}
              >
                <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${cfg.bg}`}>
                  <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground leading-snug">{notif.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{notif.body}</p>
                  <p className="text-[10px] text-muted-foreground/50 mt-1">{timeAgo(notif.createdAt)}</p>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {notif.url && (
                    <Link href={notif.url} onClick={onClose}>
                      <button className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors">
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </Link>
                  )}
                  <button
                    onClick={() => dismiss(notif.id)}
                    className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-2" />
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      )}
    </div>
  );

  return (
    <>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {unread > 0 && (
            <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
              {unread} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Push toggle */}
          <button
            title={isSubscribed ? "Push notifications on" : "Enable push notifications"}
            onClick={isSubscribed ? undefined : requestPermission}
            disabled={pushLoading || permission === "denied"}
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
              isSubscribed
                ? "text-green-400 bg-green-500/10 hover:bg-green-500/20"
                : permission === "denied"
                ? "text-red-400/60 cursor-not-allowed"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {pushLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isSubscribed ? (
              <Bell className="h-3 w-3" />
            ) : (
              <BellOff className="h-3 w-3" />
            )}
          </button>
          {notifications.length > 0 && (
            <button
              onClick={markAllRead}
              className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/40 transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      {/* Notification list */}
      {scrollable ? (
        <ScrollArea
          className="w-full flex-1"
          style={{ minHeight: "160px", height: "auto", maxHeight: "calc(80dvh - 120px)" }}
        >
          {list}
        </ScrollArea>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {list}
        </div>
      )}

      {/* This device, a browser notification, and every device — on demand */}
      <NotificationTests
        isSubscribed={isSubscribed}
        permission={permission}
        pushLoading={pushLoading}
        requestPermission={requestPermission}
      />

      {/* Footer */}
      {notifications.length > 0 && (
        <div className="border-t border-border/50 px-4 py-3 flex items-center justify-between shrink-0 pb-[env(safe-area-inset-bottom,12px)]">
          <span className="text-xs text-muted-foreground">
            {notifications.length} notification{notifications.length !== 1 ? "s" : ""}
          </span>
          <button
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
    </>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function NotificationBell() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [showPermissionBanner, setShowPermissionBanner] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { accessToken } = useAuthStore();
  const { permission, isSubscribed, isLoading: pushLoading, requestPermission } = usePushNotification();
  const isMobile = useIsMobile();
  const { data: storedList } = useNotifications(Boolean(accessToken));
  const markAllStoredRead = useMarkAllNotificationsRead();
  const deleteStored = useDeleteNotification();
  const clearStored = useClearNotifications();

  const unread = notifications.filter((n) => !n.read).length;

  // ── What the server kept: loaded on sign-in and after every change ─────────
  useEffect(() => {
    if (!storedList) return;
    const stored = storedList.items.map(fromStored);
    const known = new Set(stored.map((n) => n.id));
    const newest = stored.reduce((t, n) => Math.max(t, new Date(n.createdAt).getTime()), 0);
    // Live-only notices (older events that are not stored) stay; stored ones are replaced by the server's copy —
    // except one that came on the socket after this list was read, which the list can't have yet.
    setNotifications((prev) =>
      mergeNotifications(
        stored,
        prev.filter((n) => !n.stored || (!known.has(n.id) && new Date(n.createdAt).getTime() > newest))
      )
    );
  }, [storedList]);

  // ── Show push permission banner if not yet granted ────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = sessionStorage.getItem("push-banner-dismissed");
    // Not while a super admin views as someone: this browser's push is the admin's.
    if (!dismissed && permission === "default" && !isSubscribed && !getViewAs()) {
      const timer = setTimeout(() => setShowPermissionBanner(true), 3000);
      return () => clearTimeout(timer);
    }
  }, [permission, isSubscribed]);

  // ── Listen for real-time notifications via socket ─────────────────────────
  useEffect(() => {
    if (!accessToken || typeof window === "undefined") return;
    const socket = getSocket(accessToken);

    const handler = (payload: Omit<AppNotification, "id" | "read"> & { id?: string }) => {
      // Stored notices arrive with their id; older live-only events get one made up here.
      const notif: AppNotification = {
        ...payload,
        id: payload.id ?? `${Date.now()}-${Math.random()}`,
        read: false,
        stored: Boolean(payload.id),
      };
      setNotifications((prev) => mergeNotifications([notif], prev));
      toast(notif.title, {
        description: notif.body,
        duration: 5000,
        action: notif.url
          ? { label: "View", onClick: () => { window.location.href = notif.url!; } }
          : undefined,
        icon: (() => {
          const cfg = TYPE_CONFIG[notif.type] ?? DEFAULT_TYPE;
          const Icon = cfg.icon;
          return <Icon className={`h-4 w-4 ${cfg.color}`} />;
        })(),
      });
    };

    socket.on("notification", handler);
    return () => { socket.off("notification", handler); };
  }, [accessToken]);

  // ── Close desktop popover when clicking outside ───────────────────────────
  useEffect(() => {
    if (isMobile) return; // Drawer handles its own dismissal
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, isMobile]);

  const markAllRead = useCallback(() => {
    if (notifications.some((n) => n.stored && !n.read)) markAllStoredRead.mutate();
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, [notifications, markAllStoredRead]);

  const dismiss = useCallback((id: string) => {
    const target = notifications.find((n) => n.id === id);
    if (target?.stored) deleteStored.mutate(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, [notifications, deleteStored]);

  const clearAll = useCallback(() => {
    if (notifications.some((n) => n.stored)) clearStored.mutate();
    setNotifications([]);
  }, [notifications, clearStored]);

  const handleOpen = useCallback(() => {
    setOpen((v) => !v);
    markAllRead();
  }, [markAllRead]);

  const sharedProps = {
    notifications,
    unread,
    isSubscribed,
    permission,
    pushLoading,
    requestPermission,
    markAllRead,
    dismiss,
    clearAll,
    onClose: () => setOpen(false),
  };

  return (
    <div className="relative" ref={panelRef}>
      {/* ── Push permission banner ──────────────────────────────────────────── */}
      <AnimatePresence>
        {showPermissionBanner && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.97 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute right-0 top-12 z-50 w-72 sm:w-80 rounded-xl border border-border/60 bg-card/95 backdrop-blur-md shadow-2xl p-4"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/15 p-2 shrink-0">
                <Bell className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Stay in the loop</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Get notified when leads are assigned to you or your team gets updates.
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    disabled={pushLoading}
                    onClick={async () => {
                      await requestPermission();
                      setShowPermissionBanner(false);
                    }}
                  >
                    {pushLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
                    Enable
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => {
                      setShowPermissionBanner(false);
                      sessionStorage.setItem("push-banner-dismissed", "1");
                    }}
                  >
                    Not now
                  </Button>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowPermissionBanner(false);
                  sessionStorage.setItem("push-banner-dismissed", "1");
                }}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Bell button ─────────────────────────────────────────────────────── */}
      <button
        onClick={handleOpen}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        aria-label="Notifications"
      >
        {permission === "denied" ? (
          <BellOff className="h-[18px] w-[18px]" />
        ) : (
          <Bell className="h-[18px] w-[18px]" />
        )}
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white"
            >
              {unread > 9 ? "9+" : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {/* ── Mobile: Drawer (bottom sheet) ───────────────────────────────────── */}
      {isMobile && (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="flex flex-col rounded-t-[14px] border-border/50 bg-card/95 backdrop-blur-md max-h-[88dvh]">
            <NotificationContent {...sharedProps} scrollable />
          </DrawerContent>
        </Drawer>
      )}

      {/* ── Desktop: Floating popover panel ─────────────────────────────────── */}
      {!isMobile && (
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="absolute right-0 top-11 z-50 w-96 rounded-xl border border-border/60 bg-card/95 backdrop-blur-md shadow-2xl overflow-hidden"
            >
              <NotificationContent {...sharedProps} />
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
