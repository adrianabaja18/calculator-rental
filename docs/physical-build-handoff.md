# Physical Build Hand-off: from parts to a working kiosk

This guide takes the team from **an assembled frame and a box of parts** to **a kiosk that students can use**, with the dashboard showing everything. Follow the stages **in order**. Each one ends with a check, and you shouldn't start the next stage until that check passes.

| Stage | What | Who | Time |
|---|---|---|---|
| 0 | Get the software ready (merge, database, dashboard) | Lead | 30 min |
| 1 | Flash the ESP32-CAM (firmware 1.1.0) | Anyone with a laptop | 20 min |
| 2 | Prepare the Raspberry Pi (OS, packages, Node, code, `.env`) | Anyone | 1 h |
| 3 | Wire everything, power **off**, then check with a multimeter | Hardware team | 2–3 h |
| 4 | Test each part on its own (`hwcheck:pi`) | Hardware team | 1 h |
| 5 | First real run: the kiosk on real hardware | Whole team | 1 h |
| 6 | Connect it to the dashboard (sync) and test end to end | Lead + team | 1 h |
| 7 | Make it start by itself, plus the daily routine | Lead | 30 min |
| 8 | Sign-off | Whole team | — |

Related documents: [wiring-guide.pdf](wiring-guide.pdf) (every pin, printable), [raspberry-pi.md](raspberry-pi.md) (detailed wiring and troubleshooting), [testing.md](testing.md) (full checklists), [renter-guide.pdf](renter-guide.pdf) (for students), [onboarding.md](onboarding.md) (what each phase built).

> ⚠️ **Honest status:** everything below is tested in software (369 automated tests, a simulator, and a compiled firmware build), but **none of it has run on your physical kiosk yet**. Expect to debug. Section 9 lists what is most likely to need adjusting.

---

## Stage 0: Software ready (lead, on a laptop)

### 0.1 Merge the pull requests, in this order
1. `phase-12/sync`
2. `phase-13/monitoring`
3. `phase-14/simulator`
4. `phase-14b/operating-hours`
5. `phase-14c/power-management`

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
This adds the sync, monitoring and operating-hours migrations to the live Supabase project.

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
| **Settings** | Price ₱20 / 180 min, penalty ₱10 per 90 min, grace 10. **Operating hours** 09:00–17:00, the days the kiosk runs (default Mon–Fri; tick **Sat** if needed), and this semester's **closed dates** (holidays). Removal/return timeouts: start with 60/90 s, and lower them in Stage 4 if the solenoid gets hot. |
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

## Stage 1: Flash the ESP32-CAM (firmware 1.1.0)
Follow [firmware/esp32-cam/README.md](../firmware/esp32-cam/README.md) steps 1–3 and **6**:
1. Arduino IDE settings: ESP32 core **2.0.17**, board **AI Thinker ESP32-CAM**, library **ESP32QRCodeReader**.
2. Upload `firmware/esp32-cam/esp32-cam-qr/esp32-cam-qr.ino`.
3. Serial Monitor at 115200 should show `{"type":"hello","fw":"1.1.0","state":"awake"}`. Scanning an ID shows `{"type":"qr",...}`.
4. Power saving: send `{"cmd":"sleep"}`, then `{"cmd":"wake"}`. QR codes read again after about 1 s. **Repeat 5 times.**

