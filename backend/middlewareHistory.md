# Carlton CRM — Middleware History

This file documents the full middleware stack, every individual middleware, the complete route permission matrix, and access control rules.

---

## Middleware Stack Order

Applied globally in `src/index.ts` in this order:

```typescript
// 1. CORS
app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true
}));

// 2. Body Parser
app.use(express.json());

// 3. HTTP Request Logging
app.use(morgan("dev"));

// 4. Route Handlers
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/leads", leadRoutes);
app.use("/api/v1/teams", teamRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/users", userLeadRoutes);
app.use("/api/v1/roles", roleRoutes);
app.use("/api/v1/courses", courseRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/ai", aiRoutes);
app.use("/api/v1/push", pushRoutes);
app.use("/api/sheets", sheetsRoutes);   // NOT /api/v1 — intentional

// 5. 404 Handler (must be AFTER all routes)
app.use(notFound);

// 6. Global Error Handler (must be LAST — 4-argument signature)
app.use(errorHandler);
```

---

## Each Middleware

---

### 1. authenticate

**File**: `src/middleware/auth.ts`
**Used on**: Every protected route
**Position in chain**: Always first (before checkPermission, requireModule, or any business handler)

**What it does**:
1. Reads the `Authorization` header — expects `Bearer <token>`
2. Extracts the token, calls `verifyAccessToken(token)` from `utils/jwt.ts`
3. Fetches the User document from DB: `User.findById(decoded.userId).select("-password")`
4. Checks `user.status !== "inactive"` — rejects deactivated accounts
5. Fetches the Role document from DB: `Role.findById(user.role)` — FRESH on every request
6. Attaches `req.user` to the Express request object

**What it attaches to `req`**:
```typescript
req.user = {
  userId: string,   // user._id.toString()
  email: string,    // user.email
  roleId: string,   // role._id.toString()
  role: IRole       // full Role document including permissions map
}
```

**Error responses**:
| Condition | Status | Message |
|-----------|--------|---------|
| Missing Authorization header | 401 | "No token provided" |
| Token expired | 401 | "Token expired" |
| Token invalid/malformed | 401 | "Invalid token" |
| User not found in DB | 401 | "User not found" |
| User is inactive | 403 | "Account deactivated" |
| Role not found | 403 | "Role not found" |

---

### 2. checkPermission(module, action)

**File**: `src/middleware/permissions.ts`
**Used on**: Most protected routes (after authenticate)
**Position in chain**: After `authenticate`, before route handler

**What it does**:
1. Reads `req.user.role` (populated by `authenticate`)
2. Checks Super Admin bypass: `role.isSystemRole && role.roleName === "Super Admin"` → `next()`
3. Reads `role.permissions[module]`
4. Checks `role.permissions[module][action] === true`
5. If check passes → `next()`; if fails → 403

**Signature**:
```typescript
checkPermission(module: CrmModule, action: PermissionAction): RequestHandler
```

**Usage**:
```typescript
router.get("/leads", authenticate, checkPermission("leads", "view"), getLeads);
```

**Error responses**:
| Condition | Status | Message |
|-----------|--------|---------|
| permissions[module] is undefined | 403 | "Permission denied" |
| permissions[module][action] !== true | 403 | "Permission denied" |

---

### 3. requireModule(module)

**File**: `src/middleware/permissions.ts`
**Used on**: Routes where any access to a module is acceptable (regardless of specific action)

**What it does**:
1. Super Admin bypass (same as checkPermission)
2. Checks if `role.permissions[module]` has ANY truthy value across all actions
3. If any action is `true` → `next()`; otherwise → 403

**Usage**:
```typescript
router.get("/dashboard", authenticate, requireModule("dashboard"), getDashboard);
```

---

### 4. selfOrPermission

**File**: `src/routes/userRoutes.ts` (inline — not a separate file)
**Used on**: `GET /api/v1/users/:id` only

**What it does**:
```typescript
const selfOrPermission = (req: Request, res: Response, next: NextFunction) => {
  if (req.user.userId === req.params.id) {
    // User is viewing their own record — allow without permission check
    return next();
  }
  // Viewing someone else's record — require users:view
  checkPermission("users", "view")(req, res, next);
};
```

**Why inline**: It's only used in one place and references `req.params.id` dynamically — making it a factory function would add unnecessary complexity.

---

### 5. authenticateApiKey

