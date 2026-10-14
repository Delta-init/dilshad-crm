# Carlton CRM — Backend Bugs & Fixes

This file documents every real bug found and fixed in this project. Read this before writing similar code. Every entry shows the root cause, the fix, and the rule to follow.

---

## Bug Template
- **Bug Title**
- **File/Location**: where the bug lived
- **Root Cause**: what caused it
- **Symptom**: what went wrong in runtime
- **Fix**: how it was resolved
- **Rule**: what to always do going forward

---

## Bug #1: Populated ObjectId toString() Returns "[object Object]"

**File/Location**: `src/services/teamService.ts` → `autoAssignTeamLeads()`

**Root Cause**: Mongoose's `populate()` replaces an ObjectId field with the full referenced document. When you call `.toString()` on a Mongoose Document (not an ObjectId), it returns `"[object Object]"` — not the ID string.

**Symptom**: The active member filter in round-robin auto-assignment was comparing against `"[object Object]"` strings, which never matched any real ID. As a result, ALL members were treated as active (the filter excluded nothing), and leaders + inactive members were included in assignment distribution.

**Broken code**:
```typescript
// WRONG — team.inactiveMembers is populated [{_id: ObjectId, name: string, ...}]
const inactiveIds = new Set(team.inactiveMembers.map(m => m.toString()));
// m is a Mongoose Document → m.toString() = "[object Object]"
```

**Fix**:
```typescript
// CORRECT — access ._id first, then toString()
const inactiveIds = new Set(team.inactiveMembers.map(m => m._id.toString()));
const leaderIds = new Set(team.leaders.map(l => l._id.toString()));
const activeMembers = team.members.filter(m =>
  !leaderIds.has(m._id.toString()) && !inactiveIds.has(m._id.toString())
);
```

**Rule**: NEVER call `.toString()` directly on a populated Mongoose document. Always access `._id` first: `doc._id.toString()`. This applies anywhere you compare populated ObjectId fields.

---

## Bug #2: Lead Upload Silent Failure (Notes as Object + Invalid Email)

**File/Location**: `src/services/leadService.ts` → `bulkCreateLeads()` and `src/services/excelService.ts` → `parseExcelBuffer()`

**Root Cause**: Two separate issues in the CSV upload pipeline that caused all rows to silently fail:

**Issue A — Notes as plain string/object**:
The `notes` field on the Lead schema expects an array of objects `[{ content: string, author: ObjectId }]`. The upload code was setting `notes: row.notes` (a plain string from the spreadsheet cell) which failed Mongoose schema validation.

**Issue B — "No Email" string failing validation**:
Some spreadsheets use "No Email" as a placeholder in the email column. The Lead schema validates email format. Passing `"No Email"` caused a Mongoose ValidationError for that field.

**Symptom**: With `insertMany({ ordered: false })`, ALL rows were silently dropped (zero leads created). No error was thrown — just zero documents inserted. The controller returned `{ created: 0 }` with no explanation.

**Broken code**:
```typescript
// WRONG
const docs = rows.map(row => ({
  name: row.name,
  email: row.email,        // "No Email" fails validation
  notes: row.notes,        // plain string, not array
}));
```

**Fix**:
```typescript
// CORRECT
const emailRegex = /^\S+@\S+\.\S+$/;

const docs = rows.map(row => ({
  name: row.name,
  email: emailRegex.test(row.email) ? row.email : undefined,  // undefined if invalid
  notes: row.notes
    ? [{ content: row.notes, author: reporterId }]            // always wrap in array
    : [],
}));
```

**Rule**:
1. Always validate email against `/^\S+@\S+\.\S+$/` before inserting — set to `undefined` if invalid, never store the invalid string.
2. Always set `notes` as an array of objects `[{ content, author }]`, never as a plain string.
3. After `insertMany`, always check `result.length` vs input length to surface failures.

---

## Bug #3: `insertMany` `ordered: false` Silent Failures

**File/Location**: All bulk insert operations — `leadService.ts` `bulkCreateLeads()`

**Root Cause**: `Model.insertMany(docs, { ordered: false })` does NOT throw when individual documents fail validation or violate unique constraints. It silently skips failed documents and returns only the successfully inserted ones. The difference between the input array length and the result array length is the failure count — but only if you check.

