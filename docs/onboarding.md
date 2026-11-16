# Team Onboarding & Hand-off Report

> **Read this first if you are joining the project.** It is updated at the end of every phase.
>
> **Last updated:** 2026-11-17, end of **Phase 5** (rental rules on the kiosk)

---

## 1. The project in one minute

A kiosk lends scientific calculators to students:

1. A student scans their **school ID QR code** (ESP32-CAM).
2. The **Raspberry Pi 4** checks with the backend that they may borrow.
3. They pay **₱5 in coins** (Allan 1239 coin selector).
4. The Pi unlocks a **12 V solenoid locker** and an **RC522 RFID reader** confirms the calculator was taken.
5. To return, they scan again. Only their locker opens, and RFID verifies it's the *right* calculator.

Officers watch everything on a **web dashboard**.

| Part | Tech | Folder |
|---|---|---|
| Admin dashboard + REST API | Next.js 16, React 19, TypeScript, Tailwind 4 | `apps/web` |
| Kiosk controller | Node.js 22 + TypeScript on Raspberry Pi 4 | `apps/raspberry-pi` |
| Shared types, validation, API contracts | TypeScript + Zod | `packages/shared` |
| **Main operating database** (on the kiosk) | SQLite (better-sqlite3) | `apps/raspberry-pi/data` |
| Cloud copy, admin data, officer auth, realtime | Supabase (PostgreSQL 17) | `supabase/` |

**Architecture: SQLite-first** (decided 2026-11-16). The kiosk records everything in its own SQLite database, so it keeps working with or without internet, and syncs to Supabase. The dashboard (deployed on Vercel) reads Supabase. Settings and other officer changes flow back down to the kiosk. See [architecture.md §3.8](architecture.md).

The deeper design is in [architecture.md](architecture.md), [database.md](database.md) and [raspberry-pi.md](raspberry-pi.md).

---

## 2. Project status

| Phase | Scope | Status |
|---|---|---|
| 1 | Project setup: monorepo, Next.js, Supabase clients, Pi app, SQLite, health checks | ✅ Done and verified |
| 2 | Database schema, migrations, seed, shared types, validation, QR parser | ✅ Done, pushed to Supabase and verified |
| 3 | Admin authentication, dashboard shell, navigation | ✅ Done and verified |
| 4 | Students, calculators and lockers pages (admin data lives in Supabase) | ✅ Done and verified |
| 5 | Rental rules: eligibility and availability, as shared logic run by the kiosk on SQLite | ✅ Built and tested. ⏳ Checklist pending (§6). |
| 6 | Coin payment sessions (kiosk-side, recorded in SQLite) | ⬜ Next |
| 7 | Return rules, RFID verification, penalty engine (shared logic) | ⬜ |
| 8 | Realtime dashboard | ⬜ |
| 9 | Raspberry Pi service: state machine, adapters, device auth | ⬜ |
| 10 | ESP32-CAM QR firmware + serial link | ⬜ |
| 11 | Real hardware: RC522, relays/solenoids, coin selector, LCD, buzzer | ⬜ |
| 12 | Two-way synchronization: SQLite ⇄ Supabase (outbox push, admin-change pull) | ⬜ |
| 13 | Error handling, audit logs, device monitoring | ⬜ |
| 14 | Testing, simulator, system validation | ⬜ |
| 15 | Deployment and final documentation | ⬜ |

**Rule for the team:** a phase is finished only when its verification checklist passes. Don't start the next phase on top of a broken one.

---

## 3. Pending decisions and reminders ⚠️

These block later phases. Whoever has the hardware, please fill them in.

