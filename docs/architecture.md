# System Architecture

**Project:** Design and Implementation of a Raspberry Pi 4-Based Smart Calculator Rental and Return Locker System Using QR Code Identification (CPE 411)

## 1. High-level architecture

```
                        ┌──────────────────────────────────────────────┐
                        │              SUPABASE (cloud)                │
                        │  PostgreSQL  (cloud copy + admin data, RLS)  │
                        │  Auth        (admin/officer logins)          │
                        │  Realtime    (live dashboard updates)        │
                        │  pg_cron     (overdue processing)            │
                        └───────────────▲──────────────▲───────────────┘
                     service-role key   │              │  anon key + admin JWT
                     (server only)      │              │  (RLS-restricted, read + realtime)
                        ┌───────────────┴──────────────┴───────────────┐
                        │        NEXT.JS WEB APP  (apps/web)           │
                        │  • Admin dashboard (React 19 + Tailwind)     │
                        │  • REST API route handlers  /api/...         │
                        │  • Sync API: receives kiosk records,         │
                        │    sends admin changes down to the kiosk     │
                        │  • Admin actions (settings, blocks, waivers) │
                        └───────────────▲──────────────────────────────┘
                 HTTPS + per-device     │                   ▲ HTTPS (browser)
                 credential + idempotency keys              │
                        ┌───────────────┴───────────┐   ┌───┴───────────────┐
                        │ RASPBERRY PI 4 (apps/      │   │ Officer's browser │
                        │ raspberry-pi) Node.js + TS │   │ (dashboard only,  │
                        │ • Kiosk state machine      │   │  never GPIO)      │
                        │ • SQLite = MAIN operating  │   └───────────────────┘
                        │   database + business rules│
                        │ • Hardware adapters        │
                        └──┬─────┬─────┬─────┬────┬──┘
                   USB-UART│  SPI│  I2C│ GPIO│GPIO│
                    ┌──────┘     │     │     │    └──────────┐
              ┌─────┴─────┐ ┌────┴───┐ │ ┌───┴──────────┐ ┌──┴─────────────┐
              │ ESP32-CAM │ │2× RFID │ │ │2× relay →    │ │ Coin selector  │
              │ + OV2640  │ │readers │ │ │12 V solenoid │ │ (pulse output, │
              │ QR decode │ │        │ │ │locks         │ │ via optocoupler)│
              └───────────┘ └────────┘ │ └──────────────┘ └────────────────┘
                                 ┌─────┴──────┐  + buzzer, optional door reed switches
                                 │ I2C LCD    │
                                 └────────────┘
```

**Golden rule:** the browser never touches hardware, the ESP32-CAM never touches the internet, and the Raspberry Pi never holds Supabase credentials. Each layer talks only to its neighbour.

## 2. How the technologies work together

| Technology | Role in this project |
|---|---|
| **React 19** | Builds the admin dashboard UI (tables, cards, countdowns, dialogs). Runs in the officer's browser. |
| **Next.js 16** | Hosts the React dashboard *and* the backend REST API (route handlers under `src/app/api`). One deployable app, no separate Express server. |
| **TypeScript** | Used everywhere: web, Pi service, and `packages/shared`. Shared types and Zod schemas guarantee the Pi and the API agree on every request and response. |
| **Node.js 22** | Runtime for the Next.js server and the Raspberry Pi service. |
| **Supabase** | The **cloud copy** of everything the kiosk records, and the **main copy** of admin-managed data (settings, inventory setup, student blocks, waivers). Also provides Auth (officer logins), Realtime (live dashboard) and Row Level Security. |
| **SQLite** | The kiosk's **main operating database** (SQLite-first, decided 2026-11-16). Every rental, return, payment and event is written here first, so the kiosk works with or without internet, and is then synced to Supabase. |
| **Raspberry Pi 4** | Main embedded controller. Runs the kiosk state machine and the rental/payment/return rules, and drives the LCD, relays, solenoids, RFID readers, coin selector and buzzer. Syncs with the backend over HTTPS. |
| **Vercel** | Hosts the Next.js dashboard and API in production (Phase 15). |
| **Students' phones** | Since Phase 14d, the ID scanner. The `/scan` page decodes the student-ID QR **on the phone** and sends only the text, tied to a 6-digit code shown on the kiosk LCD (§3.10). |
| **ESP32-CAM** | Retired in Phase 14d (image quality too low). It was a dedicated QR scanner on USB serial; the code remains as the `serial` scanner option. |