**Symptom**: Callers assumed all documents were inserted if no error was thrown. Silent data loss — the user uploaded 50 leads and only 38 were inserted, but the response said "created: 50".

**Broken code**:
```typescript
const result = await Lead.insertMany(docs, { ordered: false });
return { created: result.length }; // never says how many failed
```

**Fix**:
```typescript
const result = await Lead.insertMany(docs, { ordered: false });
const failed = docs.length - result.length;
if (failed > 0) {
  console.warn(`[bulkCreateLeads] ${failed} of ${docs.length} documents failed to insert`);
}
return {
  created: result.length,
  failed,
  errors: invalidRows   // rows rejected during parsing
};
```

**Rule**: After EVERY `insertMany` call, compare `result.length` to the input array length. Log and surface the difference. Never assume all documents were inserted.

---

## Bug #4: JWT Role Loaded Once at Token Issue Time

**File/Location**: `src/middleware/auth.ts` — original version

**Root Cause**: The original `authenticate` middleware decoded the JWT and used the `roleId` from the token payload to check permissions, but did NOT re-fetch the role from the database. The JWT was generated at login time and cached the role state from that moment.

**Symptom**: If an admin updated a role's permissions AFTER a user had already logged in (valid token), the user's permissions in the current session would not reflect the change until their token expired (up to 15 minutes). In some scenarios with long-lived sessions, stale permissions persisted for hours.

**Broken code**:
```typescript
// WRONG — permissions cached in JWT at login time
const decoded = verifyAccessToken(token);
req.user = {
  userId: decoded.userId,
  email: decoded.email,
  roleId: decoded.roleId,
  permissions: decoded.permissions  // stale — from token, not current DB state
};
```

**Fix**:
```typescript
// CORRECT — always load fresh role from DB
const decoded = verifyAccessToken(token);
const user = await User.findById(decoded.userId).select("-password");
const role = await Role.findById(user.role);  // fresh from DB every request
req.user = { userId: user._id.toString(), email: user.email, roleId: role._id.toString(), role };
```

**Rule**: The `authenticate` middleware MUST fetch a fresh Role document from the database on every request. Never rely solely on the JWT payload for permission data. The JWT payload carries `userId`, `email`, `roleId` for identification — permissions must always be loaded fresh.

---

## Bug #5: Reminder `arrayFilters` Missing `_id` Match

**File/Location**: `src/services/reminderScheduler.ts` — initial implementation

**Root Cause**: When updating embedded sub-documents with `arrayFilters`, if the filter is too broad (e.g., only filtering by `remindAt` value), multiple sub-documents might match. The `$set` with positional operator `$[r]` would then update the FIRST matching element, potentially stamping `notifiedAt` on the wrong reminder.

**Symptom**: On leads with multiple reminders at similar times, the wrong reminder was getting stamped as `notifiedAt`. A reminder that fired at 10:00 AM would stamp `notifiedAt` on the reminder at 10:05 AM (first matching). The 10:05 reminder then never fired because it appeared already notified.

**Broken code**:
```typescript
// WRONG — filter by remindAt only, could match multiple reminders
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].notifiedAt": now } },
  { arrayFilters: [{ "r.remindAt": { $lte: now }, "r.isDone": false }] }
);
```

**Fix**:
```typescript
// CORRECT — always filter by _id for exact sub-document targeting
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].notifiedAt": now } },
  { arrayFilters: [{ "r._id": reminder._id }] }
);
```

**Rule**: Always use `arrayFilters` with `"r._id": subDocumentId` to target the exact embedded sub-document. Never use only value-based filters (like `remindAt` or `status`) in arrayFilters — they can match unintended elements.

---

## Bug #6: `/mine` Route Shadowed by `/:id`

**File/Location**: `src/routes/teamRoutes.ts` — route declaration order

**Root Cause**: Express matches routes in the order they are declared. A parameterized route like `GET /:id` matches ANY string in that position, including literal strings like `"mine"`. If `/:id` is declared before `/mine`, the request `GET /teams/mine` is handled by the `/:id` handler with `req.params.id = "mine"`. Mongoose then tries to cast `"mine"` as an ObjectId, which throws a CastError.

**Symptom**: `GET /teams/mine` returned 400 "Invalid ID format" (or a 500 CastError) instead of returning the current user's team.

