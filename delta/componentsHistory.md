# 🧩 Components History & Registry — Remote CRM

> Every global/shared component must be logged here.
> **Before creating a new component**: search this file first (Ctrl+F).
> **After creating a global component**: add it here immediately.
> **After updating a global component**: bump version + update change log.

---

## How to Use

- **Before building**: search by name or category
- **After building**: fill the template, add to the correct category
- **When updating**: bump version, update "Used In", update "API Routes", add change log note

---

## 📋 Component Entry Template

```
### ComponentName
- **File**: `/components/[shared|ui|leads|teams|...]/ComponentName.tsx`
- **Version**: 1.0.0
- **Created**: YYYY-MM-DD
- **Last Updated**: YYYY-MM-DD
- **Status**: active | deprecated | wip

**Purpose**: One-line description.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|

**Used In (Pages)**:
| Route | Why |
|-------|-----|

**Used In (Components)**:
- `components/path/OtherComponent.tsx` — why

**Dependencies**:
- shadcn: ...
- hooks: ...

**Notes**: any gotchas

**Change Log**:
- 1.0.0 — Initial creation
```

---

## 🗂 Categories

---

## 🏗 Layout & Shell

---

### Header
- **File**: `components/layout/Header.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Top navigation bar — logo, page title, notification bell, user avatar/menu.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/leads/reminders/count` | `useMyReminderCount()` | Bell badge count |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/layout.tsx` | Shell — renders on every dashboard page |

**Used In (Components)**:
- `components/notifications/NotificationBell.tsx` — renders inside header right side

**Dependencies**:
- shadcn: `<Avatar />`, `<DropdownMenu />`
- hooks: `useLogout()`, `useAuthStore`

**Change Log**:
- 1.0.0 — Initial creation

---

### RemoteMark
- **File**: `components/brand/RemoteMark.tsx`
- **Version**: 1.0.0
- **Created**: 2026-09-30
- **Last Updated**: 2026-09-30
- **Status**: active

**Purpose**: The Remote CRM logo — an "R" drawn as one SVG stroke, sharp at any size and coloured by its container. Replaces `DeltaMark` (the Delta "d"), which was removed when the app was renamed Remote CRM.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `className` | `string` | no | — | Size, e.g. `h-5 w-5` |
| `color` | `string` | no | `currentColor` | Stroke colour — `hsl(var(--primary-foreground))` inside a `bg-primary` tile |
| `title` | `string` | no | — | Accessible name; omit for a decorative mark |

**Used In (Components)**:
- `components/layout/Sidebar.tsx` — the logo tile, desktop and mobile drawer
- `components/auth/LoginForm.tsx` — the login card's logo

**Also drawn by**: `app/icon.tsx`, `app/apple-icon.tsx` and `public/icons/*.png` (same path, `REMOTE_MARK_PATH`, white on `#0a0a0a`).

**Dependencies**:
- 1.0.0 — Initial creation (rename from Delta to Remote CRM)

---

### Sidebar
- **File**: `components/layout/Sidebar.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Left nav with route links, active-state highlighting, role-based visibility.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/teams/mine` | `useMyTeam()` | Shows "My Team" link only if user is in a team |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/layout.tsx` | Shell — renders on every dashboard page |

**Dependencies**:
- hooks: `useAuthStore`, `useMyTeam()`

**Notes**:
- Links hidden/shown based on `user.role.permissions`
- Collapses to bottom nav on mobile

**Change Log**:
- 1.0.0 — Initial creation

---

## 🔔 Notifications

---

### NotificationBell
- **File**: `components/notifications/NotificationBell.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Bell icon with badge in header. Opens panel with upcoming/due reminders.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/leads/reminders/mine` | `useMyReminders()` | List of user's reminders |
| GET | `/leads/reminders/count` | `useMyReminderCount()` | Unread badge count |

**Socket Events**:
| Event | Direction | Purpose |
|---|---|---|
| `reminder:due` | Server → Client | Real-time alert when reminder fires |
| `reminder:warning` | Server → Client | 30-min advance warning |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/layout.tsx` | Via `Header.tsx` — present on all dashboard pages |

**Used In (Components)**:
- `components/layout/Header.tsx`

**Dependencies**:
- hooks: `useMyReminders()`, `useMyReminderCount()`, `useReminderNotifications()`
- shadcn: `<Popover />` or `<DropdownMenu />`

**Change Log**:
- 1.0.0 — Initial creation

---

## 🪟 Modals & Overlays

---

### ResponsiveModal (responsive-dialog)
- **File**: `components/ui/responsive-dialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Renders `<Dialog />` on desktop, `<Drawer />` bottom sheet on mobile (`< 768px`). Use for ALL modals in the app.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `open` | `boolean` | ✅ | — | Controlled open state |
| `onOpenChange` | `(open: boolean) => void` | ✅ | — | Toggle handler |
| `title` | `string` | ✅ | — | Modal / drawer title |
| `description` | `string` | ❌ | — | Subtitle text |
| `children` | `ReactNode` | ✅ | — | Body |
| `footer` | `ReactNode` | ❌ | — | Footer actions |
| `size` | `"sm"\|"md"\|"lg"\|"xl"` | ❌ | `"md"` | Desktop width |

**API Routes Used**: none (presentation only)

**Used In (Components)**:
- `components/leads/LeadDialog.tsx`
- `components/leads/AssignLeadDialog.tsx`
- `components/leads/ReminderPanel.tsx`
- `components/teams/TeamDialog.tsx`
- `components/users/UserDialog.tsx`
- `components/roles/RoleDialog.tsx`
- `components/courses/CourseDialog.tsx`
- `components/reports/ExportPdfDialog.tsx`

**Dependencies**:
- shadcn: `<Dialog />`, `<Drawer />`

**Notes**: Always prefer this over bare `<Dialog />` or `<Sheet />`

**Change Log**:
- 1.0.0 — Initial creation

---

### DeleteLeadDialog
- **File**: `components/leads/DeleteLeadDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Confirm and delete a single lead.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| DELETE | `/leads/:id` | `useDeleteLead()` | Delete the lead |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/page.tsx` | Delete action in lead row |

**Dependencies**: shadcn: `<AlertDialog />`

**Change Log**:
- 1.0.0 — Initial creation

---

### DeleteUserDialog
- **File**: `components/users/DeleteUserDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Confirm and delete a single user.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| DELETE | `/users/:id` | `useDeleteUser()` | Delete the user |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/users/page.tsx` | Delete action in user row |

**Change Log**:
- 1.0.0 — Initial creation

---

### DeleteTeamDialog
- **File**: `components/teams/DeleteTeamDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Confirm and delete a team.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| DELETE | `/teams/:id` | `useDeleteTeam()` | Delete the team |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/teams/page.tsx` | Delete from list |
| `app/(dashboard)/teams/[teamId]/page.tsx` | Delete from detail page |

**Change Log**:
- 1.0.0 — Initial creation

---

### DeleteRoleDialog
- **File**: `components/roles/DeleteRoleDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Confirm and delete a role.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| DELETE | `/roles/:id` | `useDeleteRole()` | Delete the role |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/roles/page.tsx` | Delete action in role row |

**Change Log**:
- 1.0.0 — Initial creation

---

### DeleteCourseDialog
- **File**: `components/courses/DeleteCourseDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Confirm and delete a course.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| DELETE | `/courses/:id` | `useDeleteCourse()` | Delete the course |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/courses/page.tsx` | Delete action in course row |

**Change Log**:
- 1.0.0 — Initial creation

---

## 📊 Data Display (Planned Global — WIP)

---

### DataTable
- **File**: `components/shared/DataTable.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: Generic sortable, filterable, paginated table (TanStack Table). Use for ALL data tables.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `columns` | `ColumnDef<T>[]` | ✅ | — | Column definitions |
| `data` | `T[]` | ✅ | — | Row data |
| `isLoading` | `boolean` | ❌ | `false` | Shows skeleton |
| `pagination` | `PaginationState` | ❌ | — | Controlled pagination |
| `onPaginationChange` | `OnChangeFn<PaginationState>` | ❌ | — | Pagination handler |
| `sorting` | `SortingState` | ❌ | — | Controlled sort |
| `onSortingChange` | `OnChangeFn<SortingState>` | ❌ | — | Sort handler |
| `emptyMessage` | `string` | ❌ | `"No results"` | Empty state text |

**API Routes Used**: none (presentation — receives data as props)

**Notes**: Always pass `getRowId`; wrap column defs in `useMemo`

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

### Pagination
- **File**: `components/shared/Pagination.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: Standalone pagination bar. Used inside DataTable or standalone.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `page` | `number` | ✅ | — | Current page (1-based) |
| `totalPages` | `number` | ✅ | — | Total pages |
| `onPageChange` | `(page: number) => void` | ✅ | — | Callback |
| `pageSize` | `number` | ❌ | `10` | Items per page |
| `onPageSizeChange` | `(size: number) => void` | ❌ | — | Page size callback |
| `totalItems` | `number` | ❌ | — | Shows "X of Y" label |

**API Routes Used**: none

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

## 🔄 Feedback & States

---

### ErrorPage
- **File**: `components/ui/error-page.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Full-page or section-level error display with message and optional retry.

**API Routes Used**: none

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/error.tsx` | Global Next.js error boundary |
| `app/global-error.tsx` | Root-level error |
| `app/(dashboard)/*/error.tsx` | Per-route error pages (all dashboard routes) |

**Change Log**:
- 1.0.0 — Initial creation

---

### LoadingSkeleton *(WIP)*
- **File**: `components/shared/LoadingSkeleton.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: Layout-matching skeleton. Pass `variant` matching the content loading.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `variant` | `"table"\|"card"\|"form"\|"list"` | ✅ | — | Shape to mimic |
| `rows` | `number` | ❌ | `5` | Skeleton row count |

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

