# Team Onboarding & Hand-off Report

> **Read this first if you are joining the project.** It is updated at the end of every phase.
>
> **Last updated:** 2026-11-19, end of **Phase 11** (real hardware drivers)

---

## 1. The project in one minute

A kiosk lends scientific calculators to students:

1. A student scans their **school ID QR code** (ESP32-CAM).
2. The **Raspberry Pi 4** checks with the backend that they may borrow.
3. They pay **₱20 in coins** (Allan 1239 coin selector).
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
| 5 | Rental rules: eligibility and availability, as shared logic run by the kiosk on SQLite | ✅ Done and verified |
| 6 | Coin payment sessions (kiosk-side, recorded in SQLite) | ✅ Done and verified |
| 7 | Return rules, RFID verification, penalty engine, Settings page | ✅ Done and verified |
| 8 | Realtime dashboard: summary cards, Active Rentals countdowns, live updates | ✅ Done and verified |
| 9 | Raspberry Pi service: state machine, mock hardware, 16×2 LCD messages, device login + heartbeat | ✅ Done and verified |
| 10 | ESP32-CAM QR firmware + serial link | ✅ Done and verified on the real board |
| 11 | Real hardware: RC522, relays/solenoids, coin selector, LCD, buzzer (Python helper) | ✅ Built and tested in software. ⏳ Bring-up on the Pi (§6). |
| 12 | Two-way synchronization: SQLite ⇄ Supabase (outbox push, admin-change pull) | ⬜ Next |
| 13 | Error handling, audit logs, device monitoring | ⬜ |
| 14 | Testing, simulator, system validation | ⬜ |
| 15 | Deployment and final documentation | ⬜ |

**Rule for the team:** a phase is finished only when its verification checklist passes. Don't start the next phase on top of a broken one.

---

## 3. Pending decisions and reminders ⚠️

These block later phases. Whoever has the hardware, please fill them in.

| # | Item | Needed by | Status |
|---|---|---|---|
| 1 | Relay module polarity | — | ✅ **Active-LOW** (ACE 6345 2-channel optocoupler board), GPIO 5/6 |
| 2 | LCD size | — | ✅ **16×2** (confirmed 2026-11-17); all messages fit 16 characters |
| 3 | 3rd relay for the coin selector | — | ✅ **Not fitted** (idle coins are logged for refund) |
| 4 | Front-panel buttons | — | ✅ **Blue + red arcade button per locker** (decided 2026-11-25). Blue chooses the locker (GPIO 24/25); red = "door closed", which locks it (GPIO 22/23). No door sensors. |
| 4b | Solenoid heat when held unlocked | Phase 11 bring-up | ⏳ The lock is held ON until the red button is pressed (up to 60/90 s). Run the heat check in `docs/raspberry-pi.md` §3.1; if the lock gets too hot, lower the removal/return timeouts in Settings. |
| 5 | Real **RFID UIDs** of the two calculator tags and the real **calculator model** | Phase 11 bring-up | ⏳ Read them with `npm run hwcheck:pi` → `watch` |
| 6 | **Real-time clock (DS3231 RTC module)?** With SQLite-first, the Pi's clock sets due times. Without an RTC, the kiosk must wait for internet time sync after every boot (it's unplugged after school hours). | Phase 9 | ⏳ **Deferred by the team, decide later** |
| — | Pricing, penalties and after-hours rule | — | ✅ Decided: **₱20 for 3 hours** (2026-11-17); overdue **₱10 per started 1.5 hours**, 10-minute grace, keeps counting overnight, **paid before the return locker opens** (2026-11-18). Editable on the Settings page. |
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
| `npm test` | All tests pass (294 at the end of Phase 11) |
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

## 6. Phase 11 hand-off: real hardware drivers

### Phase 11c update (2026-11-25): blue/red front-panel buttons
The team built a front panel: `[BLUE 1] [RED 1]  [LCD]  [BLUE 2] [RED 2]`. Wiring is in `docs/raspberry-pi.md` §3.7, and the student steps are in `docs/renter-guide.md`.
- **Idle LCD:** `SCAN STUDENT ID` / `1:READY 2:N/A`, kept up to date from the RFID readers.
- **Borrow:**
  - The student scans their ID. A blocked or ineligible student is refused right away (`RentalService.checkRental`, read-only).
  - New state `SELECTING_LOCKER`: the student presses the **blue** button of a READY locker within 30 s. `startRental(qr, lockerNumber)` reserves exactly that locker.
  - They pay, then the locker is **held unlocked**. They take the calculator, and the LCD shows `CLOSE THE DOOR` / `PUSH RED BUTTON`. The **red** button locks the locker and shows RENTAL SUCCESS.