**File**: `src/middleware/apiKeyAuth.ts`
**Used on**: `/api/sheets/*` routes ONLY
**Position**: Replaces `authenticate` + `checkPermission` for these routes

**What it does**:
1. Checks `process.env.SHEETS_API_KEY` is configured — returns 503 if not set
2. Reads `x-api-key` header from request
3. Compares to `process.env.SHEETS_API_KEY` using `timingSafeEqual` (prevents timing attacks)
4. If match → `next()`; otherwise → 401

**Error responses**:
| Condition | Status | Message |
|-----------|--------|---------|
| SHEETS_API_KEY env var not set | 503 | "API key not configured" |
| x-api-key header missing | 401 | "API key required" |
| API key does not match | 401 | "Invalid API key" |

---

### 6. errorHandler

**File**: `src/middleware/errorHandler.ts`
**Position**: Last middleware in `src/index.ts` (4-argument Express error handler)

**Signature**: `(err: Error, req: Request, res: Response, next: NextFunction) => void`

**Error mapping**:
| Error Type | Status | Message |
|-----------|--------|---------|
| Mongoose `ValidationError` | 400 | Concatenated field validation messages |
| Mongoose duplicate key (code 11000) | 409 | `"{field} already exists"` |
| Mongoose `CastError` (invalid ObjectId) | 400 | "Invalid ID format" |
| Any error with `.statusCode` property | `err.statusCode` | `err.message` |
| Anything else (production) | 500 | "Internal server error" |
| Anything else (development) | 500 | `err.message` + stack trace |

**Implementation note**: The 4-argument signature `(err, req, res, next)` is required for Express to recognize this as an error handler. Do not remove the `next` parameter even if unused.

---

### 7. notFound

**File**: `src/middleware/errorHandler.ts` (same file, different export)
**Position**: After all route handlers, before `errorHandler`

**What it does**: Catch-all for unmatched routes — returns 404.
```typescript
export const notFound = (req: Request, res: Response) => {
  sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
};
```

---

### 8. multer upload

**File**: Configured inline in `src/routes/leadRoutes.ts` — applied only to the upload route
**Position**: After `authenticate` + `checkPermission`, before the controller handler

**Configuration**:
```typescript
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  // xlsx
      "application/vnd.ms-excel",                                            // xls
      "text/csv"                                                             // csv
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only xlsx, xls, and csv are allowed."));
    }
  }
});
```

**Used on**:
```typescript
router.post("/upload",
  authenticate,
  checkPermission("leads", "create"),
  upload.single("file"),
  bulkCreateLeads
);
```

**Key**: Uses memory storage — file is available as `req.file.buffer` (never written to disk).

---

## Permission Matrix — Every Route

Complete table of all routes with their full middleware chains.

### Auth Routes (`/api/v1/auth`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| POST | `/auth/login` | (none) | — | — | Public |
| POST | `/auth/refresh` | (none) | — | — | Public |
| GET | `/auth/profile` | `authenticate` | — | — | Any authenticated user |
| PUT | `/auth/change-password` | `authenticate` | — | — | Any authenticated user |

### Lead Routes (`/api/v1/leads`)

**Important**: Routes are declared in this order — static before parameterized.

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/leads` | `authenticate`, `checkPermission` | leads | view | Users with leads:view |
| POST | `/leads` | `authenticate`, `checkPermission` | leads | create | Users with leads:create |
| GET | `/leads/reminders/mine` | `authenticate` | — | — | Any authenticated user |
| GET | `/leads/reminders/count` | `authenticate` | — | — | Any authenticated user |
| POST | `/leads/upload` | `authenticate`, `checkPermission`, `multer` | leads | create | Users with leads:create |
| POST | `/leads/auto-assign` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| GET | `/leads/:id` | `authenticate`, `checkPermission` | leads | view | Users with leads:view |
| PUT | `/leads/:id` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| DELETE | `/leads/:id` | `authenticate`, `checkPermission` | leads | delete | Users with leads:delete |
| PATCH | `/leads/:id/status` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/:id/assign` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/:id/assign-team` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/:id/transfer-team` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/:id/notes` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| PUT | `/leads/:id/notes/:noteId` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| DELETE | `/leads/:id/notes/:noteId` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/:id/reminders` | `authenticate`, `checkPermission` | reminders | create | Users with reminders:create |
| PUT | `/leads/:id/reminders/:rId` | `authenticate`, `checkPermission` | reminders | edit | Users with reminders:edit |
| DELETE | `/leads/:id/reminders/:rId` | `authenticate`, `checkPermission` | reminders | edit | Users with reminders:edit |
| PATCH | `/leads/:id/reminders/:rId/done` | `authenticate`, `checkPermission` | reminders | edit | Users with reminders:edit |
| POST | `/leads/:id/payments` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| PUT | `/leads/:id/payments/:pId` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| DELETE | `/leads/:id/payments/:pId` | `authenticate`, `checkPermission` | leads | delete | Users with leads:delete |
| POST | `/leads/bulk/status` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |
| POST | `/leads/bulk/delete` | `authenticate`, `checkPermission` | leads | delete | Users with leads:delete |
| POST | `/leads/bulk/assign-team` | `authenticate`, `checkPermission` | leads | edit | Users with leads:edit |

