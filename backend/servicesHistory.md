# Carlton CRM — Backend Services History

This file documents every service in `backend/src/services/`. Read this before writing any new service method to avoid duplication.

---

## 1. authService.ts

**File**: `src/services/authService.ts`
**Purpose**: Handles all authentication and authorization logic — login, token refresh, profile retrieval, password change.
**Model(s) used**: `User`, `Role`
**Utils called**: `generateAccessToken`, `generateRefreshToken`, `verifyRefreshToken` from `utils/jwt.ts`; `sendSuccess`, `sendError` (used in controller, not service)
**Called by**: `authController.ts`
**Routes that trigger it**: `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `GET /api/v1/auth/profile`, `PUT /api/v1/auth/change-password`

### Methods

#### `login(email: string, password: string)`
- Finds user by email using `User.findOne({ email }).select("+password").populate("role")`
- If user not found → throws 401 "Invalid credentials"
- If user status is "inactive" → throws 403 "Account deactivated"
- Calls `bcrypt.compare(password, user.password)` — throws 401 if mismatch
- Generates `accessToken` (15min TTL) and `refreshToken` (7d TTL) using jwt utils
- Returns `{ user: { _id, name, email, role }, accessToken, refreshToken }`
- Password is never returned — stripped before returning

#### `refreshToken(token: string)`
- Calls `verifyRefreshToken(token)` — throws 401 if invalid/expired
- Extracts `userId` from decoded payload
- Fetches user from DB — throws 401 if not found
- Generates a new `accessToken` (15min TTL)
- Returns `{ accessToken }`

#### `getProfile(userId: string)`
- Fetches user by `_id` using `.findById(userId).populate("role").select("-password").lean()`
- Throws 404 if not found
- Returns full user profile object

#### `changePassword(userId: string, currentPassword: string, newPassword: string)`
- Fetches user with `User.findById(userId).select("+password")`
- Calls `bcrypt.compare(currentPassword, user.password)` — throws 400 if wrong
- Hashes `newPassword` with `bcrypt.hash(newPassword, 10)`
- Updates `user.password = hashed`, calls `user.save()`
- Returns success message

---

## 2. leadService.ts

**File**: `src/services/leadService.ts`
**Purpose**: All lead domain business logic — CRUD, status management, assignment, notes, reminders, payments, bulk operations.
**Model(s) used**: `Lead`, `Team`, `User`, `Course`
**Utils called**: `emitToUser` from `socket.ts`, `sendPushToUser` / `notifyLeadAssignment` / `notifyBulkLeadAssignment` from `pushService.ts`, `buildPagination` from `utils/response.ts`
**Called by**: `leadController.ts`
**Routes that trigger it**: All routes under `/api/v1/leads/*`

### Methods

#### `createLead(data, reporterId)`
- Validates required fields (name, phone, course, source)
- Creates new Lead document with `status: "new"`, `createdBy: reporterId`
- Pushes `lead_created` entry to `activityLogs`
- Returns saved lead

#### `getLeads(filters, pagination, userId, role)`
- Builds dynamic query based on filters (status, assignedTo, team, search, dateRange, course, source)
- If user role lacks `leads:view` or is scoped, filters to `assignedTo: userId`
- Uses `.lean()` with `.populate("assignedTo", "name email").populate("team", "name").populate("course", "name")`
- Returns `{ leads, pagination: buildPagination(total, page, limit) }`

#### `getLead(leadId)`
- `Lead.findById(leadId).populate("assignedTo", "name email").populate("team", "name").populate("course", "name").populate("createdBy", "name email")`
- Throws 404 if not found
- Returns full lead with populated fields

#### `updateLead(leadId, data, userId)`
- Finds lead by ID (not lean — needs save)
- Tracks changed fields for `activityLogs`
- Updates allowed fields (name, phone, email, source, course, address, etc.)
- Pushes `lead_updated` entry to `activityLogs` with `changes: { field: { from, to } }`
- Calls `lead.save()`

#### `updateLeadStatus(leadId, status, userId)`
- Finds lead, changes `lead.status`
- Pushes `status_changed` to `activityLogs`
- Saves lead
- Returns updated lead

#### `assignLead(leadId, assignedTo, assignedBy)`
- Finds lead, sets `lead.assignedTo = assignedTo`, `lead.status = "assigned"`
- Pushes `lead_assigned` to `activityLogs`
- Calls `emitToUser(assignedTo, "lead:assigned", { leadId, leadName, assignedBy })`
- Calls `notifyLeadAssignment(assignedTo, leadId, lead.name, assignedBy)`
- Saves and returns lead

#### `assignLeadToTeam(leadId, teamId, userId)`
- Sets `lead.team = teamId`, `lead.status = "assigned"`
- Pushes `team_assigned` to `activityLogs`
- Saves lead
- Returns updated lead

#### `transferLeadToTeam(leadId, newTeamId, userId)`
- Unsets old team assignment, sets new `lead.team = newTeamId`
- Pushes `team_assigned` to `activityLogs`
- Returns updated lead

#### `deleteLead(leadId)`
- `Lead.findByIdAndDelete(leadId)` — hard delete
- Throws 404 if not found
- Returns deleted lead id

#### `bulkCreateLeads(rows, reporterId)`
- Calls `excelService.parseExcelBuffer()` (from controller which passes buffer)
- Maps valid rows to Lead documents — sets `notes` as array, validates email with regex
- `Lead.insertMany(docs, { ordered: false })`
- Counts `result.length` vs `docs.length` for failed count
- Returns `{ created: result.length, failed: docs.length - result.length, errors: [...] }`

#### `autoAssignLeads(leadIds?, teamIds?, memberOverrides?)`
- Signature: `autoAssignLeads(leadIds?: string[], teamIds?: string[], memberOverrides?: Record<string, string[]>)`
- Gets unassigned leads (optionally filtered by `leadIds` or `teamIds`)
- Distributes leads across active teams via round-robin
- After inter-team assignment, calls `autoSplitLead` for each lead passing `memberOverrides?.[teamId]`
- Returns `{ assigned: number, assignments: [{leadId, assignedTo}] }`

#### `autoSplitLead(teamId, leadId, performedById, overrideMemberIds?)`
- Signature: `autoSplitLead(teamId: string, leadId: string, performedById: string, overrideMemberIds?: string[])`
- If `overrideMemberIds` is provided and non-empty → uses those IDs (filtered to valid team members) as the assignment pool
- Otherwise falls back to team's `settings.includedMembers` → then all active members
- Assigns lead to member with fewest active leads (lowest workload)
- Calls `emitToUser` on assignment
- Wrapped in try-catch — errors are logged, never thrown (safe to await)

#### `addNote(leadId, content, authorId)`
- Finds lead (not lean)
- Pushes `{ content, author: authorId, createdAt: new Date() }` to `lead.notes`
- Pushes `note_added` to `activityLogs`
- Saves lead

#### `updateNote(leadId, noteId, content, userId)`
- Uses `$set` with `arrayFilters: [{ "n._id": noteId }]` to update specific note
- Pushes `note_updated` to `activityLogs`

#### `deleteNote(leadId, noteId, userId)`
- Uses `$pull` to remove note by `_id`
- Pushes `note_deleted` to `activityLogs`

#### `bulkUpdateStatus(leadIds, status, userId)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { status } })`
- Returns `{ updated: result.modifiedCount }`

#### `bulkDelete(leadIds)`
- `Lead.deleteMany({ _id: { $in: leadIds } })`
- Returns `{ deleted: result.deletedCount }`

#### `bulkAssignToTeam(leadIds, teamId, userId)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { team: teamId, status: "assigned" } })`
- Returns `{ updated: result.modifiedCount }`

#### `getMyReminders(userId, filters)`
- Finds leads where `reminders` array contains items with `assignedTo: userId` and `isDone: false`
- Uses `$elemMatch` to filter embedded reminders
- Returns flattened array of reminders with lead info

#### `getMyReminderCount(userId)`
- Counts upcoming active reminders for the user
- Returns `{ count: number }`

#### `addReminder(leadId, data, userId)`
- Pushes reminder object to `lead.reminders`: `{ title, body, remindAt, assignedTo: userId, isDone: false, notifiedAt: null, warnedAt: null }`
- Saves lead
- Returns added reminder

#### `updateReminder(leadId, reminderId, data, userId)`
- `$set` with `arrayFilters: [{ "r._id": reminderId }]`
- Returns updated lead

#### `deleteReminder(leadId, reminderId, userId)`
- `$pull { reminders: { _id: reminderId } }`
- Returns updated lead

#### `addPayment(leadId, data, userId)`
- Pushes payment object to `lead.payments`: `{ amount, mode, date, note, recordedBy: userId }`
- Saves lead
- Returns updated lead

#### `updatePayment(leadId, paymentId, data, userId)`
- `$set` with `arrayFilters: [{ "p._id": paymentId }]`

#### `deletePayment(leadId, paymentId, userId)`
- `$pull { payments: { _id: paymentId } }`

---

## 3. teamService.ts

**File**: `src/services/teamService.ts`
**Purpose**: All team domain business logic — CRUD, member management, auto-assignment, revenue analytics, team chat.
**Model(s) used**: `Team`, `Lead`, `User`, `TeamMessage`
**Utils called**: `emitToUser` from `socket.ts`, `emitTeamUpdate` from `socket.ts`, `notifyLeadAssignment` from `pushService.ts`, `buildPagination` from `utils/response.ts`
**Called by**: `teamController.ts`
**Routes that trigger it**: All routes under `/api/v1/teams/*`

### Methods

#### `createTeam(data)`
- Creates Team document with `{ name, description, leaders, members }`
- Returns saved team

#### `getTeamByMember(userId)`
- Finds team where `members` array includes `userId`
- Populates members and leaders
- Returns team or null

#### `getTeams(filters, pagination)`
- Lists all teams with pagination
- Populates `members` (name, email) and `leaders` (name, email)
- Returns `{ teams, pagination }`

#### `getTeamById(teamId)`
- Finds team by ID, populates members/leaders
- Throws 404 if not found

#### `updateTeam(teamId, data)`
- Updates team name, description, leaders, members
- Throws 404 if not found

#### `deleteTeam(teamId)`
- Hard deletes team
- Does NOT reassign leads — caller responsible for cleanup

#### `getTeamLeads(teamId, filters, pagination)`
- Finds leads by `team: teamId` with filter support (status, assignedTo, search)
- Returns paginated lead list

#### `getTeamMemberStats(teamId)`
- Aggregation pipeline: groups leads by `assignedTo` within team
- Returns `[{ userId, name, email, totalLeads, byStatus: { ... } }]`

#### `autoAssignTeamLeads(teamId, userId)`
- See `logicHistory.md` — Round-Robin Auto-Assignment
- Gets unassigned team leads, builds active member list, distributes round-robin
- Returns `{ assigned, assignments }`

#### `assignLeadToMember(teamId, leadId, memberId, assignedBy)`
- Verifies memberId is in team.members
- Calls `leadService.assignLead(leadId, memberId, assignedBy)`

#### `getTeamDashboard(teamId)`
- Aggregates lead stats, revenue, member performance for the team
- Returns dashboard summary object

#### `getTeamLogs(teamId, pagination)`
- Fetches `activityLogs` from all leads in the team
- Returns sorted, paginated log entries

#### `toggleMemberActive(teamId, memberId)`
- Checks if memberId is in `team.inactiveMembers`
- If inactive → `$pull` from inactiveMembers (activate)
- If active → `$push` to inactiveMembers (deactivate)
- See `logicHistory.md` for detail
- Returns updated team

#### `getTeamMemberById(teamId, memberId)`
- Verifies memberId is a member of teamId
- Returns user profile with team context

#### `getTeamMemberLeads(teamId, memberId, filters, pagination)`
- Finds leads where `team: teamId` AND `assignedTo: memberId`
- Returns paginated leads

#### `getTeamUpdates(teamId, pagination)`
- Fetches team activity feed (recent log entries across all leads in team)
- Returns paginated update items

#### `postTeamMessage(teamId, senderId, content)`
- Creates `TeamMessage` document: `{ teamId, sender: senderId, content, createdAt: now }`
- Calls `emitTeamUpdate(teamId, { type: "message", ... })`
- Returns saved message

#### `bulkAssignToMember(teamId, leadIds, memberId, assignedBy)`
- Verifies memberId is in team
- `Lead.updateMany({ _id: { $in: leadIds }, team: teamId }, { $set: { assignedTo: memberId, status: "assigned" } })`
- Calls `notifyBulkLeadAssignment(memberId, count)`
- Returns `{ updated: count }`

#### `bulkTransfer(fromTeamId, toTeamId, leadIds)`
- `Lead.updateMany({ _id: { $in: leadIds } }, { $set: { team: toTeamId, assignedTo: null } })`
- Returns `{ transferred: count }`

#### `bulkUpdateStatus(teamId, leadIds, status)`
- `Lead.updateMany({ _id: { $in: leadIds }, team: teamId }, { $set: { status } })`

#### `getTeamRevenue(teamId, dateRange)`
- Aggregation pipeline on `leads.payments` for team
- Filters by date range, groups by payment mode
- Returns `{ total, byMode: { cash, online, cheque } }`

#### `getTeamRevenueTimeline(teamId, period)`
- Aggregation pipeline grouping payments by day/week/month
- Returns `[{ date, total }]` array for charting

---

## 4. userService.ts

**File**: `src/services/userService.ts`
**Purpose**: User domain CRUD and profile management.
**Model(s) used**: `User`, `Lead`, `Role`
**Utils called**: None directly (bcrypt for password hash on create)
**Called by**: `userController.ts`
**Routes that trigger it**: All routes under `/api/v1/users/*`

### Methods

#### `createUser(data)`
- Validates email uniqueness (throws 409 if exists)
- Hashes password with `bcrypt.hash(data.password, 10)`
- Creates User with `{ name, email, password: hashed, role, status: "active" }`
- Returns user without password (`.select("-password")`)

#### `getUsers(filters, pagination)`
- Lists users with optional role/status/search filters
- Returns paginated list with role populated

#### `getUserById(userId)`
- `User.findById(userId).populate("role").select("-password").lean()`
- Throws 404 if not found

#### `getUserProfile(userId)`
- Same as `getUserById` but may include additional computed fields (team membership, stats)

#### `updateUser(userId, data)`
- Updates allowed fields (name, email, role, status, phone)
- If `data.password` present → hashes before saving
- Throws 404 if not found

#### `deleteUser(userId)`
- Hard delete user
- Does NOT reassign their leads — caller must handle
- Throws 404 if not found

#### `getLeadsByUser(userId, filters, pagination)`
- Finds leads where `assignedTo: userId`
- Returns paginated leads with filters

#### `getUserLeadStats(userId)`
- Aggregation: count leads by status for this user
- Returns `{ total, byStatus: { new, assigned, followup, ... } }`

---

## 5. roleService.ts

**File**: `src/services/roleService.ts`
**Purpose**: Role and permission management.
**Model(s) used**: `Role`
**Utils called**: None
**Called by**: `roleController.ts`
**Routes that trigger it**: All routes under `/api/v1/roles/*`

### Methods

#### `createRole(data)`
- Creates Role with `{ roleName, isSystemRole: false, permissions: data.permissions }`
- Validates that `roleName` is unique (Mongoose unique index also enforces this)
- Returns saved role

#### `getRoles(pagination)`
- Lists all roles with pagination
- Returns `{ roles, pagination }`

#### `getRoleById(roleId)`
- Finds role by ID — throws 404 if not found

#### `getRolesSimple()`
- Returns all roles as `[{ _id, roleName }]` — lean, no pagination
- Used for dropdowns/selects in UI

#### `updateRole(roleId, data)`
- Updates `roleName` and/or `permissions`
- Throws 404 if not found
- Throws 400 if attempting to modify a system role

#### `deleteRole(roleId)`
- Throws 400 if `role.isSystemRole === true` — cannot delete system roles
- Checks if any users have this role (throws 400 if yes)
- Hard deletes role

---

## 6. courseService.ts

**File**: `src/services/courseService.ts`
**Purpose**: Course catalog management.
**Model(s) used**: `Course`
**Utils called**: None
**Called by**: `courseController.ts`
**Routes that trigger it**: All routes under `/api/v1/courses/*`

### Methods

#### `createCourse(data)`
- Creates Course with `{ name, description, price, duration, category }`
- Returns saved course

#### `getCourses(filters, pagination)`
- Lists courses with optional search/category filters
- Returns paginated courses

#### `getAllCourses()`
- Returns ALL courses without pagination — for dropdowns
- `.lean()` for performance

#### `getCourseById(courseId)`
- Finds by ID, throws 404 if not found

#### `updateCourse(courseId, data)`
- Updates any course fields
- Throws 404 if not found

#### `deleteCourse(courseId)`
- Hard delete
- Does NOT check if any leads reference this course — caller responsible
- Throws 404 if not found

---

## 7. reportService.ts

**File**: `src/services/reportService.ts`
**Purpose**: All analytics and reporting — uses MongoDB aggregation pipelines.
**Model(s) used**: `Lead`, `Team`, `User`
**Utils called**: None
**Called by**: `reportController.ts`
**Routes that trigger it**: All routes under `/api/v1/reports/*`

### Methods

#### `getOverview(dateRange, teamId?)`
- Aggregates lead counts by status
- Optionally scoped to a team
- Returns `{ total, byStatus: { new, assigned, followup, ... }, conversionRate }`

#### `getTimeline(period, dateRange, teamId?)`
- Groups lead creation by day/week/month
- Returns `[{ date, count, byStatus }]` for charting

#### `getUserRankings(dateRange, teamId?)`
- Aggregates per-user: lead count, closed count, revenue
- Returns `[{ userId, name, leads, closed, revenue, conversionRate }]` sorted by revenue desc

#### `getTeamRankings(dateRange)`
- Same as user rankings but grouped by team
- Returns `[{ teamId, name, leads, closed, revenue }]`

#### `getTeamSplit(dateRange)`
- Pie chart data: how leads are distributed across teams
- Returns `[{ teamId, name, count, percentage }]`

#### `getRevenueOverview(dateRange, teamId?)`
- Aggregates payment totals from `lead.payments` array
- Returns `{ total, byMode: { cash, online, cheque }, byTeam }`

#### `getRevenueTimeline(period, dateRange)`
- Groups payments by day/week/month
- Returns `[{ date, total }]`

#### `getRevenueTeams(dateRange)`
- Revenue breakdown per team
- Returns `[{ teamId, name, total, byMode }]`

---

## 8. pushService.ts

**File**: `src/services/pushService.ts`
**Purpose**: Web Push (VAPID) notification management — subscribe, unsubscribe, send notifications.
**Model(s) used**: `PushSubscription`
**External library**: `web-push`
**Called by**: `pushController.ts`, `leadService.ts`, `teamService.ts`, `reminderScheduler.ts`
**Routes that trigger it**: `/api/v1/push/*`

### Methods

#### `sendPushToUser(userId, { title, body, tag, url, data })`
- Fetches all `PushSubscription` documents for `userId`
- Calls `webpush.sendNotification(sub, JSON.stringify({ title, body, tag, url, data }))` for each
- Handles expired/invalid subscriptions: on 410 response, deletes the subscription document
- Returns `{ sent: number, failed: number }`

#### `notifyLeadAssignment(userId, leadId, leadName, assignedBy)`
- Wrapper: calls `sendPushToUser(userId, { title: "New Lead Assigned", body: ..., tag: "lead-assign", url: /leads/${leadId} })`

#### `notifyBulkLeadAssignment(userId, count)`
- Wrapper: calls `sendPushToUser(userId, { title: "${count} Leads Assigned", ... })`

#### `subscribePush(userId, subscription)`
- `subscription` = `{ endpoint, keys: { p256dh, auth } }` from browser PushManager
- Upserts `PushSubscription` document: `{ userId, endpoint, keys }` (unique on endpoint)
- Returns saved subscription

#### `unsubscribePush(userId, endpoint)`
- Deletes `PushSubscription` where `userId` AND `endpoint` match
- Returns `{ deleted: boolean }`

#### `getVapidPublicKey()`
- Returns `process.env.VAPID_PUBLIC_KEY`

---

## 9. reminderScheduler.ts

**File**: `src/services/reminderScheduler.ts`
**Purpose**: Background job that checks for due reminders and fires Socket.io + Web Push notifications.
**Model(s) used**: `Lead`
**Utils called**: `emitToUser` from `socket.ts`, `sendPushToUser` from `pushService.ts`
**Called by**: `src/index.ts` (on server start: `startReminderScheduler()`)
**No routes** — runs entirely as a background process

### Methods

#### `startReminderScheduler()`
- Calls `setInterval(tick, 30_000)` (runs every 30 seconds)
- Also runs `tick()` once immediately on startup
- Logs startup

#### `tick()` (internal async function)
- **Pass 1 — On-Time Notifications**:
  - Query: leads where `reminders` contains `{ remindAt: { $lte: now }, isDone: false, notifiedAt: null }`
  - Uses `$elemMatch` for the query predicate
  - For each matching lead, iterates sub-documents that match Pass 1 criteria
  - Calls `emitToUser(reminder.assignedTo, "reminder:due", { ... })`
  - Calls `sendPushToUser(reminder.assignedTo, { title: reminder.title, ... })`
  - Stamps `notifiedAt: now` using `arrayFilters: [{ "r._id": reminder._id }]`

- **Pass 2 — Warning Notifications** (reminders coming up in 1-31 minutes):
  - Query: leads where `reminders` contains `{ remindAt: { $gte: nowPlus1, $lte: nowPlus31 }, isDone: false, warnedAt: null }`
  - For each match: emits `reminder:warning` with `minsLeft` calculated
  - Stamps `warnedAt: now` using `arrayFilters`

---

## 10. excelService.ts

**File**: `src/services/excelService.ts`
**Purpose**: Parses xlsx/csv file buffers, validates rows, returns structured valid/invalid split.
**Model(s) used**: None (pure parsing logic)
**External library**: `exceljs` or `xlsx`
**Called by**: `leadService.ts` → `bulkCreateLeads` (controller passes buffer from multer)

### Methods

#### `parseExcelBuffer(buffer: Buffer, reporterId: string)`
- Reads buffer as xlsx/csv
- Maps each row to a `ParsedLead` object using column index mapping
- **Email validation**: checks against `/^\S+@\S+\.\S+$/` — if value is "No Email", empty, or invalid format → sets `email: undefined` (not stored)
- **Notes validation**: if a notes column exists, wraps as `[{ content: value, author: reporterId }]` array — never a plain string
- **Phone dedup**: checks if phone already exists in DB (optional, may be done in bulkCreateLeads)
- Returns:
  ```typescript
  {
    valid: ParsedLead[],    // rows that passed all validations
    invalid: Array<{
      row: number,
      data: object,
      reason: string
    }>
  }
  ```
- Rows missing required fields (name, phone) go to `invalid`
- Rows with duplicate phones within the same upload go to `invalid`

---

## teamService — getTeamReminders (added 2026-04-06)

**Method:** `getTeamReminders(teamId, requesterId, requesterRole, filters)`
**Access:** Team leader of the team OR Super Admin only — returns 403 otherwise.
**Filters:** `memberId`, `isDone` ("true"/"false"), `search` (lead name / reminder title / note), `page`, `limit`.
**Returns:** `{ reminders: [{ reminder, lead: { _id, name, phone, status, assignedTo } }], pagination }`
**Pipeline:** $match lead → $unwind reminders → optional filters → $sort remindAt ASC → paginate → $lookup assignedTo + createdBy.

---

## financeHandoverWorker — kickFinanceHandover (added 2026-09-29)

**Method:** `kickFinanceHandover()` — fire and forget; never awaited, never throws.
**Called by:** `studentService.queueFinanceHandover`, right after the handover row is queued.
**Does:** runs a delivery pass now, in the background, so finance has the enrolment within a second or two instead of up to a minute. One pass at a time per process: a kick that lands mid-pass asks for one more pass, so nothing it queued waits for the timer.
**No-op** when finance is not configured. The 60-second timer stays as the retry net.
**Backoff after a failure:** attempts² minutes, capped at 15 minutes (was 1 hour).
**Test:** `tests/finance/handoverKick.test.ts` (`bun --no-env-file test tests/finance/handoverKick.test.ts`) — in-process, throwaway DB, stand-in finance.

---

## mailService (added 2026-09-30)

**Methods:** `isMailConfigured()`, `sendMail({ to, subject, html, text?, attachments? })`, `renderEmail({ heading, paragraphs, action? })`
**Config:** `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` ("true" for 465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. `SMTP_HOST` empty = mail off: each email is logged (`✉️  [mail dry-run] …`) and `{ sent: false, reason: "not configured" }` is returned.
**Never throws** — returns `{ sent, reason? }`. `renderEmail` is the one branded template (purple header, one button; paths resolved against `CLIENT_URL`; all text escaped).

---

## notificationService — notify (added 2026-09-30)

**Method:** `notify({ userIds, type, title, body, url?, tag?, email? })` — never throws.
**Does, in order:** stores one `Notification` per person → emits the socket `"notification"` event with the stored DTO (now carries `id`) → web push via `sendPushToUsers` → email, only when `email` is given AND `settings.email[email.setting]` is on (per person, "Hi <name>,", skips inactive users and users without email).
**Also:** `toNotificationDTO(doc)` → `{ id, type, title, body, url, read, createdAt }`.
**Used by:** Phase 2+ (inactive leads, idle alerts, meetings).

---

## settingsService (added 2026-09-30)

**Methods:** `getAppSettings()` (30 s cache; creates the `key: "app"` document with defaults on first read), `updateAppSettings(input, userId)` (partial `$set`, clears the cache; 400 if working hours end ≤ start), `isWithinWorkingHours(settings, at?)` (evaluated in the settings' own time zone).
**Defaults:** inactive leads — auto-reassign **off**, 45 min · idle alerts **off**, 30 min, team leaders not alerted · working hours Mon–Sat 09:00–18:00 Asia/Dubai · email on for inactive leads, idle alerts and meetings.

---

## inactiveLeadService (added 2026-09-30)

**Methods:**
- `listInactiveLeads({ page, limit, teamId?, ownerId?, search? }, now?)` → `{ items, summary: { total, stuck, movedToday, capped }, rule, pagination }` — longest-waiting first; each item says what the automatic mover will do (`due | off | before_switch | stuck | no_team`).
- `listLeadMoves({ page, limit, kind?, teamId? })` → the `LeadMove` log, newest first, names filled in.
- `reassignInactiveLeads({ leadIds, to? }, byUserId, now?)` → `{ moved, skipped }` — `to` = one person; without it each lead goes to the next in its team. Re-checks every lead first.
- `sweepInactiveLeads(now?)` → `{ moved, stuck, idle? }` — one automatic pass (the scheduler calls it every minute).
- `formatMinutes(n)` — "45 min", "2 h 30 min".
**Never** moves a lead back to anyone in `inactivity.lostBy`; every move is a conditional update on `{ assignedTo, assignedAt }`.

---

## leadService — split rule shared (changed 2026-09-30)

- `pickSplitAssignee(team, leadId, { overrideMemberIds?, exclude? })` → member id or `null` — the member-picking half of `autoSplitLeadInner`, pulled out unchanged so moved leads follow the same split rule as new ones. `exclude` takes people out without changing whose turn it is.
- `runInTeamQueue(teamId, task)` — the per-team split queue, now usable by callers other than `autoSplitLead`.
- New-lead behaviour is unchanged (regression-tested: round robin, source-wise round robin).

---

## settingsService — enabledAt (changed 2026-09-30)

`updateAppSettings` stamps `inactiveLeads.enabledAt` when `autoReassign` goes from off to on and clears it when it goes off; it now reads the stored settings past the cache before deciding. Clients cannot set `enabledAt` (the schema is strict).

---

## utils/workingHours (added 2026-09-30)

`workingMinutesBetween(wh, from, to)`, `workingCutoff(wh, now, minutes)`, `startOfLocalDay(tz, at)` — pure, evaluated in the working hours' own time zone (DST-safe), windows `[start, end)`.

---

## activityService (added 2026-09-30)

**Recording:** `recordLogin(req, user, method)`, `recordLoginFailure(req, email, error, method)` (401/403 only; reason `wrong_password | unknown_email | deactivated | no_account`), `recordLogout(req, userId)`, `recordHeartbeat(userId, active, now?)`. The first two never throw.
**Reading:** `listPeople({ search?, teamId? }, now?)` → everyone with status (`active | idle | away | signed_out | offline`), quiet minutes, alerted, active minutes today, last sign-in; `listLoginEvents({ page, limit, userId?, kind?, from?, to? })`; `listIdleStretches({ page, limit, userId? }, now?)`.
**Sweep:** `sweepIdleUsers(now?)` → `{ alerted, idle? }` — the scheduler calls it every minute.

---

## notificationService — superAdminIds (moved 2026-09-30)

`superAdminIds()` — every active Super Admin; moved here from inactiveLeadService so idle alerts share it.

---

## utils/requestMeta (added 2026-09-30)

`clientIp(req)` — first X-Forwarded-For hop, else the socket address (display only, not a security check); `describeDevice(userAgent)` → `{ label: "Chrome on Windows", type: desktop | mobile | tablet | app | unknown }`.

`utils/workingHours` also gained `localDayKey(tz, at)` and `formatMinutes(n)` (moved from inactiveLeadService).

---

## meetingService (added 2026-10-01)

**Methods:** `createMeeting(input, actor)`, `updateMeeting(id, input, actor)`, `cancelMeeting(id, reason, actor)`, `getMeeting(id, actor)`, `calendarFor({ from, to, userId? }, actor)` → `{ timezone, workingHours, person, meetings, followUps, reminders }`, `findConflicts({ startAt, endAt, userIds, mentorIds, excludeId? })` → `{ people, mentors, mentorsUnavailable }`, `listColleagues(search?)`, `sweepMeetingReminders(now?)`.
**Rules:** organizer or Super Admin changes/cancels; attendees see; others get 404. A client only if the organizer can see the lead (same rule as the leads list). Mentors are looked up in the LMS by id — names and emails never come from the form. Notes never leave the team. Every change bumps `sequence` (the invite's SEQUENCE); moving it re-arms the reminder.

---

## utils/ics (added 2026-10-01)

`buildIcs({ uid, sequence, method: REQUEST | CANCEL, start, end, title, description?, location?, url?, organizer, attendee?, alarmMinutes? })` — RFC 5545, CRLF, lines folded at 75 octets (UTF-8 safe), TEXT escaped, one attendee per file (the recipient).

## mailService / notificationService — calendar invites (changed 2026-10-01)

`sendMail({ …, icalEvent: { method, content, filename? } })` → nodemailer's `icalEvent` (mail clients show an "add to calendar" card). `notify({ email: { invite: (person) => icalEvent } })` builds one per recipient.

`utils/workingHours.localClock(tz, at)` → `{ weekday, minutes, dayKey }` (mentor slot checks).

---

## leadService.getLeads — filters within the role (changed 2026-10-01)

`assignedTo` and `team` filters are combined with the caller's role limit (BDE: own leads; team leader: own team) instead of
replacing it; one outside the limit returns an empty page. Super admins and reporters are unaffected.


## teamService — team report on the model's statuses (changed 2026-10-01)

- `LEAD_STATUS_VALUES` (exported) — the lead model's `status` enum, read from the schema. The team report and the team PDF
  count exactly these; no second list to keep in step.
- `gstDayRange(dateFrom?, dateTo?)` (exported) — a period of "YYYY-MM-DD" Dubai days as a `createdAt` range
  (`$gte` midnight Dubai, `$lt` the next midnight). A malformed or impossible day (2026-02-30) throws a 400.
- `getTeamMemberSplit(teamId, dateFrom?, dateTo?)` — one count per `LEAD_STATUS_VALUES` status (was a fixed list of 13,
  seven of which no lead can have); `total` still counts every lead, so a stored status outside the list shows as the
  difference. Dubai days via `gstDayRange`; a malformed team id is a 400.

## leadService.updateLeadStatus — meeting (changed 2026-10-01)

New 7th parameter `meeting?: { at: Date; note?: string }` — with `status === "meeting_scheduled"` it adds the meeting reminder
(for the lead's owner, else the performer) and appends the meeting time to the history line. `getUserLeadStats` also returns
`meeting_scheduled` and `wrong_number`.

---

## The sales CRM tag on every enrolment (2026-10-03)

#### `StudentService.buildHandoverPayload(studentId)` — `src/services/studentService.ts`
- Now also sends `crm: "remote"` — which sales CRM sold it ("Remote CRM"). Finance stores it on the enrolment and shows it as a tag, and passes it on to the LMS and Tetra Commission, which show the same tag.
- Not the `source`: the Remote CRM began as a copy of Delta's and also sends `"crm"` there, and the source is part of finance's idempotency key, so it cannot change for enrolments already sent.
- Test: `scripts/closing-fields-check.ts` / `scripts/enrolment-close-e2e.sh` check it is sent.

## Courses → several LMS courses (changed 2026-10-04)

- `courseService.createCourse` / `updateCourse` — take `financeItemId` ("" or null unmaps) and `lmsCourseSlugs` (trimmed, no
  repeats, in order; [] unmaps) through `mappingFields()`; the first slug is also stored as `lmsCourseSlug`. A side the caller
  did not mention is left as it is.
- `lmsClient.listLmsCourses()` — the LMS's public course list (`GET /api/v1/courses?per_page=100`, no secret), from
  `LMS_API_URL` or, unset, the Delta LMS's public address; `{ slug, title }` sorted by title; a 502 when it can't be read.
- `studentService.buildHandoverPayload` — `course.lmsCourseSlugs` (all) and `course.lmsCourseSlug` (the first); a course
  mapped the old way (one slug) sends that one.

## leadService — Meeting Done (changed 2026-10-04)

`updateLeadStatus` and `bulkUpdateStatus`: with `status === "meeting_done"`, every open reminder titled "Meeting scheduled"
on the lead is marked done. `getUserLeadStats` also returns `meeting_done`.

## impersonationService — View as (added 2026-10-04)

- `start(req, admin, targetId)` — checks the target (404 / 400 / 403 / 409), records the session (`Impersonation`: admin + email,
  target + email, start, expiry = start + 30 min, IP, device) and signs the pass for that same second
  (`signImpersonationToken(payload, iat)`); returns `{ accessToken, expiresAt, user }` (user as on sign-in: role + permissions).
- `stop(sessionId)` — sets `endedAt` while still open; ending one already over is fine.
- `checkImpersonation(decoded)` (`middleware/auth.ts`) — the session open, unexpired and matching; the admin active and a super
  admin; gives `req.user.impersonatedBy = { id, name, email, sessionId }`, or the refusal message.

---

## A course's bonus (2026-10-04)

#### `CourseService.createCourse(data)` / `updateCourse(id, data)` — `src/services/courseService.ts`
- Also take `bonusAmount` (validated in `courseController`: a number ≥ 0); stored on the course, 0 when not given

#### `LeadService` — `src/services/leadService.ts`
- The lead reads (`buildPopulatedQuery`, `getLeads`) populate `bonusAmount` on the lead's course, so the close starts from it
- Test: `scripts/course-bonus-e2e.sh`.

---

## Commission (2026-10-04)

#### `commissionService` — `src/services/commissionService.ts`
- `TL_RULE` — how this CRM pays a team's leader ("zero_if_sm" Sales CRM, "always" Remote, "never" Draw); the one line that differs between the three CRMs
- `resolveSale({ closer, saleTeam, plan }, config)` — who earns what under the rules; writes nothing
- `recordApprovedSales` / `settlePendingSales` / `reverseVoidedSales` — one sale per approval (insert-only, unique per student), held sales looked at again, voided invoices reversed (last 120 days, every 10 minutes)
- `sweepCommission()` — the three, run by the finance worker every minute inside `RUN_SCHEDULERS`; never throws
- `CommissionService.getPlan(viewer)` / `updateCoursePlan` / `updateSettings` / `getEarnings(viewer, month)` / `preview({ course, team, closer })`
- Test: `scripts/commission-check.sh`.

#### `pollFinanceOutcomes` — `src/services/financeHandoverWorker.ts`
- Stamps `approvedAt` on the move to approved (or not_required); commission counts from it, so approvals from before it existed are never paid on

---

## Five steps (2026-10-04)

#### `enrolmentSteps` — `src/services/enrolmentSteps.ts`
- `stepsOf(financeStatus, handover)` → `[{ key, label, state, detail, at, by }]` — finance / lms / cs / onboarded / bonus; `allDone(steps)`; `waitingOn(steps)` → "Next step: …" / "Stopped at: …"

#### `commissionService.trackSales(config, names)` — `src/services/commissionService.ts`
- Sales closed since `COUNT_FROM` (1 Oct 2026 UAE), handed over, not decided: finance's status for each; not all done → `progress` with the step; all done → who earns what at today's plan (`stepsDoneAt`). Shared logins → excluded at once; a void → reversed; a sale counted before this rule without `stepsDoneAt` → followed again

#### `StudentService.getEnrolment(id, viewer)` — `src/services/studentService.ts`
- One enrolment with its steps and its commission as the viewer may see it; 403 for somebody else's without students:view

## Split payments (added 2026-10-05)

- `checkedPayments(list, paidAmount, enrolledOn)` — validates a close's `payments[]` (see logicHistory) and returns them ready to
  store, or null when none were sent.
- `assertNotOverFee(totalFee, paidAmount)` — 422 when what was collected is more than the fee.
- `buildHandoverPayload` — adds `payments: [{ method, amountMinor, paidOn, receipt }]` when the enrolment has them.

## studentService — currency per payment (changed 2026-10-05)

- `checkedPayments` — each payment may carry `currency` / `amountInCurrency` / `exchangeRate`, checked by `foreignPart(raw,
  aed, label)`: a currency of `CLOSE_CURRENCIES`, amount and rate above zero, `amount` within 0.5% of `amountInCurrency ×
  exchangeRate`, never on `collectedBefore`; stored on `Student.payments[]`.
- `buildHandoverPayload` — a payment in another currency adds `original: { currency, amountMinor (×100), rate }`.

## Academy at the close (changed 2026-10-10)

- `financeClient` — `financeOrgOf(academy)`, `academiesOffered()` (Bangalore only when FINANCE_ORG_ID_BANGALORE is set; served
  by `GET /students/close-options`); `sendEnrolment(payload, orgId)`,
  `listFinanceItems(orgId)`, `fetchEnrolmentStatuses(ids, orgId)` take the organization (default `FINANCE_ORG_ID`); an empty
  org is never sent (retried, not misrouted).
- `financeOrgs` (new) — `orgOfHandover(row, studentAcademy)` (stored `financeOrgId`, else by academy, else Dubai), `orgsOf(ids)`,
  `fetchStatusesByOrg(ids, known?)` — one status call per organization. Used by the worker's delivery and poll,
  `listEnrolments`, `getEnrolment`, `sendBackOf`, `trackSales`, `reverseVoidedSales`.
- `studentService.createStudent` — `academy` ("dubai" default, "bangalore"); Bangalore → `assertBangaloreClose` (Bangalore
  price, and FINANCE_ORG_ID_BANGALORE set — even with finance off); payments checked against INR.
- `foreignPart(raw, amount, n, base)` / `checkedPayments(…, base)` — Bangalore: INR, or AED with rate INR per AED; the lead's
  own money must be AED with its rate.
- `buildHandoverPayload` — `academy` always; Bangalore: `bangalore.financeItemId`, `bangalore.lmsCourseSlugs` (else Dubai's),
  `original` for payments not in INR.
- `queueFinanceHandover` — stores `academy` and `financeOrgId` on the row.
- `correctEnrolment` — academy fixed (422 if another is sent), Bangalore needs a Bangalore-priced course, own money compared in
  AED, lead sync via `leadPaymentOf` (Bangalore: only AED cash, at its AED). `getCorrection` returns `academy`.

## The client's email at the close (changed 2026-10-10)

- `isFinanceEmail(v)` — zod 4 `z.email()` (finance's zod 3 `z.string().email()` pattern, `z.regexes.email`); replaces
  `EMAIL_RE` at the close, the correction, add-email and the flag.
- `createStudent(data, performedBy?)` — the client's email is required (`isFinanceEmail`), named in the "A closing needs …"
  list; stored trimmed and lower case; then `keepEmailOnLead(leadId, email, performedBy, "at the close")`.
- `keepEmailOnLead` (new, private) — sets `Lead.email` only when the lead has none finance would take (conditional update,
  `{ email: { $not: z.regexes.email } }`), pushing a `lead_updated` activity entry with `changes.email { from, to }`; never
  throws.
- `addEnrolmentEmail(id, email, viewer)` (new) — `correctable` guard; 422 for an invalid email; 409 with no row, a `sent`
  row, or one `emailCanBeAdded` refuses; conditional reset of the row (`$set payload.customer.email`, `status: "pending"`,
  `attempts: 0`, `nextAttemptAt`, `lastError: ""`, only while not `sent`); `Student.email`; `keepEmailOnLead(…, "for
  finance")`; `kickFinanceHandover()` — the worker sends it to `orgOfHandover(row)`.
- Module helpers: `payloadEmail(row)`, `refusedForEmail(row)` (not sent, lastError "Request validation failed", payload email
  invalid), `emailCanBeAdded(row)` (that, or `pending` with an invalid payload email), `stepError(row)`.
- `listEnrolments` / `getEnrolment` — select `payload.customer.email`; `handover.needsClientEmail` + `suggestedEmail`
  (`suggestedEmailOf(student.email, lead.email)` — the enrolment's if finance takes it, else the lead's, else ""; the list
  populates `leadId.email`, the page asks `suggestedEmailFor`); the finance step's error reads "the client's email is
  missing; add it and send again". `getCorrection` — `deliveryStatus`, `needsClientEmail`, `suggestedEmail`.
- `requestInvoice` — 409 (`queued: false`) for a row `refusedForEmail`: "… add the client's email first …".

## One email, one client (changed 2026-10-10)

- `services/emailHolder.ts` (new) — `findEmailHolder(email, { name, phone, leadId?, studentId? })`: students (not
  `studentId`, not of `leadId`), then leads (not `leadId`), holding the email trimmed and case-insensitively (`emailMatch`),
  earliest first; the first that `differentPeople` says is another person, as `{ kind, id, name, code? }`, or null.
- `utils/clientEmail.ts` (new) — `isFinanceEmail` / `FINANCE_EMAIL_RE` (moved from studentService), `emailKey`, `phoneKey`
  (last 9 digits; "" under 7 digits), `nameKey`, `differentPeople`, `emailMatch`, `maskEmail`, `takenMessage`.
- `createStudent` — 409 `takenMessage` after the missing check (the client: the close's name/phone, else the lead's).
- `correctEnrolment` — 409 after the missing check (the client as corrected). `requestInvoice` — the sent-back branch answers
  `queued: false` (409): the message + "Correct the enrolment to change it, and it goes again." `addEnrolmentEmail` — 409
  after the row checks.
- `suggestedEmailOf(student, leadEmail)` — async now; skips a taken email. `suggestedEmailFor(h, student)`; `listEnrolments`
  works the suggestions out for the rows that need one.
- `checkClientEmail(email, { leadId | studentId })` (new) — behind `GET /students/email-check`.

## callSyncService / leadCallService / clickToCall — 3CX calls (added 2026-10-14, from the Draw CRM)

- `syncCalls(by)` → `{ ok, skipped?, error?, windows, rows, calls, inserted, updated, leadsRecounted? }`;
  `startCallSyncWorker()`; `syncExtensions()`; `takeLock` / `releaseLock`; `getCallSettings()`.
- `recountLeadCalls(leadIds?)` — counts from `lead_calls`; no ids = every lead (with calls counted, the rest to 0).
- `keepHandCounts()` (this CRM only) — copies every lead's non-zero counts into `HAND_COUNTS`
  (`lead_call_counts_before_3cx`, upserts) before the first count from 3CX; done once `handCountsCopiedAt` is set, which
  happens only when every lead is in; returns how many were copied this time.
- `groupRows`, `parseCall`, `phoneKey`, `phoneKeysOf`, `leadsByPhone`, `pickLead`, `durationSeconds`, `callLogPath`.
- `recordingPath`, `checkRecordingLink`, `recordingSource`, `recordingCount`.
- `leadCallService.list(viewer, filters)`, `.forLead(viewer, leadId)`, `canSeeCall`, `canWorkLead`, `scopeOf`.
- `clickToCallController`: `getClickToCall`, `startThreecxCall`, `getMyCallState`, `hangUpMyCall`.
- `portalCalls`: `callsForPortal(query)`, `recordingLinkForPortal(id, index)`, `CallFilterError`.
- `lib/threecx.ts`: `threecxConfigured`, `threecxSettings`, `threecxFetch`, `threecxJson`, `threecxPost`.
- `LeaderboardService.getLeaderboard(month?, rankBy = "revenue")` — rows add `connected`, `talkSeconds`.
- `utils/dubaiDay.ts`: `dubaiToday(now?)`, `dubaiDayStart(value)` (new, beside `dubaiDayRange`).
- `logClickToCall` (callController, changed) — also stamps the lead's contact dates, for `leads.edit` / Super Admin
  (logicHistory "3CX calls" 6).
- `leadService.addFollowUp` (fixed) — populates the new entry through the lead; it used to throw after saving.

## inactiveLeadService — the page's pickers (added 2026-10-15)

- `listFilterTeams()` — every active team, by name, for the page's team filter (no Teams permission needed).
- `listMovePeople({ search? })` — active people by name (100 at most), for the Move dialog (no Users permission needed).