### EmptyState *(WIP)*
- **File**: `components/shared/EmptyState.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: Empty list state: icon + message + optional CTA.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `icon` | `ReactNode` | ❌ | default | Lucide icon |
| `title` | `string` | ✅ | — | Main message |
| `description` | `string` | ❌ | — | Supporting text |
| `action` | `{ label: string; onClick: () => void }` | ❌ | — | CTA button |

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

## 📝 Forms & Inputs (Planned Global — WIP)

---

### FormField
- **File**: `components/shared/FormField.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: RHF `Controller` + shadcn `Input` + label + error — eliminates boilerplate.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `name` | `string` | ✅ | — | RHF field name |
| `control` | `Control<any>` | ✅ | — | RHF control |
| `label` | `string` | ❌ | — | Label text |
| `placeholder` | `string` | ❌ | — | Placeholder |
| `type` | `string` | ❌ | `"text"` | Input type |
| `disabled` | `boolean` | ❌ | `false` | Disable |

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

### SearchInput
- **File**: `components/shared/SearchInput.tsx`
- **Version**: 1.0.0
- **Status**: wip

**Purpose**: Debounced search input — calls `onSearch` after user stops typing.

**Props**:
| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `onSearch` | `(value: string) => void` | ✅ | — | Debounced callback |
| `debounceMs` | `number` | ❌ | `400` | Debounce delay |
| `placeholder` | `string` | ❌ | `"Search..."` | Placeholder |
| `defaultValue` | `string` | ❌ | `""` | Initial value |

**Change Log**:
- 1.0.0 — Initial setup (WIP)

---

## 🎛 Feature-Specific Components

---