### Team Routes (`/api/v1/teams`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/teams` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| POST | `/teams` | `authenticate`, `checkPermission` | teams | create | Users with teams:create |
| GET | `/teams/mine` | `authenticate` | — | — | Any authenticated user |
| GET | `/teams/:id` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| PUT | `/teams/:id` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| DELETE | `/teams/:id` | `authenticate`, `checkPermission` | teams | delete | Users with teams:delete |
| GET | `/teams/:id/leads` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| GET | `/teams/:id/stats` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| GET | `/teams/:id/dashboard` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| GET | `/teams/:id/logs` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| POST | `/teams/:id/auto-assign` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| GET | `/teams/:id/updates` | `authenticate`, `checkPermission` | teams | view | Users with teams:view |
| POST | `/teams/:id/messages` | `authenticate` | — | — | Any authenticated user |
| GET | `/teams/:id/messages` | `authenticate` | — | — | Any authenticated user |
| GET | `/teams/:id/revenue` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/teams/:id/revenue/timeline` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/teams/:id/members/:memberId` | `authenticate` | — | — | Service-layer guard (team membership) |
| GET | `/teams/:id/members/:memberId/leads` | `authenticate` | — | — | Service-layer guard (team membership) |
| PATCH | `/teams/:id/members/:memberId/toggle-active` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| PATCH | `/teams/:id/leads/bulk/assign` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| PATCH | `/teams/:id/leads/bulk/transfer` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| PATCH | `/teams/:id/leads/bulk/status` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |
| PATCH | `/teams/:id/leads/:leadId/assign` | `authenticate`, `checkPermission` | teams | edit | Users with teams:edit |

### User Routes (`/api/v1/users`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/users` | `authenticate`, `checkPermission` | users | view | Users with users:view |
| POST | `/users` | `authenticate`, `checkPermission` | users | create | Users with users:create |
| GET | `/users/:id` | `authenticate`, `selfOrPermission` | users | view | Own profile OR users:view |
| PUT | `/users/:id` | `authenticate`, `checkPermission` | users | edit | Users with users:edit |
| DELETE | `/users/:id` | `authenticate`, `checkPermission` | users | delete | Users with users:delete |

### User Lead Routes (`/api/v1/users`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/users/:userId/leads` | `authenticate`, `checkPermission` | leads | view | Users with leads:view |
| GET | `/users/:userId/lead-stats` | `authenticate`, `checkPermission` | leads | view | Users with leads:view |

### Role Routes (`/api/v1/roles`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/roles` | `authenticate`, `checkPermission` | roles | view | Users with roles:view |
| GET | `/roles/simple` | `authenticate` | — | — | Any authenticated user |
| POST | `/roles` | `authenticate`, `checkPermission` | roles | create | Users with roles:create |
| GET | `/roles/:id` | `authenticate`, `checkPermission` | roles | view | Users with roles:view |
| PUT | `/roles/:id` | `authenticate`, `checkPermission` | roles | edit | Users with roles:edit |
| DELETE | `/roles/:id` | `authenticate`, `checkPermission` | roles | delete | Users with roles:delete |

**Note**: `/simple` MUST be declared before `/:id`.

### Course Routes (`/api/v1/courses`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/courses` | `authenticate`, `checkPermission` | courses | view | Users with courses:view |
| GET | `/courses/all` | `authenticate` | — | — | Any authenticated user |
| POST | `/courses` | `authenticate`, `checkPermission` | courses | create | Users with courses:create |
| GET | `/courses/:id` | `authenticate`, `checkPermission` | courses | view | Users with courses:view |
| PUT | `/courses/:id` | `authenticate`, `checkPermission` | courses | edit | Users with courses:edit |
| DELETE | `/courses/:id` | `authenticate`, `checkPermission` | courses | delete | Users with courses:delete |

