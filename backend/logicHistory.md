# Carlton CRM — Backend Logic History

This file documents every key business logic implementation in the backend. Read this before implementing any algorithm to avoid reimplementing existing logic.

---

## 1. Round-Robin Auto-Assignment

**What it does**: Distributes unassigned leads evenly across active team members using a round-robin algorithm.

**File**: `src/services/teamService.ts`
**Function/Method**: `autoAssignTeamLeads(teamId, userId)`

### Algorithm (Step-by-Step)

1. Fetch the team with populated `members`, `leaders`, and `inactiveMembers`:
   ```typescript
   const team = await Team.findById(teamId)
     .populate("members", "_id name email")
     .populate("leaders", "_id")
     .populate("inactiveMembers", "_id");
   ```

2. Get all unassigned leads for this team:
   ```typescript
   const unassignedLeads = await Lead.find({
     team: teamId,
     assignedTo: null,
     status: "new"
   }).lean();
   ```

3. Build the active member list — exclude leaders AND inactive members:
   ```typescript
   const leaderIds = new Set(team.leaders.map(l => l._id.toString()));
   const inactiveIds = new Set(team.inactiveMembers.map(m => m._id.toString()));
   // CRITICAL: use ._id.toString() — not .toString() on populated doc
   const activeMembers = team.members.filter(m =>
     !leaderIds.has(m._id.toString()) && !inactiveIds.has(m._id.toString())
   );
   ```

4. If no active members → return `{ assigned: 0, assignments: [] }`

5. For each active member, count their current assigned leads to sort from lowest to highest:
   ```typescript
   const memberLeadCounts = await Promise.all(
     activeMembers.map(async m => ({
       member: m,
       count: await Lead.countDocuments({ team: teamId, assignedTo: m._id })
     }))
   );
   memberLeadCounts.sort((a, b) => a.count - b.count);
   ```

6. Distribute leads round-robin (pointer cycles through sorted member list):
   ```typescript
   const assignments = [];
   let pointer = 0;
   for (const lead of unassignedLeads) {
     const member = memberLeadCounts[pointer % memberLeadCounts.length].member;
     await Lead.findByIdAndUpdate(lead._id, {
       $set: { assignedTo: member._id, status: "assigned" }
     });
     emitToUser(member._id.toString(), "lead:assigned", {
       leadId: lead._id,
       leadName: lead.name,
       assignedBy: userId
     });
     assignments.push({ leadId: lead._id, assignedTo: member._id });
     pointer++;
   }
   ```

7. Return `{ assigned: unassignedLeads.length, assignments }`

### Edge Cases Handled
- No active members → returns 0 assigned, empty array
- All members are leaders or inactive → returns 0
- No unassigned leads → returns 0 immediately
- Members with equal lead count — order is stable (sorted ascending, first one wins ties)