### LeadDialog
- **File**: `components/leads/LeadDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Create or edit a lead. Full lead form with all fields.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/leads` | `useCreateLead()` | Create new lead |
| PUT | `/leads/:id` | `useUpdateLead()` | Update existing lead |
| GET | `/courses/all` | `useAllCourses()` | Populate course dropdown |
| GET | `/teams` | `useTeams()` | Populate team dropdown |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/page.tsx` | "Add Lead" button + row edit action |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx` — wraps the form

**Dependencies**:
- hooks: `useCreateLead()`, `useUpdateLead()`, `useAllCourses()`, `useTeams()`
- react-hook-form + zod

**Change Log**:
- 1.0.0 — Initial creation

---

### AssignLeadDialog
- **File**: `components/leads/AssignLeadDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Assign a lead to a team (and optionally a user within the team).

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/teams` | `useTeams()` | Team dropdown |
| PATCH | `/leads/:id/team` | `useAssignLeadToTeam()` | Assign to team |
| PATCH | `/leads/:id/assign` | `useAssignLead()` | Assign to specific user |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/page.tsx` | Assign action in lead row |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### ReminderPanel
- **File**: `components/leads/ReminderPanel.tsx`
- **Version**: 1.2.0
- **Last Updated**: 2026-04-01
- **Status**: active

**Purpose**: CRUD panel for reminders on a lead. IST-aware time display, add/edit/delete/mark-done.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/leads/:leadId/reminders` | `useAddReminder(leadId)` | Create reminder |
| PUT | `/leads/:leadId/reminders/:id` | `useUpdateReminder(leadId)` | Edit reminder |
| DELETE | `/leads/:leadId/reminders/:id` | `useDeleteReminder(leadId)` | Delete reminder |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/[leadId]/page.tsx` | Reminders tab in lead detail |

**Dependencies**:
- hooks: `useAddReminder()`, `useUpdateReminder()`, `useDeleteReminder()`
- `lib/animations.ts`
- shadcn: `<Input type="datetime-local" />`, `<Textarea />`, `<Button />`

**Notes / Gotchas**:
- `toDatetimeLocal(iso)` → uses `sv-SE` + `Asia/Kolkata` — never `getHours()` (see `mistakes.md` M-002)
- `handleSave()` → appends `:00+05:30` before sending (see `mistakes.md` M-003)
- Input has `min={nowIST()}` — blocks past-time selection
- All display times appended with " IST"

**Change Log**:
- 1.0.0 — Initial creation
- 1.1.0 — Added IST-aware time display
- 1.2.0 — Fixed `toDatetimeLocal` (sv-SE/Kolkata); fixed `:00+05:30` parsing; added `min={nowIST()}`; added `timeError` state (2026-04-01)

---

### AiChatPanel
- **File**: `components/leads/AiChatPanel.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: AI chat assistant for a lead. Powered by Anthropic Claude via backend.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/ai/memory/lead/:leadId` | `useAiMemory("lead", leadId)` | Load conversation history |
| POST | `/ai/chat/lead/:leadId` | `useAiChat("lead", leadId)` | Send message, get reply |
| DELETE | `/ai/memory/lead/:leadId` | `useClearAiMemory("lead", leadId)` | Clear conversation |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/[leadId]/page.tsx` | AI Chat tab |

**Dependencies**:
- hooks: `useAiMemory()`, `useAiChat()`, `useClearAiMemory()` from `hooks/useAiChat.ts`
- shadcn: `<ScrollArea />`, `<Textarea />`, `<Button />`

**Notes**: Conversations scoped to `leadId + userId` — each user has separate history per lead

**Change Log**:
- 1.0.0 — Initial creation

---

### PaymentPanel
- **File**: `components/leads/PaymentPanel.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Add, edit, delete payment records for a lead. Shows payment history.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/leads/:leadId/payments` | `useAddPayment(leadId)` | Add payment |
| PUT | `/leads/:leadId/payments/:id` | `useUpdatePayment(leadId)` | Edit payment |
| DELETE | `/leads/:leadId/payments/:id` | `useDeletePayment(leadId)` | Remove payment |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/[leadId]/page.tsx` | Payments tab |

**Dependencies**: hooks: `useAddPayment()`, `useUpdatePayment()`, `useDeletePayment()` from `hooks/usePayments.ts`

**Change Log**:
- 1.0.0 — Initial creation

---

### LeadsDateFilter
- **File**: `components/leads/LeadsDateFilter.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Date range picker for filtering leads by creation date.