## 3. Key design decisions (recommended options)

### 3.1 Monorepo with npm workspaces
`apps/web`, `apps/raspberry-pi`, and `packages/shared` live in one repository. npm workspaces ship with Node, so no extra tool (pnpm or turbo) is needed. The shared package is TypeScript source compiled by each consumer: Next uses `transpilePackages`, and the Pi runs it through `tsx`.

### 3.2 Backend = Next.js route handlers (no separate server)
The specification asks for Next.js route handlers, which keeps one deployable unit. Every protected operation goes through server code that validates input with Zod, so the browser is never trusted directly (Rule 15).

With SQLite-first (§3.8), the rental, payment, return and penalty rules run **on the Pi**. They are written once as pure TypeScript functions in `packages/shared`, so they are unit-tested on a laptop and can also be reused by the server. The server still validates every record the Pi syncs (Rule 14) and enforces the database constraints from Phase 2.

### 3.3 Three Supabase clients
| File | Key | Used by | RLS |
|---|---|---|---|
| `lib/supabase/client.ts` | anon / publishable | Browser: login, Realtime | Enforced |
| `lib/supabase/server.ts` | anon + admin cookie session | Server Components and admin APIs acting *as the officer* | Enforced |
| `lib/supabase/admin.ts` | service role / secret | Device APIs and server jobs, **after** our own authorization check | Bypassed |

`server-only` imports make the build fail if the service-role client is ever imported into browser code.

### 3.4 Device authentication (replaces a single shared `DEVICE_API_SECRET`)
**Recommended:** each Raspberry Pi gets its own random secret.
- `device_registry` stores only the **SHA-256 hash** of the secret, plus `enabled`, `last_heartbeat_at`, `software_version`, `location`.
- The Pi sends `X-Device-Id` and `Authorization: Bearer <secret>` over HTTPS.
- Every state-changing request carries an `Idempotency-Key` (a UUID). The server records processed keys, so a retried or replayed request returns the original result instead of acting twice. This covers double payments, double unlocks and duplicate sync.
- A request timestamp is checked within a ±5 minute window to reject stale replays. Offline records keep their own `occurred_at`.
- Disabling a device in the dashboard revokes it immediately.

Why not one global secret in `.env`? Per-device credentials can be revoked individually, are auditable per kiosk, and support adding a second kiosk later without code changes.

### 3.5 ESP32-CAM ↔ Pi: USB serial (UART) with newline-delimited JSON
> Retired in Phase 14d: see §3.10.

**Recommended over HTTP or WebSocket for the prototype.**
- One USB cable gives both power and data (`/dev/ttyUSB0`).
- No Wi-Fi on the ESP32, so no network credentials on it, lower power draw and no IP configuration.
- Message example: `{"type":"qr","seq":42,"data":"<raw QR text>"}`
- The ESP32 forwards **raw** QR text only. The Pi and the backend parse and validate it, so the QR format can change without reflashing the ESP32.

### 3.6 Overdue status: computed, never dependent on a screen being open
- **On the dashboard:** the `v_rentals` view computes `effective_status = OVERDUE` whenever `status = ACTIVE AND now() > due_at`.
- **On the kiosk:** the same rule runs from `packages/shared` against SQLite, so returns are judged correctly even offline.
- **Optional persistence:** a `pg_cron` job can later store `status = OVERDUE` and raise notifications. The computed rule stays correct even if the job is late.

### 3.7 Time
All databases store **UTC** (`timestamptz` in PostgreSQL, ISO-8601 strings in SQLite). Only the UI and the LCD convert to `Asia/Manila`, using helpers in `packages/shared/src/time.ts`.

**Operating hours (decided 2026-11-27).** Settings define the opening hours (default Mon–Fri 9:00–17:00 Manila), closed dates, and `pauseClockOutsideHours` (default on).
- **Borrowing** is refused outside operating hours (`KIOSK_CLOSED`, LCD `KIOSK CLOSED / OPEN WED 9:00AM`). **Returns** are always accepted.
- With pausing on, **due time** = rented_at + duration counted only in open hours (`addOperatingMinutes`), and **lateness** = open minutes after due_at (`operatingMinutesBetween`). This replaces "late time keeps counting overnight". Example: rented Tue 15:00 for 3 h → due Wed 10:00.
- The same rule runs on the kiosk (TypeScript, `packages/shared/src/rental/operating-hours.ts`) and in Supabase (`operating_minutes_between()`, used by `v_rentals.overdue_minutes_now`). Tests check that both give the same answers. Manila has no DST, so it's always UTC+8.
- A rental keeps the settings snapshot from when it started.

