# ❌ Mistakes Log — Carlton CRM Frontend

> Every bug, wrong approach, or bad pattern found and fixed must be logged here.
> **Before writing code**, scan this file for patterns relevant to your current task.
> If a logged mistake pattern is detected — apply the correct fix directly. No repeats.

---

## How to Use This File

- **Before coding**: Search by keyword (component name, library, pattern, API)
- **When a bug is fixed**: Add it immediately at the **top** of the correct category
- **Entry count**: Increment counter at the bottom each time

---

## 📋 Mistake Entry Template

```
### [SHORT TITLE]
- **Date**: YYYY-MM-DD
- **Category**: notifications | datetime | react-query | nextjs | typescript | tailwind | framer-motion | api | forms | components | general

**What happened**:
Description of the bug or wrong approach.

**Why it happened**:
Root cause.

**Fix**:
What was changed.

**Rule — Never do this again**:
> One-line rule stated clearly.

**Code**:
// ❌ Wrong
...
// ✅ Correct
...
```

---

## 🗂 Categories

---

## 🔔 Notifications & Browser APIs

### Android `new Notification()` Constructor Crash
- **Date**: 2026-04-01
- **Category**: notifications

**What happened**:
`TypeError: Illegal constructor` on Android Chrome when triggering reminder notifications. Desktop browsers worked fine, Android silently crashed.

**Why it happened**:
Android Chrome blocks the direct `new Notification()` constructor. It only allows notifications via `ServiceWorkerRegistration.showNotification()`.

**Fix**:
In `hooks/useReminderNotifications.ts`, replaced all `new Notification(title, options)` with:
```ts
const reg = await navigator.serviceWorker.ready
reg.showNotification(title, options)
```

**Rule — Never do this again**:
> Never call `new Notification()` directly — always route through `navigator.serviceWorker.ready.then(reg => reg.showNotification(...))`.

**Code**:
```ts
// ❌ Wrong — crashes on Android Chrome
function fireBrowserNotification(title: string, body: string) {
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/icon.png" })
  }
}

// ✅ Correct — works on all platforms
async function fireBrowserNotification(title: string, body: string) {
  if (Notification.permission !== "granted") return
  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.ready
    reg.showNotification(title, { body, icon: "/icon.png" })
  } else {
    new Notification(title, { body }) // desktop fallback only
  }
}
```

---

## 🕐 Date / Time (IST)

### `toDatetimeLocal()` Using Browser Timezone Instead of IST
- **Date**: 2026-04-01
- **Category**: datetime

**What happened**:
Reminder times displayed with wrong hours on non-IST browsers (e.g. Vercel preview on UTC server, or users browsing from different timezone).

**Why it happened**:
`d.getHours()` returns hours in the **browser's local timezone**, not IST. On a UTC machine, IST times appear 5h30m off.

**Fix**:
Use `toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" })` which always outputs a string in `YYYY-MM-DD HH:mm:ss` format in IST, regardless of browser timezone.

**Rule — Never do this again**:
> All `datetime-local` conversions MUST use `sv-SE` locale + `Asia/Kolkata` timeZone. Never use `getHours()`, `getDate()`, etc. for IST output.

**Code**:
```ts
// ❌ Wrong — browser-timezone dependent
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ✅ Correct — always IST
function toDatetimeLocal(iso: string): string {
  return new Date(iso)
    .toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" })
    .slice(0, 16)
    .replace(" ", "T")
}
function nowIST(): string {
  return toDatetimeLocal(new Date().toISOString())
}
```

**Files fixed**: `components/leads/ReminderPanel.tsx`, `app/(dashboard)/reminders/page.tsx`

---

### `datetime-local` Input Parsed as UTC Instead of IST
- **Date**: 2026-04-01
- **Category**: datetime

**What happened**:
When saving a reminder, the time was stored 5 hours 30 minutes behind the intended IST time. E.g., user picks `10:00 AM IST`, stored as `04:30 UTC` (correct) but the parsing intermediate step was wrong and some paths stored `10:00 UTC` = `3:30 PM IST`.

**Why it happened**:
`new Date("2024-06-01T10:00")` — a datetime string without timezone is parsed as **UTC** in V8 (Chrome/Node). So `10:00` was treated as `10:00 UTC` = `15:30 IST`.

**Fix**:
Append `:00+05:30` to force IST parsing:
```ts
const pickedIST = new Date(`${remindAt}:00+05:30`)
```

**Rule — Never do this again**:
> All `datetime-local` string parsing must append `:00+05:30` to force IST timezone. Never pass a bare `datetime-local` value to `new Date()`.