**API Routes Used**: none (emits filter values up via props callback)

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/leads/page.tsx` | Filter bar — `dateFrom`/`dateTo` params |

**Change Log**:
- 1.0.0 — Initial creation

---

### TeamDialog
- **File**: `components/teams/TeamDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Create or edit a team. Fields: name, description, leaders, members.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/teams` | `useCreateTeam()` | Create team |
| PUT | `/teams/:id` | `useUpdateTeam()` | Update team |
| GET | `/users` | `useUsers()` | Populate leader/member dropdowns |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/teams/page.tsx` | "Add Team" button |
| `app/(dashboard)/teams/[teamId]/page.tsx` | Edit team |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### UserDialog
- **File**: `components/users/UserDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Create or edit a user. Fields: name, email, password, role, designation.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/users` | `useCreateUser()` | Create user |
| PUT | `/users/:id` | `useUpdateUser()` | Update user |
| GET | `/roles/all` | `useRolesSimple()` | Role dropdown |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/users/page.tsx` | "Add User" button + row edit |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### RoleDialog
- **File**: `components/roles/RoleDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Create or edit a role with a full permission matrix.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/roles/:id` | `useRole(id)` | Load existing role for edit |
| POST | `/roles` | `useCreateRole()` | Create role |
| PUT | `/roles/:id` | `useUpdateRole()` | Update role + permissions |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/roles/page.tsx` | "Add Role" + edit actions |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`
- `components/roles/PermissionMatrix.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### PermissionMatrix
- **File**: `components/roles/PermissionMatrix.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Visual module × action grid with checkboxes. Used only inside `RoleDialog`.

**API Routes Used**: none (receives/emits permissions via props)

**Used In (Components)**:
- `components/roles/RoleDialog.tsx`

**Notes**:
- Modules: `dashboard | leads | teams | users | roles | reports`
- Actions: `view | create | edit | delete`

**Change Log**:
- 1.0.0 — Initial creation

---

### CourseDialog
- **File**: `components/courses/CourseDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Create or edit a course.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/courses/:id` | `useCourse(id)` | Load existing course for edit |
| POST | `/courses` | `useCreateCourse()` | Create course |
| PUT | `/courses/:id` | `useUpdateCourse()` | Update course |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/courses/page.tsx` | "Add Course" + row edit |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### ExportPdfDialog
- **File**: `components/reports/ExportPdfDialog.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Options modal for exporting report data as PDF.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/reports/overview` | `useReportOverview()` | Data to export |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/reports/page.tsx` | Export button |

**Used In (Components)**:
- `components/ui/responsive-dialog.tsx`

**Change Log**:
- 1.0.0 — Initial creation

---

### LoginForm
- **File**: `components/auth/LoginForm.tsx`
- **Version**: 1.0.0
- **Status**: active

**Purpose**: Email + password login form with validation and submit handler.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/auth/login` | `useLogin()` | Authenticate user |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(auth)/login/page.tsx` | The login page |

**Dependencies**:
- hooks: `useLogin()` from `hooks/useAuth.ts`
- react-hook-form + zod

**Change Log**:
- 1.0.0 — Initial creation

---

## 🗺 Full Route → Component → API Map

> Quick reference: for each page, what components are used and what APIs are called.

### `app/(auth)/login/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| `LoginForm` | `POST /auth/login` |

---

### `app/(dashboard)/leads/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /leads`, `PATCH /leads/:id/status`, `POST /leads/auto-assign`, `PATCH /leads/bulk/status`, `DELETE /leads/bulk`, `PATCH /leads/bulk/team` |
| `LeadDialog` | `POST /leads`, `PUT /leads/:id`, `GET /courses/all`, `GET /teams` |
| `AssignLeadDialog` | `GET /teams`, `PATCH /leads/:id/team`, `PATCH /leads/:id/assign` |
| `DeleteLeadDialog` | `DELETE /leads/:id` |
| `LeadsDateFilter` | — (emits filter values only) |

---

### `app/(dashboard)/leads/[leadId]/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /leads/:id`, `PUT /leads/:id`, `PATCH /leads/:id/status`, `POST /leads/:leadId/notes`, `PUT /leads/:leadId/notes/:id`, `DELETE /leads/:leadId/notes/:id` |
| `ReminderPanel` | `POST /leads/:leadId/reminders`, `PUT /leads/:leadId/reminders/:id`, `DELETE /leads/:leadId/reminders/:id` |
| `PaymentPanel` | `POST /leads/:leadId/payments`, `PUT /leads/:leadId/payments/:id`, `DELETE /leads/:leadId/payments/:id` |
| `AiChatPanel` | `GET /ai/memory/lead/:id`, `POST /ai/chat/lead/:id`, `DELETE /ai/memory/lead/:id` |

---

### `app/(dashboard)/leads/upload/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `POST /leads/upload` |

---

### `app/(dashboard)/reminders/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /leads/reminders/mine`, `POST /leads/:leadId/reminders`, `PUT /leads/:leadId/reminders/:id`, `DELETE /leads/:leadId/reminders/:id` |

---

### `app/(dashboard)/teams/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /teams` |
| `TeamDialog` | `POST /teams`, `GET /users` |
| `DeleteTeamDialog` | `DELETE /teams/:id` |

---

### `app/(dashboard)/teams/[teamId]/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /teams/:id`, `GET /teams/:id/leads`, `GET /teams/:id/member-stats`, `GET /teams/:id/dashboard`, `GET /teams/:id/logs`, `GET /teams/:id/updates`, `POST /teams/:id/messages`, `POST /teams/:id/auto-assign`, `PATCH /teams/:id/members/:memberId/toggle-active`, `PATCH /teams/:id/leads/:leadId/assign`, `PATCH /teams/:id/leads/bulk/assign`, `PATCH /teams/:id/leads/bulk/transfer`, `PATCH /teams/:id/leads/bulk/status`, `PATCH /leads/:leadId/transfer`, `GET /teams/:id/revenue`, `GET /teams/:id/revenue/timeline` |
| `TeamDialog` | `PUT /teams/:id`, `GET /users` |
| `DeleteTeamDialog` | `DELETE /teams/:id` |

---

### `app/(dashboard)/teams/[teamId]/members/[memberId]/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /teams/:id/members/:memberId`, `GET /teams/:id/members/:memberId/leads` |

---

### `app/(dashboard)/users/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /users` |
| `UserDialog` | `POST /users`, `PUT /users/:id`, `GET /roles/all` |
| `DeleteUserDialog` | `DELETE /users/:id` |

---

### `app/(dashboard)/users/[userId]/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /users/:id`, `PUT /users/:id`, `GET /users/:id/leads`, `GET /users/:id/lead-stats` |

---

### `app/(dashboard)/roles/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /roles` |
| `RoleDialog` | `GET /roles/:id`, `POST /roles`, `PUT /roles/:id` |
| `DeleteRoleDialog` | `DELETE /roles/:id` |

---

### `app/(dashboard)/courses/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /courses` |
| `CourseDialog` | `GET /courses/:id`, `POST /courses`, `PUT /courses/:id` |
| `DeleteCourseDialog` | `DELETE /courses/:id` |

---

