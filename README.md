# Calculator Rental Locker System

**CPE 411 Embedded Systems:** Design and Implementation of a Raspberry Pi 4-Based Smart Calculator Rental and Return Locker System Using QR Code Identification.

Students scan their school-ID QR code at the kiosk, pay with coins, and the Raspberry Pi unlocks the locker holding an available RFID-tagged calculator. Returns are verified by RFID. Organization officers monitor and manage everything from a web dashboard.

> **Current status: Phase 10 complete** (ESP32-CAM QR scanner firmware and Pi serial driver). The full README is completed in Phase 15.
> **New to the project? Start with [docs/onboarding.md](docs/onboarding.md).**

| Document | Contents |
|---|---|
| [docs/onboarding.md](docs/onboarding.md) | Team onboarding, project status, setup, workflow, pending decisions |
| [docs/architecture.md](docs/architecture.md) | System architecture and design decisions |
| [docs/database.md](docs/database.md) | Schema, ER diagram, rules enforced by the database, RLS |
| [docs/raspberry-pi.md](docs/raspberry-pi.md) | Hardware wiring plan (GPIO map, power, component notes) |

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16 + React 19 + Tailwind 4 admin dashboard **and** REST API |
| `apps/raspberry-pi` | Node.js + TypeScript kiosk service (state machine, SQLite, hardware) |
| `packages/shared` | Shared enums, Zod validation, QR parser, API contracts |
| `supabase` | CLI config, SQL migrations, seed data, schema tests |
| `docs` | Documentation |

## Prerequisites

| Tool | Version | Check with |
|---|---|---|
| Node.js | 22 LTS (≥ 22.12) | `node -v` |
| npm | ≥ 10 (bundled with Node) | `npm -v` |
| Git | any recent | `git --version` |
| A Supabase project | free tier is enough | https://supabase.com |

The Supabase CLI is installed locally by `npm install`. Docker is **not** required.

## Quick start

```bash
npm install
```
```bash
cp apps/web/.env.example apps/web/.env.local
```
```bash
cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
```

Fill in the Supabase values in `apps/web/.env.local`. Detailed steps, including how to push the database schema and create the first admin, are in [docs/onboarding.md](docs/onboarding.md).

## Commands (run from the repository root)

| Command | Purpose |
|---|---|
| `npm run dev:web` | Dashboard and API at http://localhost:3000 |
| `npm run dev:pi` | Pi kiosk service (mock hardware, restarts on file changes) |
| `npm run check:pi` | Pi system check: SQLite and backend reachability |
| `npm run typecheck` | Type-check every workspace and the DB tests |
| `npm test` | All tests (unit + database schema) |
| `npm run test:db` | Database schema tests only (PGlite, no Docker) |
| `npm run build:web` | Production build of the web app |
| `npm run db:login` / `npm run db:link -- --project-ref <ref>` | Connect the Supabase CLI |
| `npm run db:push` / `npm run db:push:seed` | Apply migrations (and the development seed) |
| `npm run db:types` | Generate TypeScript types from the live schema |

## Security notes
- `.env`, `.env.local`, database dumps and SQLite files are git-ignored. Never commit real keys or real student data.
- The service-role key is read only in `server-only` modules. It never reaches the browser, the Raspberry Pi or the ESP32-CAM.
- Dashboard users have read-only database access. Every write goes through validated server APIs.
