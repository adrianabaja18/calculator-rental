# Raspberry Pi Hardware Guide

Final wiring for the team's parts (Phase 11), Raspberry Pi setup, and step-by-step bring-up.
The software side is `apps/raspberry-pi` (Node.js kiosk) and `apps/raspberry-pi/hw-bridge/hw_bridge.py` (Python I/O helper).

> **Safety first:** wire with the power **off**. Never connect 12 V or 5 V to a GPIO pin; the Pi's GPIO is **3.3 V only**.

## 1. Parts (as built)

| Part | Qty | Connects to |
|---|---|---|
| Raspberry Pi 4 Model B | 1 | — |
| RC522 RFID reader (13.56 MHz) | 2 | SPI0, CE0 / CE1 |
| RFID tag inside each calculator | 2 | — |
| 12 V solenoid lock | 2 | relay contacts |
| ACE 6345 2-channel optocoupler relay module, 5 V, **active-LOW** | 1 | GPIO 5, GPIO 6 |
| Allan 1239 Pro Max coin selector (12 V) | 1 | **PC817** optocoupler → GPIO 17 |
| PC817 optocoupler (or PC817 module) | 1 | between coin selector and Pi |
| 16×2 LCD with PCF8574 I2C backpack | 1 | I2C-1 (GPIO 2/3) |
| Buzzer (active buzzer module) | 1 | GPIO 18 |
| ESP32-CAM + OV2640 on USB-C base | 1 | Pi USB port (`/dev/ttyUSB0`) |
| 12 V adapter (≥ 3 A) | 1 | solenoids + coin selector |
| 5.1 V / 3 A USB-C supply | 1 | Raspberry Pi |
| Arcade push button (Yenox microswitch), **blue**, one per locker: "choose this locker" | 2 | GPIO 27, GPIO 25 |
| Arcade push button (Yenox microswitch), **red**, one per locker: "I closed the door" | 2 | GPIO 22, GPIO 23 |

**Not fitted (decided 2026-11-19):**
- **No 3rd relay** for the coin selector. It's always powered, so a coin inserted while idle is logged for an officer refund.
- **No door sensors.** The red button tells the kiosk the door is shut (decided 2026-11-25). Reed switches can still be added with `DOOR_PINS`.

**Front panel (decided 2026-11-25):** `[BLUE 1] [RED 1]  [ LCD ]  [BLUE 2] [RED 2]`. The left pair belongs to Locker 1 and the right pair to Locker 2. The student picks a locker with its **blue** button. A locker stays **unlocked** until the student presses its **red** button (or the timeout ends), and then it locks.

## 2. Pin map (BCM numbering)

| Function | BCM | Physical pin | `.env` setting |
|---|---|---|---|
| Relay IN1 → Locker 1 solenoid | GPIO 5 | 29 | `RELAY_PINS=5,6` |
| Relay IN2 → Locker 2 solenoid | GPIO 6 | 31 | |
| Coin pulses (PC817 output) | GPIO 17 | 11 | `COIN_PIN=17` |
| Buzzer | GPIO 18 | 12 | `BUZZER_PIN=18` |
| LCD SDA | GPIO 2 | 3 | `I2C_BUS=1`, `LCD_I2C_ADDRESS=0x27` |
| LCD SCL | GPIO 3 | 5 | |
| RC522 SCK (both readers) | GPIO 11 | 23 | |
| RC522 MOSI (both) | GPIO 10 | 19 | |
| RC522 MISO (both) | GPIO 9 | 21 | |
| RC522 #1 SDA/SS → Locker 1 | GPIO 8 (CE0) | 24 | `RFID_SPI=0.0,0.1` |
| RC522 #2 SDA/SS → Locker 2 | GPIO 7 (CE1) | 26 | |
| RED button → Locker 1 | GPIO 22 | 15 | `CLOSE_BUTTON_PINS=22,23` |
| RED button → Locker 2 | GPIO 23 | 16 | |
| BLUE button → Locker 1 | GPIO 27 | 13 | `SELECT_BUTTON_PINS=27,25` |
| BLUE button → Locker 2 | GPIO 25 | 22 | |
| RC522 #1 RST | GPIO 4 | 7 | `RFID_RST_PINS=4,16` (held HIGH by the bridge) |
| RC522 #2 RST | GPIO 16 | 36 | |
| 3.3 V → both RC522 3.3V | — | 1 | |
| 3.3 V → PC817 10 kΩ pull-up (to GPIO 17) | — | 17 | |
| 5 V → LCD (pin 2); relay module VCC (pin 4) | — | 2, 4 | |
| GND → PC817 emitter (pin 20); everything else on the GND rail | — | 6, 9, 14, 20, 25, 30, 34, 39 | |