- **Return:**
  - The locker is held unlocked. The LCD gives live hints from the RFID reader (return-to, wrong calculator, or close and push red).
  - **Red** checks the RFID. The right calculator → locks → RETURN SUCCESS. Wrong or missing → the locker stays unlocked so the student can fix it.
- **Locks:**
  - `LockerController.unlock(channel, maxMs)` holds the relay, and the new `lock(channel)` releases it.
  - The bridge turns the relay off at `maxMs` (the removal or return timeout) even if Node dies. Every timeout and crash path locks.
- **Config:**
  - New settings `SELECT_BUTTON_PINS=24,25` and `CLOSE_BUTTON_PINS=22,23`. `DOOR_PINS` is back to empty.
  - The config rejects a GPIO pin used twice. ⚠️ If your `.env` still has `DOOR_PINS=22,23`, clear it.
- **Tools:**
  - `hwcheck:pi` prints button presses and has a new `lock <n>` command.
  - The mock console has `blue <n>` and `red <n>`.
- **Replaces** the door-switch-only flow from Phase 11b.

### Phase 11b update (2026-11-25): real RFID UIDs, config fix
- **Real tag UIDs:** run `npm run seed:pi -- --rfid1 <uid> --rfid2 <uid>`.
- **Bug fixed:** the `.env` pin settings (`RELAY_PINS`, `RFID_SPI`, `DOOR_PINS`) were rejected because their patterns were missing backslashes. The defaults worked, but any value in `.env` stopped the kiosk at startup.

### Decisions (2026-11-19)
- **Hardware I/O through a small Python helper** (`apps/raspberry-pi/hw-bridge/hw_bridge.py`), chosen by the team over pure TypeScript.
  - It uses the Pi's official, preinstalled **gpiozero** library, plus spidev and smbus2. Nothing needs compiling, and it copes with GPIO changes in newer kernels.
  - Node keeps **all** rules and the state machine. The helper only performs I/O, over JSON lines like the ESP32.
- **Relay board:** ACE 6345 2-channel optocoupler, **active-LOW**, on GPIO 5/6. Those pins are HIGH at boot, so the locks can't fire while the Pi starts.
- **Coin signal:** through a **PC817** optocoupler to GPIO 17.
- **No 3rd relay and no door reed switches.** Idle coins are logged for refund, and returns complete on the RFID check. Either can be added later with `.env` settings.
- **RC522 RST pins tied to 3.3 V.** The driver resets the chip in software, saving 2 GPIOs.

### Built
- **`hw_bridge.py`**:
  - **Relays:** pulsed for `LOCK_PULSE_MS`, never held.
  - **Coins:** pulses are counted and grouped next to the pin (a 200 ms gap ends a coin).
  - **RC522 driver:** reads 4- and 7-byte UIDs, and turns each antenna on only while reading, so two readers don't interfere.
  - **16×2 LCD driver** for the PCF8574 backpack.
  - **Buzzer patterns** (ok, error, attention).
  - **Optional door switches.**
  - A missing device is reported, not fatal.
  - **`--mock` mode** for laptops and tests.
- **Node side** (`src/hardware/real/`):
  - `BridgeClient`: starts the helper, gives each request an id and a 2 s timeout, and restarts the helper if it crashes.
  - Adapters for the kiosk interfaces: coins, RFID, locks, display, buzzer.
  - `SystemClock`: trusts the clock once `timedatectl` says NTP is synced.
- **Kiosk modes:**
  - `HARDWARE_MODE=real` runs on the Pi's pins, plus the ESP32 scanner.
  - `mock` stays the laptop console.
  - Every pin and polarity is a `.env` setting (`RELAY_PINS`, `RELAY_ACTIVE_LOW`, `COIN_PIN`, `COIN_PULSE_GAP_MS`, `BUZZER_PIN`, `BUZZER_ACTIVE_LOW`, `RFID_SPI`, `LCD_I2C_ADDRESS`, `DOOR_PINS`, `LOCK_PULSE_MS`).
