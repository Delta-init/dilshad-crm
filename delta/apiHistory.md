# 🌐 API History & Reference — Carlton CRM Frontend

> Complete map of every API endpoint used in this app.
> For each endpoint: which hook calls it, which components use that hook, which pages render those components.
> **Update this file whenever a new API call is added.**

---

## How to Use

- **Before adding a new API call**: check if a hook already exists for it
- **After adding**: add the endpoint entry here
- **Tracing a bug**: find the endpoint → trace to hook → trace to component → trace to page

---

## Base URL

All endpoints are prefixed: `http://localhost:7868/api/v1/`
Axios instance: `frontend/lib/axios.ts` — auto-attaches `Authorization: Bearer <token>`

---

## 📋 Entry Template

```
### METHOD /path/to/endpoint
- **Hook**: `useXxx()` in `hooks/useXxx.ts`
- **Query Key**: `["key"]` (for GET) or `—` (for mutations)
- **Auth Required**: Yes | No
- **Permission**: module:action

**Request**:
- Params / Body fields

**Response**: `{ success, data: T, message }`

**Used By**:
| Component | Page |
|-----------|------|
| `ComponentName` | `/app/(dashboard)/route/page.tsx` |

**Notes**: any gotchas
```

---

## 🔐 Auth

---

### POST /auth/login
- **Hook**: `useLogin()` in `hooks/useAuth.ts`
- **Query Key**: — (mutation)
- **Auth Required**: No

**Request Body**:
```json
{ "email": "string", "password": "string" }
```

**Response**:
```json
{ "data": { "user": User, "accessToken": "string", "refreshToken": "string" } }
```

**Used By**:
| Component | Page |
|-----------|------|
| `components/auth/LoginForm.tsx` | `app/(auth)/login/page.tsx` |

**Notes**:
- On success: stores tokens via `useAuthStore`, redirects to `/dashboard`
- Refresh token stored in localStorage (`refreshToken` key)

---

### POST /auth/refresh
- **Hook**: called directly in `lib/axios.ts` interceptor
- **Auth Required**: No (uses refresh token)

**Request Body**: `{ "refreshToken": "string" }`

**Response**: `{ "data": { "accessToken": "string" } }`

**Used By**: Axios interceptor — auto-called on 401 responses

---

## 👥 Leads

---

### GET /leads
- **Hook**: `useLeads(filters?)` in `hooks/useLeads.ts`
- **Query Key**: `["leads", filters]`
- **Auth Required**: Yes
- **Permission**: `leads:view`

**Query Params**:
| Param | Type | Description |
|---|---|---|
| `page` | number | Page number |
| `limit` | number | Items per page |
| `status` | string | Lead status filter |
| `assignedTo` | string | User ID |
| `team` | string | Team ID |
| `reporter` | string | Reporter user ID |
| `search` | string | Name / phone search |
| `course` | string | Course ID |
| `dateFrom` | string | ISO date |
| `dateTo` | string | ISO date |

**Response**: `{ "data": Lead[], "pagination": { page, limit, total, totalPages } }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` (direct) | `app/(dashboard)/leads/page.tsx` |
| `components/leads/LeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### GET /leads/:id
- **Hook**: `useLead(id)` in `hooks/useLeads.ts`
- **Query Key**: `["leads", id]`
- **Auth Required**: Yes
- **Permission**: `leads:view`

**Response**: `{ "data": Lead }` — includes `notes[]`, `reminders[]`, `payments[]`, `activityLogs[]` populated

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/[leadId]/page.tsx` (direct) | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `components/leads/ReminderPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `components/leads/PaymentPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `components/leads/AiChatPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### POST /leads
- **Hook**: `useCreateLead()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`
- **Auth Required**: Yes
- **Permission**: `leads:create`

**Request Body**: `CreateLeadFormValues` (name, phone, email?, course?, notes?, team?, etc.)

**Response**: `{ "data": Lead }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/LeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PUT /leads/:id
- **Hook**: `useUpdateLead()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", id]`, `["teams"]`
- **Auth Required**: Yes
- **Permission**: `leads:edit`

**Request Body**: `UpdateLeadFormValues` (partial lead fields)

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/LeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |
| `app/(dashboard)/leads/[leadId]/page.tsx` (direct edit) | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### DELETE /leads/:id
- **Hook**: `useDeleteLead()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`
- **Auth Required**: Yes
- **Permission**: `leads:delete`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/DeleteLeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PATCH /leads/:id/status
- **Hook**: `useUpdateLeadStatus()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", id]`, `["teams"]`
- **Auth Required**: Yes
- **Permission**: `leads:edit`

**Request Body**: `{ "status": "new|assigned|followup|closed|rejected|cnc|booking|partialbooking|interested" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` (status dropdown) | `app/(dashboard)/leads/page.tsx` |
| `app/(dashboard)/leads/[leadId]/page.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### PATCH /leads/:id/assign
- **Hook**: `useAssignLead()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", id]`
- **Auth Required**: Yes
- **Permission**: `leads:edit`

**Request Body**: `{ "userId": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/AssignLeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PATCH /leads/:id/team
- **Hook**: `useAssignLeadToTeam()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", id]`, `["teams"]`
- **Auth Required**: Yes
- **Permission**: `leads:edit`

