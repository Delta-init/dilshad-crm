"use client";
import { useEffect, useState } from "react";
import { LogOut, User, Menu, Search, ChevronRight } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/lib/store/authStore";
import { useLogout } from "@/hooks/useAuth";
import { getInitials } from "@/lib/utils";
import { useUiStore } from "@/lib/store/uiStore";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ThemeToggle } from "@/components/shared/ThemeToggle";
import { BreakButton } from "@/components/shared/BreakButton";
import { navItems } from "@/components/layout/Sidebar";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { ImpersonationBanner } from "@/components/shared/ImpersonationBanner";

export function Header() {
  const { user } = useAuthStore();
  const logout = useLogout();
  const { toggleMobileDrawer, toggleSidebarCollapsed } = useUiStore();
  const pathname = usePathname();
  const [commandOpen, setCommandOpen] = useState(false);

  // ⌘K / Ctrl+K global shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Resolve current page label from navItems
  const currentNav = navItems.find(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
  );
  const pageName =
    currentNav?.label ??
    (pathname.split("/")[1]
      ? pathname.split("/")[1].charAt(0).toUpperCase() + pathname.split("/")[1].slice(1)
      : "Dashboard");

  return (
    <>
    {/* While a super admin views the CRM as someone else — above the bar, outside the scrolling page. */}
    <ImpersonationBanner />
    <header className="flex rounded-2xl scale-[.99] h-16 shrink-0 items-center justify-between border-b border-border/10  backdrop-blur-sm px-4 md:px-5">
      {/* ── Left: toggles + breadcrumb ── */}
      <div className="flex items-center gap-2">
        {/* Mobile hamburger */}
        <button
          onClick={toggleMobileDrawer}
          className="md:hidden flex items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Desktop sidebar collapse toggle */}
        <button
          onClick={toggleSidebarCollapsed}
          className="hidden md:flex items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Divider */}
        <div className="hidden md:block h-5 w-px bg-border mx-1" />

        {/* Breadcrumb */}
        <nav className="hidden md:flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">Root</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
          <span className="font-semibold text-primary">{pageName}</span>
        </nav>
      </div>

      {/* ── Right: search + bell + avatar + theme ── */}
      <div className="flex items-center gap-1.5">
        {/* Search bar */}
        <button onClick={() => setCommandOpen(true)} className="hidden md:flex items-center gap-2 h-9 rounded-lg border border-border dark:bg-muted/40 bg-background px-3 text-sm text-muted-foreground hover:dark:bg-muted/70 hover:bg-background/70 transition-colors min-w-[180px]">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left text-xs">Search...</span>
          <kbd className="inline-flex items-center rounded border border-border bg-background px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </button>

        <BreakButton />

        <NotificationBell />

        <ThemeToggle />

        {/* User avatar */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rounded-full transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ml-1">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                  {user ? getInitials(user.name) : "?"}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <p className="font-medium">{user?.name}</p>
              <p className="text-xs text-muted-foreground font-normal mt-0.5">{user?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href="/profile">
                <User className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:text-destructive"
              onClick={logout}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </header>
    </>
  );
}
