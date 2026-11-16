# System Architecture

**Project:** Design and Implementation of a Raspberry Pi 4-Based Smart Calculator Rental and Return Locker System Using QR Code Identification (CPE 411)

## 1. High-level architecture

```
                        ┌──────────────────────────────────────────────┐
                        │              SUPABASE (cloud)                │
                        │  PostgreSQL  (source of truth, RLS enabled)  │
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
                        │  • Business rules: eligibility, payment,     │
                        │    penalties, reservations, sync ingestion   │
                        └───────────────▲──────────────────────────────┘
                 HTTPS + per-device     │                   ▲ HTTPS (browser)
                 credential + idempotency keys              │
                        ┌───────────────┴───────────┐   ┌───┴───────────────┐
                        │ RASPBERRY PI 4 (apps/      │   │ Officer's browser │
                        │ raspberry-pi) Node.js + TS │   │ (dashboard only,  │
                        │ • Kiosk state machine      │   │  never GPIO)      │
                        │ • SQLite offline store     │   └───────────────────┘
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
| **Supabase** | PostgreSQL (authoritative data), Auth (officer logins), Realtime (live dashboard), Row Level Security (access control), pg_cron (scheduled overdue processing). |
| **SQLite** | Runs only on the Pi: local config, physical locker state, the current kiosk session, and an offline queue of events and returns waiting to sync. It is **not** the main database. |
| **Raspberry Pi 4** | Main embedded controller. Runs the kiosk state machine and drives the LCD, relays, solenoids, RFID readers, coin selector and buzzer. Talks to the backend over HTTPS. |
| **ESP32-CAM** | A dedicated QR scanner. Decodes the student-ID QR code and sends the **raw text** to the Pi over USB serial. It has no Wi-Fi credentials and no business logic. |

## 3. Key design decisions (recommended options)

### 3.1 Monorepo with npm workspaces
`apps/web`, `apps/raspberry-pi`, and `packages/shared` live in one repository. npm workspaces ship with Node, so no extra tool (pnpm or turbo) is needed. The shared package is TypeScript source compiled by each consumer: Next uses `transpilePackages`, and the Pi runs it through `tsx`.

### 3.2 Backend = Next.js route handlers (no separate server)
The specification asks for Next.js route handlers. Putting business logic there keeps one deployable unit. Every protected operation goes through server code that validates input with Zod, so the browser and the Pi are never trusted directly (Rules 14 and 15).

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
**Recommended over HTTP or WebSocket for the prototype.**
- One USB cable gives both power and data (`/dev/ttyUSB0`).
- No Wi-Fi on the ESP32, so no network credentials on it, lower power draw and no IP configuration.
- Message example: `{"type":"qr","seq":42,"data":"<raw QR text>"}`
- The ESP32 forwards **raw** QR text only. The Pi and the backend parse and validate it, so the QR format can change without reflashing the ESP32.

### 3.6 Overdue status: dynamic and scheduled
- **Correctness:** a database view and the API compute `effective_status = OVERDUE` whenever `status = ACTIVE AND now() > due_at`. Nothing depends on the dashboard being open.
- **Persistence:** a `pg_cron` job (built into Supabase) runs every minute, sets `status = OVERDUE`, and raises notifications. Even if the job is late, the dynamic rule is still correct.

### 3.7 Time
All databases store **UTC** (`timestamptz` in PostgreSQL, ISO-8601 strings in SQLite). The server clock is authoritative for `rented_at` and `due_at`. Only the UI and the LCD convert to `Asia/Manila` using helpers in `packages/shared/src/time.ts`.

### 3.8 Offline policy (conservative)
| Operation | Online | Offline |
|---|---|---|
| New rental | Allowed after server-side eligibility check | **Refused by default.** Eligibility and payment locking can't be verified safely. |
| Return | Normal | **Accepted** if the expected RFID UID for that locker is read locally. Stored in SQLite, synced later with idempotent UUIDs. |
| Events and logs | Sent immediately | Queued in SQLite and synced with exponential backoff |

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