**Note**: `/all` MUST be declared before `/:id`.

### Report Routes (`/api/v1/reports`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/reports/overview` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/timeline` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/user-rankings` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/team-rankings` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/team-split` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/revenue` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/revenue/timeline` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |
| GET | `/reports/revenue/teams` | `authenticate`, `checkPermission` | reports | view | Users with reports:view |

### AI Routes (`/api/v1/ai`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| POST | `/ai/chat/lead/:leadId` | `authenticate` | — | — | Any authenticated user |
| POST | `/ai/chat/team/:teamId` | `authenticate` | — | — | Any authenticated user |
| POST | `/ai/chat/report` | `authenticate` | — | — | Any authenticated user |
| GET | `/ai/memory/:leadId` | `authenticate` | — | — | Any authenticated user |
| DELETE | `/ai/memory/:leadId` | `authenticate` | — | — | Any authenticated user |

### Push Routes (`/api/v1/push`)

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| GET | `/push/vapid-public-key` | `authenticate` | — | — | Any authenticated user |
| POST | `/push/subscribe` | `authenticate` | — | — | Any authenticated user |
| DELETE | `/push/unsubscribe` | `authenticate` | — | — | Any authenticated user |

### Sheets Routes (`/api/sheets`) — NOT `/api/v1`

| Method | Path | Middleware | Module | Action | Who Can Access |
|--------|------|-----------|--------|--------|----------------|
| POST | `/sheets/sync` | `authenticateApiKey` | — | — | Google Apps Script (API key) |
| POST | `/sheets/sync/batch` | `authenticateApiKey` | — | — | Google Apps Script (API key) |

---

## Access Control — Who Can Do What

### Super Admin
- `role.isSystemRole === true` AND `role.roleName === "Super Admin"`
- **Full access to everything** — bypasses ALL `checkPermission` and `requireModule` checks
- Can view, create, edit, delete anything in the system
- Can manage roles (including system roles — but service layer still guards deletion)
- Can access all teams, all leads, all users
- Cannot be deleted (isSystemRole protection)

### Team Leader
Typical permissions: `teams:view`, `teams:edit`, `leads:view`, `leads:create`, `leads:edit`

- Can view their team's dashboard, logs, and member stats
- Can assign leads to team members
- Can run auto-assign for their team
- Can toggle member active/inactive status
- Can view and edit leads within their team
- **Cannot**: delete users, manage roles, delete teams, access reports (unless granted)
- Own profile: accessible via selfOrPermission without users:view

### Sales Agent
Typical permissions: `leads:view`, `leads:edit`, `reminders:view`, `reminders:create`, `reminders:edit`

- Can view leads assigned to them (service layer scopes based on userId if no broader leads:view)
- Can update lead status and fields
- Can add/edit/delete their own reminders
- Can post team messages (no permission needed)
- **Cannot**: create leads, delete leads, assign leads to others, view reports, manage users/roles
- Own profile: accessible via selfOrPermission without users:view

### Manager (Custom Role)
Configured per deployment. Typically:
- `leads:view`, `leads:create`, `leads:edit`, `leads:delete`
- `teams:view`
- `reports:view`
- May or may not have `users:view`, `users:create`

### Own-Record Exception (selfOrPermission)
- Applies to `GET /api/v1/users/:id` ONLY
- ANY authenticated user can view their own user record (their own `_id`)
- This is enforced by the `selfOrPermission` inline middleware in `userRoutes.ts`
- No `users:view` permission needed for own-profile access

### Team Member Routes — Service-Layer Guard
- `GET /teams/:id/members/:memberId` — no `checkPermission` middleware
- `GET /teams/:id/members/:memberId/leads` — no `checkPermission` middleware
- These are guarded in `teamService.getTeamMemberById` and `teamService.getTeamMemberLeads`
- Service checks: is the requesting user a member of this team? If not → 403
- This allows team members to see each other's profiles without needing `users:view`

### Courses/All and Roles/Simple — Open to Any Authenticated User
- `GET /courses/all` — returns all courses for dropdowns (any authenticated user)
- `GET /roles/simple` — returns all roles for dropdowns (any authenticated user)
- These endpoints return minimal data needed for form selects

---

## Modules & Actions Reference

### Modules
```
dashboard | users | roles | leads | teams | courses | reminders | reports | settings
```