| # | Item | Needed by | Status |
|---|---|---|---|
| 1 | Relay module polarity: **active-LOW or active-HIGH**? (Does the IN LED light when the pin is pulled LOW?) | Phase 11 | ⏳ **Deferred, reminder pending** |
| 2 | LCD size: **16×2 or 20×4**? | Phase 9 (messages) / 11 | ⏳ **Deferred, reminder pending** |
| 3 | Add a **3rd relay** to switch the coin selector's 12 V power? Otherwise coins inserted while idle are swallowed. | Phase 11 | Recommended, not decided |
| 4 | Add **2 reed switches** (door sensors)? | Phase 11 | Recommended, not decided |
| 5 | Real **RFID UIDs** of the two calculator tags and the real **calculator model** | Phase 11 (update seed/inventory) | Not collected yet |
| 6 | **Real-time clock (DS3231 RTC module)?** With SQLite-first, the Pi's clock sets due times. Without an RTC, the kiosk must wait for internet time sync after every boot (it's unplugged after school hours). | Phase 9 | ⏳ **Deferred by the team, decide later** |
| — | Pricing and after-hours rule | — | ✅ Decided 2026-11-17 (may change): **₱20 for 3 hours, then ₱20 per hour overdue**, and overdue time **keeps counting overnight** while the kiosk is off. Applied in migration `20261117000100`; the 10-minute grace period is kept. Still to settle in Phase 7: does a started hour count as a full hour (1 h 5 min late = ₱40, or ₱20)? |
| — | RFID reader model | — | ✅ **RC522** (13.56 MHz, SPI) |
| — | School ID QR format | — | ✅ `FULL NAME<TAB>10-digit student number<TAB>COURSE` |

---

## 4. Getting started (new teammate, from zero)

### 4.1 Install the tools
| Tool | Version | Check with |
|---|---|---|
| Node.js | 22 LTS (≥ 22.12) | `node -v` |
| npm | ≥ 10 | `npm -v` |
| Git | any recent | `git --version` |
| VS Code | recommended | — |

You don't need Docker. The Supabase CLI is installed by `npm install`.

### 4.2 Get the code
```bash
git clone https://github.com/adrianabaja18/calculator-rental.git
```
```bash
cd calculator-rental
```
```bash
npm install
```

### 4.3 Get the secrets (never from GitHub)
Ask the project lead for the Supabase values. They are shared **privately** (direct message), never in the repo, an issue or a public group chat.

```bash
cp apps/web/.env.example apps/web/.env.local
```
```bash
cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
```