**Broken code**:
```typescript
// WRONG — /:id catches everything including /mine
router.get("/:id", authenticate, checkPermission("teams","view"), getTeamById);
router.get("/mine", authenticate, getMyTeam);  // NEVER REACHED
```

**Fix**:
```typescript
// CORRECT — static routes before parameterized routes
router.get("/mine", authenticate, getMyTeam);
router.get("/:id", authenticate, checkPermission("teams","view"), getTeamById);
```

**Rule**: ALL static path segments (`/mine`, `/all`, `/bulk`, `/upload`, `/simple`, `/stats`, `/auto-assign`) MUST be declared BEFORE any parameterized routes (`/:id`, `/:leadId`, `/:teamId`). This applies to ALL routers in the project.

---

## Bug #7: `/bulk` Routes Shadowed by `/:leadId`

**File/Location**: `src/routes/teamRoutes.ts` — nested route declaration order

**Root Cause**: Same underlying issue as Bug #6 but with nested routes. The route `PATCH /teams/:id/leads/bulk/assign` was being matched by `PATCH /teams/:id/leads/:leadId/assign` with `req.params.leadId = "bulk"`. This then tried to find a lead with ID `"bulk"`, which failed.

**Symptom**: `PATCH /teams/:teamId/leads/bulk/assign` returned 404 "Lead not found" or a CastError instead of running bulk assignment.

**Broken code**:
```typescript
// WRONG — /:leadId/assign catches /bulk/assign
router.patch("/:teamId/leads/:leadId/assign", ...handlers);
router.patch("/:teamId/leads/bulk/assign", ...handlers);  // NEVER REACHED
```

**Fix**:
```typescript
// CORRECT — /bulk/* routes before /:leadId routes
router.patch("/:teamId/leads/bulk/assign", authenticate, checkPermission("teams","edit"), bulkAssignToMember);
router.patch("/:teamId/leads/bulk/transfer", authenticate, checkPermission("teams","edit"), bulkTransfer);
router.patch("/:teamId/leads/bulk/status", authenticate, checkPermission("teams","edit"), bulkUpdateStatus);
router.patch("/:teamId/leads/:leadId/assign", authenticate, checkPermission("teams","edit"), assignLeadToMember);
```

**Rule**: Same as Bug #6 — static paths before parameterized paths. For nested routes, check EACH level of nesting for this ordering issue. Always declare `/bulk/...` routes before `/:id/...` routes at the same nesting level.

---

## [2026-04-06] Lead Status enum mismatch — PipelineStage type

**Bug:** When adding `getTeamReminders` aggregation pipeline, typed as `object[]` instead of `PipelineStage[]`. Mongoose aggregation requires the stricter `PipelineStage[]` type from mongoose.
**Fix:** `import { type PipelineStage } from "mongoose"` and typed pipeline as `PipelineStage[]`.
**Also:** `preserveNullAndEmpty` is not valid — correct key is `preserveNullAndEmptyArrays` in `$unwind` stage.

---

## Settings are cached per process for 30 s (2026-09-30)

**What happened:** a Phase 1 test switched an email type off through the API, then called `notify()` from the test's own
process — and the email still went. `settingsService` caches the settings for 30 seconds in each process; `PUT /settings/app`
clears only the cache of the process that served it.

**Not a bug in the product:** `notify()` runs inside the backend, whose cache the PUT clears. A separate process (a second
API instance, or a scheduler-only process) sees a change within 30 seconds, by design.

**Rule:** a test (or script) that changes settings over HTTP and then calls a service in its own process must wait out the
30 s cache, or run the check through the API.

**Seen again (2026-10-01):** the cache also outlives a *database reset* in a running backend — a Phase 3 re-run straight after
a Phase 2 run counted active minutes on the UTC date (the old setting) while the test used Dubai, just after Dubai midnight.
After wiping a test database, wait 31 s (or restart the backend) before the next suite.

---

## A system action's `performedBy` — leave it out, never null (2026-09-30)

**What we found:** the team Logs tab renders `typeof log.performedBy === "object" ? log.performedBy.name : …`. `typeof null` is
`"object"`, so one activity entry stored with `performedBy: null` would crash the whole tab.

**Rule:** for something the CRM did on its own (an automatic inactive-lead move), omit `performedBy` from the activity entry.
The field is optional since 2026-09-30; a missing performer already shows as "System" on the lead page, team logs, the team feed
and reports.