*Final working wiring confirmed by the team on 2026-11-26.*

**Why GPIO 5 and 6 for the relays:** these pins are pulled **HIGH** while the Pi boots, and HIGH means OFF for an active-LOW relay board. So the solenoids **cannot fire during boot**.

## 3. Wiring each part

### 3.1 Relay module → solenoid locks
```
Pi pin 4  (5V)  ── VCC          Relay COM1 ── +12 V
Pi pin 6  (GND) ── GND          Relay NO1  ── Solenoid 1 (+)   Solenoid 1 (−) ── 12 V GND
Pi pin 29 (GPIO5) ─ IN1         Relay COM2 ── +12 V
Pi pin 31 (GPIO6) ─ IN2         Relay NO2  ── Solenoid 2 (+)   Solenoid 2 (−) ── 12 V GND
Flyback diode (1N4007/1N5408) across EACH solenoid: stripe (cathode) to the + side.
```
- **NO** (normally open) means the lock is energised (unlocked) only while the relay is ON.
- The kiosk keeps the relay ON from payment until the student presses the **red** button. The longest it can stay ON is the **removal timeout** when borrowing or the **return timeout** when returning (dashboard **Settings**, default 60 s and 90 s). The Python bridge turns the relay off at that limit by itself, even if the kiosk program crashes.
- **Heat:** many cheap 12 V solenoid locks are rated for only about 10 s ON at a time, so the kiosk never powers one longer than **10 s** (`SOLENOID_MAX_ON_MS`). The student pulls the door open in that time, and the door latches when pushed shut. **Latch check:** with the lock **unpowered**, push the door shut: it must latch by itself (slanted bolt). If it can't close while locked, tell the software lead.
- **3.3 V trigger check:**
  1. Power up and run `npm run hwcheck:pi`.
  2. At rest, both relay LEDs must be **off**.
  3. `unlock 1` should click ON, then OFF after 3 s.
  4. If a relay **stays on or chatters**, the board isn't fully switching off at 3.3 V. Remove the **JD-VCC jumper**, wire **VCC → Pi 3.3 V (pin 1)** and **JD-VCC → Pi 5 V (pin 2)**, and keep GND common.
- The 12 V side never touches the Pi except through the relay contacts.

### 3.2 Coin selector → PC817 → GPIO 17
The Allan 1239 runs on 12 V. Its **COIN** wire pulses LOW once per peso (programmed: ₱1 = 1 pulse, ₱5 = 5, ₱10 = 10, ₱20 = 20). The PC817 keeps the 12 V side completely separate from the Pi.
```
COIN SELECTOR SIDE (12 V)                 PI SIDE (3.3 V)
+12 V ── 2.2 kΩ ── PC817 pin 1 (anode)    PC817 pin 4 (collector) ── GPIO 17 (pin 11)
COIN wire ──────── PC817 pin 2 (cathode)  PC817 pin 4 ── 10 kΩ ── 3.3 V (pin 17)  (pull-up)
Selector GND ── 12 V GND                  PC817 pin 3 (emitter)   ── GND (pin 20)
```
- **PC817 module board** (with screw terminals): wire **IN+ → +12 V** and **IN− → COIN**. On the output side, **OUT → GPIO 17** and **GND → Pi GND**. If the module has a VCC pin for its output pull-up, connect it to **3.3 V, never 5 V**.
- Selector switches:
  - **NO** (normally open)
  - pulse speed **Medium or Slow**
  - train **both** old and new ₱1/₱5/₱10 coins (plus ₱20 if accepted)