- **`npm run hwcheck:pi`:** a bring-up tool that tests each part on its own (`lcd`, `beep`, `unlock 1`, `rfid`, `watch`), and prints coins as they're inserted.
- **`docs/raspberry-pi.md`** is rewritten for your exact parts: pin map, wiring per component (relay 3.3 V trigger check, PC817 coin wiring, RC522 ×2, LCD level shifting, buzzer), power, Pi setup commands, bring-up order and troubleshooting.
- 7 new integration tests run the **real Python helper** (mock mode) through the Node adapters, including a complete kiosk borrow where coins and RFID go through Python. 294 in total. CI runs them too.

### ⚠️ Needs the real Pi
The RC522 and LCD drivers and the GPIO wiring can only be proven on the hardware. Follow `docs/raspberry-pi.md` §5–6, and send me any error the hardware check prints.

### Phase 11 verification checklist (on the Raspberry Pi)
- [ ] §5 setup done: SPI and I2C enabled, Python packages installed, user in the gpio/spi/i2c/dialout groups, rebooted
- [ ] `ls /dev/spidev0.*` shows two devices; `i2cdetect -y 1` shows the LCD (27 or 3f)
- [ ] `npm run hwcheck:pi` lists devices with `rfid: [1, 2]` and `lcd: true`
- [ ] `lcd HELLO` shows on the LCD; `beep error` gives three beeps
- [ ] `unlock 1` and `unlock 2`: each relay clicks ON, then OFF after 3 s, and its solenoid pulls. At rest both relay LEDs are **off**.
- [ ] `watch`: putting CALC-001 over reader 1 prints `tag 04-…`, and removing it prints `no tag`. Same for reader 2. **Write both UIDs down.**
- [ ] Coins ₱1/₱5/₱10/₱20 print `COIN: 1/5/10/20 pulse(s)`
- [ ] Put the real UIDs on the dashboard (Calculators → Edit) and in the kiosk seed. Then `HARDWARE_MODE=real npm run start:pi`, and do a full borrow and return with your ID, coins, and the real lockers.

---

## 6.0f Phase 10 hand-off (completed): ESP32-CAM QR scanner

### Built
- **Firmware** at `firmware/esp32-cam/esp32-cam-qr/esp32-cam-qr.ino` (Arduino, AI-Thinker ESP32-CAM + OV2640 on the USB-C CH340 base):
  - decodes QR codes with the `ESP32QRCodeReader` library
  - **Wi-Fi and Bluetooth are off**
  - sends one JSON line per message at 115200 baud: `hello` at boot, `alive` every 5 s, and `qr` with the raw text, TABs escaped
  - all serial output comes from one task, so lines can't mix
  - the step-by-step setup, flashing and testing guide is `firmware/esp32-cam/README.md`
- **Pi driver** (`apps/raspberry-pi/src/hardware/real/`):
  - `scanner-protocol.ts` validates each line. It ignores boot noise and malformed or oversized data, and drops the same ID seen again within 3 s.
  - `serial-qr-scanner.ts` opens the port and releases DTR/RTS, which otherwise reset the board on the CH340 base. It warns once and retries every 3 s if the cable is unplugged.
- **Scanner test tool:**
  - `npm run scanner:pi` lists serial ports and flags the CH340.
  - `npm run scanner:pi -- COM7` prints every scan, and whether it's a valid school ID.
- **Kiosk switch:** in `apps/raspberry-pi/.env`, set `QR_SCANNER=serial` and `SCANNER_PORT=COM7` (Pi: `/dev/ttyUSB0`). The kiosk keeps running even if the scanner is missing. Console shortcuts (`juan`, …) still work.
- 15 new tests: the protocol, plus the serial driver against the official serialport mock (split reads, DTR/RTS release, reconnect). 287 in total.

### ⚠️ Needs your hardware
The firmware couldn't be compiled or flashed here. Its first real test is the checklist below. If the Arduino IDE reports compile errors, send them over. The most likely cause is the ESP32 core version: use **2.0.17** if 3.x fails.

