import { AsyncLocalStorage } from "node:async_hooks";

/*
 * A Super Admin acting through "View as" (the owner, 2026-10-30: they can do the actions too). The request runs as the
 * person viewed — so leads, logs and counts show that person — and this says who really did it, for the lines written
 * on a lead while it lasts (Lead.ts) and the session's own record of actions (middleware/auth.ts).
 */
export type ViewAs = { adminId: string; adminName: string; sessionId: string };
const store = new AsyncLocalStorage<ViewAs>();

export const runViewAs = <T>(ctx: ViewAs, fn: () => T): T => store.run(ctx, fn);
export const currentViewAs = (): ViewAs | undefined => store.getStore();

/** " (by <admin> using View as)" while one is acting, else "". */
export const viewAsNote = (): string => {
  const v = store.getStore();
  return v ? ` (by ${v.adminName} using View as)` : "";
};