- If a ₱5 shows up as two coins in `hwcheck:pi`, raise `COIN_PULSE_GAP_MS` to 300.

### 3.3 RC522 readers (×2, SPI)
| RC522 pin | Reader #1 (Locker 1) | Reader #2 (Locker 2) |
|---|---|---|
| SDA (SS) | GPIO 8 / pin 24 | GPIO 7 / pin 26 |
| SCK | pin 23 | pin 23 |
| MOSI | pin 19 | pin 19 |
| MISO | pin 21 | pin 21 |
| IRQ | not connected | not connected |
| GND | GND | GND |
| RST | **GPIO 4 / pin 7** | **GPIO 16 / pin 36** |
| 3.3V | pin 1 / 17 | pin 1 / 17 |

- **3.3 V only.** Powering an RC522 from 5 V damages it.
- **RST goes to GPIO 4 (reader 1) and GPIO 16 (reader 2).** At start-up the bridge pulses both LOW for 50 ms (hard reset), then **holds them HIGH**. A reader whose RST is LOW is switched off and shows `NOT RESPONDING`. GPIO 16 is pulled LOW by default at boot, so this step is required. If you ever tie RST straight to 3.3 V instead, set `RFID_RST_PINS=` (empty).
- Each antenna is switched on **only while it's reading**, so the two readers don't interfere. Still keep them **≥ 10 cm apart**.
- Mount each tag where it sits **flat over its reader** when the calculator is stowed. Batteries and metal reduce range.

### 3.4 16×2 LCD (I2C backpack)
```
LCD GND ── Pi GND     LCD VCC ── Pi 5 V (pin 4)
LCD SDA ── GPIO 2 (pin 3)     LCD SCL ── GPIO 3 (pin 5)
```
- The backpack pulls SDA and SCL up to **5 V**. Use a **BSS138 level shifter**, or remove the backpack's two pull-up resistors. The Pi has its own 3.3 V pull-ups.
- Find the address with `i2cdetect -y 1`. It's usually `27` or `3f`; set `LCD_I2C_ADDRESS` to match.
- Blank or solid blocks: turn the **blue contrast potentiometer** on the backpack.

### 3.5 Buzzer
- **Active buzzer module** (VCC/GND/I/O): I/O to GPIO 18 (pin 12), VCC to 3.3 V or 5 V as the module requires, GND to GND.
  - If it beeps constantly when idle, it's "low level trigger": set `BUZZER_ACTIVE_LOW=true`.
- **Bare buzzer** drawing more than about 15 mA: drive it through an NPN transistor (2N2222 plus a 1 kΩ base resistor). Don't drive it from the pin directly.

### 3.6 ESP32-CAM (QR scanner)
- Plug its USB-C base into a Pi USB port. It shows up as `/dev/ttyUSB0`.
- A path that never changes is `/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0` (check with `ls /dev/serial/by-id/`). Put it in `SCANNER_PORT`.

### 3.7 Front-panel buttons (×4)
Each button's microswitch has three tabs: **COM ①**, **NC ②** (top) and **NO ③** (bottom).
```
RED 1  (Locker 1):  COM ── Pi GND    NO ③ ── GPIO 22 (pin 15)    NC ② ── not connected
RED 2  (Locker 2):  COM ── Pi GND    NO ③ ── GPIO 23 (pin 16)    NC ② ── not connected
BLUE 1 (Locker 1):  COM ── Pi GND    NO ③ ── GPIO 27 (pin 13)    NC ② ── not connected
BLUE 2 (Locker 2):  COM ── Pi GND    NO ③ ── GPIO 25 (pin 22)    NC ② ── not connected
```
- No resistors: the Pi's internal pull-ups are used. All four COM wires can share one GND pin (pin 14 or 20 is closest).
- **Pi GND only**, never the 12 V side.
- Check: in `hwcheck:pi`, each press prints `BUTTON: BLUE (choose locker) for locker 1`, and so on. A button that prints nothing, or prints when you *release* it, is on the NC tab.