### Actions
```
view | create | edit | delete | approve | export
```

### What Each Action Covers Per Module

#### `leads`
- `view` — list all leads, view individual lead details, search/filter leads
- `create` — create new lead, upload CSV/bulk import
- `edit` — update lead fields, change status, assign lead, add/edit notes, add/edit reminders, add/edit payments
- `delete` — delete a lead, bulk delete leads
- `approve` — (reserved for future approval workflow)
- `export` — export leads to CSV/Excel/PDF

#### `teams`
- `view` — list teams, view team details, view team leads, view team dashboard/stats/logs
- `create` — create new team
- `edit` — update team, add/remove members, assign leads, auto-assign, toggle member active/inactive
- `delete` — delete team
- `export` — export team data to PDF

#### `users`
- `view` — list all users, view user details (other users' profiles)
- `create` — create new user account
- `edit` — update user profile, change role, activate/deactivate
- `delete` — delete user account

#### `roles`
- `view` — list roles, view role permissions
- `create` — create new role with permissions
- `edit` — update role name or permissions
- `delete` — delete role (non-system roles only)

#### `courses`
- `view` — list courses, view course details
- `create` — create new course
- `edit` — update course details
- `delete` — delete course

#### `reminders`
- `view` — view own reminders list and count
- `create` — add a reminder to a lead
- `edit` — update or mark reminder as done, delete reminder

#### `reports`
- `view` — access analytics overview, timeline, rankings, revenue breakdown
- `export` — export reports to PDF

#### `dashboard`
- `view` — access the main dashboard page

#### `settings`
- `view` — access settings page
- `edit` — modify system settings (VAPID keys, Sheets API key, etc.)


---

### Routes added 2026-09-30 — notifications & app settings

| Method | Path | Middleware chain |
|--------|------|-----------------|
| GET | `/api/v1/notifications` | `authenticate` (own notifications only) |
| POST | `/api/v1/notifications/read-all` | `authenticate` |
| DELETE | `/api/v1/notifications` | `authenticate` |
| DELETE | `/api/v1/notifications/:id` | `authenticate` — another user's id answers 404 |
| GET | `/api/v1/settings/app` | `authenticate` → `checkPermission("settings","view")` |
| PUT | `/api/v1/settings/app` | `authenticate` → `checkPermission("settings","edit")` |
| POST | `/api/v1/settings/app/test-email` | `authenticate` → `checkPermission("settings","edit")` |

`settings.edit` now also covers the Settings page's **Automation & alerts** section.

---

### Routes added 2026-09-30 — inactive leads

| Method | Path | Middleware chain |
|--------|------|-----------------|
| GET | `/api/v1/inactive-leads` | `authenticate` → `checkPermission("inactive-leads","view")` |
| GET | `/api/v1/inactive-leads/moves` | `authenticate` → `checkPermission("inactive-leads","view")` |
| GET | `/api/v1/inactive-leads/teams` | `authenticate` → `checkPermission("inactive-leads","view")` (2026-10-15) |
| GET | `/api/v1/inactive-leads/people` | `authenticate` → `checkPermission("inactive-leads","edit")` (2026-10-15) |
| POST | `/api/v1/inactive-leads/reassign` | `authenticate` → `checkPermission("inactive-leads","edit")` |

(Since the module was added to Roles these go by the "inactive-leads" box — the table said `requireSuperAdmin` until
2026-10-15. The web page itself still opens for the Super Admin only.)

**`requireSuperAdmin`** (new, `middleware/permissions.ts`) — passes only `role.isSystemRole && role.roleName === "Super Admin"`; everyone else gets 403, including a custom role with every permission ticked. It is deliberately not a module a role can be granted.

---

### Routes added 2026-09-30 — activity

| Method | Path | Middleware chain |
|--------|------|-----------------|
| POST | `/api/v1/auth/logout` | `authenticate` — records the sign-out |
| POST | `/api/v1/activity/heartbeat` | `authenticate` (everyone reports their own) |
| GET | `/api/v1/activity/people` | `authenticate` → `requireSuperAdmin` |
| GET | `/api/v1/activity/logins` | `authenticate` → `requireSuperAdmin` |
| GET | `/api/v1/activity/idle` | `authenticate` → `requireSuperAdmin` |

`POST /auth/login` and `POST /auth/sso-login` now also record the sign-in, or the refusal (401/403 only — not validation errors or server errors).

---

### Routes added 2026-10-01 — meetings

| Method | Path | Middleware chain |
|--------|------|-----------------|
| GET | `/api/v1/meetings/calendar` | `authenticate` — own calendar; `userId` of someone else only for the Super Admin (403 otherwise) |
| GET | `/api/v1/meetings/people` | `authenticate` — active colleagues to invite |
| POST | `/api/v1/meetings/conflicts` | `authenticate` |
| POST | `/api/v1/meetings` | `authenticate` — a client (`leadId`) only if the leads rule lets the organizer see it (403) |
| GET | `/api/v1/meetings/:id` | `authenticate` — organizer, attendees or Super Admin; anyone else 404 |
| PUT | `/api/v1/meetings/:id` | `authenticate` — organizer or Super Admin (attendees 403, others 404) |
| POST | `/api/v1/meetings/:id/cancel` | same as PUT |

No module permission: booking time with colleagues is everyday work, like the mentor calendar. The frontend's dashboard layout lets `/calendar` through for every role.

---

### Changed 2026-10-01 — per-user lead routes

| Method | Path | Middleware chain |
|--------|------|-----------------|
| GET | `/api/v1/users/:userId/leads` | `authenticate` → `selfOrOverseer()` |
| GET | `/api/v1/users/:userId/lead-stats` | `authenticate` → `selfOrOverseer()` |
| GET | `/api/v1/users/:userId/revenue` | `authenticate` → `selfOrOverseer()` |
| GET | `/api/v1/users/:id/export-pdf` | `authenticate` → `selfOrOverseer("id")` (`/users/profile/export-pdf` stays self-only) |

**`selfOrOverseer(param = "userId")`** (new, `middleware/permissions.ts`) — passes for the person themselves, a Super Admin or
Reporter, a role with `users.view`, or a leader of a team that person is in; everyone else 403.

### View as (2026-10-04)

| Method | Route | Chain |
|--------|-------|-------|
| POST | `/api/v1/users/:id/impersonate` | `authenticate` → `requireSuperAdmin` → `startImpersonation` |
| POST | `/api/v1/auth/impersonation/stop` | `authenticateViewAsExit` → `stopImpersonation` (400 with an ordinary sign-in) |

`authenticate` also takes a "View as" pass (a token carrying `impersonation: { id, by }`): it checks the session record and the
admin (401 when ended, expired, mismatched, or the admin is no longer an active super admin), sets `req.user.impersonatedBy`, and
refuses anything but GET/HEAD/OPTIONS with 403 "View only…". `authenticateViewAsExit` is the same without that refusal — only the
stop route uses it. Ordinary tokens take exactly the old path.

---

## Commission routes (2026-10-04)

Not a permission module: `authenticate` only, like Mentors — a module would start every role but Super Admin with no access to their own pay. The service narrows what each person sees (own / team / all). Changing the plan or its settings is `requireSuperAdmin` (in `commissionController`): `role.isSystemRole && roleName === "Super Admin"`, else 403.

---

## Calls routes (2026-10-14)

| Method | Route | Chain |
|--------|-------|-------|
| GET | `/api/v1/calls/log` | `authenticate` → `checkPermission("calls", "view")` (`export=1` also needs `calls.export`, in the controller) |
| GET | `/api/v1/calls/log/lead/:leadId` | `authenticate` → `checkPermission("leads", "view")` (the service narrows to what the viewer may see) |
| GET | `/api/v1/calls/log/:id/recording-link` | `authenticate` (the call must be one the viewer may see) |
| GET | `/api/v1/calls/log/recording` | none — the signed 10-minute link is the permission (an `<audio>` sends no header) |
| POST | `/api/v1/calls/log/sync`, `/api/v1/calls/log/test` | `authenticate` → `requireSuperAdmin` |
| GET | `/api/v1/calls/click-to-call` | `authenticate` |
| POST | `/api/v1/calls/3cx/call` | `authenticate` → `checkPermission("leads", "edit")` (the lead must be in the caller's lead list) |
| GET / POST | `/api/v1/calls/3cx/state`, `/api/v1/calls/3cx/hang-up` | `authenticate` (the caller's own extension only) |
| GET | `/api/v1/service/calls`, `/api/v1/service/calls/:id/recording-link` | `portalOnly` (`x-portal-secret`) |

`calls` is a new permission module, open by default (view, export) — a role saved before it gets it from the schema
default; unticked on the Roles screen, 403. All `/calls/log*` and `/calls/3cx/*` routes sit before `/calls/:callId`.