### Phase 10 verification checklist
- [ ] `npm test` reports **287 passed**
- [ ] Flash the ESP32-CAM (`firmware/esp32-cam/README.md` steps 1–2)
- [ ] Arduino Serial Monitor at 115200 shows `{"type":"hello","fw":"1.0.0"}`, then an `alive` line every 5 s
- [ ] Your school ID at about 15 cm prints `{"type":"qr",…,"data":"NAME\t2022…\tBSCpE"}`
- [ ] Close the Serial Monitor. Then `npm run scanner:pi -- COMx` shows **✔ valid school ID** for your card
- [ ] `QR_SCANNER=serial` + `SCANNER_PORT=COMx` in the Pi `.env`, then `npm run start:pi`: scanning your ID shows **YOUR NAME / P20 / 3 HOURS** (a first-time student is registered automatically)
- [ ] Unplug the ESP32 while the kiosk runs: one "QR scanner unavailable" warning, and the kiosk keeps running. Plug it back in: "QR scanner connected".

---

## 6.0e Phase 9 hand-off (completed): kiosk service (state machine, mock hardware, device login)

Delivered as **three PRs**:
- **9a** `phase-9a/lcd-hardware-mocks`: LCD messages and hardware interfaces
- **9b** `phase-9b/kiosk-state-machine`: the kiosk brain
- **9c** `phase-9c/device-heartbeat`: device login and heartbeat

### Built
- **16×2 LCD messages** (`apps/raspberry-pi/src/kiosk/lcd.ts`):
  - every screen is exactly 2 lines of 16 plain characters ("P20", since the LCD has no ₱; Ñ becomes N)
  - one catalog for all messages, plus a refusal screen for each error
  - the spec's "RETURN BY 12:00 PM" is 18 characters, so it became **"DUE AT 12:00 PM"**
- **Hardware interfaces** (`src/hardware/types.ts`, spec §44): QRScanner, CoinAcceptor, RFIDReader, LockerController, DisplayController, BuzzerController and ClockSource.
  - The kiosk logic never touches GPIO.
  - **Mock** versions (`src/hardware/mock.ts`) run everything on a laptop. Phases 10–11 add the real ones.
- **Kiosk state machine** (`src/kiosk/kiosk-controller.ts`, spec §21):
  - Scans, coins and a 250 ms tick all go through **one queue**, so two inputs never interleave.
  - Only allowed moves are possible. For example, SYSTEM_READY → OPENING_LOCKER is impossible.
  - **One scan decides borrow or return:** a student with a calculator out is returning it.
  - **Borrow:** quote, coins, unlock **only** the assigned locker, RFID confirms removal, RENTAL SUCCESS. Payment and removal have timeouts.
  - **Return:** late students pay the penalty first. Only their locker opens. It completes only with the right tag and the door closed (if a door sensor is fitted). A **wrong calculator** re-opens the locker once so it can be swapped.
  - **At boot:** waits for clock sync (no RTC), then reads every RFID reader **before** the first scan is accepted.
  - **Restart recovery** after a power cut:
    - open payment sessions are cancelled
    - paid-but-not-handed-out rentals become FAILED, flagged for an officer refund
    - interrupted returns go back to ACTIVE
  - Sensor states are saved on change, plus once every 30 s, which is easy on the SD card.
  - A hardware fault shows **SYSTEM ERROR** and recovers.
- **Device login** (spec §19):
  - The kiosk sends `x-device-id` and `Authorization: Bearer <secret>`. The server compares SHA-256 hashes in constant time and checks the device is enabled. Every failure gives the same 401.
  - `POST /api/device/heartbeat`, sent every 30 s, records the kiosk as **ONLINE** with its version, state, sync backlog, CPU temperature and **clock drift**. A drift over 2 minutes is logged as a warning.
  - `npm run check:pi` now also checks **"Device login + heartbeat"**.
- **Mock console:** `npm run start:pi` (mock mode) runs the real kiosk process and lets you play the student and the sensors from the keyboard:
  ```
  juan | maria | pedro | carlo | ana     scan an ID (ana is blocked)
  blue 1 | red 1                         press Locker 1's blue (choose) / red (door closed) button (Phase 11c)
  coin 20                                insert a coin (1, 5, 10, 20)
  take 1                                 take the calculator out of Locker 1
  put 1 1                                put CALC-001 into Locker 1 (put 1 2 = wrong calculator)
  door 1 open | door 1 closed            door sensor
  wait 240                               jump the kiosk clock 4 hours ahead (try a late return)
  state | help
  ```