**What the kiosk does with them**
| Step | LCD | Button |
|---|---|---|
| Idle | `SCAN STUDENT ID` / `1:READY 2:N/A` | — |
| After a valid scan (borrow) | `PUSH BLUE BUTTON` / `1:READY 2:N/A` | **Blue** of a READY locker (30 s). A locker that isn't READY shows `LOCKER 2 N/A`; pick the other one. |
| Locker unlocked, calculator inside | `LOCKER 1 OPEN` / `TAKE CALCULATOR` | Red is ignored until the calculator is out |
| Calculator taken | `CLOSE THE DOOR` / `PUSH RED BUTTON` | **Red** of that locker → locks → `RENTAL SUCCESS` |
| Return: locker unlocked | `RETURN CALC #1` / `TO LOCKER 1` | — |
| Right calculator placed | `CLOSE THE DOOR` / `PUSH RED BUTTON` | **Red** → RFID checked → locks → `RETURN SUCCESS` |
| Wrong or no calculator when red is pressed | `WRONG CALCULATOR` or `CALCULATOR NOT DETECTED` | The lock **opens again** for 10 s; fix it and press red again |
| Red never pressed | `DOOR LEFT OPEN` / `SEE AN OFFICER` | Locks at the timeout. A borrow stays active; a return with the right calculator inside still completes. A warning is logged. |

## 4. Power
```
12 V adapter (≥3 A) ──┬── Relay COM1/COM2 → solenoids (flyback diodes!)
                      └── Coin selector +12 V / GND
5.1 V 3 A USB-C ──────── Raspberry Pi (its 5 V pins feed relay module + LCD)
Common ground: Pi GND ↔ relay module GND ↔ LCD GND ↔ RC522 GND.
The 12 V ground and the Pi ground meet only where needed. The PC817 keeps the coin signal isolated.
```
Only one locker is ever unlocked at a time (Rule 4), so the 12 V adapter powers one solenoid plus the coin selector.

### 4.1 Power saving and heat (added 2026-11-27)
When nobody uses the kiosk, it **sleeps**. Any **button press** wakes it. That press only wakes it, so nobody picks a locker by accident.

