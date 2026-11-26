# Physical Build Hand-off: from parts to a working kiosk

This guide takes the team from **an assembled frame and a box of parts** to **a kiosk that students can use**, with the dashboard showing everything. Follow the stages **in order**. Each one ends with a check, and you shouldn't start the next stage until that check passes.

| Stage | What | Who | Time |
|---|---|---|---|
| 0 | Get the software ready (merge, database, dashboard) | Lead | 30 min |
| 1 | Phone scan page: print the sticker, try it on phones (after Stage 2, when the Pi runs the web app) | Anyone with a phone | 20 min |
| 2 | Prepare the Raspberry Pi (OS, packages, Node, code, `.env`) | Anyone | 1 h |
| 3 | Wire everything, power **off**, then check with a multimeter | Hardware team | 2–3 h |
| 4 | Test each part on its own (`hwcheck:pi`) | Hardware team | 1 h |
| 5 | First real run: the kiosk on real hardware | Whole team | 1 h |
| 6 | Connect it to the dashboard (sync) and test end to end | Lead + team | 1 h |
| 7 | Make it start by itself, plus the daily routine | Lead | 30 min |
| 8 | Sign-off | Whole team | — |

Related documents: [wiring-guide.pdf](wiring-guide.pdf) (every pin, printable), [raspberry-pi.md](raspberry-pi.md) (detailed wiring and troubleshooting), [testing.md](testing.md) (full checklists), [renter-guide.pdf](renter-guide.pdf) (for students), [onboarding.md](onboarding.md) (what each phase built).

> ⚠️ **Honest status:** everything below is tested in software (387 automated tests and a simulator), but **none of it has run on your physical kiosk yet**. Expect to debug. Section 9 lists what is most likely to need adjusting.