**Request Body**: `{ "teamId": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/AssignLeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PATCH /leads/:id/transfer
- **Hook**: `useTransferLeadToTeam()` in `hooks/useLeads.ts` / `useTransferLead(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["leads"]`, `["teams"]`
- **Auth Required**: Yes

**Request Body**: `{ "teamId": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### POST /leads/upload
- **Hook**: `useUploadLeads()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`
- **Auth Required**: Yes
- **Permission**: `leads:create`

**Request**: `multipart/form-data`
- `file` — CSV/XLSX file (required)
- `teamIds` — JSON string of team ID array, e.g. `'["teamId1","teamId2"]'`
- `memberOverrides` — JSON string of `Record<string, string[]>`, maps teamId → selected member IDs, e.g. `'{"teamId1":["userId1","userId2"]}'`

**Response**: `{ "data": { "total": number, "created": number, "assigned": number, "invalid": number, "invalidRows": InvalidRow[] } }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/upload/page.tsx` (direct) | `app/(dashboard)/leads/upload/page.tsx` |

**Notes**:
- `memberOverrides` controls which team members participate in auto-split for this specific upload
- Empty override array `[]` for a team → falls back to team's saved `includedMembers`
- Malformed `memberOverrides` JSON is silently ignored (server tries JSON.parse, catches error)
- BDE users see only their own team and only themselves in the member selector
- `notes` field must be array `[{ content, author }]` — not a plain object (see `mistakes.md`)
- `"No Email"` and invalid emails should be sent as `undefined`

---

### POST /leads/auto-assign
- **Hook**: `useAutoAssignLeads()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`
- **Auth Required**: Yes

**Request Body**: `{ "leadIds"?: string[] }` (optional — omit to assign all unassigned)

**Response**: `{ "data": { "assigned": number } }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PATCH /leads/bulk/status
- **Hook**: `useBulkUpdateLeadStatus()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["teams"]`

**Request Body**: `{ "leadIds": string[], "status": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### DELETE /leads/bulk
- **Hook**: `useBulkDeleteLeads()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["teams"]`

**Request Body**: `{ "leadIds": string[] }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### PATCH /leads/bulk/team
- **Hook**: `useBulkAssignLeadsToTeam()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["teams"]`

**Request Body**: `{ "leadIds": string[], "teamId": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/page.tsx` | `app/(dashboard)/leads/page.tsx` |

---

## 📝 Lead Notes

---

### POST /leads/:leadId/notes
- **Hook**: `useAddLeadNote()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", leadId]`
- **Auth Required**: Yes

**Request Body**: `{ "content": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/[leadId]/page.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### PUT /leads/:leadId/notes/:noteId
- **Hook**: `useUpdateLeadNote()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", leadId]`

**Request Body**: `{ "content": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/[leadId]/page.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### DELETE /leads/:leadId/notes/:noteId
- **Hook**: `useDeleteLeadNote()` in `hooks/useLeads.ts`
- **Query Key**: invalidates `["leads"]`, `["leads", leadId]`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/leads/[leadId]/page.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

## 🔔 Reminders

---

### GET /leads/reminders/mine
- **Hook**: `useMyReminders()` in `hooks/useReminders.ts`
- **Query Key**: `["reminders"]`
- **Auth Required**: Yes
- **Polling**: every 60s (`refetchInterval: 60_000`)

**Response**: `{ "data": ReminderWithLead[] }` — reminders with populated `lead.name`

**Used By**:
| Component | Page |
|-----------|------|
| `hooks/useReminderNotifications.ts` | Used in dashboard layout |
| `components/notifications/NotificationBell.tsx` | All dashboard pages (via Header) |
| `app/(dashboard)/reminders/page.tsx` (direct) | `app/(dashboard)/reminders/page.tsx` |

---

### GET /leads/reminders/count
- **Hook**: `useMyReminderCount()` in `hooks/useReminders.ts`
- **Query Key**: `["reminders", "count"]`
- **Auth Required**: Yes
- **Polling**: every 60s

**Response**: `{ "data": { "count": number } }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/notifications/NotificationBell.tsx` | All dashboard pages (via Header) |

---

### POST /leads/:leadId/reminders
- **Hook**: `useAddReminder(leadId)` in `hooks/useReminders.ts`
- **Query Key**: invalidates `["leads", leadId]`, `["reminders"]`
- **Auth Required**: Yes

**Request Body**: `{ "title"?: string, "note"?: string, "remindAt": string }` — ISO 8601 string parsed as IST

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/ReminderPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reminders/page.tsx` (inline form) | `app/(dashboard)/reminders/page.tsx` |

**Notes**: `remindAt` must be sent as IST — use `new Date(\`${datetimeLocal}:00+05:30\`).toISOString()`

---

### PUT /leads/:leadId/reminders/:reminderId
- **Hook**: `useUpdateReminder(leadId)` in `hooks/useReminders.ts`
- **Query Key**: invalidates `["leads", leadId]`, `["reminders"]`

**Request Body**: `{ "title"?: string, "note"?: string, "remindAt"?: string, "isDone"?: boolean }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/ReminderPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reminders/page.tsx` | `app/(dashboard)/reminders/page.tsx` |

---

### DELETE /leads/:leadId/reminders/:reminderId
- **Hook**: `useDeleteReminder(leadId)` in `hooks/useReminders.ts`
- **Query Key**: invalidates `["leads", leadId]`, `["reminders"]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/ReminderPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reminders/page.tsx` | `app/(dashboard)/reminders/page.tsx` |

---

## 💳 Payments

---

### POST /leads/:leadId/payments
- **Hook**: `useAddPayment(leadId)` in `hooks/usePayments.ts`
- **Query Key**: invalidates `["leads", leadId]`
- **Auth Required**: Yes

**Request Body**: `{ "amount": number, "note"?: string, "paidAt": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/PaymentPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### PUT /leads/:leadId/payments/:paymentId
- **Hook**: `useUpdatePayment(leadId)` in `hooks/usePayments.ts`
- **Query Key**: invalidates `["leads", leadId]`

**Request Body**: `{ "amount"?: number, "note"?: string, "paidAt"?: string }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/PaymentPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

### DELETE /leads/:leadId/payments/:paymentId
- **Hook**: `useDeletePayment(leadId)` in `hooks/usePayments.ts`
- **Query Key**: invalidates `["leads", leadId]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/PaymentPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |

---

## 👨‍👩‍👧 Teams

---

### GET /teams/mine
- **Hook**: `useMyTeam()` in `hooks/useTeams.ts`
- **Query Key**: `["teams", "mine"]`
- **Auth Required**: Yes
- **Stale Time**: 60s

**Response**: `{ "data": Team | null }` — the team the current user belongs to

**Used By**:
| Component | Page |
|-----------|------|
| `components/layout/Sidebar.tsx` | All dashboard pages |
| `app/(dashboard)/layout.tsx` | All dashboard pages |

---

### GET /teams
- **Hook**: `useTeams(filters?)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", filters]`
- **Auth Required**: Yes
- **Permission**: `teams:view`

**Query Params**: `page`, `limit`, `status`, `search`

**Response**: `{ "data": Team[], "pagination": {...} }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/page.tsx` (direct) | `app/(dashboard)/teams/page.tsx` |
| `components/leads/LeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |
| `components/leads/AssignLeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |
| `components/teams/TeamDialog.tsx` | `app/(dashboard)/teams/page.tsx` |

---

### GET /teams/:id
- **Hook**: `useTeam(id)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", id]`
- **Auth Required**: Yes
- **Permission**: `teams:view`

**Response**: `{ "data": Team }` — includes `members[]`, `leaders[]`, `inactiveMembers[]` populated

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` (direct) | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### POST /teams
- **Hook**: `useCreateTeam()` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`
- **Auth Required**: Yes
- **Permission**: `teams:create`

**Request Body**: `{ "name": string, "description"?: string, "leaders"?: string[], "members"?: string[], "status"?: "active"|"inactive" }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/teams/TeamDialog.tsx` | `app/(dashboard)/teams/page.tsx` |

---

### PUT /teams/:id
- **Hook**: `useUpdateTeam()` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["teams", id]`
- **Auth Required**: Yes
- **Permission**: `teams:edit`

**Used By**:
| Component | Page |
|-----------|------|
| `components/teams/TeamDialog.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### DELETE /teams/:id
- **Hook**: `useDeleteTeam()` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`
- **Auth Required**: Yes
- **Permission**: `teams:delete`

**Used By**:
| Component | Page |
|-----------|------|
| `components/teams/DeleteTeamDialog.tsx` | `app/(dashboard)/teams/page.tsx` |

---

### POST /teams/:id/auto-assign
- **Hook**: `useAutoAssignTeamLeads(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["leads"]`
- **Auth Required**: Yes

**Request Body**: `{ "leadIds"?: string[] }` (optional — auto-picks unassigned if omitted)

**Response**: `{ "data": { "assigned": number, "assignments": [...] } }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

**Notes**: Excludes team leader and `inactiveMembers`; distributes round-robin by current load

---

### GET /teams/:id/leads
- **Hook**: `useTeamLeads(teamId, filters?)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "leads", filters]`
- **Auth Required**: Yes

**Query Params**: `page`, `limit`, `status`, `assignedTo`, `reporter`, `search`, `dateFrom`, `dateTo`, `unassignedOnly`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/member-stats
- **Hook**: `useTeamMemberStats(teamId)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "member-stats"]`

**Response**: `{ "data": TeamMemberStat[] }` — per-member lead count breakdown

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/dashboard
- **Hook**: `useTeamDashboard(teamId)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "dashboard"]`

**Response**: `{ "data": TeamDashboard }` — aggregated team stats

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/logs
- **Hook**: `useTeamLogs(teamId, page?)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "logs", page]`

**Response**: `{ "data": TeamLog[], "pagination": {...} }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/updates
- **Hook**: `useTeamUpdates(teamId, filters?)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "updates", ...]`
- **Polling**: every 30s (`refetchInterval: 30_000`)

**Query Params**: `page`, `limit`, `dateFrom`, `dateTo`, `memberId`, `search`, `action`

**Response**: `{ "data": TeamUpdateItem[], "pagination": {...} }` — combined activity + chat messages

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### POST /teams/:id/messages
- **Hook**: `usePostTeamMessage(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams", teamId, "updates"]`

**Request Body**: `{ "content": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### PATCH /teams/:id/members/:memberId/toggle-active
- **Hook**: `useToggleMemberActive(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams", teamId]`, `["teams", teamId, "dashboard"]`

**Response**: `{ "data": { "memberId": string, "isActive": boolean } }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

**Notes**: Toggles whether member receives auto-assigned leads. When inactive → excluded from round-robin.

---

### PATCH /teams/:id/leads/:leadId/assign
- **Hook**: `useAssignLeadToMember(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["leads"]`

**Request Body**: `{ "memberId": "string" }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### PATCH /teams/:id/leads/bulk/assign
- **Hook**: `useBulkAssignTeamLeadsToMember(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["leads"]`

**Request Body**: `{ "leadIds": string[], "memberId": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### PATCH /teams/:id/leads/bulk/transfer
- **Hook**: `useBulkTransferTeamLeads(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["leads"]`

**Request Body**: `{ "leadIds": string[], "newTeamId": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### PATCH /teams/:id/leads/bulk/status
- **Hook**: `useBulkUpdateTeamLeadsStatus(teamId)` in `hooks/useTeams.ts`
- **Query Key**: invalidates `["teams"]`, `["leads"]`

**Request Body**: `{ "leadIds": string[], "status": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/members/:memberId
- **Hook**: `useTeamMember(teamId, memberId)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "members", memberId]`
- **Auth Required**: Yes (accessible by team leaders without `users:view` permission)

**Response**: `{ "data": { member, team, isLeader, stats } }` — full member profile + lead stats

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx` | `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx` |

---

### GET /teams/:id/members/:memberId/leads
- **Hook**: `useTeamMemberLeads(teamId, memberId, filters?)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "members", memberId, "leads", filters]`

**Query Params**: `page`, `limit`, `status`, `search`, `dateFrom`, `dateTo`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx` | `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx` |

---

### GET /teams/:id/revenue
- **Hook**: `useTeamRevenue(teamId, dateFrom, dateTo)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "revenue", dateFrom, dateTo]`
- **Stale Time**: 60s

**Response**: `{ "data": TeamRevenueOverview }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### GET /teams/:id/revenue/timeline
- **Hook**: `useTeamRevenueTimeline(teamId, period, dateFrom, dateTo)` in `hooks/useTeams.ts`
- **Query Key**: `["teams", teamId, "revenue", "timeline", period, dateFrom, dateTo]`
- **Stale Time**: 60s

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

## 👤 Users

---

### GET /users
- **Hook**: `useUsers(params?)` in `hooks/useUsers.ts`
- **Query Key**: `["users", params]`
- **Auth Required**: Yes
- **Permission**: `users:view`

**Query Params**: `page`, `limit`, `search`, `role`, `status`

**Response**: `{ "data": User[], "pagination": {...} }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/users/page.tsx` (direct) | `app/(dashboard)/users/page.tsx` |
| `components/teams/TeamDialog.tsx` | `app/(dashboard)/teams/page.tsx` |

---

### GET /users/:id
- **Hook**: `useUser(id)` in `hooks/useUsers.ts`
- **Query Key**: `["users", id]`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/users/[userId]/page.tsx` (direct) | `app/(dashboard)/users/[userId]/page.tsx` |

---

### GET /users/:id/leads
- **Hook**: `useUserLeads(userId, filters?)` in `hooks/useLeads.ts`
- **Query Key**: `["leads", "user", userId, filters]`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/users/[userId]/page.tsx` | `app/(dashboard)/users/[userId]/page.tsx` |

---

### GET /users/:id/lead-stats
- **Hook**: `useUserLeadStats(userId)` in `hooks/useLeads.ts`
- **Query Key**: `["leads", "stats", userId]`

**Response**: `{ "data": LeadStats }` — lead count per status for this user

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/users/[userId]/page.tsx` | `app/(dashboard)/users/[userId]/page.tsx` |

---

### POST /users
- **Hook**: `useCreateUser()` in `hooks/useUsers.ts`
- **Query Key**: invalidates `["users"]`
- **Auth Required**: Yes
- **Permission**: `users:create`

**Request Body**: `CreateUserFormValues` (name, email, password, roleId, designation?)

**Used By**:
| Component | Page |
|-----------|------|
| `components/users/UserDialog.tsx` | `app/(dashboard)/users/page.tsx` |

---

### PUT /users/:id
- **Hook**: `useUpdateUser()` in `hooks/useUsers.ts`
- **Query Key**: invalidates `["users"]`
- **Auth Required**: Yes
- **Permission**: `users:edit`

**Used By**:
| Component | Page |
|-----------|------|
| `components/users/UserDialog.tsx` | `app/(dashboard)/users/page.tsx` |
| `app/(dashboard)/users/[userId]/page.tsx` | `app/(dashboard)/users/[userId]/page.tsx` |

---

### DELETE /users/:id
- **Hook**: `useDeleteUser()` in `hooks/useUsers.ts`
- **Query Key**: invalidates `["users"]`
- **Auth Required**: Yes
- **Permission**: `users:delete`

**Used By**:
| Component | Page |
|-----------|------|
| `components/users/DeleteUserDialog.tsx` | `app/(dashboard)/users/page.tsx` |

---

## 🔑 Roles

---

### GET /roles
- **Hook**: `useRoles(params?)` in `hooks/useRoles.ts`
- **Query Key**: `["roles", params]`
- **Auth Required**: Yes
- **Permission**: `roles:view`

**Response**: `{ "data": Role[], "pagination": {...} }`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/roles/page.tsx` (direct) | `app/(dashboard)/roles/page.tsx` |

---

### GET /roles/all
- **Hook**: `useRolesSimple()` in `hooks/useRoles.ts`
- **Query Key**: `["roles", "simple"]`
- **Stale Time**: 5 minutes

**Response**: `{ "data": RoleSimple[] }` — lightweight `{ _id, roleName }` for dropdowns

**Used By**:
| Component | Page |
|-----------|------|
| `components/users/UserDialog.tsx` | `app/(dashboard)/users/page.tsx` |
| `app/(dashboard)/profile/page.tsx` | `app/(dashboard)/profile/page.tsx` |

---

### GET /roles/:id
- **Hook**: `useRole(id)` in `hooks/useRoles.ts`
- **Query Key**: `["roles", id]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/roles/RoleDialog.tsx` | `app/(dashboard)/roles/page.tsx` |

---

### POST /roles
- **Hook**: `useCreateRole()` in `hooks/useRoles.ts`
- **Query Key**: invalidates `["roles"]`
- **Permission**: `roles:create`

**Request Body**: `CreateRoleFormValues` (roleName, permissions: `{ module, actions[] }[]`)

**Used By**:
| Component | Page |
|-----------|------|
| `components/roles/RoleDialog.tsx` | `app/(dashboard)/roles/page.tsx` |

---

### PUT /roles/:id
- **Hook**: `useUpdateRole()` in `hooks/useRoles.ts`
- **Query Key**: invalidates `["roles"]`
- **Permission**: `roles:edit`

**Used By**:
| Component | Page |
|-----------|------|
| `components/roles/RoleDialog.tsx` | `app/(dashboard)/roles/page.tsx` |

---

### DELETE /roles/:id
- **Hook**: `useDeleteRole()` in `hooks/useRoles.ts`
- **Query Key**: invalidates `["roles"]`
- **Permission**: `roles:delete`

**Used By**:
| Component | Page |
|-----------|------|
| `components/roles/DeleteRoleDialog.tsx` | `app/(dashboard)/roles/page.tsx` |

---

## 📚 Courses

---

### GET /courses
- **Hook**: `useCourses(filters?)` in `hooks/useCourses.ts`
- **Query Key**: `["courses", filters]`
- **Auth Required**: Yes

**Query Params**: `page`, `limit`, `status`, `search`

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/courses/page.tsx` (direct) | `app/(dashboard)/courses/page.tsx` |

---

### GET /courses/all
- **Hook**: `useAllCourses()` in `hooks/useCourses.ts`
- **Query Key**: `["courses", "all"]`

**Response**: `{ "data": Course[] }` — all active courses, for dropdowns

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/LeadDialog.tsx` | `app/(dashboard)/leads/page.tsx` |

---

### GET /courses/:id
- **Hook**: `useCourse(id)` in `hooks/useCourses.ts`
- **Query Key**: `["courses", id]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/courses/CourseDialog.tsx` | `app/(dashboard)/courses/page.tsx` |

---

### POST /courses
- **Hook**: `useCreateCourse()` in `hooks/useCourses.ts`
- **Query Key**: invalidates `["courses"]`

**Request Body**: `{ "name": string, "description"?: string, "amount": number, "status"?: string }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/courses/CourseDialog.tsx` | `app/(dashboard)/courses/page.tsx` |

---

### PUT /courses/:id
- **Hook**: `useUpdateCourse()` in `hooks/useCourses.ts`
- **Query Key**: invalidates `["courses"]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/courses/CourseDialog.tsx` | `app/(dashboard)/courses/page.tsx` |

---

### DELETE /courses/:id
- **Hook**: `useDeleteCourse()` in `hooks/useCourses.ts`
- **Query Key**: invalidates `["courses"]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/courses/DeleteCourseDialog.tsx` | `app/(dashboard)/courses/page.tsx` |

---

## 📈 Reports

---

### GET /reports/overview
- **Hook**: `useReportOverview(dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "overview", dateFrom, dateTo]`
- **Stale Time**: 60s

**Response**: `{ "data": OverviewReport }` — total leads, by-status counts, conversion rate

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/timeline
- **Hook**: `useReportTimeline(period, dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "timeline", period, dateFrom, dateTo]`

**Query Params**: `period` (`"day"|"week"|"month"`), `dateFrom`, `dateTo`

**Response**: `{ "data": TimelinePoint[] }` — date + count array for charting

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/users
- **Hook**: `useReportUserRankings(dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "users", dateFrom, dateTo]`

**Response**: `{ "data": UserRankItem[] }` — users ranked by lead closure count

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/teams
- **Hook**: `useReportTeamRankings(dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "teams", dateFrom, dateTo]`

**Response**: `{ "data": TeamRankItem[] }` — teams ranked by performance

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/team-split
- **Hook**: `useReportTeamSplit(period, dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "team-split", period, dateFrom, dateTo]`

**Response**: `{ "data": TeamSplitReport }` — per-team lead distribution breakdown

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/revenue/overview
- **Hook**: `useRevenueOverview(dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "revenue", "overview", dateFrom, dateTo]`

**Response**: `{ "data": RevenueOverview }` — total revenue, bookings count

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/revenue/timeline
- **Hook**: `useRevenueTimeline(period, dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "revenue", "timeline", period, dateFrom, dateTo]`

**Response**: `{ "data": RevenueTimelineReport }` — revenue over time, for charting

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

### GET /reports/revenue/teams
- **Hook**: `useRevenueTeams(dateFrom, dateTo)` in `hooks/useReports.ts`
- **Query Key**: `["reports", "revenue", "teams", dateFrom, dateTo]`

**Response**: `{ "data": RevenueTeamDetail[] }` — revenue breakdown per team with member detail

**Used By**:
| Component | Page |
|-----------|------|
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

## 🤖 AI Chat

---

### GET /ai/memory/:contextType/:contextId
- **Hook**: `useAiMemory(contextType, contextId)` in `hooks/useAiChat.ts`
- **Query Key**: `["ai-memory", contextType, contextId]`
- **Auth Required**: Yes

**Context Types**: `"lead"`, `"team"`, `"report"`

**Response**: `{ "data": { "messages": AiMessage[] } }` — full conversation history

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/AiChatPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reports/page.tsx` (AI report assistant) | `app/(dashboard)/reports/page.tsx` |
| `app/(dashboard)/teams/[teamId]/page.tsx` (team AI) | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### POST /ai/chat/:contextType/:contextId
- **Hook**: `useAiChat(contextType, contextId)` in `hooks/useAiChat.ts`
- **Query Key**: updates `["ai-memory", contextType, contextId]` directly via `setQueryData`
- **Special URL**: for `report` context → `POST /ai/chat/report`

**Request Body**: `{ "message": "string" }`

**Response**: `{ "data": { "reply": string, "messages": AiMessage[] } }`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/AiChatPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |
| `app/(dashboard)/teams/[teamId]/page.tsx` | `app/(dashboard)/teams/[teamId]/page.tsx` |

---

### DELETE /ai/memory/:contextType/:contextId
- **Hook**: `useClearAiMemory(contextType, contextId)` in `hooks/useAiChat.ts`
- **Query Key**: sets `["ai-memory", contextType, contextId]` to `[]`

**Used By**:
| Component | Page |
|-----------|------|
| `components/leads/AiChatPanel.tsx` | `app/(dashboard)/leads/[leadId]/page.tsx` |
| `app/(dashboard)/reports/page.tsx` | `app/(dashboard)/reports/page.tsx` |

---

## 🔔 Push Notifications (Web Push / VAPID)

---

### GET /push/vapid-public-key
- **Hook**: `usePushNotification()` → `requestPermission()` in `hooks/usePushNotification.ts`
- **Auth Required**: Yes

**Response**: `{ "data": { "publicKey": "string" } }` — VAPID public key for browser subscription

**Used By**:
| Component | Page |
|-----------|------|
| `hooks/usePushNotification.ts` | Called from notification settings / header |

---

### POST /push/subscribe
- **Hook**: `usePushNotification()` → `requestPermission()` in `hooks/usePushNotification.ts`
- **Auth Required**: Yes

**Request Body**: `{ "endpoint": string, "keys": { "p256dh": string, "auth": string } }`

**Used By**:
| Component | Page |
|-----------|------|
| `hooks/usePushNotification.ts` | Called on user permission grant |

---

### DELETE /push/unsubscribe
- **Hook**: `usePushNotification()` → `unsubscribe()` in `hooks/usePushNotification.ts`
- **Auth Required**: Yes

**Request Body**: `{ "endpoint": string }`

**Used By**:
| Component | Page |
|-----------|------|
| `hooks/usePushNotification.ts` | Called on user unsubscribe action |

---

## 🔌 Socket.io Events

> Not HTTP — real-time events via Socket.io connection in `hooks/useSocket.ts`

| Event | Direction | Payload | Listened In | Page |
|---|---|---|---|---|
| `reminder:due` | Server → Client | `{ reminderId, leadId, leadName, title, body }` | `useReminderNotifications` | All dashboard pages |
| `reminder:warning` | Server → Client | `{ reminderId, leadId, leadName, title, body, minsLeft }` | `useReminderNotifications` | All dashboard pages |
| `join:team` | Client → Server | `teamId` | `useTeamSocket(teamId)` | `teams/[teamId]/page.tsx` |
| `leave:team` | Client → Server | `teamId` | `useTeamSocket(teamId)` cleanup | `teams/[teamId]/page.tsx` |

**Socket connection**: Singleton via `useSocket()` — one connection per app session. Bearer token passed as `auth.token`.

---

## 📊 Quick Reference: Endpoint Count

| Module | Endpoints |
|---|---|
| Auth | 2 |
| Leads (CRUD) | 9 |
| Leads (Bulk) | 3 |
| Lead Notes | 3 |
| Reminders | 5 |
| Payments | 3 |
| Teams | 18 |
| Users | 5 |
| Roles | 5 |
| Courses | 5 |
| Reports | 7 |
| AI Chat | 3 |
| Push Notifications | 3 |
| Notifications | 4 |
| App settings | 3 |
| Inactive leads | 3 |
| Activity | 4 |
| Auth — logout | 1 |
| Meetings & calendar | 7 |
| **Total** | **93** |

---

## ➕ Adding a New Endpoint

Copy the template at the top of this file and add under the correct module section.

**Endpoint count**: 93
*(Increment every time you add an endpoint)*

---

## useTeamReminders (added 2026-04-06)

**File:** `hooks/useTeams.ts`
**Query key:** `["teams", teamId, "reminders", filters]`
**Endpoint:** `GET /api/v1/teams/:id/reminders`
**Params:** `memberId`, `isDone`, `search`, `page`, `limit`
**Response:** `{ data: TeamReminderItem[], pagination }`
**Used by:** `TeamRemindersTab`


---

## Notifications hooks (added 2026-09-30)

**File:** `hooks/useNotifications.ts`
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useNotifications(enabled)` | `["notifications"]` · `GET /notifications?limit=50` | `{ items: AppNotificationDTO[], unread }` |
| `useMarkAllNotificationsRead()` | `POST /notifications/read-all` | invalidates `["notifications"]` |
| `useDeleteNotification()` | `DELETE /notifications/:id` | invalidates `["notifications"]` |
| `useClearNotifications()` | `DELETE /notifications` | invalidates `["notifications"]` |
**Used by:** `NotificationBell`

## App settings hooks (added 2026-09-30)

**File:** `hooks/useAppSettings.ts`
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useAppSettings(enabled)` | `["settings","app"]` · `GET /settings/app` | `{ settings: AppSettings, mail: { configured, from } }` |
| `useUpdateAppSettings()` | `PUT /settings/app` | partial update; writes the response into the cache; toasts |
| `useSendTestEmail()` | `POST /settings/app/test-email` | toasts whether it was sent, or why not |
**Used by:** `AutomationSettingsCard`

## Inactive leads hooks (added 2026-09-30)

**File:** `hooks/useInactiveLeads.ts` — super admin only (the API answers 403 to everyone else)
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useInactiveLeads(filters, enabled)` | `["inactive-leads","list",filters]` · `GET /inactive-leads` | `{ items, summary, rule, pagination }`; keeps the previous page while loading; refetches every 60 s |
| `useLeadMoves(filters, enabled)` | `["inactive-leads","moves",filters]` · `GET /inactive-leads/moves` | `{ items: LeadMoveEntry[], pagination }` |
| `useReassignInactiveLeads()` | `POST /inactive-leads/reassign` | `{ leadIds, to? }` → `{ moved, skipped }`; invalidates `["inactive-leads"]` and `["leads"]`; toasts moved / skipped with the reason |
**Types:** `types/inactiveLeads.ts`
**Used by:** `app/(dashboard)/inactive-leads/page.tsx`, `MoveLeadsDialog`

## Activity hooks (added 2026-09-30)

**File:** `hooks/useActivity.ts` — super admin only (the API answers 403 to everyone else)
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useActivityPeople(filters, enabled)` | `["activity","people",filters]` · `GET /activity/people` | `{ items, summary, idleRule }`; refetches every 30 s |
| `useLoginEvents(filters, enabled)` | `["activity","logins",filters]` · `GET /activity/logins` | `{ items, pagination }` |
| `useIdleStretches(filters, enabled)` | `["activity","idle",filters]` · `GET /activity/idle` | `{ items, pagination }` |
**Types:** `types/activity.ts` · **Used by:** `app/(dashboard)/activity/page.tsx`

**File:** `hooks/useActivityHeartbeat.ts` — `POST /activity/heartbeat { active }` every 60 s while signed in (plus one when someone comes back after a quiet minute); errors are ignored. Mounted once in `app/(dashboard)/layout.tsx`.

**Changed:** `useLogout` (`hooks/useAuth.ts`) — `POST /auth/logout` with `fetch(…, { keepalive: true })` and the stored token, before the tokens are removed.

## Meetings hooks (added 2026-10-01)

**File:** `hooks/useMeetings.ts` — open to everyone signed in (per-meeting rules on the server)
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useCalendar({ from, to, userId? })` | `["meetings","calendar",q]` · `GET /meetings/calendar` | refetches every 60 s |
| `useMeeting(id)` | `["meetings","one",id]` · `GET /meetings/:id` | |
| `useColleagues(enabled)` | `["meetings","people"]` · `GET /meetings/people` | 5 min stale |
| `useLeadSearch(search, enabled)` | `["leads","meeting-search",search]` · `GET /leads?search=&limit=8` | from 2 characters; the leads rule applies |
| `useMentorSchedule(from, to, enabled)` | `["mentors","schedule",from,to]` · `GET /mentors/schedule` | no retry |
| `useMeetingConflicts(input)` | `["meetings","conflicts",input]` · `POST /meetings/conflicts` | debounced by the form |
| `useCreateMeeting()` / `useUpdateMeeting()` / `useCancelMeeting()` | `POST /meetings` · `PUT /meetings/:id` · `POST /meetings/:id/cancel` | invalidate `["meetings"]`; toasts |
**Types:** `types/meeting.ts` · **Time zone maths:** `lib/zonedTime.ts`

## useTeamMemberSplit — current statuses (changed 2026-10-01)

**File:** `hooks/useTeams.ts` · `GET /teams/:id/member-split?dateFrom=&dateTo=` (Dubai days)
`TeamMemberSplitItem` now extends `Partial<Record<LeadStatus, number>>` (the 11 statuses of `lib/statusConfig.ts`) instead of the old 13 fixed keys. A count may be missing (an API that predates the status) — read it as `m[s] ?? 0`; `total` still includes those leads.

## useUpdateLeadStatus — meeting (changed 2026-10-01)

**File:** `hooks/useLeads.ts` · `PATCH /leads/:id/status` — also sends `meetingAt` (ISO) and `meetingNote`; `meetingAt` is required by the server for `meeting_scheduled`, which then creates the meeting reminder. `useBulkUpdateLeadStatus` never sends `meeting_scheduled` (the server refuses it in bulk).

## Course mapping hooks (changed 2026-10-04)

**File:** `hooks/useCourses.ts`
| Hook | Key / endpoint | Notes |
|------|----------------|-------|
| `useFinanceItems(enabled = true)` | `["finance-items"]` · `GET /courses/finance-items` | now takes `enabled` (the dialog loads it only when open) |
| `useLmsCourses(enabled = true)` | `["lms-courses"]` · `GET /courses/lms-courses` | `{ slug, title }[]`; 502 when the LMS can't be read |
| `useMapCourse()` | `PUT /courses/:id` `{ financeItemId, lmsCourseSlugs }` | invalidates `["courses"]`; "Mapping saved" |
**Types:** `types/course.ts` — `Course.lmsCourseSlug(s)`, `LmsCourse`, `lmsCoursesOf(course)`.

## useImpersonate — View as (added 2026-10-04)

**File:** `hooks/useUsers.ts` · `POST /users/:id/impersonate` → `{ accessToken, expiresAt, user }` → `beginViewAs` (keeps the admin's tokens aside, signs in with the pass, reloads to /dashboard); errors toast the server's message. Ending: `endViewAs()` in `lib/impersonation.ts` (keepalive `POST /auth/impersonation/stop`, restores the admin, reloads to /users). No query key — the reloads clear the cache.

---

## A course's bonus (added 2026-10-04)

**File:** `hooks/useCourses.ts`

| Hook | Endpoint | Notes |
|------|----------|-------|
| `useCreateCourse()` (existing) | `POST /api/v1/courses` | Body may carry `bonusAmount` (≥ 0) |
| `useUpdateCourse()` (existing) | `PUT /api/v1/courses/:id` | Same |

**Types:** `types/course.ts` — `Course.bonusAmount?` (missing on a course from before = none).

---

## Commission hooks (added 2026-10-04)

**File:** `hooks/useCommission.ts`

| Hook | Query key | Endpoint | Notes |
|------|-----------|----------|-------|
| `useCommissionPlan()` | `["commission", "plan"]` | `GET /api/v1/commission/plan` | Courses with their plan rows, Sales Manager, excluded logins, teams, sales on hold (Super Admins) |
| `useCommissionEarnings(month)` | `["commission", "earnings", month]` | `GET /api/v1/commission/earnings?month=` | Scoped by the server: own / team / all |
| `useCommissionPreview({ course, team, closer })` | `["commission", "preview", …]` | `GET /api/v1/commission/preview` | For the closing dialog; off without a course |
| `useUpdateCoursePlan()` | invalidates `["commission"]`, `["courses"]` | `PUT /api/v1/commission/plan/:courseId` | Super Admin |
| `useUpdateCommissionSettings()` | invalidates `["commission"]` | `PUT /api/v1/commission/settings` | Super Admin |

**Types:** `types/commission.ts`; `Course.commission` in `types/course.ts`. **Helpers:** `lib/commission.ts` (AED/USD formatting, UAE months, `TL_RULE` — must match the backend's).

---

## Enrolment steps (added 2026-10-04)

| Hook | Query key | Endpoint | Notes |
|------|-----------|----------|-------|
| `useMyEnrolments()` (existing) | `["enrolments", …]` | `GET /api/v1/students/enrolments/mine` | Each row now has `steps` |
| `useEnrolment(id)` | `["enrolments", "one", id]` | `GET /api/v1/students/enrolments/:id` | The enrolment's own page: steps with who/when, commission |

**Types:** `EnrolmentStep`, `EnrolmentDetail` in `hooks/useEnrolments.ts`; `EnrolmentCommission.onboarded / bonus`.

## Split payments (added 2026-10-05)

`useCreateStudent` sends `payments: [{ method, amount, receipt, paidAt, collectedBefore? }]` (types/student.ts `StudentPayment`)
beside `paymentMethod` / `paymentReceipt` (the first payment's). Each new payment is added to the lead with `useAddPayment`, once.

## Currency per payment (changed 2026-10-05)

**File:** `hooks/useStudents.ts` (`useCreateStudent`) · `POST /students` — each of `payments[]` may add `currency`,
`amountInCurrency` and `exchangeRate` (1 of it = that many AED); `amount` stays the AED figure. Built by `rowForeignFields` in
`components/students/PaymentRowsEditor.tsx`. **Types:** `StudentPayment` gains the three; `BASE_CURRENCY` in `types/student.ts`.

## The client's email (added 2026-10-10)

| Hook | Query key | Endpoint | Notes |
|------|-----------|----------|-------|
| `useAddEnrolmentEmail()` | invalidates `["enrolments"]`, `["students"]`, `["leads"]` | `POST /api/v1/students/:id/enrolment/email` | `{ email }` → sent to finance again at once |
| `useEnrolmentCorrection(id, enabled, { followDelivery })` (changed) | `["enrolments", "correction", id]` | `GET /api/v1/students/:id/correction` | `followDelivery`: every 3 s while `deliveryStatus` is pending |
| `useCreateStudent()` (changed) | also invalidates `["leads"]` | `POST /students` | `email` now required by the server |

**Types:** `Handover.needsClientEmail` / `suggestedEmail`, `EnrolmentCorrectionStart.needsClientEmail` / `suggestedEmail` /
`deliveryStatus`; `isFinanceEmail` in `types/student.ts`. `POST /students/:id/invoice` answers 409 for a close refused for want
of the client's email (the toast says to add it first).

## One email, one client (added 2026-10-10)

| Hook | Query key | Endpoint | Notes |
|------|-----------|----------|-------|
| `useEmailCheck(email, { leadId \| studentId }, enabled)` | `["students", "email-check", email, leadId, studentId]` | `GET /api/v1/students/email-check` | asked 400 ms after typing stops; `{ taken, checking }`; a failed check holds nothing up |

**Types:** `EmailCheck` (`ok`, `takenBy { name, code?, kind }`, `message`) in `hooks/useStudents.ts`. `POST /students`, `PUT
/students/:id/correction`, `POST /students/:id/enrolment/email` and `POST /students/:id/invoice` (sent back) answer 409 "This
email is already used by … — enter …'s own email." for an email another client holds.

## 3CX calls (added 2026-10-14, from the Draw CRM)

**File:** `hooks/useCalls.ts` (the older `useRecentCalls` / `useQcQueue` / `useLeadCalls` stay for the QC screens).

| Hook / call | Query key | Endpoint | Notes |
|---|---|---|---|
| `useCallLog(filters)` | `["calls", "log", filters]` | `GET /calls/log` | page of calls + stats + people + period + threecx; every minute |
| `fetchCallLogForExport(filters)` | — | `GET /calls/log?export=1&limit=5000` | the CSV |
| `useLeadCallLog(leadId)` | `["calls", "log", "lead", id]` | `GET /calls/log/lead/:leadId` | a lead's calls + stats |
| `getRecordingLink(callId, i)` | — | `GET /calls/log/:id/recording-link` | a 10-minute link |
| `useSyncCallsNow()` | — | `POST /calls/log/sync` | Super Admin |
| `testThreecx()` | — | `POST /calls/log/test` | Super Admin's Test connection (`ThreecxTestDialog`) |
| `useClickToCall()` | `["calls", "click-to-call"]` | `GET /calls/click-to-call` | `{ enabled, connected, extension, webClientUrl }` |
| (CallFlow) | — | `POST /calls/3cx/call`, `GET /calls/3cx/state`, `POST /calls/3cx/hang-up` | the call window |
| (CallFlow) | — | `POST /calls/click` | the click log; the server stamps the lead's contact dates |
| (CallFlow) | — | `PATCH /leads/:id/status`, `POST /leads/:id/followups`, `POST /leads/:id/reminders`, `POST /leads/:id/notes` | "How did the call go?" — payloads per status in backend logicHistory "3CX calls" 7 |
| `useLeaderboard(month?, rankBy?)` | `["leaderboard", month, rankBy]` | `GET /leaderboard?rankBy=` | rows add `connected`, `talkSeconds` |

Removed: `useUpdateCallNotConnected`, `useUpdateCallCount` (the counts come from 3CX). `Lead.callConnected` added.
**Types:** `ThreecxCall`, `CallStats`, `CallPersonRow`, `ThreecxStatus`, `CallLogFilters`, `CallLogResponse`,
`PlacedCall`, `MyCallState`.