✅ The scanner reads IDs, and still reads after every sleep/wake.
❌ If it stops reading after a wake-up, report it (Section 9). The kiosk still works with `POWER_SAVE=false`.

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
QR_SCANNER=serial
SCANNER_PORT=/dev/ttyUSB0
LOG_PRETTY=false
```
Leave the pin settings as they are. They match the final wiring:

| Setting | Value | Meaning |
|---|---|---|
| `RELAY_PINS` | `5,6` | relay IN1/IN2 (active-LOW board) |
| `COIN_PIN` | `17` | PC817 output |
| `BUZZER_PIN` | `18` | buzzer |
| `RFID_SPI` / `RFID_RST_PINS` | `0.0,0.1` / `4,16` | readers 1 and 2 |
| `CLOSE_BUTTON_PINS` / `SELECT_BUTTON_PINS` | `22,23` / `24,25` | red / blue buttons |
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
| 6 | **Buttons ×4** | COM ① → GND rail; NO ③ (bottom tab): RED 1 → pin 15, RED 2 → pin 16, BLUE 1 → pin 18, BLUE 2 → pin 22; NC ② unused |
| 7 | **PC817 (coin)** | Pi side: pin 4 → pin 11 (GPIO 17) + 10 kΩ to pin 17 (3.3 V); pin 3 → pin 20 (GND). 12 V side: +12 V → 2.2 kΩ → pin 1; selector COIN → pin 2. |
| 8 | **12 V side** | +12 V → relay COM1, COM2, coin selector +12 V, 2.2 kΩ. Relay NO1/NO2 → solenoid +. Solenoid − and selector GND → **12 V −**. **Flyback diode across each solenoid** (stripe to +). |
| 9 | **ESP32-CAM** | USB-C cable to a Pi USB port |

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
✅ The startup lists the devices and shows `RST 4,16`, `blue 24,25, red 22,23`.

| Step | Type / do | Pass when |
|---|---|---|
| LCD | `lcd HELLO` | text shows (turn the contrast pot if blank) |
| Backlight | `backlight off`, `backlight on` | the light turns off and on |
| Buzzer | `beep ok`, `beep error` | 1 beep, then 3 beeps |
| Relays | `unlock 1`, `unlock 2` | the relay clicks, the solenoid pulls, and both release after 3 s |
| **Solenoid heat** | set `LOCK_PULSE_MS=60000` in `.env`, restart, `unlock 1`, touch after 60 s | warm is fine. **Too hot to hold** → lower the removal/return timeouts in Settings. Put 3000 back afterwards. |
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
Expected: `PLEASE WAIT / SYNCING CLOCK` → `SCAN STUDENT ID / 1:READY 2:READY`. The first sync downloads the lockers and calculators, so `READY` can take up to 1 minute after a clean database.

Do these with a real school ID (see [testing.md](testing.md) §3.2–3.3 for the full list):
- [ ] **Borrow:** scan → `PUSH BLUE BUTTON` → blue → name + `P20 / 3 HOURS` → coins → the locker unlocks → take the calculator → `CLOSE THE DOOR / PUSH RED BUTTON` → close it, press red → it locks → `RENTAL SUCCESS / DUE AT …`. **Pull the door: it's locked.**
- [ ] **Return:** scan → that locker unlocks → put it back → red → `RETURN SUCCESS`.
- [ ] **Wrong calculator** → `WRONG CALCULATOR`, and the locker stays unlocked until it's fixed.
- [ ] **Payment timeout** (insert nothing for 2 min) → `PAYMENT TIMEOUT`, no locker opens.
- [ ] **Power saving:** idle for 2 min → the LCD dims to `PRESS ANY BUTTON`. A button wakes it, and **a QR scan works within ~2 s**.
- [ ] **After hours** (or set *Closes* to a few minutes from now in Settings): `RETURNS ONLY`, borrowing → `KIOSK CLOSED`, returns still work.
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
| Block a student on the dashboard | within ~1 min their scan says `ACCOUNT BLOCKED` |
| Locker 2 → Maintenance | within ~1 min the LCD shows `2:N/A` |
| **Emergency unlock** (Devices, reason required) | the locker opens for 10 s within ~10 s; Recent commands shows Done; it appears in Audit Logs |
| Unplug the network, borrow, plug it back | the rental appears once; nothing lost or doubled |
| **Event Logs** | scans, coins and unlocks appear; no ERROR/CRITICAL rows you can't explain |

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
✅ After `sudo reboot`, the LCD comes back to `SCAN STUDENT ID` by itself.

### 7.2 Daily routine
| When | Do |
|---|---|
| Morning | Plug in the 12 V adapter, then the Pi. Wait for `SCAN STUDENT ID` (it waits for internet time first). |
| During the day | Nothing. Check **Devices** now and then. |
| After hours | **Shut down before unplugging** (unplugging a running Pi can corrupt the SD card): `sudo shutdown -h now`, wait until the green LED stops blinking (~10 s), then unplug the Pi, then the 12 V adapter. Phase 15 adds a shutdown button. |
| Weekly | **Event Logs** filtered to Error/Critical. **Penalties** for anything still owed. **Payments** for failed rentals that need a refund. |

---

## Stage 8: Sign-off
| # | Item | Done by | Date |
|---|---|---|---|
| 1 | Stage 0: PRs merged, `db:push`, device secret replaced, real UIDs and settings on the dashboard | | |
| 2 | Stage 1: ESP32-CAM 1.1.0 reads IDs and survives sleep/wake ×5 | | |
| 3 | Stage 3: multimeter checks passed, two-step power-on OK | | |
| 4 | Stage 4: every `hwcheck` row passed, solenoid heat acceptable | | |
| 5 | Stage 5: borrow, return, wrong calculator, timeout, sleep, after hours, power cut | | |
| 6 | Stage 6: every dashboard check passed | | |
| 7 | Stage 7: auto-start after reboot, safe shutdown practised | | |
| 8 | Renter guide printed with the officer contact filled in | | |

---

## 9. Most likely to need adjusting (and what to send back)
| Area | Why it's uncertain | If it misbehaves |
|---|---|---|
| ESP32-CAM sleep/wake (fw 1.1.0) | new decoding loop, not yet run on the board | set `POWER_SAVE=false` to keep going; send the Serial Monitor output after a failed wake |
| Solenoid heat | held open up to 60–90 s | lower the timeouts in Settings (minimum 15 s) |
| LCD on 5 V pull-ups | can confuse the Pi's I2C | level shifter, or remove the backpack resistors |
| Relays at 3.3 V | some boards don't switch off fully | JD-VCC trick, [raspberry-pi.md](raspberry-pi.md) §3.1 |
| Coin pulses | selector speed vs. `COIN_PULSE_GAP_MS` | 300 ms, Slow pulse setting |
| RC522 after power-down | chips re-initialised on wake | if a reader stays NOT RESPONDING after waking, report it; `RFID_RST_PINS=` (empty) disables reader power-down |
| Sync against the live project | tested against the real migrations locally, not the live project | the **Devices** "Sync problem" text + `journalctl` lines starting with `Sync:` |
| Saturday classes | default open days are Mon–Fri | tick **Sat** in Settings |

When something fails, send: **which stage/step**, the **LCD text**, the last ~30 lines of `journalctl -u calculator-kiosk` (or the terminal), and a photo of the wiring for that part.