> 📱 **No ESP32-CAM any more (Phase 14e).** Students scan their ID with **their own phone**: they press any kiosk button, the LCD shows a 6-digit code, and they send their ID from the Pi's `/scan` page. Leave the ESP32-CAM unplugged (keep it as a spare). No internet is needed, but **phones must be on the kiosk's network** (the team's portable Wi-Fi).

> 🏠 **The dashboard now runs on the Pi itself** (team PR #20/#21). Where this guide mentions a laptop backend, Supabase or `db:push`, follow [raspberry-pi-local-setup.md](raspberry-pi-local-setup.md) instead.

---

## Stage 0: Software ready (lead, on a laptop)

### 0.1 Merge the pull requests, in this order
1. `phase-12/sync`
2. `phase-13/monitoring`
3. `phase-14/simulator`
4. `phase-14b/operating-hours`
5. `phase-14c/power-management`
6. `handoff/physical-build`
7. `phase-14e/phone-scan-local`

Each builds on the one before. Wait for CI to pass on each, then:
```bash
git checkout main && git pull
npm ci
npm test
```
✅ All tests pass.

### 0.2 Update the database (lead only)
```bash
npm run db:push
```
This adds the sync, monitoring and operating-hours migrations to the live Supabase project (only needed for the online monitor; phone scanning lives in the Pi's SQLite).

### 0.3 Make a real device password for the kiosk
The seed uses a public placeholder secret. Replace it before the kiosk goes on a real network.
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output; this is the **DEVICE_SECRET**. Keep it private: never commit it, and never post it in chat. Then get its SHA-256 hash:
```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" PASTE_SECRET_HERE
```
In **Supabase → SQL Editor**, run (paste the hash):
```sql
update public.device_credentials
set secret_hash = 'PASTE_HASH_HERE', rotated_at = now()
where device_id = (select id from public.device_registry where device_code = 'DEVICE-CALC-KIOSK-001');
```
✅ `1 row updated`. The secret goes into the Pi's `.env` in Stage 2.

### 0.4 Set up the dashboard with the real data
Start the dashboard (`npm run dev:web`), log in as a Super Admin, then:

| Page | Do this |
|---|---|
| **Calculators** | CALC-001 → RFID UID **`FE-AC-31-03`** (tag A), CALC-002 → **`57-99-3B-03`** (tag B). Set the real **model**. Check each is assigned to the right locker (CALC-001 → Locker 1). |
| **Settings** | Price ₱20 / 180 min, penalty ₱10 per 90 min, grace 10. **Operating hours** 09:00–17:00, the days the kiosk runs (default Mon–Fri; tick **Sat** if needed), and this semester's **closed dates** (holidays). Removal/return timeouts: 60/90 s (how long the kiosk waits for the student; the solenoid itself is powered for 10 s at most). |
| **Students** | The seed added 5 fake students (Juan, Maria…). Remove them (optional, below). |

Optional, to remove the fake seed students who never rented (Supabase SQL Editor):
```sql
delete from public.students
where notes = 'DEV SEED' and id not in (select student_id from public.rental_transactions);
```
✅ The Calculators page shows both real UIDs.

> **Why the UIDs matter:** once the kiosk syncs, it takes calculator RFID UIDs **from the dashboard**. If the dashboard still has the fake seed UIDs, the kiosk will say both lockers are N/A.

### 0.5 Where the kiosk reaches the backend
Until Phase 15 deploys the dashboard to Vercel, the kiosk talks to **a laptop running the web app on the same Wi-Fi**:
- Run `npm run dev:web` on that laptop and note the **Network** address it prints, e.g. `http://192.168.1.20:3000`.
- Windows will ask to allow Node.js through the firewall: allow it on **Private networks**.
- Test it from a phone on the same Wi-Fi: `http://<laptop-ip>:3000/api/health` should show JSON with `"success":true`.

---

## Stage 1: Phone scan page and its sticker
Do this once the Pi runs the web app (Stage 2 and [raspberry-pi-local-setup.md](raspberry-pi-local-setup.md)). Students open `http://<pi-ip>:3000/scan` on their phone.
1. From a phone or laptop **on the kiosk network**, open the dashboard at the Pi's address (e.g. `http://192.168.1.50:3000`) and sign in.
2. **Devices** → **Student scan page** → **Download the QR (SVG)**. Print it about 5 × 5 cm and stick it next to the LCD with a line like "Scan to send your ID". If the card shows a yellow warning, you opened the dashboard as `localhost`: use the Pi's address, or set `SCAN_PAGE_URL` in `apps/web/.env.local`.
3. Give the Pi a **fixed address** on the portable Wi-Fi, or the sticker stops working when the address changes. In the portable router's admin page (usually printed on its label, e.g. `192.168.0.1` or `192.168.8.1`), find **DHCP reservation / Address reservation / Static IP**, pick the Pi (hostname `raspberrypi`, or match its MAC from `ip link show wlan0`), and reserve its current address. Reboot the Pi and check `hostname -I` still shows it.
   Put up **two QR signs** beside the kiosk, as in the renter guide:
   - **STEP 1: Wi-Fi QR** (the team provides it). Phones join the Wi-Fi by scanning it. Its text is `WIFI:T:WPA;S:<wifi name>;P:<password>;;` (for an open network: `WIFI:T:nopass;S:<wifi name>;;`); many portable routers' apps can show it. Reprint it if the Wi-Fi name or password changes.
   - **STEP 2: scan-page QR** from **Devices → Student scan page** (this step).
4. Test with at least one **Android** and one **iPhone**: scan the sticker → the page opens → **Take or upload a photo** of a test ID → the name appears. Try a dim spot and a slightly dirty ID too.
5. Students use **Take or upload a photo** (it opens the phone's normal camera app). The live-camera button is hidden on the Pi's `http://` address because phones only allow it on https (team decision: photo only).

✅ Both phones read a test ID from a photo and show the right name.
❌ If a phone can't open the page at all, it's not on the kiosk's network, or the web app on the Pi isn't running.

---

## Stage 2: Prepare the Raspberry Pi
Raspberry Pi OS **64-bit** (Bookworm or newer), on the internet, logged in as your user.

### 2.1 System
```bash
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git i2c-tools python3-gpiozero python3-lgpio python3-spidev python3-smbus2
sudo usermod -aG gpio,spi,i2c,dialout $USER
```
Optional power saving (no Bluetooth is used):
```bash
echo "dtoverlay=disable-bt" | sudo tee -a /boot/firmware/config.txt
```
```bash
sudo reboot
```

### 2.2 Node.js 22
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```
✅ `node -v` prints `v22.x`.

### 2.3 The code
```bash
cd ~
git clone https://github.com/adrianabaja18/calculator-rental.git
cd calculator-rental
npm ci
echo 'cd ~/calculator-rental' >> ~/.bashrc
```
If the folder already exists from earlier testing:
```bash
cd ~/calculator-rental && git checkout main && git pull && npm ci
```

### 2.4 The kiosk settings (`.env`)
Start from the **newest** template. Older `.env` files are missing settings added since.
```bash
cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
nano apps/raspberry-pi/.env
```
Change only these lines:
```
BACKEND_URL=http://192.168.1.20:3000        # the laptop's Network address from Stage 0.5
DEVICE_SECRET=<the secret from Stage 0.3>
HARDWARE_MODE=real
QR_SCANNER=phone
LOG_PRETTY=false
```
Leave the pin settings as they are. They match the final wiring:

| Setting | Value | Meaning |
|---|---|---|
| `RELAY_PINS` | `5,6` | relay IN1/IN2 (active-LOW board) |
| `COIN_PIN` | `17` | PC817 output |
| `BUZZER_PIN` | `18` | buzzer |
| `RFID_SPI` / `RFID_RST_PINS` | `0.0,0.1` / `4,16` | readers 1 and 2 |
| `CLOSE_BUTTON_PINS` / `SELECT_BUTTON_PINS` | `22,23` / `27,25` | red / blue buttons |
| `LCD_I2C_ADDRESS` | `0x27` | change if `i2cdetect` shows `3f` |
| `POWER_SAVE`, `SLEEP_AFTER_SECONDS` | `true`, `120` | idle sleep |

✅ Running `npm run check:pi` prints the configuration without errors. A "backend not reachable" message is fine if the laptop isn't running yet.

### 2.5 Start from a clean kiosk database
Any test data on the Pi (from `seed:pi` or mock runs) should go. The kiosk downloads the real settings, lockers, calculators and students from the dashboard on its first sync.
```bash
rm -f apps/raspberry-pi/data/kiosk.db apps/raspberry-pi/data/kiosk.db-wal apps/raspberry-pi/data/kiosk.db-shm
```

---

## Stage 3: Wiring (power OFF the whole time)
Use **[wiring-guide.pdf](wiring-guide.pdf)**: the 40-pin map is on page 2 and each component's table is on pages 3–4. Wire in this order. After each block, compare against the PDF and tick it off.

| # | Block | Key points |
|---|---|---|
| 1 | **Rails on the copper board** | 3.3 V rail ← Pi pin 1. GND rail ← Pi pins 6 **and** 9. Label them. Keep a strip gap from the 12 V area. |
| 2 | **LCD** | VCC → pin 2 (5 V), GND → rail, SDA → pin 3, SCL → pin 5. **Level shifter or remove the backpack pull-ups** (the backpack pulls SDA/SCL to 5 V). |
| 3 | **Buzzer** | I/O → pin 12, VCC → 3.3 V or 5 V as the module needs, GND → rail |
| 4 | **Relay module** | VCC → pin 4 (5 V), GND → rail, IN1 → pin 29, IN2 → pin 31 |
| 5 | **RC522 ×2** | 3.3 V rail only. SDA: reader 1 → pin 24, reader 2 → pin 26. SCK/MOSI/MISO shared → pins 23/19/21. RST: reader 1 → pin 7, reader 2 → pin 36. GND → rail. Readers ≥ 10 cm apart. |
| 6 | **Buttons ×4** | COM ① → GND rail; NO ③ (bottom tab): RED 1 → pin 15, RED 2 → pin 16, BLUE 1 → pin 13, BLUE 2 → pin 22; NC ② unused |
| 7 | **PC817 (coin)** | Pi side: pin 4 → pin 11 (GPIO 17) + 10 kΩ to pin 17 (3.3 V); pin 3 → pin 20 (GND). 12 V side: +12 V → 2.2 kΩ → pin 1; selector COIN → pin 2. |
| 8 | **12 V side** | +12 V → relay COM1, COM2, coin selector +12 V, 2.2 kΩ. Relay NO1/NO2 → solenoid +. Solenoid − and selector GND → **12 V −**. **Flyback diode across each solenoid** (stripe to +). |
| 9 | ~~ESP32-CAM~~ | Not used any more (phones scan IDs). Leave it unplugged. |

### Before the first power-on (multimeter, power OFF)
- [ ] **No continuity** between the 12 V + and any Pi pin or rail.
- [ ] **No continuity** between 12 V − and the Pi GND rail (they stay separate).
- [ ] No continuity between the 3.3 V rail and GND, between 5 V and GND, or between 12 V + and 12 V −.
- [ ] RC522 VCC is on **3.3 V**, never 5 V.
- [ ] The diode stripe is on the solenoid + side.

Then power on **in two steps**:
1. **The Pi alone** (5.1 V USB-C). Nothing gets hot, and the relay LEDs stay **off**.
2. **The 12 V adapter.** Nothing clicks by itself.

✅ The Pi boots normally and `ls /dev/spidev0.*` shows two devices. `i2cdetect -y 1` shows `27` (or `3f`).

---

## Stage 4: Test each part on its own
```bash
npm run hwcheck:pi
```
✅ The startup lists the devices and shows `RST 4,16`, `blue 27,25, red 22,23`.

| Step | Type / do | Pass when |
|---|---|---|
| LCD | `lcd HELLO` | text shows (turn the contrast pot if blank) |
| Backlight | `backlight off`, `backlight on` | the light turns off and on |
| Buzzer | `beep ok`, `beep error` | 1 beep, then 3 beeps |
| Relays | `unlock 1`, `unlock 2` | the relay clicks, the solenoid pulls, and both release after 3 s |
| **Solenoid heat & latch** | set `LOCK_PULSE_MS=10000` in `.env`, `unlock 1` five times in a row, then touch it; also with the lock unpowered, push the door shut: it must latch by itself (slanted bolt). If it can't close while locked, tell the software lead | warm is fine (the kiosk never powers it longer than 10 s). Put 3000 back afterwards. |
| RFID | `rfid` | both readers say `no tag` (not NOT RESPONDING) |
| Tags | `watch`, put each calculator in its locker | reader 1 `FE-AC-31-03`, reader 2 `57-99-3B-03` (tags **inside the calculators, in the lockers**) |
| RFID power | `rfidpower off`, `rfid` → NOT RESPONDING; `rfidpower on`, `rfid` | both readers read again |
| Coins | insert ₱1, ₱5, ₱10, ₱20 (old and new designs) | `COIN: N pulse(s) = PN`. If a coin counts as two, set `COIN_PULSE_GAP_MS=300`. |
| Buttons | press all 4 | `BUTTON: BLUE/RED … for locker N`, once per press |

✅ Every row passes. Type `quit`.

---

## Stage 5: First real run (kiosk on real hardware)
Keep the dashboard laptop running (Stage 0.5).
```bash
npm run start:pi
```
Expected: `PLEASE WAIT / SYNCING CLOCK` → `PRESS TO START / 1:READY 2:READY`. The first sync downloads the lockers and calculators, so `READY` can take up to 1 minute after a clean database.

Do these with a real school ID (see [testing.md](testing.md) §3.2–3.3 for the full list):
- [ ] **Borrow:** press any button → `SCAN ID ON PHONE / CODE ...` → send the ID from a phone (Stage 1) → `PUSH BLUE BUTTON` → blue → name + `P20 / 3 HOURS` → coins → the locker unlocks → take the calculator → `CLOSE THE DOOR / PUSH RED BUTTON` → close it, press red → it locks → `RENTAL SUCCESS / DUE AT …`. **Pull the door: it's locked.**
- [ ] **Return:** press a button, send the ID from the phone → that locker unlocks → put it back → red → `RETURN SUCCESS`.
- [ ] **Wrong calculator** → `WRONG CALCULATOR`, and the lock opens again so it can be fixed.
- [ ] **Payment timeout** (insert nothing for 2 min) → `PAYMENT TIMEOUT`, no locker opens.
- [ ] **Power saving:** idle for 2 min → the LCD dims to `PRESS ANY BUTTON`. A button wakes it **and shows a code straight away**.
- [ ] **Code timeout:** press a button and send nothing for 2 min → `TIME RAN OUT / PRESS TO RETRY`.
- [ ] **No internet:** unplug the Pi's internet but keep its Wi-Fi/hotspot: borrowing with a phone still works.
- [ ] **After hours** (or set *Closes* to a few minutes from now in Settings): `PRESS TO RETURN`, borrowing → `KIOSK CLOSED`, returns still work.
- [ ] **Power cut:** pay, then unplug the Pi before taking the calculator. After reboot the kiosk is ready, no locker opened by itself, and the rental shows **Failed** on the dashboard (refund it by hand).

Stop it with **Ctrl+C**.

---

## Stage 6: Dashboard and sync, end to end
With `start:pi` running and the dashboard open:

| Check | Pass when |
|---|---|
| **Devices** | ONLINE, recent heartbeat, CPU temperature, Power Awake/Asleep, both lockers' RFID `Expected tag` and lock state. **Sync problem: None.** |
| Borrow at the kiosk | appears on **Active Rentals** within ~10 s, with a countdown |
| Return | disappears from Active Rentals, and appears on **Transactions** as Completed |
| Late return | **Penalties** shows it Paid; **Payments** shows ₱20 + ₱10 |
| Block a student on the dashboard | within ~1 min sending their ID says `ACCOUNT BLOCKED` |
| Locker 2 → Maintenance | within ~1 min the LCD shows `2:N/A` |
| **Emergency unlock** (Devices, reason required) | the locker opens for 10 s within ~10 s; Recent commands shows Done; it appears in Audit Logs |
| Send your ID, then unplug the network while paying; finish the borrow and plug it back | the rental appears once; nothing lost or doubled |
| **Event Logs** | rentals, coins and unlocks appear; no ERROR/CRITICAL rows you can't explain |

---

## Stage 7: Start automatically, and the daily routine
### 7.1 Auto-start on boot (interim, until Phase 15)
```bash
sudo nano /etc/systemd/system/calculator-kiosk.service
```
Paste this, replacing `pi` with your username (two places):
```ini
[Unit]
Description=Calculator rental kiosk
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/calculator-rental
ExecStart=/usr/bin/npm run start:pi
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now calculator-kiosk
systemctl status calculator-kiosk
```
Live log:
```bash
journalctl -u calculator-kiosk -f
```
✅ After `sudo reboot`, the LCD comes back to `PRESS TO START` by itself.

### 7.2 Daily routine
| When | Do |
|---|---|
| Morning | Plug in the 12 V adapter, then the Pi. Wait for `PRESS TO START` (it waits for internet time first). The web app (and the `/scan` page) starts on the Pi with it. |
| During the day | Nothing. Check **Devices** now and then. |
| After hours | **Shut down before unplugging** (unplugging a running Pi can corrupt the SD card): `sudo shutdown -h now`, wait until the green LED stops blinking (~10 s), then unplug the Pi, then the 12 V adapter. Phase 15 adds a shutdown button. |
| Weekly | **Event Logs** filtered to Error/Critical. **Penalties** for anything still owed. **Payments** for failed rentals that need a refund. |

---

## Stage 8: Sign-off
| # | Item | Done by | Date |
|---|---|---|---|
| 1 | Stage 0: PRs merged, `db:push`, device secret replaced, real UIDs and settings on the dashboard | | |
| 2 | Stage 1: sticker printed and stuck on; an Android and an iPhone both send a test ID | | |
| 3 | Stage 3: multimeter checks passed, two-step power-on OK | | |
| 4 | Stage 4: every `hwcheck` row passed, solenoid heat acceptable | | |
| 5 | Stage 5: borrow, return, wrong calculator, timeouts, borrowing without internet, sleep, after hours, power cut | | |
| 6 | Stage 6: every dashboard check passed | | |
| 7 | Stage 7: auto-start after reboot, safe shutdown practised | | |
| 8 | Renter guide printed with the officer contact filled in | | |

---

## 9. Most likely to need adjusting (and what to send back)
| Area | Why it's uncertain | If it misbehaves |
|---|---|---|
| Phone scanning | depends on the portable Wi-Fi and each phone's camera | if "No QR code found", take the photo closer and sharper; if phones can't open the page, check they joined the kiosk Wi-Fi and the Pi's reserved address hasn't changed. Send the phone model and what the page said. |
| Solenoid heat | powered 10 s at most (fixed in code) | if the door can't close while locked, the lock needs a slanted bolt |
| LCD on 5 V pull-ups | can confuse the Pi's I2C | level shifter, or remove the backpack resistors |
| Relays at 3.3 V | some boards don't switch off fully | JD-VCC trick, [raspberry-pi.md](raspberry-pi.md) §3.1 |
| Coin pulses | selector speed vs. `COIN_PULSE_GAP_MS` | 300 ms, Slow pulse setting |
| RC522 after power-down | chips re-initialised on wake | if a reader stays NOT RESPONDING after waking, report it; `RFID_RST_PINS=` (empty) disables reader power-down |
| Sync against the live project | tested against the real migrations locally, not the live project | the **Devices** "Sync problem" text + `journalctl` lines starting with `Sync:` |
| Saturday classes | default open days are Mon–Fri | tick **Sat** in Settings |

When something fails, send: **which stage/step**, the **LCD text**, the last ~30 lines of `journalctl -u calculator-kiosk` (or the terminal), and a photo of the wiring for that part.
