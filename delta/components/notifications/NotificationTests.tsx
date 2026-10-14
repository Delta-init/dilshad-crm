"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ChevronDown, Loader2, Monitor, Smartphone } from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { sendTestPush, showLocalTestNotification } from "@/hooks/usePushNotification";
import { SaleAnnouncementControls } from "@/components/notifications/SaleAnnouncementControls";

/*
 * Testing notifications from the bell (the user, 2026-10-05, as in the Sales
 * CRM): whether this device has them on (and turning them on), a browser
 * notification, and one sent by the server to every device the person enabled —
 * which is how an installed phone app is reached, even when it's closed.
 */

interface NotificationTestsProps {
  isSubscribed: boolean;
  permission: string;
  pushLoading: boolean;
  requestPermission: () => void;
}

export function NotificationTests({ isSubscribed, permission, pushLoading, requestPermission }: NotificationTestsProps) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const blocked = permission === "denied";
  const allowed = permission === "granted";

  async function browserTest() {
    try {
      await showLocalTestNotification();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not show a notification");
    }
  }

  async function devicesTest() {
    setSending(true);
    try {
      toast.success(await sendTestPush(), { description: "Check your phone and your other browsers." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the test");
    } finally {
      setSending(false);
    }
  }

  const status = blocked
    ? { text: "Blocked by this browser — allow notifications for this site in its settings", tone: "text-red-400" }
    : isSubscribed
      ? { text: "On for this device", tone: "text-green-400" }
      : { text: "Off for this device", tone: "text-amber-400" };

  return (
    <div className="border-t border-border/50 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        Test notifications
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="space-y-3 px-4 pb-3"
          >
            {/* This device */}
            <div className="flex items-center justify-between gap-2">
              <p className={cn("text-[11px]", status.tone)}>{status.text}</p>
              {!isSubscribed && !blocked && (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.97 }}
                  onClick={requestPermission}
                  disabled={pushLoading}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
                >
                  {pushLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
                  Enable
                </motion.button>
              )}
            </div>

            <SaleAnnouncementControls />

            {/* Browser and devices */}
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Notifications</p>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => void browserTest()}
                disabled={!allowed}
                className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left text-[11px] hover:border-primary/50 disabled:opacity-50"
              >
                <Monitor className="h-3.5 w-3.5 shrink-0" /> Show a test on this browser
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => void devicesTest()}
                disabled={sending}
                className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left text-[11px] hover:border-primary/50 disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Smartphone className="h-3.5 w-3.5 shrink-0" />}
                Send a test to all my devices (phone app too)
              </motion.button>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Phone app: open the CRM in your phone&apos;s browser, choose &ldquo;Add to Home screen&rdquo;, open it from there once and press
                Enable. After that a test reaches it even when it&apos;s closed — with the phone&apos;s own notification sound.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