Fill in `apps/web/.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (treat it like a password)

The Pi `.env` defaults work on a laptop.

### 4.4 Check that everything works
| Command | Expected result |
|---|---|
| `npm run typecheck` | No errors |
| `npm test` | All tests pass (168 at the end of Phase 5) |
| `npm run dev:web`, then open http://localhost:3000 | Redirects to the login page. After signing in, the Dashboard's system check cards are green. |
| `npm run check:pi` (second terminal, web running) | `SYSTEM CHECK PASSED` |

---

## 5. How we collaborate

### Branches and pull requests
- `main` must always run. **Nobody pushes directly to `main`.**
- Create a branch per task, for example `phase-3/admin-login` or `fix/health-check-timeout`.
- Open a pull request into `main`. **CI** (GitHub Actions) runs typecheck, tests and build automatically, and the PR template has a checklist.
- At least one teammate reviews before merging.

```bash
git switch -c phase-3/admin-login
```
```bash
git add -A
```
```bash
git commit -m "Add admin login page"
```
```bash
git push -u origin phase-3/admin-login
```

### Golden rules
1. **Never commit secrets** (`.env`, `.env.local`), database dumps, or **real student data**. Tests and seeds use fake people only.
2. **Never edit a migration that has already been pushed to Supabase.** Add a new migration file instead.
3. Database enum changed? Update `packages/shared/src/enums.ts` too. A test fails if they differ.
4. Business values (fee, duration, penalties) live in the `system_settings` table, **never hard-coded**.
5. Don't hard-code lockers (`if (locker === 1)`). Lockers come from the database.
6. The browser never controls hardware. Only the Raspberry Pi touches GPIO.

### Who runs database migrations
Only **one person** (the "DB owner", normally the project lead) pushes migrations to the shared Supabase project, after the PR is merged. Others write migrations and test them locally with `npm run test:db`. Teammates who need dashboard access to Supabase can be invited under Supabase **Organization → Team**.

---

## 6. Phase 5 hand-off: rental rules on the kiosk (SQLite-first)

Delivered as **two smaller PRs**, so reviewers (and Sourcery) can read them:
- **5a** `phase-5a/shared-rental-rules`: pure rules in `packages/shared/src/rental/`
- **5b** `phase-5b/kiosk-rental-service`: the kiosk's SQLite tables and rental service

### Built
**Shared rules** (`packages/shared/src/rental/`): pure functions with no database or hardware, so they're easy to test and explain.
| Function | Rule |
|---|---|
| `checkBorrowEligibility` | Refuses blocked or inactive students, anyone with an open rental (Rule 1, including a duplicate scan mid-payment), and unpaid penalties when the setting is on. |
| `selectLockerForRental` / `isLockerAssignable` | Lends a locker only if the database says available **and** the RFID reader sees the expected tag **and** the lock is closed (spec §5.14). Lowest locker number first. |
| `findInventoryMismatches` | Finds lockers that should hold a calculator but whose reader sees nothing or the wrong tag. |
| `RENTAL_TRANSITIONS`, `assertTransition` | The rental state machine. For example, it's impossible to open a locker before payment, cancel a paid rental, or reuse a completed one. |
| `computeDueAt`, `isOverdue`, `overdueMinutes` | Due time is the rental time plus the duration (3 h). Overdue starts the moment that time passes. |
| `generateTransactionCode` | Kiosk-made codes such as `RNT-20261117-K001-7F3A` |
| `systemSettingsFromRow` | Converts a Supabase settings row into validated kiosk settings, and rejects invalid ones. |

**Kiosk SQLite**: migration 2 in `apps/raspberry-pi/src/db/migrations.ts`.
- Tables `settings`, `students`, `lockers`, `calculators`, `rentals`, `penalties`, `device_events` and `sync_queue`. Names mirror Supabase, which makes syncing a straight copy.
- These replace the spec's cache-style names (`cached_students`, `offline_transactions`, …), because under SQLite-first this is the main database.
- Money is stored in **centavos** (whole numbers), so there are no rounding errors.
- SQLite enforces one open rental per student, calculator and locker. It also blocks "paid" without full payment, and "active" without confirmed removal.
- **Outbox:** every change writes a `sync_queue` row in the same transaction, so nothing is saved without being scheduled for upload. Phase 12 sends the queue to Supabase.

**Rental service** (`apps/raspberry-pi/src/rental/rental-service.ts`):
| Step | Status after |
|---|---|
| `startRental(qr)`: parse QR, register a new student, check eligibility, pick a locker, reserve it | PAYMENT_PENDING (locker RESERVED) |
| `markPaid(id, amount)`: refused if below the fee (Phase 6 calls this) | PAID |
| `startDispensing(id)`: one payment opens exactly one locker | DISPENSING (locker OPEN) |
| `confirmRemoval(id, sensors)`: refused while the reader still sees the calculator | **ACTIVE**, due in 3 h (calculator and locker RENTED) |
| `cancelRental` (payment timeout) / `failDispensing` (locker or removal problem; officer follows up on the refund) | CANCELLED / FAILED (locker freed) |

Each step is atomic and runs only if the rental is still in the expected status, so a repeated or late call can't apply the same step twice. Events (`QR_SCANNED`, `QR_INVALID`, `INVENTORY_MISMATCH`, `LOCKER_UNLOCK_REQUESTED`, `RENTAL_STARTED`, `PAYMENT_TIMEOUT`, …) are logged for the Event Logs page.

**Dev tools:**
- `npm run demo:pi` prints a full borrow and every refusal case as LCD screens.
- `npm run seed:pi` loads the same fake data as Supabase (same IDs) into the kiosk's SQLite file.

**Tests:** 68 new (43 shared-rule tests, 25 kiosk service tests). They cover the spec's borrowing list: valid and invalid student, active rental, no calculator, insufficient and successful payment, correct locker, removal, duplicate prevention.

### Not yet (by design)
- The kiosk **state machine**, LCD and hardware that call this service: Phases 9–11.
- **Coins:** Phase 6 builds the coin session that calls `markPaid`.
- **Uploading the outbox** to Supabase and pulling officer changes down: Phase 12. Until then, kiosk rentals don't appear on the dashboard.

### Phase 5 verification checklist
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **168 passed**
- [ ] `npm run demo:pi` shows, in order:
  - Juan's quote (**P20, 3 Hours, Locker 1**)
  - **RENTAL SUCCESS** with a due time 3 hours later
  - the refusals: ACTIVE RENTAL, ACCOUNT BLOCKED, INVALID ID, NO CALCULATOR
  - Locker 2 *not* handed out when its reader sees nothing
- [ ] `npm run seed:pi` reports `students=5 lockers=2 calculators=2 settings=1`, and running it twice gives the same numbers
- [ ] `npm run check:pi` shows `Schema migrations — user_version=2, expected=2`

---

## 6.0 Phase 4 hand-off (completed): students, calculators and lockers

### Built
- **Students** (`/students`)
  - Search by name, student number or course, and filter by status. Filters live in the URL, so they survive a refresh.
  - Columns: name and student number, course, current rental (with calculator and due time), rental count, overdue count, unpaid penalties, status.
  - **Block / Unblock** (Officer and above). Blocking needs a reason. A student who is blocked can still *return* a calculator.
- **Calculators** (`/calculators`)
  - Columns: code and model, RFID UID, locker, status and condition, current borrower and due time, last transaction and rental count.
  - **Add calculator.** The next code is suggested. RFID UIDs are accepted in any reader format and saved as `04-A1-B2-C3-D4`. A calculator becomes AVAILABLE only once it has a locker and isn't DAMAGED.
  - **Edit, Maintenance and Reactivate.** A calculator out with a student can't change locker or RFID tag, and can't go into maintenance. An AVAILABLE calculator can't lose its locker or be marked DAMAGED.
- **Lockers** (`/lockers`)
  - Shows the database status *next to* what the kiosk's sensors report (lock, door, RFID tag seen), plus "Ready to lend" from `v_lockers.is_assignable`.
  - A red banner appears on an **inventory mismatch**, where the system expects a calculator but the reader doesn't see it.
  - **Edit** (name and notes) and **Maintenance on/off**. **Unlock** is shown disabled until the kiosk command channel exists (Phase 13).
- **Every officer action:**
  - re-checks the role on the server
  - validates input with Zod
  - writes with the server key (dashboard users stay read-only in RLS)
  - records before/after values in `audit_logs`
  - shows a toast
  - asks for confirmation in a dialog that blocks double-submits
  - Under SQLite-first, the kiosk picks these changes up on its next sync (Phase 12).
- **Migration `20261117000100_pricing_and_admin_views.sql`** (already pushed to Supabase):
  - the new pricing
  - views `v_students` and `v_calculators`, which give each page its counts and current borrower in a single query
- **Reusable UI** in `src/components/ui/`:
  - `ActionDialog` (confirmation and form dialog bound to a Server Action)
  - `ToastProvider` / `useToast`
  - `TableCard` / `Th` / `Td` / `EmptyRow`
  - `FilterBar`
  - form fields
- **Helpers** in `src/lib/`:
  - `status-tones.ts` (badge colors per status, as in the spec)
  - `format.ts` (pesos, PH time, relative time, and `cleanSearch` so search text can't change a database filter)
  - `action-result.ts` (consistent results and friendly database error messages)
- 11 new tests (2 database view tests, 9 formatting and search-cleaning tests), 100 in total.

### Adding an officer action (how-to)
1. Write a `'use server'` function `(prev, formData) => Promise<ActionResult>` in the page's `actions.ts`.
2. Inside it: `requireAdmin(AdminRole.OFFICER)`, Zod `safeParse`, write with `createSupabaseAdminClient()`, `writeAuditLog(...)`, `revalidatePath(...)`, then return `actionOk(...)`.
3. In the page, wrap it in `<ActionDialog action={...} hidden={{ id }}>…fields…</ActionDialog>`.

### Phase 4 verification checklist
Sign in as your Super Admin, then check:
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **100 passed**
- [ ] **Students** lists the 5 seed students. Searching `maria` or `BSCpE` filters the list. **Clear** resets it.
- [ ] Block **Juan Dela Cruz** with a reason. You see a green toast, a red BLOCKED badge and the reason. Unblock him again.
- [ ] Try to block without a reason. The dialog stays open with an error.
- [ ] **Calculators** shows CALC-001 and CALC-002 in Locker 1 and Locker 2.
- [ ] Add **CALC-003** with RFID `04:11:22:33:44` and **no locker**. It's saved as `04-11-22-33-44` with status MAINTENANCE.
- [ ] Add another calculator with RFID `04-A1-B2-C3-D4`. You're told "That RFID tag is already assigned to another calculator."
- [ ] Move **CALC-002** to maintenance (reason required), then **Reactivate** it.
- [ ] **Lockers** shows both lockers as AVAILABLE, with lock, door and RFID `UNKNOWN` and the kiosk `NEVER_SEEN`. That's correct until the Pi is connected, so "Not lendable right now" is also correct.
- [ ] Put **Locker 2** in maintenance and end it again.
- [ ] Supabase SQL Editor: `select action, target_type, reason from audit_logs order by id desc limit 10;` lists your STUDENT_BLOCKED, CALCULATOR_CREATED, CALCULATOR_MAINTENANCE, LOCKER_MAINTENANCE and other actions.
- [ ] Optional cleanup: CALC-003 can't be deleted (inventory history is kept). Leave it in maintenance, or reuse it later.

---

## 6.1 Phase 3 hand-off (completed): admin authentication and dashboard shell

### Built
- **Login** at `/login`: email and password through Supabase Auth, using a Server Action and `useActionState`.
  - Inputs are validated with Zod on the server.
  - The error is the same for an unknown email and a wrong password, so nobody can probe which accounts exist.
  - A signed-in user whose profile isn't active is signed straight back out with a clear message.
  - Logins, rejected logins and logouts are written to `audit_logs`, and `profiles.last_login_at` is updated.
- **Two-layer protection**, the pattern recommended by Next.js 16:
  1. `src/proxy.ts` (Next 16's replacement for `middleware.ts`) refreshes the session cookie on every page request and redirects signed-out visitors to `/login?next=<page>`. It's a fast, optimistic check only.
  2. `requireAdmin(role)` in `src/lib/auth/session.ts` is the **real** check. It verifies the JWT, loads the profile from the database, and sends the user to `/login`, `/pending` (inactive account) or `/dashboard?denied=1` (role too low). Every dashboard layout, page and Server Action calls it.
- **Role hierarchy** `VIEWER < OFFICER < SUPER_ADMIN` via `hasRole()` in `packages/shared/src/roles.ts`. The sidebar hides links a role can't use, but each page checks again, because hiding a link isn't security.
- **Open-redirect protection:** `?next=` only accepts paths inside this app (`safeNextPath`).
- **Dashboard shell:** a responsive sidebar (a slide-in drawer on phones), a header with the officer's name, role and Sign out, plus loading, error and 404 states.
- **All 12 pages are routed:** Dashboard, Active Rentals, Transaction History, Payments, Penalties, Calculators, Lockers, Students, Device Status, Event Logs, Audit Log (Officer and above) and Settings. Each one not built yet shows which phase builds it and what it will contain.
- The Phase 1 system check now lives on the Dashboard page. `/` simply redirects to it.
- All three Supabase clients are typed with the generated `database.types.ts`, so queries are checked against the real schema.
- 19 new tests (role hierarchy and redirect safety), 89 in total.

### Where the code lives
| File | Purpose |
|---|---|
| `apps/web/src/proxy.ts` | Session refresh and optimistic redirects |
| `apps/web/src/lib/auth/session.ts` | `getCurrentAdmin()` and `requireAdmin()`, the security check |
| `apps/web/src/lib/auth/actions.ts` | `signIn` and `signOut` Server Actions |
| `apps/web/src/lib/audit.ts` | `writeAuditLog()` helper |
| `apps/web/src/app/login/`, `app/pending/` | Public auth pages |
| `apps/web/src/app/(dashboard)/` | Every protected page. The `(dashboard)` folder name doesn't appear in URLs. |
| `apps/web/src/components/layout/` | Sidebar, header, icons, navigation list |

### Adding a new dashboard page (how-to)
1. Create `apps/web/src/app/(dashboard)/<name>/page.tsx`.
2. Make `await requireAdmin(AdminRole.<minimum role>)` the page's first line.
3. Add the link to `NAV_SECTIONS` in `components/layout/nav-items.ts`.

### Phase 3 verification checklist
- [ ] `npm run typecheck` shows no errors
- [ ] `npm test` reports **89 passed**
- [ ] Signed out, visiting http://localhost:3000/students redirects to `/login?next=%2Fstudents`
- [ ] A wrong password shows "Invalid email or password."
- [ ] Signing in with your Super Admin account opens **Students** (the page you originally asked for)
- [ ] The sidebar shows all 12 pages, and the header shows your email and "Super Admin"
- [ ] The Dashboard's system check cards are all green
- [ ] On a narrow window or a phone, the ☰ button opens and closes the menu
- [ ] **Sign out** returns to `/login`. Pressing Back doesn't show dashboard data.
- [ ] Supabase SQL Editor: `select action, actor_label, created_at from audit_logs order by id desc limit 5;` shows your `LOGIN` and `LOGOUT`
- [ ] Optional role test: create a second user. It shows "not been activated" until you set `is_active = true`. As a `VIEWER` it can't see **Audit Log**, and opening `/audit` directly shows "Your role doesn't have access to that page."

---

## 6.2 Phase 2 hand-off (completed): database

### Built
- **Database schema** in 5 migrations under `supabase/migrations/`:
  - 19 enum types and 14 tables with foreign keys, unique and check constraints, and indexes
  - triggers: `updated_at`, auto-create a profile for new users, history cannot be deleted, audit log is append-only
  - Row Level Security: the public key gets nothing, admins get read-only access, all writes go through the server
  - views: `v_rentals` (live OVERDUE), `v_lockers` (`is_assignable` requires the RFID reader to agree with the database), `v_device_status` (online or offline from the heartbeat)
- **Seed data** (`supabase/seed.sql`, fake): 1 kiosk, Locker 1 and 2, CALC-001 and CALC-002 (fake UIDs `04-A1-B2-C3-D4` and `04-E5-F6-A7-B8`), and 5 fake students, one of them blocked. Default settings (₱5, 2 h, 10 min grace, ₱5/hour penalty) come from migration 0002.
- **Shared code** in `packages/shared`:
  - `enums.ts`: every status as constants mirroring the database
  - `validation.ts`: student number, RFID UID normalizer, money, and settings validation
  - `qr.ts`: `parseStudentQr()` for the school-ID format, with a fallback when a scanner turns tabs into spaces
- **Tests**, 70 in total, run with `npm test`. The database tests run the real migrations in PGlite (Postgres in-process) and check every design rule: one open rental per student and per calculator, no payment bypass, no ACTIVE without removal, no COMPLETED without the right RFID, history can't be deleted, and RLS.
- **Tooling:** Supabase CLI config (`supabase/config.toml`, public sign-up disabled), CI workflow, PR template, `.gitattributes` (LF line endings for the Pi).

### Design decisions made in Phase 2 (and why)
| Decision | Reason |
|---|---|
| A calculator has no `OVERDUE` status. Overdue lives only on the rental. | Avoids two tables disagreeing (spec: "don't duplicate status semantics") |
| The locker↔calculator link is stored once, on `calculators.locker_id` | The locker's "expected RFID" is derived, so it can never go stale |
| Students use one `status` enum (`ACTIVE` / `BLOCKED` / `INACTIVE`) instead of `status` plus a `blocked` boolean | One source of truth |
| Penalty type `PER_INTERVAL` with `penalty_interval_minutes` (60) replaces "hourly" | Same behavior; the interval is configurable |
| Penalty balance is computed by the database (`amount_due`) | Can't drift or go negative |
| A rental stores a `settings_snapshot` | Changing settings later doesn't change what a past rental owes |
| `system_settings` is one typed row, not key/value pairs | Invalid settings are impossible at the database level |
| Device secrets live in a separate `device_credentials` table | Locked away from every dashboard user |
| History tables refuse `DELETE` even with the service-role key | Rules 12 and 13 hold even if the API has a bug |

### Setting up a Supabase project (done once by the project lead; repeat only for a new project)
1. Log in to the Supabase CLI. This opens a browser to approve.
   ```bash
   npm run db:login
   ```
2. Link the repo to your project. Find `<project-ref>` in the Supabase URL `https://<project-ref>.supabase.co`. If you're asked for a password, it's the **database** password you chose when creating the project.
   ```bash
   npm run db:link -- --project-ref <project-ref>
   ```
