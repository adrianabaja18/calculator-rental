# Testing Guide

How the system is tested, how to run each kind of test, and the checklist to run on the **real kiosk** once the hardware is assembled.

## 1. Automated tests (no hardware, no internet)
```bash
npm test
```
| Suite | What it proves |
|---|---|
| `packages/shared` | Business rules: eligibility, availability, rental state machine, penalties, QR parsing, validation |
| `supabase/tests` | The real migrations + seed in PGlite (Postgres in-process): constraints, RLS, views, enums match TypeScript |
| `apps/raspberry-pi/src/rental`, `payment`, `db` | Kiosk services on SQLite: borrowing, coins, returns, penalties, migrations, crash recovery |
| `apps/raspberry-pi/src/kiosk` | The state machine with simulated hardware: every LCD screen, buttons, timeouts, officer unlock |
| `apps/raspberry-pi/src/hardware/real` | The Python hardware bridge in mock mode: relays, buttons, RFID, coins, LCD, restart after a crash |
| `apps/raspberry-pi/src/sync` | Sync logic (back-off, offline, paging, waivers) and **real kiosk outbox → real Supabase migrations** |
| `apps/raspberry-pi/src/full-system.test.ts` | **Whole-system scenarios**: kiosk + simulated hardware + sync + Supabase: offline day, late return, power cut, officer block/maintenance/price/unlock/waiver |
| `apps/web` | Device login hashing, formatting, redirects |

Also run `npm run typecheck` and `npm run build:web`. CI runs all three on every pull request.

## 2. Kiosk simulator (no hardware)
```bash
npm run sim:pi
```
Open **http://localhost:4040**. It's the real kiosk program on simulated hardware:
- The LCD, the four front-panel buttons, the coin slot and a "scan ID" box.
- What the student does inside each locker (take or put a calculator, or put the wrong one).
- A kiosk clock you can move forward to try late returns.
- The live kiosk log.

| Option | Effect |
|---|---|
| `npm run sim:pi -- --fresh` | Start again from the development seed |
| `npm run sim:pi -- --sync` | Also sync with the backend in `apps/raspberry-pi/.env` (the dashboard then shows what you do) |

The simulator uses its own database (`apps/raspberry-pi/data/simulator.db`), never the kiosk's real one.

**Try these in the simulator**
1. **Borrow:** Juan → Scan ID → BLUE 1 → ₱20 → Locker 1 "Take calculator" → RED 1 → `RENTAL SUCCESS`.
2. **Return on time:** Scan Juan → Locker 1 "Put CALC-001" → RED 1 → `RETURN SUCCESS`.
3. **Late return:** borrow, then **+4 hours**, scan → `LATE 1H00M / PAY PENALTY P10` → ₱10 → put it back → RED.
4. **Wrong calculator:** return, but "Put CALC-002" into Locker 1 → `WRONG CALCULATOR`. The locker stays open.
5. **Blocked student:** Ana → `ACCOUNT BLOCKED`.
6. **Empty locker:** borrow from Locker 1, then have another student press BLUE 1 → `LOCKER 1 N/A`.
7. **Idle coin:** insert a coin with nobody paying. It's logged for refund.
8. **Power saving:** leave it alone for 2 min. The LCD dims (`PRESS ANY BUTTON`), then any button wakes it. Start with `SIM_SLEEP_SECONDS=20` to wait less.
9. **After hours:** click **+4 hours** until past 5 PM: `RETURNS ONLY`. Borrowing is refused and returns work.

## 3. Hardware acceptance checklist (real kiosk)
Run these in order on the assembled kiosk. Each step says what must happen. If one fails, stop and fix it before continuing (see [raspberry-pi.md](raspberry-pi.md) troubleshooting).