- 32 new tests: LCD, state machine and recovery, device secret check. 272 in total.

### Not yet (by design)
- **Real drivers:** ESP32-CAM serial (Phase 10); RC522, relays, coin pulses, LCD over I2C and the buzzer (Phase 11).
- **Sending kiosk records to Supabase:** Phase 12. The heartbeat already reports how many are waiting.
- **The production device secret.** The kiosk still uses the development placeholder secret. Phase 15 generates a real one per kiosk.

### Phase 9 verification checklist
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **272 passed**
- [ ] With `npm run dev:web` running, `npm run check:pi` shows **"Device login + heartbeat — DEVICE-CALC-KIOSK-001 accepted"** and 15 passed
- [ ] Dashboard **Lockers** page: the Kiosk column shows **ONLINE** for about 90 s after the check, then OFFLINE (no heartbeat), which is correct
- [ ] `npm run seed:pi`, then `npm run start:pi`, then type in order:
  1. `juan`: shows JUAN DELA CRUZ / P20 / 3 HOURS
  2. `coin 20`: shows LOCKER 1 OPEN
  3. `take 1`: shows RENTAL SUCCESS / DUE AT …
  4. `wait 240`, then `juan`: shows LATE 1H00M / PAY PENALTY P10
  5. `coin 10`: shows RETURN CALC #1 / TO LOCKER 1
  6. `put 1 2`: shows **WRONG CALCULATOR**
  7. `put 1 1`: shows **RETURN SUCCESS / PENALTY: P10**
- [ ] `ana`: shows ACCOUNT BLOCKED. A `coin 5` while idle is recorded for refund.
- [ ] Ctrl+C mid-payment, then `npm run start:pi` again: the kiosk returns to SYSTEM READY, and the student can start over

---

## 6.0d Phase 8 hand-off (completed): live dashboard

### Built
- **Dashboard cards**, all computed by one database view, `v_dashboard_summary`:
  - Total Calculators, Available, Currently Rented, Overdue
  - Rentals Today, Returns Today, Income Today, Outstanding Penalties
  - "Today" is the current day in **Philippine time**; stored times stay UTC. Overdue is computed live from `due_at`, so no scheduled job is needed (spec §26).
  - Each card links to the page with the details.
- **Live updates (Supabase Realtime):**
  - Migration `20261119000100` adds calculators, lockers, students, rentals, payments, penalties and devices to the Realtime publication.
  - `LiveRefresh` (`apps/web/src/components/live-refresh.tsx`) listens for changes and refreshes the page, at most every 0.5 s. A **Live** indicator shows the connection, and its pulse respects reduced-motion settings.
  - Row Level Security applies to Realtime too, so only active admins receive changes.
- **Active Rentals** (`/rentals`):
  - Every calculator that is out, soonest due first. Columns: student, student number, course, calculator, locker, borrowed and due times (PH time), status, amount paid, and penalty due.
  - A **countdown** reads "Due in 01:42:15" or **"Overdue by 00:32:16"** (red). It ticks every second in the browser from `due_at` (spec §25), and nothing is written to the database.
- `rentalCountdown()` in `packages/shared`, with tests. 5 new tests in total, 245 overall.

### Not yet (by design)
- Kiosk rentals reach Supabase only once **sync** exists (Phase 12). Until then, Active Rentals shows "No calculators are out right now", and the rental and income cards show 0. That's correct for your current data.
- Transactions, Payments and Penalties pages: they show data once sync brings it in (Phases 12–13).

### Phase 8 verification checklist
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **245 passed**
- [ ] **Dashboard** shows real numbers: Total Calculators **3** (CALC-001–003), Available **2**, everything else 0 / ₱0.00, and a green **Live** indicator
- [ ] **Live update test:** open the Dashboard in **two tabs**. In tab 2, put **CALC-002** in maintenance. Within about a second, tab 1 shows **Available 1** with no reload. Reactivate it, and tab 1 goes back to **2**.
- [ ] **Active Rentals** shows the empty state with a Live indicator
- [ ] Phone width: the cards stack into one column

---