### Related Logic
- `toggleMemberActive` (Logic #6) — manages the inactiveMembers list this algorithm reads
- `leadService.autoAssignLeads` — global version (not team-scoped), uses same pattern

---

## 2. JWT Auth Flow

**What it does**: Login, token generation, refresh, and role-aware authentication.

**File**: `src/services/authService.ts`, `src/middleware/auth.ts`, `src/utils/jwt.ts`
**Functions**: `login`, `refreshToken`, and the `authenticate` middleware

### Login Flow
```
POST /auth/login
  → authController.login
  → authService.login(email, password)
     1. User.findOne({ email }).select("+password").populate("role")
     2. bcrypt.compare(password, user.password)  — throws 401 if mismatch
     3. generateAccessToken({ userId, email, roleId })  — 15min TTL
     4. generateRefreshToken({ userId })  — 7d TTL
     5. return { user, accessToken, refreshToken }
```

### Access Token Payload
```typescript
{
  userId: string,
  email: string,
  roleId: string
}
```

### Refresh Token Payload
```typescript
{
  userId: string
}
```

### Token Refresh Flow
```
POST /auth/refresh  (body: { refreshToken })
  → authController.refreshToken
  → authService.refreshToken(token)
     1. verifyRefreshToken(token)  — throws 401 if invalid/expired
     2. User.findById(decoded.userId)  — throws 401 if not found
     3. generateAccessToken({ userId, email, roleId })
     4. return { accessToken }
```

### Auth Middleware (authenticate)
On every protected request:
1. Extract `Bearer <token>` from `Authorization` header
2. `verifyAccessToken(token)` — throws 401 if invalid/expired
3. `User.findById(decoded.userId).select("-password")` — throws 401 if not found
4. Check `user.status !== "inactive"` — throws 403 if inactive
5. `Role.findById(user.role)` — loads FRESH role from DB (not from token payload)
6. Attaches `req.user = { userId, email, roleId, role: fullRoleDocument }`

### Why Role is Loaded Fresh Every Request
The role's permissions could change after the token was issued. If we relied solely on the JWT payload for permissions, a role change would not take effect until token expiry. Loading fresh from DB ensures permissions are always current.

### Edge Cases
- Token missing → 401 "No token provided"
- Token expired → 401 "Token expired"
- User deleted after token issued → 401 "User not found"
- User deactivated after token issued → 403 "Account deactivated"
- Role deleted after token issued → 403 (role lookup fails)

---

## 3. Permission Check Logic

**What it does**: Guards routes by checking user's role permissions.

**File**: `src/middleware/permissions.ts`
**Functions**: `checkPermission(module, action)`, `requireModule(module)`

### checkPermission(module, action)
```typescript
export const checkPermission = (module: CrmModule, action: PermissionAction) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { role } = req.user;

    // Super Admin bypass — always passes
    if (role.isSystemRole && role.roleName === "Super Admin") {
      return next();
    }

    const perms = role.permissions?.[module];
    if (!perms || !perms[action]) {
      return sendError(res, "Permission denied", 403);
    }
    next();
  };
};
```

### requireModule(module)
```typescript
export const requireModule = (module: CrmModule) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { role } = req.user;

    if (role.isSystemRole && role.roleName === "Super Admin") return next();

    const perms = role.permissions?.[module];
    if (!perms) return sendError(res, "Permission denied", 403);

    const hasAny = Object.values(perms).some(v => v === true);
    if (!hasAny) return sendError(res, "Permission denied", 403);
    next();
  };
};
```

### Edge Cases
- `role.permissions` is undefined/null → treated as no permissions (403)
- `role.permissions[module]` is undefined → 403
- Super Admin with `isSystemRole: false` → does NOT bypass (intentional)
- Only the exact combination of `isSystemRole: true` + `roleName: "Super Admin"` bypasses

---

## 4. Lead CSV/Excel Upload

**What it does**: Parses a spreadsheet file, validates rows, bulk-inserts valid leads.

**Files**: `src/services/excelService.ts` (parsing), `src/services/leadService.ts` (bulkCreateLeads)
**Function**: `leadService.bulkCreateLeads(buffer, reporterId, teamId?)`

### Algorithm (Step-by-Step)

1. Controller receives file via multer (memory storage) — `req.file.buffer`
2. Calls `excelService.parseExcelBuffer(buffer, reporterId)` → `{ valid, invalid }`

3. Email validation (critical — see mistakes.md #2):
   ```typescript
   const emailRegex = /^\S+@\S+\.\S+$/;
   const email = emailRegex.test(row.email) ? row.email : undefined;
   // "No Email", "", "N/A" all fail regex → stored as undefined
   ```

4. Notes must be an array (critical — see mistakes.md #2):
   ```typescript
   // WRONG: notes: row.notes
   // CORRECT:
   const notes = row.notes
     ? [{ content: row.notes, author: reporterId }]
     : [];
   ```

5. Map valid rows to Lead documents:
   ```typescript
   const docs = valid.map(row => ({
     name: row.name,
     phone: row.phone,
     email: email,  // undefined if invalid
     source: row.source || "manual",
     status: "new",
     createdBy: reporterId,
     team: teamId || undefined,
     notes: notes,
     activityLogs: [{ action: "lead_created", ... }]
   }));
   ```

6. Insert with `ordered: false` (partial success allowed):
   ```typescript
   const result = await Lead.insertMany(docs, { ordered: false });
   const failed = docs.length - result.length;
   ```

7. Return `{ created: result.length, failed, errors: invalidRows }`

### Edge Cases Handled
- "No Email" string → stored as `undefined`
- Invalid email format → stored as `undefined`
- Missing name or phone → row goes to `invalid` in excelService
- Duplicate phone within file → second row goes to `invalid`
- Duplicate phone already in DB → `insertMany` silently skips (ordered: false), counted as failed
- Empty file → returns `{ created: 0, failed: 0, errors: [] }`

### Related Logic
- excelService.parseExcelBuffer — handles the raw parsing and per-row validation

---

## 5. Reminder Scheduler Two-Pass

**What it does**: Fires real-time and push notifications for due reminders and upcoming reminders.

**File**: `src/services/reminderScheduler.ts`
**Function**: `tick()` — called every 30 seconds

### Scheduler Initialization
```typescript
export function startReminderScheduler() {
  tick(); // run immediately on start
  setInterval(tick, 30_000); // then every 30 seconds
}
```

### Pass 1 — On-Time Notifications (reminder is due now or overdue)

**MongoDB Query**:
```typescript
const now = new Date();
const leads = await Lead.find({
  "reminders": {
    $elemMatch: {
      remindAt: { $lte: now },
      isDone: false,
      notifiedAt: null
    }
  }
});
```

**For each matching lead**, iterate reminders and fire for those matching Pass 1 criteria:
```typescript
for (const lead of leads) {
  for (const reminder of lead.reminders) {
    if (reminder.remindAt <= now && !reminder.isDone && !reminder.notifiedAt) {
      // Emit socket event
      emitToUser(reminder.assignedTo.toString(), "reminder:due", {
        reminderId: reminder._id,
        leadId: lead._id,
        leadName: lead.name,
        title: reminder.title,
        body: reminder.body,
        remindAt: reminder.remindAt
      });

      // Send push notification
      await sendPushToUser(reminder.assignedTo.toString(), {
        title: reminder.title,
        body: `Due: ${reminder.body}`,
        tag: `reminder-${reminder._id}`,
        url: `/leads/${lead._id}`
      });

      // Stamp notifiedAt — use arrayFilters to target exact reminder
      await Lead.updateOne(
        { _id: lead._id },
        { $set: { "reminders.$[r].notifiedAt": now } },
        { arrayFilters: [{ "r._id": reminder._id }] }
      );
    }
  }
}
```

### Pass 2 — Warning Notifications (reminder coming up in 1-31 minutes)

**MongoDB Query**:
```typescript
const nowPlus1 = new Date(now.getTime() + 1 * 60 * 1000);
const nowPlus31 = new Date(now.getTime() + 31 * 60 * 1000);
const warningLeads = await Lead.find({
  "reminders": {
    $elemMatch: {
      remindAt: { $gte: nowPlus1, $lte: nowPlus31 },
      isDone: false,
      warnedAt: null
    }
  }
});
```

**For each matching reminder**:
```typescript
const minsLeft = Math.round((reminder.remindAt.getTime() - now.getTime()) / 60000);
emitToUser(reminder.assignedTo.toString(), "reminder:warning", {
  reminderId: reminder._id,
  leadId: lead._id,
  leadName: lead.name,
  title: reminder.title,
  body: reminder.body,
  minsLeft,
  remindAt: reminder.remindAt
});

// Stamp warnedAt
await Lead.updateOne(
  { _id: lead._id },
  { $set: { "reminders.$[r].warnedAt": now } },
  { arrayFilters: [{ "r._id": reminder._id }] }
);
```

### Edge Cases Handled
- Reminder marked `isDone: true` before scheduler runs → skipped (isDone check)
- Reminder already notified (`notifiedAt` not null) → skipped (idempotent)
- Reminder already warned (`warnedAt` not null) → skipped (idempotent)
- Multiple reminders on same lead — `arrayFilters` with `"r._id"` ensures only the correct sub-document is updated
- Scheduler fires while previous tick is still running → each tick is independent, no lock needed (low probability of overlap at 30s interval)

### Related Logic
- `addReminder` in leadService — creates the reminder sub-document this scheduler reads
- `reminder:due` and `reminder:warning` socket events — see socketHistory.md

---

## 6. Team Member Active/Inactive Toggle

**What it does**: Activates or deactivates a team member, controlling their eligibility for auto-assignment.

**File**: `src/services/teamService.ts`
**Function/Method**: `toggleMemberActive(teamId, memberId)`

### Algorithm
```typescript
async toggleMemberActive(teamId: string, memberId: string) {
  const team = await Team.findById(teamId).populate("inactiveMembers", "_id");

  if (!team) throw createError("Team not found", 404);

  // Check current state — MUST use ._id.toString() on populated docs
  const isCurrentlyInactive = team.inactiveMembers.some(
    m => m._id.toString() === memberId
  );

  let updateOp;
  if (isCurrentlyInactive) {
    // Activate: remove from inactiveMembers
    updateOp = { $pull: { inactiveMembers: memberId } };
  } else {
    // Deactivate: add to inactiveMembers
    updateOp = { $addToSet: { inactiveMembers: memberId } };
  }

  const updated = await Team.findByIdAndUpdate(teamId, updateOp, { new: true })
    .populate("members inactiveMembers leaders");

  return updated;
}
```

### Key Details
- Uses `$addToSet` not `$push` — prevents duplicates if called twice
- Does NOT emit a socket event — UI polls via React Query invalidation
- Does NOT reassign leads from deactivated member — their existing leads remain
- Effect is immediate — next `autoAssignTeamLeads` call will exclude inactive members

### Edge Cases
- memberId not in `team.members` — toggle still runs (inactiveMembers can technically include non-members, but service should validate membership first)
- Called twice rapidly → `$addToSet` is idempotent for deactivate; `$pull` is idempotent for activate

---

## 7. selfOrPermission

**What it does**: Allows users to view their own profile without needing the `users:view` permission, while still protecting other users' profiles.

**File**: `src/routes/userRoutes.ts` (inline middleware, not a standalone file)
**Used on**: `GET /api/v1/users/:id`

### Implementation
```typescript
const selfOrPermission = (req: Request, res: Response, next: NextFunction) => {
  // If the requesting user is viewing their own record → allow
  if (req.user.userId === req.params.id) {
    return next();
  }
  // Otherwise → require users:view permission
  checkPermission("users", "view")(req, res, next);
};

router.get("/:id", authenticate, selfOrPermission, getUserById);
```

### Why This Exists
Users need to load their own profile (for the header/navbar, settings page, etc.) without requiring admins to grant `users:view` to every role. Sales agents should be able to see their own name/email/role without being able to browse all users.

### Edge Cases
- User A trying to view User B's profile → falls through to `checkPermission("users", "view")`
- Super Admin viewing any profile → passes checkPermission (Super Admin bypass)
- User viewing own profile → skips permission check entirely

---

## 8. Activity Log Tracking

**What it does**: Records every mutation to a lead in the `activityLogs` embedded array.

**File**: `src/services/leadService.ts`
**Pattern**: Every mutation method pushes a log entry

### ActivityLog Schema
```typescript
{
  action: ActivityAction,       // enum string
  description: string,          // human-readable description
  performedBy: ObjectId,        // userId who made the change
  createdAt: Date,              // auto-set
  changes?: {                   // optional field-level diff
    [field: string]: {
      from: unknown,
      to: unknown
    }
  }
}
```

### Activity Actions (enum)
- `lead_created` — new lead creation
- `lead_updated` — general field update
- `status_changed` — `lead.status` changed
- `lead_assigned` — `assignedTo` changed
- `team_assigned` — `lead.team` changed
- `note_added` — note pushed to `lead.notes`
- `note_updated` — note content changed
- `note_deleted` — note removed
- `reminder_added` — reminder created
- `reminder_updated` — reminder updated
- `reminder_done` — reminder marked done
- `payment_added` — payment recorded

### Example — Status Change Log Entry
```typescript
lead.activityLogs.push({
  action: "status_changed",
  description: `Status changed from ${oldStatus} to ${newStatus}`,
  performedBy: userId,
  changes: {
    status: { from: oldStatus, to: newStatus }
  },
  createdAt: new Date()
});
```

### Performance Note
`activityLogs` grows unboundedly. For very active leads, use `$slice` on reads or consider a separate collection if the array exceeds ~100 entries.

---

## 9. Google Sheets Sync

**What it does**: Receives lead data from Google Sheets (via Apps Script) and upserts it into the CRM.

**File**: `src/controllers/sheetsController.ts` (+ optional `src/services/sheetsService.ts`)
**Routes**: `POST /api/sheets/sync` (single), `POST /api/sheets/sync/batch` (array)
**Auth**: `authenticateApiKey` middleware (NOT JWT) — reads `x-api-key` header

### Single Row Sync
```
POST /api/sheets/sync
Headers: { "x-api-key": SHEETS_API_KEY }
Body: { name, phone, email, source, course, ... }
```
1. Validate required fields (name, phone)
2. `Lead.findOneAndUpdate({ phone }, { $set: mappedFields }, { upsert: true, new: true })`
3. Returns `{ created: boolean, lead }`

### Batch Sync
```
POST /api/sheets/sync/batch
Body: { rows: [...] }
```
1. Validate each row
2. `Promise.all(rows.map(row => Lead.findOneAndUpdate({ phone }, ...)))`
3. Returns `{ synced: count, errors: [...] }`

### Column Mapping
Google Sheets columns map to Lead fields:
- Column A → `name`
- Column B → `phone`
- Column C → `email` (validated, undefined if invalid)
- Column D → `source`
- Column E → `course` name (looked up in Course collection)
- Column F → `notes` (wrapped as array)

### Edge Cases
- SHEETS_API_KEY not set in env → `authenticateApiKey` returns 503
- Missing x-api-key header → 401
- Wrong key → 401
- Duplicate phone → upserts (updates existing lead, does not create duplicate)

---

## 10. AI Chat Context

**What it does**: Provides Claude AI assistance within different CRM contexts (lead, team, report).

**File**: `src/controllers/aiController.ts`
**Routes**: `POST /ai/chat/lead/:leadId`, `POST /ai/chat/team/:teamId`, `POST /ai/chat/report`
**Memory Model**: `AiMemory` — stores conversation per `{ contextType, contextId, userId }`

### Context Types
1. **Lead context** (`POST /ai/chat/lead/:leadId`):
   - Fetches full lead data (notes, status, payments, reminders, activityLogs)
   - Builds system prompt with lead details as context
   - Sends conversation history + new user message to Anthropic Claude API
   - Stores updated conversation in AiMemory

2. **Team context** (`POST /ai/chat/team/:teamId`):
   - Fetches team stats, member performance, recent activity
   - Builds system prompt with team analytics
   - Same conversation flow

3. **Report context** (`POST /ai/chat/report`):
   - No `contextId` — single memory per userId for report context
   - Fetches overall CRM statistics for context
   - Useful for "what is our conversion rate?" type questions

### Memory Structure
```typescript
{
  contextType: "lead" | "team" | "report",
  contextId: string | null,  // null for report context
  userId: string,
  messages: [
    { role: "user" | "assistant", content: string, timestamp: Date }
  ]
}
```

### Conversation Flow
1. Fetch `AiMemory.findOne({ contextType, contextId, userId })`
2. If none exists → create new empty memory
3. Append new user message to `memory.messages`
4. Build messages array for Anthropic API (last N messages for context window)
5. Call `anthropic.messages.create({ model, system, messages })`
6. Append assistant response to `memory.messages`
7. Save updated memory
8. Return `{ reply: assistantMessage, memoryId }`

### Memory Management Routes
- `GET /api/v1/ai/memory/:leadId` — fetch conversation history for a lead
- `DELETE /api/v1/ai/memory/:leadId` — clear conversation for a lead

---

## Finance handover — sent when queued (2026-09-29)

- Closing a lead still never waits for finance: the enrolment is written to the `FinanceHandover` outbox first.
- It is then sent immediately in the background (`kickFinanceHandover`), not on the next 60-second tick. The timer only retries what could not be sent.
- Retry wait after a failure: 1, 4, 9 … minutes, now capped at **15 minutes** (was 60), so an enrolment goes out soon after finance comes back.
- 4xx other than 401 still stops (`failed`); 401 and 5xx keep retrying.

---

## Inactive leads — the rule, the clock and the moves (2026-09-30)

**File**: `src/services/inactiveLeadService.ts` (+ `src/utils/workingHours.ts`, `leadService.pickSplitAssignee`)

1. **Candidates** — status `new`/`assigned`, has an owner, `assignedAt ≤ cutoff`. The cutoff is the latest moment that is at
   least the limit of working time before now (`workingCutoff`): working time only grows the earlier something started, so
   "assigned at or before the cutoff" is exactly "past the limit" — a plain date the database filters on.
2. **Acted on** (any one, by the owner, at or after `assignedAt`) — an activity entry `status_changed` / `note_added` /
   `note_updated`, or `lead_updated` that changed `status`; a note; a follow-up; a reminder; `firstContactTime`
   (stamped by the owner's first call, note or status change); `lastContactedAt` (a counted call); a `CallLog` for the lead
   `initiatedBy` the owner or on the owner's 3CX `extension`; or the owner created the lead and took it on the spot.
   Opening the lead does not count. A note or call from before the lead became theirs does not count.
3. **Where it goes** — `pickSplitAssignee` with `exclude = [current owner, everyone in inactivity.lostBy, deactivated users]`,
   inside the team's split queue. Round-robin: an excluded member's turn passes to the next one. Nobody left, or no team →
   `inactivity.stuckAt` is stamped (super admins told once), and it waits for a person to be picked by hand.
4. **The move** — one conditional update on `{ _id, assignedTo, assignedAt }` (a lead reassigned or moved meanwhile is left
   alone): new owner, `assignedAt = now`, `status = "assigned"`, `firstContactTime = null`, loser added to
   `inactivity.lostBy`, `inactivity.moves + 1`, activity `inactive_reassigned`; then a `LeadMove` record.
5. **Automatic** — every 60 s, in working hours only, with the switch on, and only for leads assigned since
   `inactiveLeads.enabledAt` (stamped when the switch goes on, cleared when off). At most 200 leads a pass.
6. **By hand** — the page's leads are checked again before moving; one worked or moved since the page loaded is skipped
   with the reason.

---

## Presence, active time and idle alerts (2026-09-30)

**File**: `src/services/activityService.ts` (+ `hooks/useActivityHeartbeat.ts` in the web app)

1. **Heartbeat** — every 60 s while the app is open; `active` = a pointer, key, wheel, touch, scroll or focus event in the last
   60 s (the app also sends one straight away when someone comes back after a quiet minute). Server: `lastSeenAt` always,
   `lastActiveAt` when active (both `$max`).
2. **Active minutes** — one per clock minute with an active heartbeat, however many tabs: a conditional `$inc` on
   `{ user, day, lastMinute < thisMinute }`; the day's first minute creates the record (a duplicate-key race means another tab
   already counted it). `day` is the date in the working hours' time zone.
3. **Status** (Activity page) — `signed_out`: signed out after the last sign-in and last heartbeat (90 s slack for one in
   flight), today; `active`: used in the last 2 min; `idle`: heartbeat in the last 2½ min but not used; `away`: seen today, app
   closed; `offline`: not seen today.
4. **Idle alert** — in working hours, with the switch on: `lastActiveAt` today and at or before `workingCutoff(now, limit)`,
   not already alerted for that `lastActiveAt`, not signed out since, not a super admin, not deactivated. Stamp
   `idleAlertedAt` (conditional on `lastActiveAt` unchanged), record an `IdleStretch`, notify. The next active heartbeat ends
   every open stretch; a new quiet stretch can then be alerted again.

---

## Meetings, invites and the busy check (2026-10-01)

**File**: `src/services/meetingService.ts`

1. **Booking** — start not more than 5 min in the past; end after start; at most 12 h; attendees active (organizer and duplicates
   dropped); client visible to the organizer; mentors resolved from the LMS.
2. **Who hears what** — employees: in-app + push + email (switch: Settings → Email → Meetings) with notes; client and mentors:
   email only, never notes, always sent. Each email carries its own .ics (the recipient as the only ATTENDEE).
3. **Changes** — people added: invite; taken off: cancellation; staying: "changed" when time, title, link, notes, client or
   mentors changed. Client and mentors only hear about time, title or link. SEQUENCE + 1 every save; a time change clears
   `reminderSentAt`.
4. **Busy check** — other scheduled meetings of the chosen people overlapping [start, end) (the meeting being edited excluded);
   for mentors, LMS classes and meetings overlapping it, and whether it sits inside one of their weekly slots in the LMS's
   zone. A warning in the form, never a refusal. LMS unreachable → `mentorsUnavailable`, the rest still answered.
5. **Reminder** — every minute: scheduled, not yet reminded, `startAt − reminderMinutes ≤ now < startAt` → stamp (conditional),
   notify organizer + attendees.

## Team report, team PDF and "Redistribute today" — current statuses (2026-10-01)

**Files**: `src/services/teamService.ts`, `src/controllers/exportController.ts`, `src/controllers/teamController.ts`

1. **Columns** — the team Report (`GET /teams/:id/member-split`) and the team PDF (`GET /teams/:id/export-pdf`) count the
   lead model's statuses: New, Assigned, Pending Response, Follow Up, Closed, Lost, Not Connected, MIA, Repeated, Call Back,
   CNC. Before, they counted an older list, so leads in Pending Response, Lost, Not Connected, MIA or Repeated were in the
   total and in no column.
2. **Other** — total minus the listed columns: a stored status the model no longer lists. The web page and the PDF show an
   Other column only when it is not zero.
3. **Period** — `dateFrom` / `dateTo` are Dubai calendar days (they were read as UTC days, so a period started and ended at
   4 a.m. Dubai time). The web page builds them from the Dubai date, not the browser's.
4. **Team PDF** — landscape A4; status bar and member table use the same statuses and the Leads page's colours.
5. **Redistribute today** — besides new, assigned, follow-up, call back and CNC, leads in Pending Response, Not Connected,
   MIA and Repeated assigned today to an absent member now move too; closed and lost stay. The older statuses stay in the
   list for leads that still carry them. As before, a moved lead becomes "assigned" for its new owner.

## New lead — source required (2026-10-01)

**File**: `src/controllers/leadController.ts` (`createLeadSchema`, `POST /leads`)

A lead created through `POST /leads` must carry a source (trimmed, 1–100 characters; missing, null or blank → 400 "Source is
required"). Email stays optional. Editing a lead (`PUT /leads/:id`) is unchanged, so older leads without a source still save.
Excel uploads and the sheet sync (`POST /sheets/sync/batch`, used by the Apps Script and the Root lead router) have their own
routes and still take rows without a source.

## Statuses: Wrong Number, Meeting Scheduled (2026-10-01)

**Files**: `models/Lead.ts`, `types/index.ts`, `controllers/leadController.ts`, `services/leadService.ts`,
`services/reportService.ts`, `controllers/exportController.ts`, `services/followupWarningScheduler.ts`

1. **Wrong Number** (`wrong_number`) — a plain status, settable everywhere a status is (single, bulk, lead edit, create). A dead
   lead: reports count it with Lost (every `lost` / `$nin` group next to `mia`/`cnc`), the missed-follow-up warning skips it,
   old-leads upload maps "wrong…" to it and treats it as terminal, Redistribute today leaves it alone.
2. **Meeting Scheduled** (`meeting_scheduled`) — only through `PATCH /leads/:id/status`, which requires `meetingAt` (a date, not
   more than 5 minutes in the past) and takes an optional `meetingNote` (≤ 500). Create, lead edit and both bulk endpoints refuse
   it, so no route sets it without a time.
3. **The reminder** — saving pushes a lead reminder `{ title: "Meeting scheduled", note, remindAt: meetingAt }` whose
   `createdBy` (the person the reminder scheduler notifies) is the lead's owner, or whoever booked it when nobody owns the lead.
   The usual reminder rules apply: a heads-up 1–31 minutes before, then on time. The history line reads
   `… to "meeting_scheduled" — meeting on 3 Oct 2026 at 16:00 (Dubai)`. Moving a meeting = editing its reminder.
4. **Reports** count Meeting Scheduled with Follow-up ("in follow-up" / `followup` groups); the overview, user/team rankings,
   timeline, team Report and team PDF list both statuses. Redistribute today leaves Meeting Scheduled with its owner.

## Courses → finance product + several LMS courses (2026-10-04)

**Files**: `models/Course.ts`, `services/courseService.ts`, `controllers/courseController.ts`, `routes/courseRoutes.ts`,
`services/lmsClient.ts`, `services/studentService.ts` — the same as Draw's (draw crm 3acfa10).

1. A course has `lmsCourseSlugs` — every LMS course a student gets for it, in order (a bundle like "MBT + DWT" has two);
   `lmsCourseSlug` stays the first, for anything that reads one.
2. Each enrolment handed to finance carries them. At approval finance opens, per invoice line, the **product's own LMS
   courses when it has any**, else the courses the CRM sent for that line. So a bundle billed against the plain MBT product
   opens MBT only — bundles are left with no finance product (as Draw's are) until finance has a product that opens both.
3. The Map dialog warns when a finance product is chosen for a course with more than one LMS course (it can't read the
   product's own LMS list — finance's catalogue endpoint returns name, sku, price and type only).

## Status: Meeting Done (2026-10-04)

`meeting_done` — a plain status after Meeting Scheduled, settable everywhere (single, bulk, lead edit, create). Marking it
(single or bulk) closes the lead's open "Meeting scheduled" reminders (`isDone: true`, also one that already rang), so nobody
is reminded of a meeting that has happened; other reminders are left alone. Reports count it with follow-up / in progress
(next to `meeting_scheduled`); Redistribute today leaves it with its owner; an old-leads upload's "meeting done" maps to it.
Team PDF: "Mtg Set" / "Mtg Done" columns, member-table headers at 6pt so fourteen status columns stay on one line.

## View as (impersonation) (2026-10-04)

**Files**: `models/Impersonation.ts`, `services/impersonationService.ts`, `controllers/impersonationController.ts`, `middleware/auth.ts`,
`utils/jwt.ts`, `routes/userRoutes.ts`, `routes/authRoutes.ts` — like the Root portal's "View as", with its gaps closed.

1. **Who**: a super admin, for an active user who is neither themselves nor a super admin (404 unknown / 400 self / 403 super
   admin / 409 deactivated).
2. **The pass**: an access token for the target (`userId`, `email`, `roleId` — so their permissions) plus `impersonation: { id, by }`,
   30 minutes (`IMPERSONATION_TTL_SECONDS`), signed with `JWT_SECRET`. No refresh token, and a refresh can't take it (other secret).
3. **The session** is an `Impersonation` record made before the pass. `authenticate` accepts the pass only while the record is open
   (`endedAt` null) and unexpired, names the same target and admin, and the admin is still active and still a super admin —
   otherwise 401. `POST /auth/impersonation/stop` sets `endedAt`, so "Back to my account" ends the pass at once.
4. **View only**: with a pass, `authenticate` refuses every method but GET/HEAD/OPTIONS with 403 "View only…" (leads, notes, status,
   calls, notifications read/clear, push subscribe, heartbeat, logout, password, a nested View as) — bar the stop route
   (`authenticateViewAsExit`). So nothing is done, logged or counted in the person's name.
5. A target deactivated mid-session answers 401 while viewing (the app goes back to the admin) instead of the usual 403.
6. **The app** keeps the admin's own tokens aside (`crm-own-auth`) and returns to them on Back, at zero, on any 401, and on Logout
   (which ends the session and records the sign-out under the admin).

---

## A course's bonus — where a close starts (2026-10-04)

A course says what bonus comes with it (`Course.bonusAmount`, the course's currency, 0 for none), set on the Courses page. It is a starting point, never a rule: a new close answers "Bonus given?" yes with the course's bonus, and the seller changes the amount or says no for a sale that differs. Choosing another course moves it along until the seller answers it themselves; an enrolment being edited is never changed by it. What is stored and sent to finance is still the close's own `hasBonus` / `bonusAmount` — outside the fee and the balance, as before. End-to-end test: `backend/scripts/course-bonus-e2e.sh`.

---

## Commission — who earns what on an approved sale (2026-10-04)

- **When**: the finance worker sees the enrolment approved (`approvedAt`); the sale is recorded once (`CommissionSale`, unique per student) with the plan row of that day — a plan changed later never rewrites a past month. Counted in the month of `enrollmentDate`, UAE time.
- **Who** (TL_RULE "always"): the leader of the sale's team (or the closer's one team) is paid TL — also when he is the Sales Manager, so one person earns both TL and SM; a TL or SM who closes earns Sales Staff too. A team with no leader or two, or a closer in no team, holds the sale until fixed.
- **Sales Manager**: the one in `CommissionSettings` (dilshad); while none is set, sales wait.
- **Excluded logins** (test (test@crm.com), super admin (superadmin@crm.com)): a sale closed under one earns nobody anything; given to its real closer, it is counted.
- **Held sales** settle on their own: each minute they are looked at again (the student's current closer and team), at the plan of their approval.
- **Reversal**: a sale whose invoice finance voids (asked every 10 minutes, for the last 120 days) is reversed — kept, no longer counted.
- **Who sees what**: Super Admins and the Sales Manager everything; a team leader their teams' sales (without the SM's line) and their own lines; everyone else their own.

---

## Five steps before commission (2026-10-04)

- A sale's commission counts only once: finance approved it; the LMS has the student; Tetra Commission gave them a CS; their CS sent the welcome (onboarded); and the MT5 bonus promised at the close was approved by a broker admin — "none" promised is approved by itself. A course Tetra Commission doesn't take (not Forex) needs only the first two.
- Until then: `CommissionSale.state = "progress"`, `reason` = the first step not done ("Next step: …", or "Stopped at: …" when rejected/refused). Nothing is paid on a guess: Tetra Commission not answering leaves a step unknown.
- From 1 October 2026 (UAE) on, in the month of the close; amounts frozen the day the steps complete.

## Split payments at the close (2026-10-05)

1. **The payments**: `payments[]` on a close — 1 to 10, each with a method this CRM takes, an amount above zero and its receipt
   (key + url). They must add up to `paidAmount` to the fil (`minor()`), or 422. None sent = an older screen: one method, one
   receipt, as before.
2. **The money already on the lead** before the close is a payment of its own (`collectedBefore`), its amount fixed by the dialog.
3. **Never above the fee** (the user, 2026-10-05: "block"): `assertNotOverFee` on every close, and on an edit that changes
   `totalFee` or `paidAmount` — an enrolment already over it from before can still have other fields edited.
4. **Compatibility**: the first payment is also `paymentMethod` / `paymentReceipt`, and finance still gets `declaredPaidMinor`,
   `declaredPaymentMethod` and `receipt` beside `payments[]`.
5. **Finance** records each payment against the invoice with its receipt when accounts approve (finance-delta).

## Currency at the close (2026-10-05)

1. Every payment at the close is in AED (`BASE_CURRENCY`) unless it says otherwise: `currency` (one of `CLOSE_CURRENCIES`),
   `amountInCurrency` and `exchangeRate` — 1 of the currency = `exchangeRate` AED. `amount` is always the AED figure.
2. `checkedPayments` → `foreignPart`: for another currency the amount in it and the rate must be above zero, and `amount` must be
   what they come to, within half a percent (rounding) — so a figure typed in the wrong currency (INR 50,000 sent as AED 50,000)
   is refused. The money already on the lead (`collectedBefore`) is AED and can't carry a currency. AED (or no currency) drops
   any stray fields. Everything else — the sum, the over-the-fee block — runs on the AED figures, as before.
3. Handover: each such payment goes to finance with `original: { currency, amountMinor, rate }` beside its AED `amountMinor`;
   finance keeps it, shows it, and records the payment in AED with the original in its note.
4. The lead's payment (added at the close) is in AED; its note ends "· INR 50,000 at 1 INR = 0.044 AED".

## 3CX calls — brought over from the Draw CRM (2026-10-14)

The Draw CRM's 3CX work (Tetra Commission's call sync and call flow, for leads), with this CRM's rules where they differ.
**Files**: `lib/threecx.ts`, `models/LeadCall.ts`, `services/callSyncService.ts`, `services/leadCallService.ts`,
`services/portalCalls.ts`, `controllers/leadCallController.ts`, `controllers/clickToCallController.ts`,
`routes/callRoutes.ts`, `routes/portalRoutes.ts`, `services/leaderboardService.ts`, `utils/dubaiDay.ts`.

1. **The sync**: every minute (off with a log line when `RUN_SCHEDULERS=false` or a `THREECX_*` is missing) the 3CX call
   log is read from where the last run got to less 3 hours, a day at a time — each day after the first from 3 hours
   before it starts, so a call whose rows straddle a day's start is read whole; the first run reaches 90 days back. State and
   a 15-minute lock in `app_settings` `_id: "threecx_calls"` (a raw collection — not the `AppSetting` model's
   `appsettings`). Rows sharing a `MainCallHistoryId` are one call, keyed `call:<id>` (unique: never stored twice).
2. **Matching**: a lead by the last 9 digits of any number in its phone field (a number on several leads: the one
   assigned to whoever took it, else the newest); a person by `User.extension`. Extensions come from 3CX's users by email
   every 6 hours (`extensionSource: "3cx"`); one typed on the Users screen (`"manual"`) or there before (no source) is
   never overwritten.
3. **Who sees what** (as `getLeads`): Super Admin, Reporter and the Sales Manager (Commission settings) every call; a team
   leader their teams' people's calls and calls on their teams' leads; anyone else their own calls and calls on their
   leads. Module `calls` (view, export), open by default.
4. **Recordings** play through the server on a 10-minute signed link; the 3CX key never reaches a browser.
5. **Counts**: `callCount` / `callConnected` / `callNotConnected` (missed + not answered) counted again from `lead_calls`
   for every lead a run touched; the first run (`countsVersion` unset) first copies every lead's non-zero counts into
   `lead_call_counts_before_3cx` (`_id` = the lead's, `savedAt`; upserts, a lead copied already keeps its first copy),
   marks the copy done (`app_settings.threecx_calls.handCountsCopiedAt`) only once every lead is in — a copy cut short
   is finished by the next run before any count is replaced — then counts every lead with calls and sets the rest to 0. Raw writes, only where a number changed: `updatedAt` untouched. `PATCH /leads/:id/call-count` and
   `/call-not-connected` now answer with the counts and change nothing.
6. **Contact dates** (this CRM only): the old Call button's `PATCH call-count` stamped `lastContactedAt`,
   `lastFollowupDate` and — on the assigned agent's first call — `firstContactTime`; Inactive Leads, the missed follow-up
   warning and the response-time reports read them. The new Call button only logs the click (`POST /calls/click`), so that
   route now stamps them: both dates on every click with a lead id by someone with `leads.edit` (or the Super Admin —
   what the old counter route asked; the click itself needs only a sign-in), `firstContactTime` only when the clicker is
   the lead's owner and it is still empty. Calls made outside the CRM (straight from the 3CX app) stamp nothing, as before.
7. **After the call** (web, existing routes only): Follow Up → `PATCH /status` with `followUpNote` (the notes —
   required; at most 1,000 characters, the follow-up history's limit — the route allows 2,000, the model 1,000), `followUpAt` (now), `nextFollowUpAt` (optional; the server makes the "Follow-up due" reminder); Follow Up
   on a lead already in it → `POST /reminders` ("Follow-up due", when a time is given) + `POST /followups` (no status
   change, no team-leader alert); Meeting Scheduled → `meetingAt` (required, not past) + `meetingNote`; Lost →
   `lostReason` (one of `LOST_REASONS`) + `lostNotes` (required); Call Back → `POST /reminders` ("Call back", optional)
   then the status; any other status as it is; Closed → the enrolment dialog, the status only once it is saved. Then
   `POST /notes` with the summary ("Call through 3CX — connected · Follow Up, 16 Oct, 3:00 PM GST"), the lost reason
   and the notes. A time in the past is refused in the popup before anything is sent. Each request is named; Save
   pressed again after a part-way failure sends only the ones that did not go through, judged against the lead's
   status when Save was first pressed (so a status is not changed twice, a reminder or follow-up not added twice).
8. **Leaderboard**: calls = `lead_calls` in the Dubai month by the call's person (`calls`, `connected`, `talkSeconds`);
   `rankBy` revenue (revenue → closings → follow-ups → calls) | calls | talk. The old `call_logs` no longer count.
9. **Root portal**: `GET /service/calls` (portal secret) — the Calls page's totals, per-person rows with emails, a page of
   calls; `GET /service/calls/:id/recording-link` — a link signed here for 10 minutes.