**Code**:
```ts
// ❌ Wrong — parsed as UTC
const pickedDate = new Date(remindAt) // "2024-06-01T10:00" → UTC

// ✅ Correct — parsed as IST
const pickedDate = new Date(`${remindAt}:00+05:30`) // explicitly IST
```

**Files fixed**: `components/leads/ReminderPanel.tsx`, `app/(dashboard)/reminders/page.tsx`

---

### Time Display Missing IST Label
- **Date**: 2026-04-01
- **Category**: datetime

**What happened**:
Reminder times displayed without timezone label — users confused whether times were IST or UTC.

**Why it happened**:
`toLocaleString` was called without `timeZone: "Asia/Kolkata"` option, falling back to browser timezone.

**Fix**:
Added `timeZone: "Asia/Kolkata"` to all `toLocaleString` calls that display reminder times, and appended `" IST"` to the output string.

**Rule — Never do this again**:
> All time display for this CRM must use `timeZone: "Asia/Kolkata"` and append `" IST"` so users always see IST-labeled times.

**Code**:
```ts
// ❌ Wrong
function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { ... }) // no timezone
}

// ✅ Correct
function formatTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " IST"
}
```

---

## 📦 Components

### Duplicate Delete Dialogs Across Modules
- **Date**: 2026-04-01
- **Category**: components

**What happened**:
6 separate delete dialog components existed (`DeleteLeadDialog`, `DeleteUserDialog`, `DeleteTeamDialog`, `DeleteRoleDialog`, `DeleteCourseDialog`) — all nearly identical. Bug fixed in one was not fixed in others.

**Why it happened**:
No global `ConfirmDialog` existed. Each developer built their own.

**Fix**:
Create `components/shared/ConfirmDialog.tsx` as the single global confirmation dialog. All delete dialogs should use it. Document in `componentsHistory.md`.

**Rule — Never do this again**:
> Before building any modal/dialog, check `componentsHistory.md`. If a `ConfirmDialog` or `ResponsiveModal` exists — use it, never build a new one from scratch.

---

## 🔄 React Query

### Fetching Data in `useEffect` Instead of React Query
- **Date**: 2026-04-01
- **Category**: react-query

**What happened**:
Some components fetched data directly inside `useEffect` with `axios`. Data was not cached, re-fetched on every mount, and loading/error states were manually managed.

**Why it happened**:
Component was written without checking existing hooks.

**Fix**:
Move all data fetching to React Query hooks in `/hooks/`. Use `useQuery` for reads, `useMutation` for writes.

**Rule — Never do this again**:
> Zero raw fetches in components. All server state through React Query hooks in `/hooks/`. No exceptions.

**Code**:
```tsx
// ❌ Wrong
const [leads, setLeads] = useState([])
useEffect(() => {
  axios.get("/leads").then(r => setLeads(r.data))
}, [])

// ✅ Correct
const { data: leads, isLoading, error } = useLeads(filters)
```

---

### Missing `onError` Toast in Mutations
- **Date**: 2026-04-01
- **Category**: react-query

**What happened**:
Mutations failed silently — no error message shown to the user.

**Why it happened**:
`useMutation` was called without an `onError` handler.

**Fix**:
Every `useMutation` must have both `onSuccess` (toast + invalidate) and `onError` (error toast).

**Rule — Never do this again**:
> Every mutation must have `onError: (err) => toast.error(err.response?.data?.message ?? err.message)`.

---

## 🎨 Tailwind CSS

### Raw Color Classes Breaking Dark Mode
- **Date**: 2026-04-01
- **Category**: tailwind

**What happened**:
Some components appeared white-on-white in dark mode because they used `bg-white` and `text-gray-900`.

**Why it happened**:
Raw Tailwind color classes don't invert in dark mode. Semantic tokens like `bg-card` do.

**Fix**:
Replace all raw color classes with semantic token equivalents.

**Rule — Never do this again**:
> Never use raw Tailwind colors (`bg-white`, `text-gray-900`, `border-gray-200`). Always use semantic tokens (`bg-card`, `text-foreground`, `border-border`).

**Code**:
```tsx
// ❌ Wrong
<div className="bg-white text-gray-900 border border-gray-200">

// ✅ Correct
<div className="bg-card text-card-foreground border border-border">
```

---

### Inline `style={}` Instead of Tailwind
- **Date**: 2026-04-01
- **Category**: tailwind

**What happened**:
Responsive breakpoints and dark mode didn't work on elements using inline styles.

**Why it happened**:
Convenience — quick inline style instead of finding the Tailwind class.

**Fix**:
Replace all `style={{ ... }}` with equivalent Tailwind utility classes.

**Rule — Never do this again**:
> Zero inline styles. All styling via Tailwind classes only.

---

## 🌐 General / Other

