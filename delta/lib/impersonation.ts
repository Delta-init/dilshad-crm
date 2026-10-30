"use client";
import { useAuthStore } from "@/lib/store/authStore";
import { API_URL } from "@/lib/apiUrl";
import type { AuthUser, User } from "@/types";

/*
 * "View as": a super admin signs in as one of their people for 30 minutes,
 * read only (the server refuses every change). Their own sign-in waits in
 * localStorage and comes back on "Back to my account", when the time is up, or
 * on any sign-in error while viewing — never the login page. Starting and
 * ending both reload the page, so cached data and live sockets start afresh.
 */

const OWN_KEY = "crm-own-auth";
const VIEW_AS_KEY = "crm-view-as";
const STOP_URL = `${API_URL}/auth/impersonation/stop`;

/** What POST /users/:id/impersonate answers. */
export interface ViewAsStart {
  accessToken: string;
  /** When the pass runs out (ISO), from the server. */
  expiresAt: string;
  user: AuthUser;
}

/** Who is being viewed as, for the banner. */
export interface ViewAsInfo {
  endsAt: string;
  name: string;
  email: string;
}

interface OwnAuth {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** The current view-as session, or null when signed in as yourself. */
export function getViewAs(): ViewAsInfo | null {
  if (typeof window === "undefined") return null;
  return readJson<ViewAsInfo>(VIEW_AS_KEY);
}

/** A super admin, not already viewing as someone, looking at an active user who is not themselves or a super admin. */
export function canViewAs(me: AuthUser | null, target: Pick<User, "_id" | "status" | "role">): boolean {
  if (!me || getViewAs()) return false;
  if (!(me.role?.isSystemRole && me.role.roleName === "Super Admin")) return false;
  if (target._id === me._id || target.status !== "active") return false;
  const role = typeof target.role === "object" ? target.role : null;
  return role?.roleName !== "Super Admin";
}

/**
 * Start viewing as someone: put the admin's own sign-in aside, sign in with the
 * pass, reload. False when there is no complete sign-in of their own to come back to.
 */
export function beginViewAs(start: ViewAsStart): boolean {
  if (typeof window === "undefined" || getViewAs()) return false;
  const state = useAuthStore.getState();
  // The raw keys are what Axios uses (and refreshes), so they are the freshest copy.
  const accessToken = localStorage.getItem("accessToken") ?? state.accessToken;
  const refreshToken = localStorage.getItem("refreshToken") ?? state.refreshToken;
  if (!state.user || !accessToken || !refreshToken) return false;

  localStorage.setItem(OWN_KEY, JSON.stringify({ user: state.user, accessToken, refreshToken } satisfies OwnAuth));
  localStorage.setItem(
    VIEW_AS_KEY,
    JSON.stringify({ endsAt: start.expiresAt, name: start.user.name, email: start.user.email } satisfies ViewAsInfo)
  );
  // The pass has no refresh token: when it stops working, Axios takes the admin back instead.
  useAuthStore.setState({ user: start.user, accessToken: start.accessToken, refreshToken: null, isAuthenticated: true });
  localStorage.setItem("accessToken", start.accessToken);
  localStorage.removeItem("refreshToken");
  window.location.assign("/dashboard");
  return true;
}

/** End the session on the server — it may already be over, which is fine. */
function tellServerItEnded(): void {
  const pass = localStorage.getItem("accessToken");
  if (!pass) return;
  void fetch(STOP_URL, { method: "POST", headers: { Authorization: `Bearer ${pass}` }, keepalive: true }).catch(() => undefined);
}

/** Back to the admin's own account. Does nothing when not viewing as anyone (so repeat calls are harmless). */
export function endViewAs(options: { tellServer?: boolean } = {}): void {
  if (typeof window === "undefined" || !getViewAs()) return;
  if (options.tellServer !== false) tellServerItEnded();
  const own = readJson<OwnAuth>(OWN_KEY);
  localStorage.removeItem(OWN_KEY);
  localStorage.removeItem(VIEW_AS_KEY);

  if (own?.user && own.accessToken && own.refreshToken) {
    useAuthStore.setState({ user: own.user, accessToken: own.accessToken, refreshToken: own.refreshToken, isAuthenticated: true });
    localStorage.setItem("accessToken", own.accessToken);
    localStorage.setItem("refreshToken", own.refreshToken);
    window.location.assign("/users");
    return;
  }
  // Nothing to go back to: sign out completely.
  localStorage.removeItem("crm-auth");
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  window.location.assign("/login");
}

/**
 * Signing out while viewing as someone: end that session, forget it, and hand
 * back the admin's own access token so the sign-out is recorded under them.
 * Null when not viewing as anyone.
 */
export function leaveViewAsForSignOut(): string | null {
  if (typeof window === "undefined" || !getViewAs()) return null;
  tellServerItEnded();
  const own = readJson<OwnAuth>(OWN_KEY);
  localStorage.removeItem(OWN_KEY);
  localStorage.removeItem(VIEW_AS_KEY);
  return own?.accessToken ?? null;
}
