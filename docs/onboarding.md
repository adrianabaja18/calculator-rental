# Team Onboarding & Hand-off Report

> **Read this first if you are joining the project.** It is updated at the end of every phase.
>
> **Last updated:** 2026-11-16, end of **Phase 2** (database schema)

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
| Central database, auth, realtime | Supabase (PostgreSQL 17) | `supabase/` |
| Offline store on the Pi | SQLite (better-sqlite3) | `apps/raspberry-pi/data` |

The deeper design is in [architecture.md](architecture.md), [database.md](database.md) and [raspberry-pi.md](raspberry-pi.md).

---

## 2. Project status

| Phase | Scope | Status |
|---|---|---|
| 1 | Project setup: monorepo, Next.js, Supabase clients, Pi app, SQLite, health checks | ✅ Done and verified |
| 2 | Database schema, migrations, seed, shared types, validation, QR parser | ✅ Built and tested locally. ⏳ Push to Supabase pending (§6). |
| 3 | Admin authentication, dashboard shell, navigation | ⬜ Next |
| 4 | Students, calculators and lockers pages | ⬜ |
| 5 | Rental backend: eligibility, availability, reservation | ⬜ |
| 6 | Coin payment sessions | ⬜ |
| 7 | Return backend, RFID verification, penalty engine | ⬜ |
| 8 | Realtime dashboard | ⬜ |
| 9 | Raspberry Pi service: state machine, adapters, device auth | ⬜ |
| 10 | ESP32-CAM QR firmware + serial link | ⬜ |
| 11 | Real hardware: RC522, relays/solenoids, coin selector, LCD, buzzer | ⬜ |
| 12 | Offline synchronization | ⬜ |
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
| `npm test` | All tests pass (70 at the end of Phase 2) |
| `npm run dev:web`, then open http://localhost:3000 | All status cards green |
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

## 6. Phase 2 hand-off: what was built and what's left

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

### Still to do for Phase 2 (project lead, once)
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