### `app/(dashboard)/reports/page.tsx`
| Component | APIs Called |
|-----------|-------------|
| Page direct | `GET /reports/overview`, `GET /reports/timeline`, `GET /reports/users`, `GET /reports/teams`, `GET /reports/team-split`, `GET /reports/revenue/overview`, `GET /reports/revenue/timeline`, `GET /reports/revenue/teams`, `POST /ai/chat/report`, `GET /ai/memory/report/report`, `DELETE /ai/memory/report/report` |
| `ExportPdfDialog` | `GET /reports/overview` |

---

### `app/(dashboard)/layout.tsx` (all dashboard pages)
| Component | APIs Called |
|-----------|-------------|
| `Header` → `NotificationBell` | `GET /leads/reminders/mine`, `GET /leads/reminders/count` |
| `Sidebar` | `GET /teams/mine` |
| Socket (via `useReminderNotifications`) | Events: `reminder:due`, `reminder:warning` |

---

## ➕ Adding a New Component

1. Copy the template at the top
2. Place in the correct category
3. Fill **every section** including "API Routes Used" and "Used In (Pages)"
4. If reusable in 2+ places → `/components/shared/`, status: `active`
5. Update this file's component count

**Component count**: 24
*(Increment every time you add a component)*

---

## TeamRemindersTab (added 2026-04-06)

**File:** `components/teams/TeamRemindersTab.tsx`
**Props:** `teamId: string`, `members: { _id: string; name: string }[]`
**Used in:** `app/(dashboard)/teams/[teamId]/page.tsx` — "Reminders" tab (leader/admin only)
**Hook:** `useTeamReminders(teamId, filters)` from `hooks/useTeams.ts`
**Features:** Search (debounced 400ms), member filter, isDone filter (pending/done), pagination (20/page), overdue badge, Framer Motion stagger list.

---

## MemberSelector (added 2026-04-24)

**File:** `app/(dashboard)/leads/upload/page.tsx` (inline sub-component)
**Props:** `teamId: string`, `members: TeamMember[]`, `inactiveMembers: string[]`, `selected: Set<string>`, `locked?: boolean`, `lockedIds?: string[]`, `onChange: (id: string) => void`
**Used in:** `TeamMemberSelector` → upload page
**Purpose:** Renders member pills with checkboxes. Locked mode (BDE): members can't be deselected. Inactive members shown greyed/disabled. "All/None" quick actions for admins.

---

## TeamMemberSelector (added 2026-04-24)

**File:** `app/(dashboard)/leads/upload/page.tsx` (inline sub-component)
**Props:** `teams: Team[]`, `selectedTeamIds: Set<string>`, `selectedMemberIds: Record<string, Set<string>>`, `lockedTeamId?: string | null`, `lockedMemberId?: string | null`, `onToggleTeam: (id: string) => void`, `onToggleMember: (teamId: string, memberId: string) => void`, `onSetAllMembers: (teamId: string, all: boolean) => void`
**Used in:** upload page
**Purpose:** Vertical list of team rows, each expands to show `MemberSelector`. BDE sees only their team (locked, non-removable). Admins can toggle any team + any member. Framer Motion AnimatePresence for expand/collapse.


---

### AutomationSettingsCard
- **File**: `components/settings/AutomationSettingsCard.tsx`
- **Version**: 1.0.0
- **Created**: 2026-09-30
- **Last Updated**: 2026-09-30
- **Status**: active