## 6.0c Phase 7 hand-off (completed): returns, RFID verification, penalties

Delivered as **two PRs**:
- **7a** `phase-7a/penalty-rules-settings`: shared penalty and return rules, the Supabase policy migration, and the Settings page
- **7b** `phase-7b/kiosk-returns`: the kiosk's return flow

### Team policy (decided 2026-11-18, editable in Settings)
| Rule | Value |
|---|---|
| Rental | ₱20 for 3 hours. It is **never charged again on return.** |
| Overdue penalty | **₱10 for every started 1.5 hours late.** Examples: 1 h late → ₱10 · 2 h → ₱20 · 3 h → ₱20 · 4 h → ₱30 |
| Grace period | 10 minutes late is free. After that, lateness counts from the due time. |
| Overnight | Keeps counting while the kiosk is off |
| When to pay | **Before the return locker opens** (pay-first). See the risk note below. |

### Built
- **Shared rules** (`packages/shared/src/rental/penalty.ts`):
  - `calculatePenalty` supports FLAT, PER_INTERVAL and STEPPED penalties, with the grace period and a maximum cap.
  - `verifyReturnedCalculator` passes only when the expected RFID tag is in the locker and, if a door sensor exists, the door is closed. It rejects the wrong calculator (Rule 10) and an empty locker or random object (Rule 9).
- **Settings page** (`/settings`):
  - Every admin can view it. **Only a Super Admin can save.**
  - Validated with the same rules the kiosk uses, and every change is audit-logged with old and new values.
  - A **live preview table** shows what a late return will cost.
- **Kiosk SQLite migration 4:**
  - full penalty records
  - a link from each payment to its penalty
  - a per-session expiry time
  - penalties added to the sync outbox (rebuilt in place, without losing unsynced rows)
- **`ReturnService`** (`apps/raspberry-pi/src/rental/return-service.ts`):
  | Step | What happens |
  |---|---|
  | `startReturn(qr)` | Finds the student's rental, persists OVERDUE, and quotes the penalty using the rules in force when they borrowed. If something is owed, it opens a **penalty coin session**. |
  | `openReturnLocker(id)` | Refused while any penalty is unpaid. Otherwise it unlocks **only the borrowed locker** (rental → RETURNING). |
  | `verifyReturn(id, sensors)` | Correct tag and door closed → **COMPLETED**: calculator and locker become AVAILABLE, and `returned_at`, `was_overdue` and `overdue_minutes` are recorded. Wrong tag → `RFID_MISMATCH` (logged). No tag → `RFID_NOT_DETECTED`. |
  | `abandonReturn(id)` | The student never placed the calculator: the rental goes back to ACTIVE or OVERDUE and the locker is locked up. |
  | `markOverdueRentals()` | ACTIVE rentals past due become OVERDUE (the Phase 9 state machine calls this periodically). |
- **Penalty payments** reuse the Phase 6 coin session (`openPenaltySession`):
  - If the student walks away mid-payment, the coins so far are **kept as part-payment**, because the student owes them anyway, so no refund is needed. A WARNING is logged for officers.
  - If the student comes back later, they pay only the **extra** time since.
- **Returns work fully offline** (Rule 11), because everything runs on the kiosk's own SQLite database and syncs later.
- `npm run demo:pi` now ends with a late return: P10 penalty → locker refused until paid → wrong calculator rejected → correct calculator accepted.
- 42 new tests (19 penalty and return-check, 22 return flow, 1 migration upgrade), 240 in total.

### ⚠️ Risk of the pay-first policy (team decision)
A late student without enough coins can't open the locker, so they leave **with the calculator**, and the penalty keeps growing. Each refused attempt is logged as `Late return not completed …` (WARNING), so officers can follow up. If this becomes a problem, switch to "return first, pay later": the penalty is then recorded as unpaid and blocks the student's next rental.

### Phase 7 verification checklist
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **240 passed**
- [ ] `npm run demo:pi` ends with **OVERDUE 1 HOUR / Penalty: P10**, the locker refused before paying, **Payment P10/P10**, **WRONG CALCULATOR**, then **RETURN SUCCESS / PENALTY: P10**
- [ ] `npm run check:pi` shows `user_version=4, expected=4`
- [ ] Dashboard **Settings**, as Super Admin:
  - shows ₱20 / 180 min / ₱10 every 90 min / grace 10
  - the preview row reads ₱0, ₱10, ₱10, ₱20, ₱20, ₱30, ₱160
  - change the grace period to 15, save (green toast), then change it back
