"use client";
import { useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { useAuthStore } from "@/lib/store/authStore";
import { navItems } from "@/components/layout/Sidebar";
import { CRM_MODULES } from "@/types";
import { useReminderNotifications } from "@/hooks/useReminderNotifications";
import { useSyncedCurrency } from "@/hooks/useSyncedCurrency";
import { CurrencyRedraw } from "@/components/shared/CurrencyRedraw";
import { useActivityHeartbeat } from "@/hooks/useActivityHeartbeat";
import { RecentPageTracker } from "@/components/shared/CommandPalette";
import { SaleCelebration } from "@/components/shared/SaleCelebration";
import { RootPortalHistoryBridge } from "@/components/shared/RootPortalHistoryBridge";
import { CallFlowProvider } from "@/components/calls/CallFlow";

/**
 * Pages everyone signed in may open, whatever their role. Every other page is
 * read as a module on the Roles screen — Mentors, Commission, Leaderboard and
 * Calendar have their own rows since 2026-10-07, open to every role until
 * someone unticks them.
 */
const OPEN_TO_EVERYONE = new Set(["/login", "/profile"]);

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, hasPermission } = useAuthStore();
  const router = useRouter();
  useReminderNotifications();
  // The currency they see amounts in, from their account — the same on every device (2026-10-15).
  useSyncedCurrency();
  useActivityHeartbeat();

  useEffect(() => {
    if (typeof window !== "undefined" && !isAuthenticated) {
      // alert("You are not authorized to access this page");
      router.replace("/login");

    }
  }, [isAuthenticated, router]);



  if (!isAuthenticated && typeof window !== "undefined") return null;

  const pathname = usePathname();

  // Whether this role may open a page. A path named after a permission module
  // needs that module's "view" (/leads/…, /settings, /mentors). Any other
  // sidebar page needs what its sidebar item names — /my-tracker is Tracker,
  // /calls its module — or nothing. Reading the path alone sent everyone but
  // Super Admin away from My Tracker and Calls (2026-10-14): there is no
  // "my-tracker" permission to have, even with Tracker ticked.
  const canOpen = (path: string) => {
    const segment = path.split("/")[1] ?? "";
    if ((CRM_MODULES as readonly string[]).includes(segment)) return hasPermission(segment, "view");
    const item = navItems.find((n) => n.href === `/${segment}`);
    if (item) return item.permModule === null || hasPermission(item.permModule, "view");
    return hasPermission(segment, "view");
  };

  const redirectPermisionPage = useCallback(() => {
    if (typeof window == "undefined") return;
    for (let i = 0; i < navItems.length; i++) {
      const item = navItems[i];
      if (canOpen(item.href)) {
        router.push(item.href);
        break;
      }
    }
  }, [hasPermission]);
  useEffect(() => {
    if (OPEN_TO_EVERYONE.has(pathname)) return;
    if (!canOpen(pathname)) {
      redirectPermisionPage();
    }
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-neutral-200 dark:bg-background pwa-safe-top">
      <RootPortalHistoryBridge />
      <RecentPageTracker />
      <SaleCelebration />
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Every Call button's dialogs: 3CX or phone, the call window, "How did the call go?" */}
        <CallFlowProvider>
          <Header />
          <main className="flex-1 overflow-y-auto p-6"><CurrencyRedraw>{children}</CurrencyRedraw></main>
        </CallFlowProvider>
      </div>
    </div>
  );
}