3. Preview what would be applied:
   ```bash
   npx supabase db push --remote --dry-run
   ```
4. Apply the migrations and the development seed:
   ```bash
   npm run db:push:seed
   ```
5. Generate typed database definitions (used from Phase 3):
   ```bash
   npm run db:types
   ```
6. In the Supabase dashboard, open **Authentication → Sign In / Providers** and turn **off "Allow new users to sign up"**.
7. Create the first admin:
   - In **Authentication → Users → Add user**, enter your email and a password, and tick *Auto Confirm User*.
   - Activate them as SUPER_ADMIN by running this in the **SQL Editor**:
     ```sql
     update public.profiles set role = 'SUPER_ADMIN', is_active = true where email = 'your-email@example.com';
     ```

### Phase 2 verification checklist
- [ ] `npm run typecheck` shows no errors
- [ ] `npm test` reports **70 passed**
- [ ] `npm run db:push:seed` finishes without errors
- [ ] Supabase **Table Editor** shows 14 tables. `students` has 5 rows, `calculators` 2, `lockers` 2, `system_settings` 1.
- [ ] Supabase **Database → Views** (or the SQL Editor) shows `v_rentals`, `v_lockers`, `v_device_status`
- [ ] SQL Editor `select * from v_lockers;` returns 2 rows with `is_assignable = false`. This is correct, because the kiosk hasn't reported RFID yet.
- [ ] `npm run db:types` creates `apps/web/src/lib/supabase/database.types.ts`
- [ ] Your admin row in `profiles` has `role = SUPER_ADMIN` and `is_active = true`
- [ ] `npm run dev:web` still shows all green on http://localhost:3000