**Purpose**: Settings → "Automation & alerts": inactive-lead limit (hours + minutes) and auto-reassign switch, idle alerts, working hours, per-event email switches, mailbox status and test email. Read-only for anyone without `settings.edit`.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| GET | `/settings/app` | `useAppSettings()` | Load |
| PUT | `/settings/app` | `useUpdateAppSettings()` | Save |
| POST | `/settings/app/test-email` | `useSendTestEmail()` | Test the mailbox |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/settings/page.tsx` | Last card on the Settings page |

**Dependencies**:
- 1.0.0 — Initial creation

### NotificationBell — change log
- 2026-09-30 — Loads kept notifications from `GET /notifications` and merges live socket ones (stored ones arrive with an `id`); mark-all-read, dismiss and clear-all now persist through `hooks/useNotifications.ts`.

---

### MoveLeadsDialog
- **File**: `components/inactive-leads/MoveLeadsDialog.tsx`
- **Version**: 1.0.0
- **Created**: 2026-09-30
- **Last Updated**: 2026-09-30
- **Status**: active

**Purpose**: Move one or more inactive leads — "Next in their team" (the team's split rule) or "A person I choose" (searchable list of active users; the current owner is disabled). Stays open when nothing moved, so another choice can be made.

**API Routes Used**:
| Method | Endpoint | Hook | Purpose |
|--------|----------|------|---------|
| POST | `/inactive-leads/reassign` | `useReassignInactiveLeads()` | Move |
| GET | `/users?status=active` | `useUsers()` | People to pick from |

**Used In (Pages)**:
| Route | Why |
|-------|-----|
| `app/(dashboard)/inactive-leads/page.tsx` | Row "Move" and the bulk "Move N" bar |

**Dependencies**: `ResponsiveDialog` (Drawer on mobile)
- 1.0.0 — Initial creation

### Inactive Leads page
- **File**: `app/(dashboard)/inactive-leads/page.tsx` — route `/inactive-leads`, super admin only (renders nothing else for anyone else; the layout also redirects them)
- **Parts**: header with the rule and automatic-moves badge, 3 stat cards, tabs "Inactive now" / "Moves log", table with select-all, bulk bar, pager; local `StatCard`, `Pager`, `EmptyState`, `ErrorState`, `TableSkeleton`
- **Created**: 2026-09-30

### Change log — 2026-09-30 (Phase 2)
- `Sidebar` — "Inactive Leads" nav item (`permModule: "inactive-leads"`, which only the Super Admin passes); the notification handler also reads `type` from stored notices, so the lead count refreshes for moved leads.
- Lead detail page — `inactive_reassigned` in the activity log (amber, `ArrowRightLeft`); entries with no performer show "by System".
- `AutomationSettingsCard` 1.1.0 — Inactive leads section live (no "Coming next"), shows since when automatic moves apply and links to the page; never sends `enabledAt` back.

---

### Shared list parts (added 2026-09-30)
- **Files**: `components/shared/StatCard.tsx` (`StatCard`), `components/shared/Pager.tsx` (`Pager`), `components/shared/ListStates.tsx` (`EmptyState`, `ErrorState`, `TableSkeleton`); variants in `lib/animations.ts` (`pageVariants`, `listContainerVariants`, `listItemVariants`)
- **Why**: pulled out of the Inactive Leads page when the Activity page needed the same parts. Reuse them for new list pages.
- **Used In**: `app/(dashboard)/inactive-leads/page.tsx`, `app/(dashboard)/activity/page.tsx`

### Activity page
- **File**: `app/(dashboard)/activity/page.tsx` — route `/activity`, super admin only (renders nothing else for anyone else; the layout also redirects them)
- **Parts**: header with the idle-alert rule badge, 4 stat cards, tabs People / Sign-ins / Idle alerts, person chip filter, pagers; local `EventBadge`, `DeviceIcon`
- **Created**: 2026-09-30

### Change log — 2026-09-30 (Phase 3)
- `Sidebar` — "Activity" nav item (`permModule: "activity"`, which only the Super Admin passes).
- `app/(dashboard)/layout.tsx` — mounts `useActivityHeartbeat()`.
- `NotificationBell` — icons for `inactive_lead_moved`, `inactive_leads_moved`, `inactive_leads_stuck`, `idle_self`, `idle_alert`.
- `AutomationSettingsCard` 1.2.0 — Idle alerts live (no "Coming next"), clearer description, link to `/activity`.
- Inactive Leads page — uses the shared list parts; tabs no longer shrink.

---

### Calendar components (added 2026-10-01)
- `components/calendar/TimeGrid.tsx` — day/week hours grid: side-by-side overlaps, mentors' strip (free/busy), now line, click-to-book
- `components/calendar/MonthGrid.tsx` — six weeks, three items a day + "+N more"
- `components/calendar/MeetingDialog.tsx` — book/change: colleagues, client, mentors, link, notes, reminder, live busy warning (ResponsiveDialog)
- `components/calendar/MeetingDetails.tsx` — one meeting; change / cancel with a reason
- `components/calendar/mentorColors.ts` — mentor colours as full class names (Tailwind can't build them from pieces)
- **Used In**: `app/(dashboard)/calendar/page.tsx`

### Change log — 2026-10-01 (Phase 4)
- `Sidebar` — "Calendar" nav item (`permModule: null`).
- `app/(dashboard)/layout.tsx` — `/calendar` passes the permission redirect for every role (like `/profile`).
- `NotificationBell` — icons for `meeting_scheduled`, `meeting_updated`, `meeting_reminder`, `meeting_cancelled`.

### Change log — 2026-10-01 (Leads page)
- Leads page — "All leads / My team | My leads" toggle for super admins and team leaders (shortcut for Assigned To = you, remembered per browser); team-leader detection falls back to `useMyTeam()`; "You" in the Assigned To filter and pill.

### Change log — 2026-10-01 (team Report tab)
- `teams/[teamId]/page.tsx` `ReportTab` — columns come from `LEAD_STATUSES` / `STATUS_META` (`lib/statusConfig.ts`), the same names and colours as the Leads page; an **Other** column (row total minus the listed columns) appears only when not zero; the period presets are Dubai dates (`getReportRange` builds them from `toGstDateISO(new Date())`, not the browser's calendar).

### Change log — 2026-10-01 (lead form & Assign)
- `LeadDialog` — on create, Source is required ("Source *", "Source is required" under the field); Email is labelled "(optional)". Editing is unchanged.
- `AssignLeadDialog` — rewritten for the Leads list's row button: shows who has the lead now, the current owner is disabled in the list, no "Auto Assign All Unassigned" (it assigned every unassigned lead from a one-lead dialog); the pick is cleared on every opening and on Cancel.
- Leads page — "Assign to" (UserPlus) button next to Call and Note on each row, super admin only, in the phone cards and the desktop table (visible on keyboard focus too); the phone card's action icons wrap three to a row so the lead's details keep their width.

### Change log — 2026-10-01 (Wrong Number, Meeting Scheduled)
- `lib/statusConfig.ts` — `meeting_scheduled` (teal) and `wrong_number` (pink); every status menu, filter, Kanban column, team Report column and badge picks them up.
- `MeetingScheduledModal` (new, `components/leads/`) — meeting date & time (GST, required, not in the past) + optional note; shown when a lead is moved to Meeting Scheduled from the lead page, the Leads list row, a Kanban drop (also on the profile page and the team member board) or the profile page list. It stays open if saving fails; dismissing leaves the lead as it was.
- Leads page bulk "Change Status" — Meeting Scheduled is not offered.
- Profile and user pages — "Meeting Scheduled" and "Wrong Number" stat cards.
- `lib/animations.ts` — `overlayVariants`, `modalVariants`.
- `tailwind.config.ts` — scans `lib/` too.

### Change log — 2026-10-04 (course mapping, like Draw)
- `MapCourseDialog` (new, `components/courses/`) replaces `MapToFinanceDialog`: finance product + LMS course(s) ticked in order (numbered when more than one; "Opens: A + B"), same-name suggestions offered, never applied; an amber warning when a product is chosen for a course with two or more LMS courses (finance would open the product's own courses instead).
- Courses page — each card shows "Mapped / Not mapped to finance" and "LMS: N course(s) / LMS not mapped"; both chips and the link button open the dialog.

### Change log — 2026-10-04 (Meeting Done)
- `lib/statusConfig.ts` — `meeting_done` (indigo), after Meeting Scheduled: every status menu, filter, Kanban column, team Report column and badge picks it up. No dialog — it is set straight away.
- Profile and user pages — a "Meeting Done" stat card.

### Change log — 2026-10-04 (View as)
- `ImpersonationBanner` (new, `components/shared/`) — the amber bar while viewing as someone: name, email (wider screens), "View only", m:ss left, "Back to my account"; goes back on its own at zero. Rendered by `Header` above the header bar, outside the scrolling page.
- `lib/impersonation.ts` (new) — `getViewAs`, `canViewAs`, `beginViewAs`, `endViewAs`, `leaveViewAsForSignOut`; localStorage `crm-view-as`, `crm-own-auth`.
- Users list (row actions) and user page (next to Export PDF) — "View as" for super admins (`canViewAs`).
- `lib/axios.ts` — a 401 while viewing goes back to the admin's account, not /login. `useLogout` ends the session and records the sign-out under the admin; `useActivityHeartbeat` sends nothing while viewing; `usePushNotification` won't subscribe or unsubscribe while viewing (a toast says so) and the bell's push prompt stays hidden.

## CourseDialog (changed 2026-10-04)

A Bonus field (the course's currency, 0 for none) beside the Amount on Add and Edit, with "A new close starts from it". The course card shows "· $X bonus" beside the fee.

## CreateStudentModal (changed 2026-10-04)

A new close starts "Bonus given?" at yes with the course's bonus, marked "From the course — change it if this sale differs"; choosing another course moves it until the seller answers or types an amount (`bonusTouched`). Editing an enrolment never takes it.

---

## Commission page (added 2026-10-04)

**Route:** `app/(dashboard)/commission/page.tsx` — tabs Earnings / Plan; in the sidebar for every role (`permModule: null`).
**EarningsTab** (`components/commission/EarningsTab.tsx`): month picker (UAE months), totals, each person's Sales Staff / TL / SM, and every sale with its lines or why it is on hold, excluded or reversed.
**PlanTab** (`components/commission/PlanTab.tsx`): how it's paid (per `TL_RULE`), a card per course (Super Admins edit and save each row), the Sales Manager, excluded logins, team leaders to fix, sales on hold.
**CommissionPreview** (`components/commission/CommissionPreview.tsx`): props `courseId`, `teamId`, `closerId` — what the counsellor earns on the sale, in the closing dialog; never blocks a close.
**Changed:** the course card shows its commission (Sales / TL / SM, MT5 credit) and links to the plan; `CreateStudentModal` shows `CommissionPreview` after the fee.

---

## EnrolmentSteps (added 2026-10-04, replaces AfterApproval)

**File:** `components/students/EnrolmentSteps.tsx` — `EnrolmentStepsStrip({ steps })` (five pills at the foot of a My Enrolments card, details on hover, and "Next step: …" / "Every step done") and `EnrolmentStepsList({ steps })` (the enrolment page: each step with its detail, who and when). Green done, amber waiting, red stopped, grey unknown / not needed.
**Page:** `app/(dashboard)/enrolments/[id]/page.tsx` — opened from the student's name on a card; the steps and the sale's commission.

### Change log — 2026-10-05 (split payments)
- `PaymentRowsEditor` (new, `components/students/`) — one row per payment at the close: method, amount (fixed for the money
  already on the lead), its own receipt upload; add / remove rows. Exports `newPaymentRow`, `rowAmount`, `missingInRows`.
- `CreateStudentModal` — a new close uses the rows instead of one method and one receipt; red "more than the fee" and a blocked
  save when collected is above the fee (edit mode too).

### Change log — 2026-10-05 (currency at the close; sources)
- `PaymentRowsEditor` — each payment row has a currency (AED first, then the app's other ten). Another currency shows "1 INR = [rate] AED → [AED] AED": typing the rate works out the AED figure, typing the AED figure works out the rate, a new amount keeps the rate. `rowAmount` is the AED figure (totals, balance, fee status, over-the-fee); `missingInRows` asks for the rate; `rowForeignFields` / `describeForeign` for the close and the lead's payment note.
- `CreateStudentModal` — sends each row's currency fields; the lead's payment note says what was handed over.
- `LeadDialog` — Social Media, Direct and Other can be picked as a source again (they were switched off in the copy from Delta's CRM).

### Change log — 2026-10-06 (Mentors and Commission for every role)
- `app/(dashboard)/layout.tsx` — `OPEN_TO_EVERYONE` (profile, calendar, Mentors, Commission): every role may open these. The guard read the address as a permission, and there is no "mentors" or "commission" one, so everyone but the Super Admin was sent away though the sidebar listed both. The server already narrows Commission to each person's own.

### Change log — 2026-10-10 (academy at the close)
- `AcademyBadge` (new) — Dubai / Bangalore pill.
- `PaymentRowsEditor` — `base` prop ("AED" | "INR"); helpers take `base` (`isForeign`, `rowAmount`, `rowForeignFields`, `describeForeign`, `missingInRows`); new `leadAmountOf`, `rowsForBase`. On INR: currencies INR / AED, the lead's own row is AED with its rate.
- `CreateStudentModal` — academy selector, shown only when `useCloseOptions` (GET /students/close-options) lists Bangalore; fee/labels follow it; Bangalore without a price blocked; sends `academy`.
- `CorrectEnrolmentDialog` — academy read-only; money in its currency; course without a Bangalore price flagged.
- `MapCourseDialog` — Bangalore section (price, Bangalore finance product, LMS courses or Dubai's).
- `lib/currency.fmtAcademy`, `types/course.bangalorePriceOf` / `feeFor`, `types/student` `ACADEMIES` / `academyOf`.

### Change log — 2026-10-10 (the client's email at the close)
- `CreateStudentModal` — a new close asks "Email *" in Personal Details when the lead has no email that works (amber when
  what is typed isn't one); "the client's email" joins "Still needed", blocking Create; sends it (lower case).
- `AddClientEmail` (new) — "Finance couldn't take this enrolment — it went without the client's email. Add the client's
  email and send again:" field + "Add email & send again" button (`useAddEnrolmentEmail`), disabled until finance would
  take it; filled in from the server's `suggestedEmail` (the enrolment's, else the lead's) with "Filled in from the client's
  details here — check it, then send" — never sent by itself; for a role without `enrolments:edit` only the sentence.
  Shown where the server says `needsClientEmail`.
- My Enrolments row — `AddClientEmail` in place of the "Could not reach finance … Request validation failed" box, and no
  "Generate invoice" (which would send it to be refused again); after saving it shows Sending.
- Enrolment page header — `AddClientEmail`; "On its way to finance…" while pending (not a resend).
- Student page — `AddClientEmail` from `useEnrolmentCorrection` (`needsClientEmail`), followed every 3 s while pending, with
  "On its way to finance…".
- `types/student.isFinanceEmail` — finance's own check (zod 3 `z.string().email()`, as the server's); used by the close
  dialog, `AddClientEmail` and `CorrectEnrolmentDialog` (in place of its own looser `EMAIL_RE`), so `a@b.c` is asked for
  again before the server refuses it, and nothing the server takes is blocked.

### Change log — 2026-10-10 (one email, one client)
- `CreateStudentModal` — the lead's email is checked when the dialog opens (`useEmailCheck`, by lead); one another client
  holds is treated as missing: the Email field shows, starting from it, with the server's words in red ("This email is
  already used by … (STU-…), a different client — enter …'s own email."); "the client's own email" joins "Still needed"; Create
  waits while an email is checked ("Checking the client's email…"). The lead keeps its email. A 409 from the server is shown
  on the field too.
- `CorrectEnrolmentDialog` — the email checked as typed (by enrolment); taken → the message under the field and "the
  client's own email" in Still needed; a 409 shows there too.
- `AddClientEmail` — the same check and message; the button waits for it.
- `hooks/useStudents.useEmailCheck` (new).

### Change log — 2026-10-14 (exact money figures)
- `lib/currency.ts` — `fmtFull` caps at two decimals and reads a missing amount as 0; `fmtCompact` is now only for chart axes.
- `app/(dashboard)/reports/page.tsx` — `fmtUSD` is `fmtFull` (was `fmtCompact`); `KpiCard` puts the value on its own full-width line, smaller when long; the revenue chart's Y axis keeps `fmtCompact`.
- `app/(dashboard)/teams/[teamId]/page.tsx` — `fmtUSD` is `fmtFull`; new local `MoneyFigure` for the Total Received / Total Pending / Avg per Lead cards; the Y axis keeps `fmtCompact`.

### Change log — 2026-10-14 (3CX calls, from the Draw CRM)
- `components/calls/callUi.tsx` (new) — `CallResult`, `CallPerson`, `RecordingPlayer`, `SyncNote`, `fmtClockDuration`,
  `fmtTalkTotal`, `fmtWhen` (Dubai), `RESULTS`.
- `components/calls/ThreecxTestDialog.tsx` (new) — the Super Admin's Test connection, step by step.
- `components/calls/CallFlow.tsx` (new) — `CallFlowProvider` (in the dashboard layout), `useCallFlow`, `dialOf`: the call
  choice, the call window, "How did the call go?" with this CRM's status rules (Follow Up asks what happened and an
  optional next follow-up — picked again on a lead in Follow Up it logs one more follow-up; Meeting Scheduled asks when;
  Lost picks from `LOST_REASONS` and needs notes; Call Back an optional reminder), and the enrolment dialog for Closed.
  Pending log kept in sessionStorage `remotecrm.pendingCallLog` for 30 minutes. Save is safe to press again after a
  part-way failure (each request named; only the missing ones are sent); a Follow Up note goes to the follow-up history
  cut to 1,000 characters; a refused form shows its first reason.
- `components/leads/ClickToCall.tsx` — one Call button that opens the call flow (was a dropdown: 3CX web client popup /
  tel: / copy, each bumping the call count).
- `app/(dashboard)/calls/page.tsx` — rewritten: 3CX calls only. `components/leads/CallsPanel.tsx` — the lead's 3CX calls.
- Lead page: the Call Not Connected / Call Count + / − counters → one read-only "Calls — from 3CX" box. Leads list: a
  Calls (3CX) column. Kanban: card and preview show the three counts.
- Leaderboard page + `DashboardLeaderboardCard`: Calls, Connected, Talk time; Revenue / Calls / Talk time switch.
- `lib/dubaiDates.ts` (new) — `DUBAI_TZ`, `dubaiDate()`. Sidebar Calls → module `calls`.

### Change log — 2026-10-15 (Activity and Inactive Leads on phones and tablets)
- `app/(dashboard)/activity/page.tsx` — `PersonCard` (with the last sign-in's device and IP), `LoginCard`, `IdleCard`
  below `lg`, the tables from `lg`; filters full-width / shared on phones; no page padding of its own (the layout's
  `<main>` has it); an unknown status shows as itself.
- `app/(dashboard)/inactive-leads/page.tsx` — `LeadCard`, `MoveCard` below `lg` (why it won't move on its own and who
  lost it before written out), tables from `lg` with long names clamped to two lines (full name on hover); `HowBadge`
  (`compact` on cards); filters as above; an unknown state from the server shows as itself; still the Super Admin only.
- Both pages: the tab bar scrolls inside itself rather than widening the page on the narrowest phones.
- `components/shared/StatCard.tsx` — fills its grid cell, so a row of them is one height.