**Related, not fixed yet:** `splitScheduler` passes the string `"system"` as the performer. It cannot be cast to an ObjectId, so
the timed daily split assigns the lead but its `lead_assigned` entry — and the new owner's notification after it — fail
(`CastError`, logged as `[autoSplitLead] error`).

---

## Presence timestamps only move forward — `$max`, not `$set` (2026-09-30)

**What happened:** in the Phase 3 test, a heartbeat recorded "a minute from now" was followed by a real one, and `$set` moved
`lastSeenAt` backwards. With one server that cannot happen; with two whose clocks differ by a second, a late heartbeat could.

**Fix:** `recordHeartbeat` writes `lastSeenAt` / `lastActiveAt` with `$max`. The idle sweep's conditional update on
`lastActiveAt` is unaffected.

---

## A filter narrows a role's view — it never replaces it (2026-10-01)

**Rule:** when a list is limited by role (a BDE to their own leads, a team leader to their team), a query filter on the same
field must be combined with that limit, not assigned over it; a filter pointing outside the limit returns nothing. Endpoints
that serve one person's data (`/users/:userId/leads`, `lead-stats`, `revenue`, `/users/:id/export-pdf`) go through
`selfOrOverseer()`.

**Where:** `leadService.getLeads` (`narrow()`), `middleware/permissions.selfOrOverseer`. Tested 28/28 — every role's own view
unchanged.


---

## A second copy of the status list drifts (2026-10-01)

**What happened:** the lead statuses changed (Pending Response, Lost, Not Connected, MIA, Repeated came in; Interested,
Booking, Partial Booking, RNR, Rejected, WhatsApp, Student went), but the team Report and the team PDF kept their own
hard-coded list. A team showed "Total 8" with only 2 leads in its columns.

**Rule:** count statuses from the model — `LEAD_STATUS_VALUES` in `teamService` (the schema's enum) — and keep a row's
total reconcilable (show what no column counts as Other). Still on the old list: the Reports page's Excel/PDF export, the
user PDF, the Sales Funnel's "qualified" step and the AI insights' closings.

**Also:** report dates are Dubai days. `new Date(day + "T00:00:00.000Z")` reads them as UTC days — 4 hours off. Use
`gstDayRange`.

## populate() on an array entry threw after the save — Log follow-up said it failed (2026-10-14)

**What happened:** `leadService.addFollowUp` saved the lead, then called `saved.populate("followedUpBy", …)` on the new
`followUps` entry. Mongoose 8 throws on `populate()` of an array subdocument, so `POST /leads/:id/followups` answered 500
with the follow-up already saved — the lead page's Log follow-up panel showed "Failed to log follow-up" and stayed open,
inviting a second (duplicate) save. Found by the 3CX port's check (the after-call popup uses the same route).

**Rule:** populate an array entry through its parent: `lead.populate({ path: `followUps.${i}.followedUpBy`, select })`,
then return `lead.followUps[i]`. Never `doc.arr[i].populate(...)`.

## A call split across two day windows kept only its later rows (2026-10-14)

**What happened:** the 3CX sync reads the call log a day at a time (the first run: 90 of them). A call's rows have their
own start times; when they straddle the start of a day (a queue call answered a second later), each day parsed only its
own rows and the later day's upsert overwrote the earlier — the call kept one row: wrong talk time, taker, recordings.
Caught by the check (2 runs in 10, when the fixture's call fell on a boundary). The Draw CRM's sync has the same gap.

**Rule:** read each day after the first from `OVERLAP_MS` before it starts, so the later day sees the whole call; calls
are keyed, so reading a row twice is harmless.

## A one-time copy counted as done when it had only begun (2026-10-14, before shipping)

**What happened:** `keepHandCounts` treated "the backup collection has any document" as "the copy is done". A copy cut
short after its first 1,000 leads (a restart, a database error) was then skipped by the next run, which replaced every
lead's counts — the rest of the counts from before 3CX gone, never retried. Found by the 4-case test (a fail-point on
the second batch).

**Rule:** a one-time migration marks itself done only after its last write (here `handCountsCopiedAt`), writes with
upserts so it can be run again, and nothing irreversible runs before that mark. Likewise, a side effect moved to a
looser route keeps the old route's permission: the contact stamp on `POST /calls/click` asks `leads.edit`, as
`PATCH /call-count` did.