With SQLite-first, the **Pi's clock** sets `rented_at` and `due_at`. The Pi 4 has no battery-backed clock, so:
- On boot, the kiosk stays in a **STARTING / "Please wait"** state until the system clock has synced over the internet (NTP). Only then does it accept rentals.
- When syncing, the server compares the Pi's clock with its own and records any drift as a `WARNING` device event.
- **Deferred decision:** adding a DS3231 real-time clock module would let the kiosk keep correct time when it boots without internet (see `onboarding.md` §3).

### 3.8 SQLite-first data ownership (decided 2026-11-16)
The kiosk must keep working 24/7 even if the internet drops, so the **Pi's SQLite database is the main operating database**. Supabase receives a copy and is what the dashboard (on Vercel) shows.

| Data | Main copy | Sync direction |
|---|---|---|
| Rentals, returns, kiosk payments, coin events, device events, locker sensor state | **Pi (SQLite)** | Pi → Supabase |
| Students first seen at the kiosk | **Pi** creates them | Pi → Supabase |
| Settings, calculator and locker setup, student blocks, officer-recorded penalty payments and waivers | **Supabase** (edited on the dashboard) | Supabase → Pi |

**Sync rules**
- Every record created on the Pi gets a **UUID on the Pi**, so a re-sent record is recognized and never duplicated (idempotent upsert).
- **Push** (Pi → Supabase): an outbox table in SQLite (`sync_queue`) is drained in order, with retries and exponential backoff. A record is marked synced only after the server confirms it.
- **Pull** (Supabase → Pi): the Pi asks for admin changes made since its last pull, using a version or `updated_at` cursor, and applies them locally.
- **Conflicts:** each kind of data has exactly one owner (table above), so the two sides never edit the same field. The one shared case, a student's status, is set by officers and only read by the kiosk.
- The server **re-validates** everything it receives (Rule 14). Phase 2's database constraints remain the final safety net.

**Behavior**
| Situation | What happens |
|---|---|
| Online (normal) | The kiosk works from SQLite and syncs within seconds; the dashboard is near-real-time. |
| Internet drops | Rentals and returns continue. Records queue in SQLite, and the dashboard shows "Kiosk offline, last synced X min ago". |
| Officer changes something while the kiosk is offline | It reaches the kiosk on reconnection (for example, a student blocked from the dashboard can still borrow until then). |
| Kiosk unplugged after school hours | On the next boot it waits for clock sync, then flushes its queue before or while serving students. |

**Assumption:** one kiosk. With several kiosks offline at the same time, one student could borrow from each. Supabase's one-open-rental rule would reject the second rental at sync time and flag it for officers.

**Power-off safety:** SQLite runs in WAL mode with `synchronous=FULL`, so committed records survive a power cut. Pulling the plug can still damage the SD card's file system, so Phase 15 adds a safe-shutdown button or a read-only root file system.

### 3.9 Two-way sync as built (Phase 12)
```
 KIOSK (SQLite)                                  SUPABASE
 every change ─► sync_queue (outbox)
 every 10 s:  POST /api/device/sync  ─────────►  apply_kiosk_sync(): items applied IN ORDER,
              {items:[{seq,entity,payload}]}     one sub-transaction each; reply says how far
              ◄─── {appliedThroughSeq, failure}   it got → kiosk marks those synced
 every 60 s:  GET  /api/device/sync  ─────────►  settings + this kiosk's lockers + calculators
              ?students=…&penalties=…            (complete) + students/penalties changed since
              ◄─── officer data (paged)           the cursors → kiosk.applyPull()
 every 30 s:  POST /api/device/heartbeat  ────►  online status, sync health, live locker sensors
```
**Outbox entities:** `student`, `rental`, `payment`, `penalty`, `coin_event`, `device_event`, `locker_state`, `calculator_state`. Each payload is the full SQLite row at the time of the change, so re-sending is harmless.

**Who wins (field ownership)**
| Kiosk owns | Officers own (dashboard) |
|---|---|
| Rentals, payments, coins, device events | Settings |
| Student name/course (from their ID scans), new students | Student status and blocked reason |
| Penalty amounts and coin payments | Penalty **waivers** (merged: `calculated − waived − paid`) |
| Workflow statuses: locker RESERVED/OPEN/RENTED/RETURNING/AVAILABLE, calculator RENTED/AVAILABLE | Locker number/name/channel; calculator code/model/**RFID UID**/locker/condition |
| Live sensor state (via heartbeat) | Out-of-service statuses: locker MAINTENANCE, calculator MAINTENANCE/MISSING/DISABLED |