- [ ] SQL Editor: `select action, new_value from audit_logs where action = 'SETTINGS_UPDATED' order by id desc limit 2;` shows both changes
- [ ] Optional: as a VIEWER or OFFICER, the Settings page is read-only

---

## 6.0b Phase 6 hand-off (completed): coin payment sessions

### Built
- **Shared coin rules** (`packages/shared/src/payment/coins.ts`). The Allan 1239 is programmed so that **pulses = peso value** (₱1 = 1 pulse … ₱20 = 20).
  - `groupPulses` turns raw pulse timestamps into coins (a gap of 200 ms or more ends a coin).
  - `coinValueFromPulses` accepts only the coins enabled in Settings and rejects noise.
  - `paymentProgress` / `formatPaymentLine` produce the LCD line, e.g. "Payment P5/P20".
- **Kiosk SQLite migration 3:** `payments` and `coin_events`, mirroring Supabase. SQLite allows only one live rental payment per rental (Rule 3).
- **`PaymentService`** (`apps/raspberry-pi/src/payment/payment-service.ts`):
  | Call | What happens |
  |---|---|
  | `openSession(rentalId)` | For a reserved (PAYMENT_PENDING) rental. Opening twice returns the same session. |
  | `insertCoin(sessionId, coin)` | Adds the coin (PENDING → PARTIAL → **PAID**), then marks the rental PAID in the same transaction. |
  | `expireSessions()` | After the payment window (120 s), cancels the payment and the rental and frees the locker. |
- **Coin safety:**
  - **Duplicate coin events** are counted once, because each coin carries its own event ID.
  - **Once paid, the payment is locked.** A later coin, or a coin inserted while the kiosk is idle, is recorded as **unattributed** for an officer refund. It's never applied to another rental (Rule 23).
  - **Pulse noise** and coins disabled in Settings are logged and not credited.
  - **Overpayment** (e.g. ₱10 + ₱20 for a ₱20 fee) is recorded, because the selector can't give change.
  - **Timeout with coins already inserted** logs a WARNING: "refund needed".
- Payments and coin events are queued in the sync outbox.
- `npm run demo:pi` now pays with real coin handling (P5, P5, P10). It includes a duplicate event and a late coin.
- 30 new tests (16 shared coin tests, 14 payment service tests), 198 in total.

### Not yet (by design)
- **Reading the real coin pulses on GPIO 17**, and enabling or disabling the selector: Phase 11. The adapter will use `groupPulses` and call `insertCoin`.
- **Calling `expireSessions()` every few seconds:** the kiosk state machine, Phase 9.
- **Payments on the dashboard** appear once the outbox syncs to Supabase (Phase 12). The Payments page is built when that data flows.
- **Recommendation stands:** a 3rd relay to power the coin selector only during payment (open decision #3). The unattributed-coin logging is the fallback until then.

### Phase 6 verification checklist
- [ ] `npm run typecheck` shows no errors, and `npm test` reports **198 passed**
- [ ] `npm run demo:pi` shows **Payment P5/P20**, then **P10/P20**, then **P20/P20 PAID**. The repeated coin says "duplicate (counted once)", and the extra P1 is "unattributed".
- [ ] `npm run check:pi` shows `Schema migrations — user_version=3, expected=3`

---

## 6.0a Phase 5 hand-off (completed): rental rules on the kiosk (SQLite-first)

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
| `npm run start:pi` | Pi kiosk service without auto-restart: use this for the **mock keyboard console** (`juan`, `coin 20`, `take 1`, `wait 240`, …) |
| `npm run check:pi` | Pi system check: SQLite + backend |
| `npm run demo:pi` | Demo: a full borrow with coin payment and the refusal cases on a throwaway database, printed as LCD screens |
| `npm run scanner:pi` | List serial ports. Add `-- COM7` to print scans from the ESP32-CAM |
| `npm run hwcheck:pi` | Hardware bring-up on the Pi: `lcd`, `beep`, `unlock 1`, `rfid`, `watch`, coin counting. Add `-- --mock` on a laptop. |
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
