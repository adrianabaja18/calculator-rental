# Raspberry Pi Hardware Plan

> **Status:** planning document. The pin map is a *proposal* that is finalized and tested in Phase 11.
> Nothing here needs to be wired for Phase 1, since the software runs with `HARDWARE_MODE=mock`.

## 1. Bill of materials (as provided)

| # | Part | Qty | Interface to Pi |
|---|---|---|---|
| 1 | Raspberry Pi 4 Model B (main controller) | 1 | — |
| 2 | RFID reader | 2 | SPI (assumed MFRC522 / RC522, 13.56 MHz; see §5) |
| 3 | RFID tag embedded in each calculator | 2 | — |
| 4 | 12 V solenoid lock | 2 | through relays |
| 5 | Relay module channel | 2 | GPIO |
| 6 | ESP32-CAM + OV2640 with USB-C programmer base | 1 | USB serial |
| 7 | LCD with I2C backpack (PCF8574) | 1 | I2C |
| 8 | 12 V power adapter | 1 | power for solenoids and coin selector |
| 9 | Allan 1239 Pro Max universal (multi-coin) coin selector | 1 | GPIO pulse input through an optocoupler |
| — | Buzzer, optional door reed switches | — | GPIO |

## 2. Proposed GPIO map (BCM numbering)

| Function | BCM GPIO | Physical pin | Notes |
|---|---|---|---|
| LCD SDA | GPIO 2 | 3 | I2C-1. Use a level shifter (see §4.3). |
| LCD SCL | GPIO 3 | 5 | I2C-1 |
| SPI MOSI (both RFID) | GPIO 10 | 19 | SPI0, shared bus |
| SPI MISO (both RFID) | GPIO 9 | 21 | SPI0, shared bus |
| SPI SCLK (both RFID) | GPIO 11 | 23 | SPI0, shared bus |
| RFID #1 SDA/CS (Locker 1) | GPIO 8 (CE0) | 24 | |
| RFID #2 SDA/CS (Locker 2) | GPIO 7 (CE1) | 26 | |
| RFID #1 RST | GPIO 25 | 22 | |
| RFID #2 RST | GPIO 24 | 18 | |
| Relay 1 → Locker 1 solenoid | GPIO 5 | 29 | Pulled **high** at boot, so an active-LOW relay stays OFF. |
| Relay 2 → Locker 2 solenoid | GPIO 6 | 31 | Pulled **high** at boot, so an active-LOW relay stays OFF. |
| Coin pulse input | GPIO 17 | 11 | From the optocoupler output with internal pull-up |
| Coin selector power gate (recommended 3rd relay) | GPIO 4 | 7 | Pulled high at boot, so the relay is OFF and the selector is disabled. |
| Buzzer (through a transistor) | GPIO 18 | 12 | PWM-capable |
| Door sensor Locker 1 (optional reed) | GPIO 22 | 15 | Internal pull-up, reed switch to GND |
| Door sensor Locker 2 (optional reed) | GPIO 23 | 16 | Internal pull-up, reed switch to GND |
| ESP32-CAM | USB port | — | Appears as `/dev/ttyUSB0` (CH340 on the USB-C base) |

**Why GPIO 4, 5 and 6 for relays?** GPIO 0–8 default to pull-**up** at power-on and GPIO 9–27 default to pull-**down**. Most cheap relay modules are **active-LOW**. Putting them on pull-up pins means **no solenoid fires while the Pi boots**. If your relay module turns out to be active-HIGH, move the relays to pull-down pins (for example GPIO 26 and 27). The software will make polarity configurable.

## 3. Power architecture

```
12 V adapter (≥ 3 A recommended) ──┬── Relay 1 COM → NO → Solenoid 1 (+ flyback diode) → GND
                                   ├── Relay 2 COM → NO → Solenoid 2 (+ flyback diode) → GND
                                   └── (Relay 3) → Coin selector +12 V

Raspberry Pi 4 ← official 5.1 V / 3 A USB-C supply (recommended)
                 or a quality 12 V → 5 V **5 A** buck converter

All grounds common, EXCEPT across the coin-selector optocoupler (isolated by design).
```

- **Flyback diode** (1N4007, or 1N5408 for large solenoids) across each solenoid, cathode to +12 V. Without it the inductive kick can reset the Pi, weld relay contacts, or corrupt the SD card.
- **Pulse the solenoid, don't hold it.** Most 12 V cabinet solenoid locks are not rated for continuous duty and overheat. The software energizes the lock for a few seconds (configurable, about 3–5 s). The student opens the door during that window, and the slanted latch re-locks when the door is pushed shut.
- Only **one** locker is ever unlocked at a time (Rule 4), so the adapter only has to supply one solenoid plus the coin selector.
- A separate supply for the Pi avoids under-voltage resets when a solenoid switches.