| Part | Asleep | How |
|---|---|---|
| **ESP32-CAM camera** | **Off** (OV2640 power-down pin, CPU 240 → 80 MHz) | `{"cmd":"sleep"}` over USB serial (firmware **1.1.0**, re-flash needed) |
| **LCD backlight** | **Off** (text stays, dim: `PRESS ANY BUTTON / TO START`) | PCF8574 backlight bit (`backlight` bridge command) |
| **RC522 readers ×2** | **Off** (RST held LOW = hard power-down, microamps) | GPIO 4 / 16 (`RFID_RST_PINS`); readers are re-initialised on wake |
| Solenoids / relays | Already off except during an unlock | — |
| Coin selector | Stays on (no 3rd relay) | A coin also wakes the kiosk (it's logged for refund, as before) |
| Sensor polling | Paused (readers are off) | Resumes, with a fresh reading, on wake |

- **When:** after `SLEEP_AFTER_SECONDS` (default **120 s**) idle on the ready screen, or `CLOSED_SLEEP_AFTER_SECONDS` (default **30 s**) outside operating hours. Never in the middle of a rental or return.
- **Wakes on:** any blue or red button, a coin, an officer's emergency unlock, or a QR scan if the camera is still on.
- **Turn it off:** `POWER_SAVE=false` in `.env`. The dashboard's **Devices** page shows *Power: Asleep/Awake*.
- **Heat watch:** the kiosk logs a WARNING event when the Pi's CPU reaches **75 °C** and a CRITICAL one at **80 °C** (where the Pi slows itself down), at most once per 30 min. They show on **Event Logs**.

**Raspberry Pi itself (optional, saves a little more heat):**
- Fit the heatsinks, and a small 5 V fan if the enclosure is closed. Leave vent holes at the top and bottom.
- Turn off Bluetooth (not used): add `dtoverlay=disable-bt` to `/boot/firmware/config.txt`, then reboot.
- Run it without a monitor attached (HDMI unplugged).
- Keep the Wi-Fi on if the kiosk uses Wi-Fi for internet. Turn it off (`dtoverlay=disable-wifi`) only if the kiosk uses Ethernet.

## 5. Raspberry Pi setup (once)
On Raspberry Pi OS (64-bit, Bookworm or newer):
```bash
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
sudo apt update
sudo apt install -y git i2c-tools python3-gpiozero python3-lgpio python3-spidev python3-smbus2
sudo usermod -aG gpio,spi,i2c,dialout $USER
sudo reboot
```
Install **Node.js 22 LTS** (follow nodejs.org → "Download Node.js" for Linux/ARM64, or the NodeSource instructions), then:
```bash
git clone https://github.com/adrianabaja18/calculator-rental.git
cd calculator-rental
npm ci
cp apps/raspberry-pi/.env.example apps/raspberry-pi/.env
nano apps/raspberry-pi/.env
```
In `.env` set:
- `HARDWARE_MODE=real`
- `QR_SCANNER=serial`
- `SCANNER_PORT=/dev/ttyUSB0`
- `BACKEND_URL` = your laptop's `http://<laptop-ip>:3000`, or the deployed site

## 6. Bring-up, one part at a time
```bash
npm run hwcheck:pi
```
The tool prints which devices it found, then accepts commands. Work through it in this order:

| Step | Type | Expect |
|---|---|---|
| 1. LCD | `lcd HELLO` | text on the LCD (adjust contrast if blank) |
| 2. Buzzer | `beep error` | three short beeps |
| 3. Relays | `unlock 1`, `unlock 2` | that relay clicks ON, then OFF after 3 s, and the solenoid pulls |
| 4. RFID | `watch`, then place/remove each calculator over its reader | `RFID reader 1: tag 04-…` / `no tag` |
| 5. Coins | insert ₱1, ₱5, ₱10, ₱20 | `COIN: 5 pulse(s) = P5`, … |
| 6. Buttons | press each of the 4 buttons | `BUTTON: BLUE (choose locker) for locker 1`, `BUTTON: RED (door closed) for locker 2`, … |

**Write down the two tag UIDs from step 4.** They go into the dashboard (**Calculators → Edit → RFID tag UID**) and into the kiosk's local database (Phase 12 sync will do this automatically; until then pass them to the seed, using your own UIDs):

Then run the whole kiosk:
```bash
npm run seed:pi -- --rfid1 <UID of the Locker 1 calculator> --rfid2 <UID of the Locker 2 calculator>
```
```bash
npm run start:pi
```

## 7. Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| `Hardware bridge did not start` | Python packages missing (step 5), or run `python3 apps/raspberry-pi/hw-bridge/hw_bridge.py --help` to see the error |
| `RFID reader 2 not available: no answer on SPI0.1` | SPI not enabled, a wrong SS wire, or the reader is on 5 V. Check `ls /dev/spidev0.*` shows two devices |
| `LCD not available at 0x27` | Wrong address (`i2cdetect -y 1`) or I2C not enabled |
| Relay stays on | See the 3.3 V trigger check in §3.1 |
| No coins counted | NO/NC switch, PC817 orientation (pin 1 dot = anode), or the 12 V supply |
| A coin counted as two | Raise `COIN_PULSE_GAP_MS` to 300 |
| Permission errors on GPIO/SPI/I2C | You skipped `usermod -aG gpio,spi,i2c,dialout` + reboot |

## 8. Still open
- **RTC (DS3231):** deferred. Without it, the kiosk waits for internet time after each boot.