- The kiosk's `AVAILABLE` never ends an officer's maintenance. A workflow status (the locker is actually in use) is always recorded.
- On the kiosk, an officer status is applied only when no rental is using that locker or calculator.
- A rental an officer resolved by hand (`resolved_by`) is never overwritten by the kiosk.

**Failures:** if Supabase refuses an item, nothing after it is applied, and the kiosk retries it with back-off (10 s, 20 s, 40 s … up to 10 min). After 20 attempts the item is set aside (`failed_at`), a CRITICAL `SYNC_FAILED` event is logged, and the rest continue. The heartbeat reports `failedItems`, which marks the device DEGRADED on the dashboard. Synced outbox rows are deleted after 7 days.

### 3.10 Phone ID scanning (Phase 14e, decided 2026-11-28)
The kiosk has no camera. Because the web app runs **on the Pi** with the same SQLite file as the kiosk (local-first, see [raspberry-pi-local-setup.md](raspberry-pi-local-setup.md)), identification needs **no internet**, only the kiosk's LAN or Wi-Fi hotspot:
1. **Kiosk** (any button at idle) → `startScanSession()` writes a random 6-digit code to `scan_sessions` (SQLite migration 7), valid 2 min. The LCD shows it with a countdown. A new code ends the previous one.
2. **Phone** → `http://<pi-ip>:3000/scan` (public page, no login; opened from a printed sticker). The QR is decoded **on the phone** (BarcodeDetector, else jsQR with several sizes, a centre crop and a contrast boost). `POST /api/scan {code, qr}` → the web app parses the QR again (Rule 14) and calls `submitScan()`.
3. **Kiosk** checks every 0.5 s with `takeScan()`, which hands the text over **once** and deletes it; the kiosk then runs the normal borrow/return flow.

All three functions live in `packages/shared/src/sqlite-node.ts`, so the kiosk and the web app use the same rules.

Security: the code proves physical presence (only the LCD shows it); it is single-use and short-lived. Wrong codes are counted per phone (SHA-256 of its address with a per-Pi random salt; no addresses stored): 10 in 10 minutes → refused. The photo never leaves the phone. The online (cloud) dashboard refuses `/api/scan`: scanning only happens on the Pi.

Limit: phones only allow the **live** camera view on https. Over the Pi's plain `http://` address, **Take or upload a photo** works (it opens the phone's own camera app).

## 4. Folder structure

```
calculator-rental-system/
├─ package.json              # npm workspaces + root scripts
├─ tsconfig.base.json        # strict TS settings inherited by every package
├─ .gitignore  .nvmrc
├─ README.md
├─ apps/
│  ├─ web/                   # Next.js 16 + React 19 + Tailwind 4 (dashboard + REST API)
│  │  ├─ .env.example
│  │  ├─ next.config.ts  postcss.config.mjs  tsconfig.json  package.json
│  │  └─ src/
│  │     ├─ app/             # pages (App Router) and api/ route handlers
│  │     ├─ components/      # UI components
│  │     └─ lib/             # env, supabase clients, http helpers, services
│  └─ raspberry-pi/          # Node.js + TS kiosk service
│     ├─ .env.example
│     ├─ data/               # local SQLite file (git-ignored)
│     ├─ scripts/            # check-system.ts and future simulators
│     └─ src/
│        ├─ config.ts  logger.ts  index.ts
│        ├─ db/              # SQLite connection + migrations
│        ├─ backend/         # HTTP client for the web API
│        ├─ hardware/        # (Phase 9+) interfaces + Real*/Mock* adapters
│        ├─ state/           # (Phase 9)  kiosk state machine
│        └─ sync/            # (Phase 12) offline queue + sync
├─ packages/
│  └─ shared/                # shared types, Zod schemas, constants, API contracts
├─ firmware/
│  └─ esp32-cam/             # (Phase 10) Arduino sketch for QR scanning
├─ supabase/
│  ├─ migrations/            # (Phase 2) SQL migrations
│  └─ seed.sql               # (Phase 2) development seed data
└─ docs/
   ├─ architecture.md        # this file
   ├─ raspberry-pi.md        # hardware wiring plan
   ├─ api.md                 # (Phase 5+)
   └─ database.md            # (Phase 2)
```