### Tailwind classes built from pieces never exist
- **Date**: 2026-10-01
- **Category**: tailwind

**What happened**:
The calendar's first draft coloured each mentor with `` `bg-${color}-500/15` ``. Tailwind only generates classes it finds written out in the source, so those would have rendered with no colour at all.

**Fix**:
A lookup of full class names (`components/calendar/mentorColors.ts`).

**Rule — Never do this again**:
> Never assemble a Tailwind class from variables — map each value to the full class name.

---

### Spreading a Set or Map fails the typecheck (TS2802)
- **Date**: 2026-09-30
- **Category**: typescript

**What happened**:
`[...new Set(days)]` and `[...map.values()]` failed `tsc` with TS2802 — this project compiles to a target below ES2015 without `downlevelIteration`. Hit twice (NotificationBell, Inactive Leads page).

**Fix**:
`Array.from(new Set(days))`, `Array.from(map.values())`.

**Rule — Never do this again**:
> Never spread a Set, Map or iterator here — use `Array.from(...)`.

---

### No Input Validation for Future Time on Reminder Form
- **Date**: 2026-04-01
- **Category**: forms

**What happened**:
Users could save reminders with past times, causing notifications to fire immediately on creation.

**Why it happened**:
No `min` attribute on `datetime-local` input, and no frontend validation.

**Fix**:
1. Added `min={nowIST()}` on `<input type="datetime-local">` — prevents past-time selection
2. Added `timeError` state with future-time check before save
3. Backend also validates future time (double safety)

**Rule — Never do this again**:
> All `datetime-local` inputs for future-event scheduling must have `min={nowIST()}` and a frontend validation check before submit.

---

## [2026-10-14] Pages not named after a permission sent everyone but Super Admin away

**Bug:** The dashboard layout's guard read the first path segment as the permission module — `hasPermission(pathname.split("/")[1], "view")`. There is no "my-tracker" or "calls" permission, so every role but Super Admin was redirected off My Tracker and Calls although the sidebar showed them the link — the BDE even with Tracker ticked.
**Fix:** `canOpen()` in `app/(dashboard)/layout.tsx`: a path named after a module in `CRM_MODULES` needs that module; any other sidebar page needs its item's `permModule` (`null` = every role). The same fix as Draw (2026-10-03).
**Rule:** A page whose path is not a permission module goes in `navItems` with the right `permModule` — the guard goes by that, not by the path.

---

## ➕ Adding a New Mistake

Copy the template at the top and place it at the **top** of the correct category section.

**Entry count**: 12
*(Increment every time you add a mistake)*

---

### A report kept its own status list (2026-10-01)
- **Category**: data

**What happened**: the team Report hard-coded 13 statuses from an older version of the CRM. After the statuses changed, leads in Pending Response, Lost, Not Connected, MIA or Repeated counted in Total but in no column ("Total 8", two in the columns).

**Rule — never do this again**:
> Columns over lead statuses come from `LEAD_STATUSES` / `STATUS_META` in `lib/statusConfig.ts`. A table with a Total shows what its columns don't cover (an "Other" column), so a gap is visible instead of silent.

### Report periods from the browser's calendar (2026-10-01)
- **Category**: datetime

**What happened**: "This Month" was `toGstDateISO(new Date(y, m, 1))` — local midnight on the 1st, converted to a Dubai date. East of Dubai (India) that is still the previous day in Dubai, so the month began a day early. The same applies to `getDay()` for the week.

**Rule**: take today's Dubai date first (`toGstDateISO(new Date())`) and do date arithmetic on that string (`shiftDay` in the Report tab). Still built the old way: the period buttons in `components/reports/ExportPdfDialog.tsx`.

### A dialog that stays mounted keeps its state (2026-10-01)
- **Category**: components

**What happened**: `AssignLeadDialog` is rendered once on the Leads page and only opened and closed. Its Cancel button closed it without clearing the chosen user, so the next lead's dialog opened with that person already picked and Assign enabled — one click from giving the wrong lead away. (Found in review before release.)

**Rule — never do this again**:
> A dialog mounted once and reused for different records resets its own form state when it opens for a record (`useEffect` on `open` + the record id), and every way of closing it goes through the same reset.

### Tailwind never scanned `lib/` (2026-10-01)
- **Category**: styling

**What happened**: `tailwind.config.ts` scanned `pages`, `components`, `app` and `src` only, yet every status colour lives in `lib/statusConfig.ts`. A class used only there was never generated — MIA's Kanban drop tint (`bg-rose-500/5`) had none, and the new statuses' teal and pink classes would have been missing too. It worked for most statuses only because the same classes happened to appear in some page.

**Rule**: any folder whose files hold Tailwind class strings is in `content` — `lib/` is now.