## 4. Component-specific notes

### 4.1 Allan 1239 Pro Max coin selector (important)
- **The coin signal must not go straight into a Pi GPIO.** The selector runs on 12 V. Depending on the unit and the NO/NC switch, the COIN line may be open-collector or pulled up internally. Any voltage above 3.3 V destroys a GPIO. **Recommended:** a PC817 optocoupler module between the COIN output and GPIO 17. Measure the COIN line with a multimeter before connecting anything.
- **Program pulses equal to the peso value:** ₱1 = 1 pulse, ₱5 = 5 pulses, ₱10 = 10 pulses. Software then counts pulses and finalizes a coin after a quiet gap of about 200 ms.
- **Pulse speed:** set the selector to the *medium* or *slow* pulse width for reliable edge detection on Linux.
- **Train both coin series.** Old BSP-series and new NGC-series ₱1, ₱5 and ₱10 coins differ in size and alloy. Use the selector's sample-learning mode for both versions of each accepted denomination (up to the number of coin channels your unit supports).
- **Enable it only during payment.** The specification says "enable coin acceptor" in the PAYMENT_PENDING state. With only 2 relays (both used by the locks), the selector is always on, so a coin inserted while the kiosk is idle would be swallowed. **Recommended:** use a 3rd relay channel to switch the selector's 12 V (GPIO 4 above). If that is not possible, the software logs such coins as `UNATTRIBUTED_COIN` events so officers can refund them.

### 4.2 RFID readers (two on one SPI bus)
- Both readers share MOSI, MISO and SCLK. Each has its own chip-select (CE0 / CE1) and RST.
- RC522 boards are **3.3 V only**. Power them from the Pi's 3.3 V pin, never 5 V.
- **Presence detection:** the software polls each reader every ~200–300 ms with a wake-up request. "Tag present" means the expected UID was read recently, and "removed" means N consecutive polls missed. This gives the *removal confirmed* (Rule 7) and *return verified* (Rule 8) signals.
- **Interference:** keep the two antennas at least about 10 cm apart, or poll them alternately with the antenna of the idle reader turned off.
- **Mounting:** stick the tag where it sits flat over the reader when the calculator is stowed. Batteries and metal reduce range, so test the read distance with the calculator in place.

### 4.3 I2C LCD (PCF8574 backpack)
- The backpack is normally powered at 5 V (needed for LCD contrast) and has pull-up resistors to **5 V** on SDA and SCL. The Pi's I2C pins are 3.3 V. **Recommended:** a BSS138 bidirectional level shifter, or remove the backpack's pull-ups.
- Common addresses are `0x27` or `0x3F`. Check with `i2cdetect -y 1` in Phase 11.
- A **16×2** LCD fits 16 characters per line, so all kiosk messages are written to fit (for example `Return by 12:00PM` becomes `Due: 12:00 PM`). Tell us if yours is 20×4.

### 4.4 ESP32-CAM + OV2640 (USB-C base)
- Connect the base's USB-C to a Pi USB port. This provides both power and serial.
- Wi-Fi stays **off** on the ESP32. It only decodes QR codes and prints one JSON line per scan.
- Opening the serial port can toggle DTR/RTS and **reset** the ESP32. The Pi service handles this at startup in Phase 10.
- The on-board flash LED (GPIO 4 on the ESP32) can be dimmed with PWM to light the ID for scanning.

## 5. Open questions to confirm before Phase 10 and 11

1. **RFID reader model.** This plan assumes MFRC522 (RC522, 13.56 MHz, SPI). If they are **125 kHz** readers (for example RDM6300 over UART), they only report a tag once when it arrives and **cannot report removal**. That changes the design.
2. **Relay module polarity:** active-LOW or active-HIGH? Many modules have an `IN` LED that lights when the input is pulled LOW.
3. **LCD size:** 16×2 or 20×4?
4. **Student ID QR content.** Scan your school ID with a phone QR app. Is the result just the student number, a URL, or text with name and course? Redact real data before sharing. The QR parser is built around this.
5. Can you add a **3rd relay** (coin selector power) and **2 reed switches** (door sensors)? Both are cheap and make the system much more robust.

## 6. Raspberry Pi OS setup (preview; full steps in Phase 9)
- Raspberry Pi OS Lite (64-bit), Node.js 22 LTS, `raspi-config` → enable **I2C** and **SPI**.
- Install only the Pi workspace: `npm install --workspace @calc-rental/raspberry-pi`.
- Run the kiosk as a `systemd` service with `Restart=always`. SQLite lives at `/var/lib/calc-kiosk/kiosk.db`.
