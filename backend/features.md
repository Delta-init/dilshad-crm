# Carlton CRM — Backend Features

This file documents every backend feature. Read this before implementing anything to understand scope, middleware chains, and related features.

---

## Feature Template

Each feature documents:
- **Description**: What this feature does
- **Routes**: Method, path, full middleware chain
- **Service Methods**: Which service methods are called
- **Models Used**: Which Mongoose models are read/written
- **Socket Events**: Any Socket.io events emitted
- **Related Features**: Which features interact with this one
- **Change Log**: History of changes

---

## 1. Authentication

**Description**: Login with email/password, get JWT tokens, refresh access token, view own profile, change password.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/auth/login` | (none — public) |
| POST | `/api/v1/auth/refresh` | (none — public) |
| GET | `/api/v1/auth/profile` | `authenticate` |
| PUT | `/api/v1/auth/change-password` | `authenticate` |

**Service Methods**: `authService.login`, `authService.refreshToken`, `authService.getProfile`, `authService.changePassword`

**Models Used**: `User` (read + write for password change), `Role` (read for auth middleware)

**Socket Events**: None

**Related Features**: All protected features (authenticate is the gateway), Role & Permission Management (role loaded fresh per request)

**Change Log**:
- Initial implementation — login + JWT tokens
- Added role loading in authenticate middleware (load fresh from DB, not from token)
- Added inactive user check in authenticate middleware

---

## 2. Lead Management

**Description**: Full CRUD for leads including status updates, field editing, single assignment to users/teams, and activity log tracking.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/leads` | `authenticate`, `checkPermission("leads","view")` |
| POST | `/api/v1/leads` | `authenticate`, `checkPermission("leads","create")` |
| GET | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","view")` |
| PUT | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","edit")` |
| DELETE | `/api/v1/leads/:id` | `authenticate`, `checkPermission("leads","delete")` |
| PATCH | `/api/v1/leads/:id/status` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/assign` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/assign-team` | `authenticate`, `checkPermission("leads","edit")` |
| POST | `/api/v1/leads/:id/transfer-team` | `authenticate`, `checkPermission("leads","edit")` |

**Service Methods**: `leadService.createLead`, `leadService.getLeads`, `leadService.getLead`, `leadService.updateLead`, `leadService.deleteLead`, `leadService.updateLeadStatus`, `leadService.assignLead`, `leadService.assignLeadToTeam`, `leadService.transferLeadToTeam`

**Models Used**: `Lead` (all), `User` (assignedTo populate), `Team` (team populate), `Course` (course populate)

