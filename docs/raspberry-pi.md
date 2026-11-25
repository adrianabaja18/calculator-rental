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
| Door switch per locker (push button or microswitch, pressed by the closed door) | 2 | GPIO 22, GPIO 23 |

**Not fitted (decided 2026-11-19):**
- **No 3rd relay** for the coin selector. It's always powered, so a coin inserted while idle is logged for an officer refund.

**Door switches (added 2026-11-25):** each locker has a button on its frame that the closed door presses. A rental finishes only after the student shuts the door, and a return completes only with the right calculator inside **and** the door shut. Without switches, set `DOOR_PINS=` (empty) and the RFID check alone decides.

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
| Door switch → Locker 1 | GPIO 22 | 15 | `DOOR_PINS=22,23` |
| Door switch → Locker 2 | GPIO 23 | 16 | |
| 3.3 V (RC522s, PC817 output side) | — | 1, 17 | |
| 5 V (relay module, LCD) | — | 2, 4 | |
| GND (everything, common) | — | 6, 9, 14, 20, 25, 30, 34, 39 | |

**Why GPIO 5 and 6 for the relays:** these pins are pulled **HIGH** while the Pi boots, and HIGH means OFF for an active-LOW relay board. So the solenoids **cannot fire during boot**.

## 3. Wiring each part

### 3.1 Relay module → solenoid locks
```
Pi pin 2  (5V)  ── VCC          Relay COM1 ── +12 V
Pi pin 6  (GND) ── GND          Relay NO1  ── Solenoid 1 (+)   Solenoid 1 (−) ── 12 V GND
Pi pin 29 (GPIO5) ─ IN1         Relay COM2 ── +12 V
Pi pin 31 (GPIO6) ─ IN2         Relay NO2  ── Solenoid 2 (+)   Solenoid 2 (−) ── 12 V GND
Flyback diode (1N4007/1N5408) across EACH solenoid: stripe (cathode) to the + side.
```
- **NO** (normally open) means the lock is energised only while the relay is ON. The kiosk pulses it for `LOCK_PULSE_MS` (3 s) and never holds it, because the solenoids would overheat.
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
COIN wire ──────── PC817 pin 2 (cathode)  PC817 pin 3 (emitter)   ── Pi GND
Selector GND ── 12 V GND                  (GPIO 17 uses the Pi's internal pull-up)
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
| RST | **3.3 V** | **3.3 V** |
| 3.3V | pin 1 / 17 | pin 1 / 17 |

- **3.3 V only.** Powering an RC522 from 5 V damages it.
- **RST is tied to 3.3 V.** The software resets the chip itself, which saves two GPIOs compared with the earlier plan.
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

### 3.7 Door switches (×2)
```
Locker 1 switch: one leg ── GPIO 22 (pin 15)    other leg ── Pi GND
Locker 2 switch: one leg ── GPIO 23 (pin 16)    other leg ── Pi GND
```
- No resistor: the Pi's internal pull-up is used. **Pressed = door CLOSED**, released = OPEN.
- 3-terminal microswitch (COM/NO/NC): use **COM + NO**.
- Mount it so the door presses it fully **only when the latch has caught**. If the button is pressed before the door is fully shut, the kiosk is told the door is closed too early.
- Wire it to the **Pi's** GND, never the 12 V side.

**What the kiosk does with it**
| Step | Door switch | Kiosk |
|---|---|---|
| Borrow: calculator taken | still OPEN | LCD `PLEASE CLOSE / THE LOCKER DOOR` + beep; waits (removal timeout) |
| Borrow: door shut | CLOSED | `RENTAL SUCCESS / DUE AT …` |
| Borrow: never shut | OPEN at timeout | `DOOR LEFT OPEN / SEE AN OFFICER` (rental stays active, warning logged) |
| Return: right calculator in | OPEN | `PLEASE CLOSE / THE LOCKER DOOR`; completes when CLOSED |
| Return: right calculator in, never shut | OPEN at timeout | return **completes** (no extra penalty), `DOOR LEFT OPEN`, warning logged |

## 4. Power
```
12 V adapter (≥3 A) ──┬── Relay COM1/COM2 → solenoids (flyback diodes!)
                      └── Coin selector +12 V / GND
5.1 V 3 A USB-C ──────── Raspberry Pi (its 5 V pins feed relay module + LCD)
Common ground: Pi GND ↔ relay module GND ↔ LCD GND ↔ RC522 GND.
The 12 V ground and the Pi ground meet only where needed. The PC817 keeps the coin signal isolated.
```
Only one locker is ever unlocked at a time (Rule 4), so the 12 V adapter powers one solenoid plus the coin selector.

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
| 6. Door switches | `watch`, then open/close each door | `Door switch 1: CLOSED (pressed)` / `OPEN (released)` |

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