---

## 7. Repository map

```
calculator-rental-system/
├─ apps/web/                Next.js dashboard + API   (src/app, src/lib, src/components)
├─ apps/raspberry-pi/       Kiosk service             (src/, scripts/check-system.ts)
├─ packages/shared/         enums, validation, QR parser, API contracts (+ *.test.ts)
├─ supabase/
│  ├─ config.toml           Supabase CLI configuration
│  ├─ migrations/           SQL migrations (0001 enums … 0005 views)
│  ├─ seed.sql              fake development data
│  └─ tests/                PGlite schema tests
├─ docs/                    architecture, database, raspberry-pi, onboarding (this file)
├─ .github/                 CI workflow + PR template
└─ vitest.config.ts         test runner for the whole repo
```

## 8. Command reference (run from the repository root)

| Command | What it does |
|---|---|
| `npm run dev:web` | Dashboard and API at http://localhost:3000 |
| `npm run dev:pi` | Pi kiosk service (mock hardware), restarts on save |
| `npm run check:pi` | Pi system check: SQLite + backend |
| `npm run demo:pi` | Phase 5 demo: a full borrow and the refusal cases on a throwaway database, printed as LCD screens |
| `npm run seed:pi` | Load the fake development data into the kiosk's SQLite file. Add `-- --sensors-ready` to simulate both calculators detected. |
| `npm run typecheck` | Type-check everything |
| `npm test` | All tests |
| `npm run test:db` | Database schema tests only |
| `npm run build:web` | Production build |
| `npm run db:login` / `db:link` | Connect the Supabase CLI to the project |
| `npm run db:push` | Apply new migrations to Supabase |
| `npm run db:push:seed` | Apply migrations and the development seed |
| `npm run db:types` | Regenerate TypeScript types from the live database |

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 3000 is in use` | Another dev server is running. Close it, or find it with `netstat -ano \| findstr :3000`. |
| Supabase cards are amber ("Not configured") | `apps/web/.env.local` is missing or the variables are empty. Restart `npm run dev:web` after editing. |
| Supabase cards are red ("Error") | Wrong key. Copy it again from Project Settings → API Keys. |
| `check:pi` fails with `NETWORK_OFFLINE` | The web app isn't running, or `BACKEND_URL` is wrong |
| `[config] Invalid Raspberry Pi configuration` | Fix the listed variable in `apps/raspberry-pi/.env` |
| `npm run db:push` asks for a password | That's the **database** password from project creation. It's resettable in Project Settings → Database. |
| A test says an enum doesn't match | You changed a database enum without updating `packages/shared/src/enums.ts`, or the other way round |

## 10. Glossary

| Term | Meaning |
|---|---|
| RLS | Row Level Security: Postgres rules that decide which rows each user may see |
| Service-role key | Supabase key that bypasses RLS. Server only, never in the browser, on the Pi or on the ESP32. |
| Migration | A versioned SQL file that changes the database schema |
| Seed | Fake starter data for development |
| Idempotency key | A unique ID on a request, so retrying it can't do the action twice |
| Open rental | A rental in any status from PENDING to RETURNING; it still "holds" its calculator |
| PGlite | Postgres compiled to WebAssembly, used to test migrations without Docker |