### 3.1 Parts, one at a time (`npm run hwcheck:pi`)
- [ ] Startup lists the devices found. The pins line shows `RST 4,16` and the buttons `blue 24,25, red 22,23`.
- [ ] `lcd HELLO` shows on the LCD (adjust contrast if blank).
- [ ] `beep ok` / `beep error` sound.
- [ ] `unlock 1` / `unlock 2`: that relay clicks, the solenoid pulls, and it releases after 3 s. At rest both relay LEDs are off.
- [ ] **Heat check:** set `LOCK_PULSE_MS=60000`, run `unlock 1`, and touch the solenoid after 60 s. If it's too hot to hold, lower the removal/return timeouts in Settings. Set it back to 3000 afterwards.
- [ ] `rfid`: both readers answer (`no tag`, not `NOT RESPONDING`).
- [ ] `watch`: tag A over reader 1 shows `FE-AC-31-03`, tag B over reader 2 shows `57-99-3B-03`, and removing them shows `no tag`. Test with the tags **inside the calculators, in the lockers**.
- [ ] Coins: ₱1, ₱5, ₱10, ₱20 (old and new designs) show `COIN: N pulse(s) = PN`.
- [ ] Buttons: each of the 4 prints `BUTTON: BLUE/RED … for locker N` once per press.

### 3.2 Kiosk flows (`npm run start:pi` with `HARDWARE_MODE=real`, `QR_SCANNER=serial`)
- [ ] Boot: `PLEASE WAIT / SYNCING CLOCK`, then `SCAN STUDENT ID / 1:READY 2:READY`.
- [ ] Borrow: scan an ID QR → `PUSH BLUE BUTTON` → blue → name and price → coins → the locker unlocks → take the calculator → `CLOSE THE DOOR / PUSH RED BUTTON` → close it, press red → it locks → `RENTAL SUCCESS / DUE AT …`.
- [ ] The locker is really locked afterwards (pull the door).
- [ ] Return on time: scan → that locker unlocks → put it back → red → `RETURN SUCCESS`, locked.
- [ ] Wrong calculator into the wrong locker → `WRONG CALCULATOR`, and the locker stays unlocked until fixed.
- [ ] Red pressed with nothing inside → `CALCULATOR NOT DETECTED`.
- [ ] Payment timeout (insert nothing for 2 min) → `PAYMENT TIMEOUT`, no locker opens.
- [ ] Red never pressed → after the timeout the locker locks by itself and shows `DOOR LEFT OPEN`.
- [ ] Coin with nobody paying → attention beep, logged.
- [ ] **Power cut mid-rental:** pay, then unplug the Pi before taking the calculator. After reboot it shows ready, the rental is FAILED and the payment is on the dashboard for a refund. No locker opens by itself.

### 3.3 Operating hours and power saving
- [ ] **ESP32-CAM firmware 1.1.0** is flashed. The startup `hello` shows `"fw":"1.1.0"`. Sleep/wake by hand works (firmware README §6).
- [ ] `hwcheck:pi`: `backlight off` / `backlight on` switch the LCD backlight. `rfidpower off` → `rfid` says NOT RESPONDING; `rfidpower on` → `rfid` reads tags again.
- [ ] Leave the kiosk idle for 2 min. The LCD dims to `PRESS ANY BUTTON / TO START` and the ESP32-CAM gets noticeably cooler.
- [ ] Press any button. The kiosk wakes (beep, `SCAN STUDENT ID`) and **a QR scan works within ~2 s**. Repeat 5 times.
- [ ] Insert a coin while asleep. It wakes and the coin is logged for refund.
- [ ] After 5:00 PM (or set *Closes* earlier in Settings): `RETURNS ONLY`, borrowing gives `KIOSK CLOSED`, a return still works, and it sleeps after 30 s.
- [ ] A rental after 2:00 PM shows `DUE <weekday> …` the next open day.
- [ ] **Devices** shows *Power: Asleep* while sleeping and the CPU temperature stays under 75 °C in normal use.

### 3.4 With the dashboard (sync)
- [ ] Rentals and returns appear on **Active Rentals / Transactions** within ~10 s.
- [ ] **Devices** shows ONLINE, CPU temperature, both lockers' RFID and lock state.
- [ ] Unplug the network cable, do a borrow, then plug it back in. It appears once, with nothing lost.
- [ ] Block a student / set a locker to maintenance / change the price on the dashboard. The kiosk follows within ~1 min.
- [ ] Emergency unlock from **Devices** opens the locker for 10 s (only when no student is using the kiosk).