**Socket Events**: `lead:assigned` — emitted when a lead is assigned to a user (emitted to assignee's private room)

**Related Features**: Lead Upload (#3), Lead Auto-Assignment (#4), Reminder System (#5), Payment Tracking (#6), Team Management (#7)

**Change Log**:
- Initial CRUD implementation
- Added activityLogs tracking on every mutation
- Added `lead:assigned` socket event on assignment
- Added push notification on assignment via pushService

---

## 3. Lead Upload (CSV/Excel Bulk Import)

**Description**: Upload an xlsx/csv file of leads; parse, validate, and bulk-insert. Returns count of created vs failed rows.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/upload` | `authenticate`, `checkPermission("leads","create")`, `multer.single("file")` |

**Note**: `/upload` route MUST be declared before `/:id` in the router — see mistakes.md #6.

**Service Methods**: `leadService.bulkCreateLeads`, `excelService.parseExcelBuffer`

**Models Used**: `Lead`

**Socket Events**: None

**Related Features**: Lead Management (#2), Lead Auto-Assignment (#4)

**Change Log**:
- Initial implementation with xlsx parsing
- Fixed notes field — must be array, not string (see mistakes.md #2)
- Fixed email validation — "No Email" now stored as undefined (see mistakes.md #2)
- Added `ordered: false` for partial success on insertMany
- Added result.length check to count actual failures

---

## 4. Lead Auto-Assignment (Global)

**Description**: Automatically distribute unassigned leads to team members using round-robin algorithm. Global version (not team-scoped).

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/auto-assign` | `authenticate`, `checkPermission("leads","edit")` |

**Note**: `/auto-assign` route MUST be declared before `/:id` in the router.

**Service Methods**: `leadService.autoAssignLeads`

**Models Used**: `Lead`, `Team`, `User`

**Socket Events**: `lead:assigned` — emitted per assignment to each assignee

**Related Features**: Team Auto-Assign (#8), Team Management (#7)

**Change Log**:
- Initial round-robin implementation
- Fixed populated ObjectId toString() bug (see mistakes.md #1)

---

## 5. Reminder System

**Description**: Leads can have multiple time-based reminders. Background scheduler fires socket + push notifications when reminders are due or upcoming.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/leads/reminders/mine` | `authenticate` |
| GET | `/api/v1/leads/reminders/count` | `authenticate` |
| POST | `/api/v1/leads/:id/reminders` | `authenticate`, `checkPermission("reminders","create")` |
| PUT | `/api/v1/leads/:id/reminders/:reminderId` | `authenticate`, `checkPermission("reminders","edit")` |
| DELETE | `/api/v1/leads/:id/reminders/:reminderId` | `authenticate`, `checkPermission("reminders","edit")` |

**Note**: `/reminders/mine` and `/reminders/count` MUST be declared before `/:id` — static before parameterized.

**Service Methods**: `leadService.getMyReminders`, `leadService.getMyReminderCount`, `leadService.addReminder`, `leadService.updateReminder`, `leadService.deleteReminder`

**Background**: `reminderScheduler.ts` — runs every 30s via `setInterval`

**Models Used**: `Lead` (reminders embedded array)

**Socket Events**:
- `reminder:due` — emitted by scheduler when reminder passes due time
- `reminder:warning` — emitted by scheduler when reminder is 1-31 minutes away

**Related Features**: Lead Management (#2) — reminders are embedded in leads; Push Notifications (#15)

**Change Log**:
- Initial reminder CRUD
- Added scheduler with two-pass notification system
- Fixed arrayFilters bug — must include `_id` match (see mistakes.md #5)
- Added push notification alongside socket event

---

## 6. Payment Tracking

**Description**: Per-lead payment recording. Each lead can have multiple payment records (amount, mode, date, note).

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/leads/:id/payments` | `authenticate`, `checkPermission("leads","edit")` |
| PUT | `/api/v1/leads/:id/payments/:paymentId` | `authenticate`, `checkPermission("leads","edit")` |
| DELETE | `/api/v1/leads/:id/payments/:paymentId` | `authenticate`, `checkPermission("leads","delete")` |

**Service Methods**: `leadService.addPayment`, `leadService.updatePayment`, `leadService.deletePayment`

**Models Used**: `Lead` (payments embedded array)

**Socket Events**: None

**Related Features**: Reports & Analytics (#13) — revenue reports aggregate from payment records; Team Management (#7) — team revenue uses these records

**Change Log**:
- Initial payment CRUD implementation

---

## 7. Team Management

**Description**: Full CRUD for teams, member management, team lead lists, team dashboard, activity logs.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams` | `authenticate`, `checkPermission("teams","view")` |
| POST | `/api/v1/teams` | `authenticate`, `checkPermission("teams","create")` |
| GET | `/api/v1/teams/mine` | `authenticate` |
| GET | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","view")` |
| PUT | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","edit")` |
| DELETE | `/api/v1/teams/:id` | `authenticate`, `checkPermission("teams","delete")` |
| GET | `/api/v1/teams/:id/leads` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/stats` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/dashboard` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/logs` | `authenticate`, `checkPermission("teams","view")` |
| GET | `/api/v1/teams/:id/revenue` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/teams/:id/revenue/timeline` | `authenticate`, `checkPermission("reports","view")` |

**Note**: `/mine` MUST be declared before `/:id` — static before parameterized (see mistakes.md #6).

**Service Methods**: `teamService.createTeam`, `teamService.getTeams`, `teamService.getTeamByMember`, `teamService.getTeamById`, `teamService.updateTeam`, `teamService.deleteTeam`, `teamService.getTeamLeads`, `teamService.getTeamMemberStats`, `teamService.getTeamDashboard`, `teamService.getTeamLogs`, `teamService.getTeamRevenue`, `teamService.getTeamRevenueTimeline`

**Models Used**: `Team`, `Lead`, `User`

**Socket Events**: None for basic CRUD

**Related Features**: Team Auto-Assign (#8), Team Activity Feed + Chat (#9), Reports (#13)

**Change Log**:
- Initial team CRUD
- Added `/mine` route for team leaders to see their own team
- Added revenue endpoints
- Added dashboard endpoint

---

## 8. Team Auto-Assign

**Description**: Distribute unassigned team leads to active (non-leader, non-inactive) members using round-robin algorithm.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/teams/:id/auto-assign` | `authenticate`, `checkPermission("teams","edit")` |
| POST | `/api/v1/teams/:id/members/:memberId/assign` | `authenticate`, `checkPermission("teams","edit")` |
| PATCH | `/api/v1/teams/:id/members/:memberId/toggle-active` | `authenticate`, `checkPermission("teams","edit")` |

**Service Methods**: `teamService.autoAssignTeamLeads`, `teamService.assignLeadToMember`, `teamService.toggleMemberActive`

**Models Used**: `Team`, `Lead`

**Socket Events**: `lead:assigned` — emitted per assignment

**Related Features**: Lead Management (#2), Team Management (#7)

**Change Log**:
- Initial round-robin implementation
- Fixed populated ObjectId toString() bug on inactiveMembers (see mistakes.md #1)
- Added toggleMemberActive with `$addToSet`/`$pull`

---

## 9. Team Activity Feed + Chat

**Description**: Team-scoped activity feed showing recent lead changes, plus a real-time team chat.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams/:id/updates` | `authenticate`, `checkPermission("teams","view")` |
| POST | `/api/v1/teams/:id/messages` | `authenticate` |
| GET | `/api/v1/teams/:id/messages` | `authenticate` |

**Service Methods**: `teamService.getTeamUpdates`, `teamService.postTeamMessage`

**Models Used**: `Team`, `TeamMessage`, `Lead` (for activity feed)

**Socket Events**: `team:update` — emitted to `team:{teamId}` room when new message or activity occurs

**Related Features**: Team Management (#7)

**Change Log**:
- Initial team messages implementation
- Added socket emission on new message

---

## 10. User Management

**Description**: Admin CRUD for users. Any authenticated user can view their own profile via selfOrPermission.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/users` | `authenticate`, `checkPermission("users","view")` |
| POST | `/api/v1/users` | `authenticate`, `checkPermission("users","create")` |
| GET | `/api/v1/users/:id` | `authenticate`, `selfOrPermission` |
| PUT | `/api/v1/users/:id` | `authenticate`, `checkPermission("users","edit")` |
| DELETE | `/api/v1/users/:id` | `authenticate`, `checkPermission("users","delete")` |

**Service Methods**: `userService.createUser`, `userService.getUsers`, `userService.getUserById`, `userService.updateUser`, `userService.deleteUser`

**Models Used**: `User`, `Role`

**Socket Events**: None

**Related Features**: Authentication (#1) — same User model; Role & Permission Management (#11)

**Change Log**:
- Initial implementation
- Added selfOrPermission for own-profile access without users:view
- Fixed `/mine` route shadowing — selfOrPermission handles own profile

---

## 11. Role & Permission Management

**Description**: Admin management of roles and their permission sets.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/roles` | `authenticate`, `checkPermission("roles","view")` |
| GET | `/api/v1/roles/simple` | `authenticate` |
| POST | `/api/v1/roles` | `authenticate`, `checkPermission("roles","create")` |
| GET | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","view")` |
| PUT | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","edit")` |
| DELETE | `/api/v1/roles/:id` | `authenticate`, `checkPermission("roles","delete")` |

**Note**: `/simple` MUST be declared before `/:id`.

**Service Methods**: `roleService.createRole`, `roleService.getRoles`, `roleService.getRolesSimple`, `roleService.getRoleById`, `roleService.updateRole`, `roleService.deleteRole`

**Models Used**: `Role`, `User` (check before delete)

**Socket Events**: None

**Related Features**: Authentication (#1) — roles are loaded fresh on every request; User Management (#10) — users are assigned roles

**Change Log**:
- Initial implementation
- Added guard: cannot delete role if users assigned to it
- Added guard: cannot delete or modify system roles

---

## 12. Course Management

**Description**: CRUD for the course catalog. Courses are referenced by leads.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/courses` | `authenticate`, `checkPermission("courses","view")` |
| GET | `/api/v1/courses/all` | `authenticate` |
| POST | `/api/v1/courses` | `authenticate`, `checkPermission("courses","create")` |
| GET | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","view")` |
| PUT | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","edit")` |
| DELETE | `/api/v1/courses/:id` | `authenticate`, `checkPermission("courses","delete")` |

**Note**: `/all` MUST be declared before `/:id`.

**Service Methods**: `courseService.createCourse`, `courseService.getCourses`, `courseService.getAllCourses`, `courseService.getCourseById`, `courseService.updateCourse`, `courseService.deleteCourse`

**Models Used**: `Course`

**Socket Events**: None

**Related Features**: Lead Management (#2) — leads reference courses

**Change Log**:
- Initial implementation
- 2026-10-04 — Courses map to a finance product and **several LMS courses** (like Draw's): `GET /api/v1/courses/lms-courses`
  (`authenticate`, `checkPermission("leads","edit")`, before `/:id`) lists the LMS's published courses; `POST` / `PUT
  /api/v1/courses(/:id)` take `financeItemId` ("" unmaps) and `lmsCourseSlugs` (≤ 10, in order, [] unmaps; the first is kept
  as `lmsCourseSlug`). The finance handover sends `lmsCourseSlug` + `lmsCourseSlugs`.

---

## 13. Reports & Analytics

**Description**: Aggregated analytics — lead overview, timeline charts, user/team rankings, revenue breakdown.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/reports/overview` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/timeline` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/user-rankings` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/team-rankings` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/team-split` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue/timeline` | `authenticate`, `checkPermission("reports","view")` |
| GET | `/api/v1/reports/revenue/teams` | `authenticate`, `checkPermission("reports","view")` |

**Service Methods**: `reportService.getOverview`, `reportService.getTimeline`, `reportService.getUserRankings`, `reportService.getTeamRankings`, `reportService.getTeamSplit`, `reportService.getRevenueOverview`, `reportService.getRevenueTimeline`, `reportService.getRevenueTeams`

**Models Used**: `Lead`, `Team`, `User` (via aggregation pipelines)

**Socket Events**: None

**Related Features**: Payment Tracking (#6) — revenue reports read payment data; Team Management (#7)

**Change Log**:
- Initial overview + timeline implementation
- Added user and team rankings
- Added revenue endpoints
- Added team split chart endpoint

---

## 14. AI Chat Assistant

**Description**: Claude AI assistant with context-aware conversations (lead, team, report contexts). Conversation memory persisted per user+context.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/v1/ai/chat/lead/:leadId` | `authenticate` |
| POST | `/api/v1/ai/chat/team/:teamId` | `authenticate` |
| POST | `/api/v1/ai/chat/report` | `authenticate` |
| GET | `/api/v1/ai/memory/:leadId` | `authenticate` |
| DELETE | `/api/v1/ai/memory/:leadId` | `authenticate` |

**Service Methods**: AI logic in `aiController.ts` (or dedicated aiService)

**Models Used**: `AiMemory`, `Lead`, `Team`

**Socket Events**: None (streaming not implemented — request/response)

**Related Features**: Lead Management (#2) — lead context reads lead data; Team Management (#7)

**Change Log**:
- Initial implementation with lead context
- Added team context
- Added report context
- Added memory CRUD (view + delete conversation)

---

## 15. Push Notifications

**Description**: Web Push (VAPID) notification delivery. Users subscribe their browser and receive push notifications for lead assignments and reminders.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/push/vapid-public-key` | `authenticate` |
| POST | `/api/v1/push/subscribe` | `authenticate` |
| DELETE | `/api/v1/push/unsubscribe` | `authenticate` |

**Service Methods**: `pushService.getVapidPublicKey`, `pushService.subscribePush`, `pushService.unsubscribePush`

**Models Used**: `PushSubscription`

**Socket Events**: None (Push is separate transport from Socket.io)

**Related Features**: Reminder System (#5) — scheduler calls pushService for reminder notifications; Lead Management (#2) — assignment calls pushService

**Change Log**:
- Initial VAPID implementation
- Added auto-cleanup of expired subscriptions (delete on 410 response)

---

## 16. Google Sheets Sync

**Description**: API key authenticated endpoint for Google Apps Script to push lead data from Google Sheets into the CRM. Supports single and batch upsert.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| POST | `/api/sheets/sync` | `authenticateApiKey` |
| POST | `/api/sheets/sync/batch` | `authenticateApiKey` |

**Note**: These routes are under `/api/sheets/` (NOT `/api/v1/`) to keep them simple for Apps Script integration.

**Service Methods**: Implemented inline in `sheetsController.ts` or a dedicated `sheetsService.ts`

**Models Used**: `Lead`, `Course` (name lookup)

**Socket Events**: None

**Related Features**: Lead Management (#2) — creates/updates the same Lead documents

**Change Log**:
- Initial single row sync
- Added batch endpoint
- Added authenticateApiKey middleware

---

## 17. PDF Export

**Description**: Export team or user lead data as a PDF document.

**Routes**:
| Method | Path | Middleware Chain |
|--------|------|-----------------|
| GET | `/api/v1/teams/:id/export/pdf` | `authenticate`, `checkPermission("reports","export")` |
| GET | `/api/v1/users/:id/export/pdf` | `authenticate`, `checkPermission("reports","export")` |

**Service Methods**: PDF generation logic (uses a PDF library such as `pdfkit` or `puppeteer`)

**Models Used**: `Lead`, `Team`, `User`

**Socket Events**: None

**Related Features**: Team Management (#7), User Management (#10), Reports (#13)

**Change Log**:
- Initial PDF export for teams
- Added user-scoped PDF export
- 2026-10-01 — team PDF: the lead model's current statuses (+ Other when one is stored that the model doesn't list),
  landscape, the period as Dubai days, 400 on a malformed date. The user PDF is unchanged.
- 2026-10-01 — team PDF: Meeting Scheduled and Wrong Number columns; its member table's headers are 6.5pt so thirteen
  status columns stay on one line.


---

## 18. Notifications, email & app settings (Phase 1 foundations, 2026-09-30)

**Description**: The groundwork for inactive leads, idle alerts and meetings — a kept notification per person, one `notify()` that sends in-app + push + email, an SMTP mailer that logs instead of sending until configured, and one app-wide settings document.

**Routes**: see middlewareHistory.md → "Routes added 2026-09-30".

**Service Methods**: `mailService.sendMail/renderEmail/isMailConfigured`, `notificationService.notify/toNotificationDTO`, `settingsService.getAppSettings/updateAppSettings/isWithinWorkingHours`

**Models Used**: `Notification` (60-day TTL), `AppSetting` (single document, `key: "app"`), `User`

**Socket Events**: `notification` — unchanged name; stored notices now include `id`.

**Change Log**:
- 1.0.0 — Initial build (dependency: `nodemailer`)

---

## 19. Inactive leads (Phase 2, 2026-09-30)

**Description**: A lead is *inactive* when its status is still new/assigned and its owner has not changed the status, added a note, logged a follow-up or a call, or set a reminder within the limit set in Settings (default 45 min), counting working time only. The super admin sees them on the **Inactive leads** page and moves them on by hand; with Settings → Automation & alerts → "Move leads nobody acted on" switched on, a scheduler moves them every minute in working hours — to the next person by the team's split rule, never back to anyone who lost that lead before.

**Routes**: see middlewareHistory.md → "Routes added 2026-09-30 — inactive leads".

**Service Methods**: `inactiveLeadService.listInactiveLeads / listLeadMoves / reassignInactiveLeads / sweepInactiveLeads`; `leadService.pickSplitAssignee / runInTeamQueue` (split rule shared with new leads); `utils/workingHours.workingMinutesBetween / workingCutoff / startOfLocalDay`

**Models Used**: `Lead` (new `inactivity` sub-document, `inactive_reassigned` activity), `LeadMove` (the move log), `AppSetting` (`inactiveLeads.enabledAt`), `Team`, `User`, `Role`, `CallLog`, `Notification`

**Scheduler**: `inactiveLeadScheduler` — every 60 s, only when `RUN_SCHEDULERS` is on and the switch is on.

**Socket Events**: `notification` (types `inactive_lead_moved`, `lead_assigned`, `inactive_leads_moved`, `inactive_leads_stuck`); `team:update` activity item `inactive_reassigned`.

**Change Log**:
- 1.0.0 — Initial build. Automatic moves only for leads assigned after the switch went on (`enabledAt`).
- 1.1.0 (2026-10-15) — fixes found bringing it to the Sales CRM:
  - "acted" is the owner's alone: a colleague's call (the Call button sets the contact date for anyone) no longer
    counts; the owner's calls straight from 3CX (`LeadCall`, by its person — out answered or not, in when picked
    up) now do; an inbound call nobody answered at their extension doesn't;
  - a lead handed back to the person who first added it counts like any other (timed from `originalCreatedAt`);
  - a lead worked, closed or moved while its move is on its way is left alone (every move and stuck flag is written
    under `stillInactive`; the lead is checked again in the team's queue, so a lost race spends nobody's turn);
  - the 2,000 cap counts after the calls are checked, so leads their owners phoned can't hide newer ones;
  - the page's own `GET /inactive-leads/teams` and `/people` lists; settings: read without stamping "last saved",
    saving nothing writes nothing, time zones by name, two half-saves of the hours can't cross; a notice whose lead
    name is very long is cut to fit instead of being lost. `scripts/inactive-leads-check.sh` — 271 checks.

---

## 20. Sign-ins, activity & idle alerts (Phase 3, 2026-09-30)

**Description**: Every sign-in, refused sign-in (with the reason) and sign-out is recorded with IP and device. The web app sends a heartbeat every minute it is open, saying whether anyone used it — which gives last seen, last active and active minutes per day. With Settings → Automation & alerts → "Send idle alerts" on, anyone who used the app today, hasn't signed out and has done nothing in it for the limit (working time) gets one alert per quiet stretch, as do the super admins (and their team leaders, if switched on). Super admins are not tracked. The super admin's **Activity** page shows it all.

**Routes**: see middlewareHistory.md → "Routes added 2026-09-30 — activity".

**Service Methods**: `activityService.recordLogin / recordLoginFailure / recordLogout / recordHeartbeat / listPeople / listLoginEvents / listIdleStretches / sweepIdleUsers`; `notificationService.superAdminIds`; `utils/requestMeta.clientIp / describeDevice`; `utils/workingHours.localDayKey / formatMinutes`

**Models Used**: `LoginEvent`, `UserPresence` (one per user), `ActivityDay` (per user per day), `IdleStretch` — the last three kept a year (TTL); plus `User`, `Team`, `AppSetting`, `Notification`

**Scheduler**: `idleAlertScheduler` — every 60 s, only when `RUN_SCHEDULERS` is on and idle alerts are switched on.

**Socket Events**: `notification` types `idle_self`, `idle_alert` (see socketHistory.md).

**Change Log**:
- 1.0.0 — Initial build. Tokens are still not revoked on sign-out (stateless JWT); the sign-out is recorded and the app drops its copy.

---

## 21. Meetings & calendars (Phase 4, 2026-10-01)

**Description**: Anyone signed in books meetings with colleagues (and the super admin), optionally a client — a lead they can see — and mentors from the LMS. The organizer (or a super admin) changes or cancels them; a busy check warns (never blocks) when a colleague has another meeting then, or a mentor has an LMS class/meeting or no free slot. Everyone involved is told: employees in the app, by push and by email; the client and mentors by email — all with a calendar invite (.ics), updated or cancelled as the meeting changes. A reminder goes out before the start. Each person's calendar shows their meetings, follow-ups and reminders; the super admin can open anyone's.

**Routes**: see middlewareHistory.md → "Routes added 2026-10-01 — meetings".

**Service Methods**: `meetingService.createMeeting / updateMeeting / cancelMeeting / getMeeting / calendarFor / findConflicts / listColleagues / sweepMeetingReminders`; `utils/ics.buildIcs`; `mailService.sendMail({ icalEvent })`; `notify({ email: { invite } })`

**Models Used**: `Meeting`; `User`, `Lead`, `Team`, `Notification`; the LMS via `mentorService.schedule`

**Scheduler**: `meetingReminderScheduler` — every 60 s (`RUN_SCHEDULERS`).

**Change Log**:
- 1.0.0 — Initial build. Mentors are invited by email; their LMS diary is not booked (that stays on the Mentors page).

## 22. View as — a super admin sees the CRM as someone else (2026-10-04)

**Description**: A super admin opens the CRM as any active user who is not a super admin, for 30 minutes, read only: every page answers exactly as it does for that person, every change is refused ("View only…"), and nothing counts as their activity (no heartbeat, sign-in or sign-out in their name). "Back to my account", the time running out, or the session ending on the server takes the admin back to their own account.

**Routes**: see middlewareHistory.md → "View as (2026-10-04)".

**Service Methods**: `impersonationService.start / stop`; `checkImpersonation` in `middleware/auth.ts`; `utils/jwt.signImpersonationToken`.

**Models Used**: `Impersonation` (new — the session: admin, target, IP, device, start, expiry, end; kept a year); `User`, `Role`.

**Change Log**:
- 1.0.0 — Initial build. No screen lists past sessions yet (they are in the `impersonations` collection).

---

## 23. A course's bonus (2026-10-04)

**Description**: Each course can carry the bonus a client gets with it (`bonusAmount`, in the course's currency; 0 for none), set when the course is created or edited on the Courses page. A new close starts from it — "Bonus given?" answered yes with the course's bonus — and the seller can change it, or say no, for a sale that differs. An enrolment being edited keeps what it has. The same in all three sales CRMs (Delta, Remote, Draw).

**Routes**: `POST /api/v1/courses` and `PUT /api/v1/courses/:id` accept `bonusAmount` (a number ≥ 0); every course read returns it, and the lead reads (`GET /api/v1/leads`, `GET /api/v1/leads/:id`) now populate it on the lead's course.

**Model**: `Course.bonusAmount: number` (default 0; a course from before reads as none).

**Tests**: `scripts/course-bonus-e2e.sh` — throwaway mongod, no `.env`; the four cases.

**Change Log**: 2026-10-04 — added (the owner: "bonus adding option in the course create and edit").

---

## Commission (2026-10-04)

**Description**: A commission plan per course — Sales Staff / TL / SM in AED per approved sale, and the MT5 credit (USD) the course comes with — and what each sale finance approves earns. Recorded once, when the finance worker sees the enrolment approved, with the plan of that day; counted in the month the sale was made (UAE time). TL_RULE "always": the leader of the sale's team (or the closer's one team) is paid TL — also when he is the Sales Manager, so one person earns both TL and SM; a TL or SM who closes earns Sales Staff too. A team with no leader or two, or a closer in no team, holds the sale until fixed. Shared logins (settings) earn nobody anything; a voided invoice reverses the sale.

**Routes** (`authenticate` only — everyone sees their own; the service narrows it): `GET /api/v1/commission/plan`, `GET /api/v1/commission/earnings?month=YYYY-MM` (own / team / all), `GET /api/v1/commission/preview?course=&team=&closer=` (for the closing dialog, nothing saved); Super Admin only: `PUT /api/v1/commission/plan/:courseId` `{ sales, tl, sm, creditUsd }`, `PUT /api/v1/commission/settings` `{ salesManager, excludedUsers }`.

**Models**: `Course.commission`, `CommissionSettings` (`commissionsettings`, key "default"), `CommissionSale` (`commissionsales`, one per student), `FinanceHandover.approvedAt` / `commissionAt`.

**Tests**: `scripts/commission-check.sh` — throwaway mongod, no `.env`, a stand-in for finance; rules, scoping, preview and the API's refusals (follows TL_RULE).

**Change Log**: 2026-10-04 — added (the owner: commission per portal from the "Course Commission Plans" image; Sales Manager dilshad; excluded logins test (test@crm.com), super admin (superadmin@crm.com)).

---

## An enrolment's five steps — and commission only once they're done (2026-10-04)

**Description**: After the close every enrolment shows five steps — Finance approved → LMS account → CS assigned (Tetra Commission) → Onboarded (welcome sent) → MT5 bonus approved by a broker admin (approved by itself when no bonus was promised) — green done, yellow waiting, red stopped, grey not known / not needed (a course Tetra Commission doesn't take skips 3–5). Commission counts only once all are done, for sales closed from 1 October 2026 (UAE), in the month closed; until then the sale is "progress", saying which step it waits on.

**Routes**: `GET /api/v1/students/enrolments/mine` rows carry `steps`; `GET /api/v1/students/enrolments/:id` (`authenticate` → `checkPermission("enrolments", "view")`, before `/:id`) — the enrolment's own page: steps with who/when, and its commission (own lines; all for a Super Admin or the Sales Manager); the closer, or anyone with students:view.

**Services**: `enrolmentSteps.stepsOf / allDone / waitingOn`; `commissionService.trackSales` (every two minutes) replaces recording at approval.

**Tests**: `scripts/commission-check.sh` — the steps, one at a time; no bonus; not Forex; Tetra Commission silent; counted early under the old rule; void; finance down; the enrolment endpoint.

**Change Log**: 2026-10-04 — added (the owner: "finance approved => lms created account => commission portal get cs => onboarded => mt5 bonus approved, then only they get the commission").

## Split payments at the close — and nothing collected above the fee (2026-10-05)

**Description**: A client may pay in more than one way — 300 in cash and 200 by card on a 500 fee — and each payment has its
own method, amount and receipt. A close sends `payments[]`; they must add up to `paidAmount`, and what was collected may never
be more than the fee, on a close or on an edit that changes the money. Finance gets every payment with its receipt and records
them against the invoice when it approves.

**Routes**: `POST /api/v1/students` (unchanged route; takes `payments`), `PUT /api/v1/students/:id` (refuses an edit that leaves
paid above the fee).

**Service Methods**: `checkedPayments`, `assertNotOverFee` in `studentService.ts`; `buildHandoverPayload` sends `payments`.

**Models Used**: `Student.payments` (new: method, amount, receipt, paidAt, collectedBefore).

**Tests**: `scripts/split-payments-check.sh` — 27 checks in the four cases.

**Change Log**:
- 1.0.0 — Initial build. An older screen (one method, one receipt) still closes.

## Currency at the close (2026-10-05)

**Description**: A payment taken at the close can be in another currency than AED (the owner, 2026-10-05): the seller picks the
currency, types the amount in it and the rate (1 of it = so many AED), and the AED figure is worked out (or typed, and the rate
worked out). The AED figure is what counts — paid, balance, fee status, the over-the-fee block, commission — and finance gets it
with what was handed over beside it.

**Routes**: unchanged — `POST /api/v1/students` takes `currency`, `amountInCurrency`, `exchangeRate` on each payment.

**Service Methods**: `studentService.checkedPayments` (→ `foreignPart`), `buildHandoverPayload` (each payment's `original`).

**Models Used**: `Student.payments[]` gains `currency`, `amountInCurrency`, `exchangeRate`.

**Change Log**:
- 1.0.0 — Initial build. The 11 currencies of the app's currency setting; AED (`BASE_CURRENCY`) is the base.

## Notifications for sheet leads, test notifications, and VAPID key changes (2026-10-05)

**Description**: New-lead notifications weren't reaching people (the user, 2026-10-05).
- A sheet lead given straight to somebody (`assigned_to` — as when Root's split names one person) now tells them at
  once, on the website (the live connection) and on their devices: one alert per lead, or one per batch with the
  count. It used to tell nobody; only the team split notified.
- `POST /api/v1/push/test` (as in the Sales CRM): a test notification to every device the signed-in person enabled,
  only them — "Sent to 2 of 3 devices"; 409 when nothing is enabled yet, 429 within 10 seconds of the last test.
- `sendPushToUser` returns `{ devices, delivered }`, logs a failed send, and drops a device registered with another
  VAPID key (403 — as after the keys are changed) as it drops a gone one (404/410). The website registers the device
  again with the current key when it is next opened.

**Tests**: `scripts/push-test-check.sh` — 20 checks in six cases (web-push's send replaced by a stand-in; a real
socket.io connection for the website side).

**Change Log**:
- 1.0.0 — Initial build, ported from the Sales CRM.

## Correcting a sent-back enrolment, and "sent again" (2026-10-05)

**Description**: As in the Sales CRM. When finance sends an enrolment back, everything the close took can be corrected —
the client's name, phone and email, the course, the date, the fee, each payment with its receipt (one paid in another
currency with what was handed over and its rate, checked against the AED as at the close), the language, the bonus and
the notes; whoever may edit students can also move it to another counsellor or team — and saving sends it to finance
again in the same step, as the same invoice with the same number (the user: "if send it back we can edit the course and
amount also, all details"). Only while finance has it sent back. The closer corrects their own; anyone who may edit
students, or a super admin, any.

The money the lead holds of its own stays a payment of its own, at what it comes to now; the close's "Collected at
enrolment" payments on the lead are replaced by the corrected ones (a foreign one's note says what was handed over).

Sent again — corrected, or with "Send again" — is recorded on the outbox row (`resentAt`, `resends`) and shown: "Sent
again 5 Oct, 3:42 pm — on its way to finance", then "— waiting for accounts to approve it" (the user: "if send again
show that also"). "Send again" goes out at once.

**Routes** (`authenticate`, `enrolments:edit`): `GET /api/v1/students/:id/correction`, `PUT /api/v1/students/:id/correction`
(`{ name, phone, email, course, team?, assignedTo?, enrollmentDate, feeStatus, totalFee, paidAmount, notes, language,
payments[] (each may carry currency, amountInCurrency, exchangeRate), hasBonus, bonusAmount }`).
`POST /students/receipts/:leadId` also takes `enrolments:edit`.

**Service Methods**: `StudentService.getCorrection`, `correctEnrolment`, `sendBackOf`, `resendCorrected`;
`enrolmentSteps.stepsOf` (sent again); `middleware/permissions.checkAnyPermission`.

**Models Used**: `FinanceHandover.resentAt` / `resends` (new), `Student`, `Lead.payments`, `Course`, `Team`, `User`.

**Tests**: `scripts/enrolment-correction-check.sh` — 65 checks against a stand-in finance, a payment in INR among them.

## Academy at the close — Dubai / Bangalore (2026-10-10)

**Description**: A close is for the Dubai academy (as every close was) or the Bangalore one. Bangalore is billed in its own
finance organization (`FINANCE_ORG_ID_BANGALORE`) in INR: the fee is the course's Bangalore price, the finance item its
Bangalore item, the LMS courses its Bangalore ones (Dubai's when none set); payments are rupees, or cash in AED with its rate
(INR per AED) sent as finance's `original`. The money already on the lead is AED, so on a Bangalore close it is that, with its
rate. The academy and its organization are fixed at the close — on the student and on the outbox row — and every later call
(delivery and retries, resend, correction, decision poll, My Enrolments, the enrolment page, the send-back check, commission
lookups) goes to that organization; status calls are grouped per organization. Refused at the close: a course with no Bangalore
price, and no Bangalore organization set (even with finance switched off). `GET /students/close-options` says `academies`
(["dubai","bangalore"] only when FINANCE_ORG_ID_BANGALORE is set) and the dialog offers the choice only when Bangalore is
listed — an older API lists nothing, so a newer screen never closes for Bangalore there. A correction cannot change the academy. The bonus stays USD;
commission and salary unchanged. A Bangalore close puts only its AED cash on the lead's (AED) payment list.

**Routes**: `GET /students/close-options` (new, any signed-in user) → `{ academies }`; `POST /students` takes `academy`; `PUT /courses/:id` takes `bangalore: { price, financeItemId,
lmsCourseSlugs }`; `GET /courses/finance-items?academy=bangalore` lists the Bangalore organization's catalogue.

**Service Methods**: `financeOrgs.orgOfHandover` / `orgsOf` / `fetchStatusesByOrg`, `financeClient.financeOrgOf` /
`academiesOffered`, `studentService.assertBangaloreClose`, `foreignPart(…, base)`, `leadPaymentOf`.

**Models Used**: `Student.academy`, `FinanceHandover.academy` + `financeOrgId`, `Course.bangalore`.

**Change Log**:
- 1.0.0 — Initial build. Enrolments from before have no academy and are Dubai.

## The client's email at the close — and closes that went without one (2026-10-10)

**Description**: Finance's intake (`inboundEnrolmentSchema`, `customer.email` a valid email) refuses an enrolment without
the client's email — "Request validation failed", permanent, so the row sat `failed` and nobody closing the lead saw it
(1 here on 2026-10-10; 21 in the Sales CRM, fixed the same way). As Draw's close already does:

- **Checked as finance checks it**: zod's email check (`z.email()`, zod 4 — the same pattern as finance's zod 3
  `z.string().email()`), at the close, at a correction, when an email is added, and for the flag below — so `a@b.c`, which
  only looks like an address, is refused here rather than by finance.
- **At the close** every close needs a valid client email. Refused with the rest of
  what is missing — "A closing needs the client's email, … Give the client's email, upload the receipt, …" — nothing saved.
  Kept lower case on the enrolment and on the lead when the lead had none that works (an invalid one counts as none), with
  an activity entry ("Email added at the close: …", by who closed it); a lead's own email is never replaced from the close.
  The dialog asks for it when the lead has none.
- **A close already refused for it** — the correction can't reach these (finance never had them to send back): `POST
  /students/:id/enrolment/email { email }` checks the email the same way, writes it on the enrolment, on the lead (where it
  had none, "Email added for finance: …") and into the queued payload (`payload.customer.email` — nothing else of the
  snapshot), resets the row (`pending`, attempts 0, `nextAttemptAt` now, `lastError` cleared) and kicks the worker: it goes
  at once as the same enrolment (same `externalId`) to the organization stored on the row at the close. Only for a row not
  delivered whose payload email is missing or not one — refused by finance's check, or still waiting to go; 409 for one
  finance has (`sent`), one failed for another reason, or no row; 422 for an email that isn't one. Not counted as a resend
  after a send-back.
- **Shown**: `handover.needsClientEmail` on My Enrolments and the enrolment page, `needsClientEmail` + `deliveryStatus` on
  `GET /students/:id/correction` (the student page) — true for a row not delivered, refused with "Request validation
  failed", whose payload email is missing or one finance's check refuses. Beside it `suggestedEmail`: the enrolment's email
  if finance would take it, else the lead's (people add it to the lead by hand), else "" — it only fills the field in;
  nothing is sent until somebody presses the button. Its finance step reads "Couldn't be sent to finance — the client's
  email is missing; add it and send again".
- **"Send again" / "Generate invoice"** (`POST /students/:id/invoice`) on such a close: 409 "Finance refused this enrolment
  because it went without the client's email — add the client's email first, and it goes to finance again at once." —
  sent as it is, it would only be refused again. Unchanged for one held up by anything else.

**Routes**: `POST /students` (`email` required) — the closer is passed for the lead's activity; `POST
/students/:id/enrolment/email` (new; `authenticate`, `enrolments:edit`, then the closer their own / `students:edit` or
super admin any — the correction's guard) → `{ queued, email }`.

**Service Methods**: `StudentService.createStudent(data, performedBy)`, `keepEmailOnLead`, `addEnrolmentEmail`,
`suggestedEmailFor`, `requestInvoice` (the guard); `isFinanceEmail`, `refusedForEmail`, `emailCanBeAdded`, `suggestedEmailOf`,
`stepError`, `payloadEmail` (module helpers).

**Models Used**: `Student.email`, `Lead.email` + `activityLogs`, `FinanceHandover.payload.customer.email` / `status` /
`attempts` / `nextAttemptAt` / `lastError` / `financeOrgId`.

**Tests**: `scripts/split-payments-check.sh` Case 6 (the close: refused without one — `a@b.c` too — nothing saved; kept on
the enrolment and the lead with its activity entry; a lead's own never replaced, one that isn't an email is) — 65 checks;
`scripts/enrolment-correction-check.sh` Case 10 (a stand-in finance that refuses an email as finance's check does; add-email
→ delivered with it, same externalId, the rest of the payload as refused, to Dubai's / to Bangalore's stored organization
after the setting changed; refused for a sent row, an invalid email or `a@b.c`, a row failed for another reason, no row,
another BDE, a role without enrolments, not signed in; "Send again" refused until the email is added, still there for one
failed otherwise; `suggestedEmail` — none, the lead's added by hand, the enrolment's first — never sent by itself) and a
correction with `a@b.c` refused — 134 checks; `scripts/closing-fields-check.sh` — 44 checks (now runs with `bun
--no-env-file`).

**Change Log**:
- 1.0.0 — Initial build. The stuck close(s) are fixed from the screens once this is deployed.

## One email, one client — an email another client holds is refused (2026-10-10)

**Description**: Finance knows a customer by the email alone (`findOrCreateCustomer`, per organization), so every close is
filed under the customer its email already belongs to. Here 4 different students were closed with one address (23 leads
carry it) and finance filed all four invoices under the first; a correction keeping it would have renamed that customer.
An email (trimmed, lower-cased, exact) is now **taken** for a client when another record here holds it and is a different
person — another student (not this one, nor a student of this same lead) or another lead (not this one). Different person:
both phones known (7+ digits) and their last 9 digits differ; with a phone missing, the names differ (case and spaces
aside); with neither to go on, not known to differ. The same phone is the same person — a second course is ordinary.
Refused with 409, naming the holder and never a phone: "This email is already used by mohammed lebbie (STU-0021), a
different client — enter Halif's own email." (a lead: "Rahul K (a lead)"; one with no name: "another lead"). At:

- **The close** (`POST /students`) — after the missing-fields check, before anything is saved; the client is the close's
  name/phone, else the lead's. A lead whose own email is taken is closed with the client's own; the lead keeps its email
  (nothing is cleaned: `keepEmailOnLead` only fills one in where there is none).
- **The correction** (`PUT /students/:id/correction`) — the client as corrected — and **"Send again"** on a sent-back close
  (`POST /students/:id/invoice`, which resends it as it stands): the same words + "Correct the enrolment to change it, and
  it goes again."
- **The added email** (`POST /students/:id/enrolment/email`) — after the row checks. `suggestedEmail` never suggests a
  taken email.
- **`GET /students/email-check?email=&leadId=` or `&studentId=`** (new; `authenticate`, `students:create` or
  `enrolments:edit`) — for the client of that lead (the close) or enrolment (correction, add-email): `{ ok: true }` or
  `{ ok: false, takenBy: { name, code?, kind: "student" | "lead" }, message }`; 422 for an email finance won't take or no
  id, 404 for an unknown one. Only a help: the server refuses regardless.

Not covered: "Generate invoice" for an enrolment never queued, retries of a queued row's snapshot, and the student edit
(`PUT /students/:id`).

**Report** (read only): `scripts/shared-emails-report.ts` — every email finance would take that 2+ different people hold
across leads and students: masked (`na***@gmail.com`), records (students, leads), people, and each record (kind, name, code
or lead id, status) — never a phone. Loads no models (no index built), `autoIndex`/`autoCreate` off, reads only; takes
`--json` and nothing else. From `backend/`:
`MONGODB_URI='mongodb+srv://USER:PASS@HOST/DB' bun --no-env-file run scripts/shared-emails-report.ts [--json]`.

**Service Methods**: `findEmailHolder` (`services/emailHolder.ts`), `StudentService.checkClientEmail`; `utils/clientEmail.ts`
— `isFinanceEmail` (moved there), `emailKey`, `phoneKey`, `nameKey`, `differentPeople`, `emailMatch`, `maskEmail`,
`takenMessage`.

**Tests**: `scripts/closing-fields-check.sh` — 81 checks (was 44): 23 leads + 4 students on one email, another lead, the same
client's second course, no phone → names, a junk phone, another case/spaces in storage, the dialog's check, and the report
(groups, masking, no phones, refuses `--write` / no `MONGODB_URI`, database unchanged). `scripts/split-payments-check.sh` —
86 (was 65): Case 7, the close and `GET /students/email-check` through the API (401/403/422/404).
`scripts/enrolment-correction-check.sh` — 154 (was 134): Case 11, Halif's case — the correction keeping the shared email,
one a lead holds, "Send again": refused, nothing changed or sent; corrected with his own → delivered as the same enrolment;
the same client's other email allowed; the added email refused for a taken one; `suggestedEmail` never a taken one. The
three runners stop only the mongod they started (its pid file) — `mongod --shutdown` is Linux only.

**Change Log**:
- 1.0.0 — Initial build. Existing leads' emails are left as they are.

## Calls from 3CX — brought over from the Draw CRM (2026-10-14)

**What it does**: The Calls page lists only calls with leads through 3CX, read from 3CX's call log every minute (90 days
back the first time): when, in or out, connected / missed / not answered, who took it, talk and ring time, and the
recordings (played from 3CX through the server). Totals, a per-person table, filters (Dubai days: today / 7 days / 30 days
/ this month / custom; direction; result; salesperson; lead name or number), sorting, paging and a CSV. A lead's page
shows its calls the same way. The Super Admin has Sync now and Test connection. Extensions are filled from 3CX by email;
one typed on the Users screen wins. The old click-to-call / journal logs (`call_logs`) stay in the database and on the QC
screens; Inactive Leads still reads them.

Every Call button asks "3CX call" (3CX rings the caller's own 3CX app / web client, then dials the lead; a call window
follows it and can hang up) or "Phone call". After a call started here, "How did the call go?": connected yes / no, the
next status with what this CRM asks for it (Follow Up: what happened, and the next follow-up if any — on a lead already in
Follow Up, one more follow-up; Meeting Scheduled: when; Call Back: a reminder if wanted; Lost: one of its reasons and
notes; Closed through the enrolment dialog), and notes saved as a lead note.

A lead's call counts (calls, connected, not connected) come from 3CX and are no longer typed by hand: the lead page's
+ / − counters are gone. On the first sync after deploy the counts kept before (the old Call button's clicks and the
+ / −) are copied into `lead_call_counts_before_3cx`, then replaced by 3CX's — a lead with none from 3CX goes to 0.
Pressing Call still stamps the lead's last contacted / last follow-up dates, and the first contact on the owner's first
call, as before. The Leaderboard's calls are 3CX's (calls, connected, talk time), rankable by calls or talk time. The
Root portal can read every call (`GET /service/calls`).

**Routes**: `/api/v1/calls/log*`, `/calls/click-to-call`, `/calls/3cx/*` (middlewareHistory "Calls routes"),
`GET /leaderboard?rankBy=`, `GET /service/calls`, `GET /service/calls/:id/recording-link`.

**Env**: `THREECX_URL`, `THREECX_CLIENT_ID`, `THREECX_API_KEY` (all three, or no sync and no 3CX calls);
`RUN_SCHEDULERS`.

**Models Used**: `LeadCall` (`lead_calls`, new), `User.extensionSource` (new), `Lead.callConnected` (new), `Lead`,
`Team`, `CommissionSettings`, `CallLog`, `app_settings` (`_id: "threecx_calls"`), `lead_call_counts_before_3cx` (new).

**Tests**: `scripts/calls-check.sh` (210 checks, stand-in 3CX, scratch mongod), `scripts/portal-calls-check.sh` (20).

## The open leaderboard — a TV board, live (2026-10-15)

**What it does**: The leaderboard without signing in, for a TV on the wall or a phone — as the Bangalore CRM's public
link, and the same as the Sales CRM's. Every salesperson's month (Dubai months): revenue, closings, follow-ups logged,
3CX calls / connected / talk time (`lead_calls`, by the call's person), today's calls and talk
time, and the leads each holds now by status; ranked by revenue, calls or talk time. Talk-time targets: 1,000 minutes a
month, 100 a day. No emails, nothing else about anyone. The Super Admins and the commission plan's excluded people are
not on it (as on the signed-in board, which now shows the same new figures).

Live: a screen joins the socket's `/public-leaderboard` namespace (no sign-in). While any screen is there the board is
counted again every 5 seconds while a count is quick — less often when it isn't (counting takes at most about a
twentieth of the time; never more than a minute apart); when anything on it changes, every screen is told
`leaderboard:changed` (the month and when — no names, no figures) and fetches the board again, answered from that same
count in any ranking. A screen is also told once as it joins. The watch goes on 15 s after the last screen leaves (a
TV reloading comes straight back), and only one count of it runs at a time however often screens come and go. One
screen per connection, 200 at most; one more is turned away and keeps its refresh. A lead with no status counts as
"unknown".

**Routes**:
- `GET /api/v1/public/leaderboard?month=YYYY-MM&rankBy=revenue|calls|talk` — no sign-in; no month = this Dubai
  month; a bad month (1900-01 to next month — a TV clock a little ahead at midnight) or rank → 400. This month, while watched live: the watcher's count.
  Otherwise kept 15 s, the same ask counted once, two counted at a time — 503 "busy, try again" past 100 waiting.
- `GET /api/v1/leaderboard` (signed in, `leaderboard:view`) — the same rows (now with today's calls and the leads by
  status), counted fresh.

**Socket**: namespace `/public-leaderboard` — server → screen `leaderboard:changed` `{ month, at }`; screens send
nothing (anything sent is ignored).

**Models Used**: `Lead` (payments, follow-ups, status by owner), `Student` (closings), `LeadCall`,
`User`, `Role`, `CommissionSettings` (`excludedUsers`).

**Tests**: `scripts/leaderboard-check.sh` — 67 checks (scratch mongod; the live line in Case 5, with raw WebSocket
screens and a pile of joins in one polling request; the open door's limits in Case 6).

## Currency on the person's account (2026-10-15)

**What it does**: The currency someone picks to see amounts in (Settings → Currency — the symbol and number format;
nothing is converted) is kept on their account, so it follows them to every device they sign in on. Never picked: none
(the app's default, USD).

**Routes**: `GET /api/v1/auth/preferences` → `{ currency, currencyAt }` (null when never picked);
`PUT /api/v1/auth/preferences` `{ currency, pickedAgoMs? }` — one of USD, INR, EUR, GBP, AED, SAR, CAD, AUD, SGD,
JPY, MYR (`utils/currencies.ts`, the web's list); anything else → 400. The newest pick wins by when it was picked — this
server's time, less `pickedAgoMs` for a pick sent late (the app was offline), measured on the device's own clock so a
clock set wrong doesn't matter: not kept over a newer one, and the answer says what is (`applied`). Signed in, their own only. A View-as pass reads it but can't change it. `GET /auth/profile` carries it too.

**Models Used**: `User` (`currency`, `currencyAt`, new, default null).

**Tests**: `scripts/preferences-check.sh` — 29 checks (scratch mongod).
