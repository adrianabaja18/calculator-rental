# ESP32-CAM QR Scanner Firmware

Turns the **AI-Thinker ESP32-CAM (OV2640)** on its **USB-C programmer base (CH340)** into a QR scanner for the kiosk. It decodes school-ID QR codes and sends the raw text to the Raspberry Pi over the USB cable.

- **No Wi-Fi or Bluetooth.** The ESP32 never touches the network or any credentials.
- **Protocol** (115200 baud, one JSON object per line):
  ```
  ESP32 → Pi
  {"type":"hello","fw":"1.1.0","state":"awake"}                 after boot
  {"type":"alive","seq":12}                                     every 5 s
  {"type":"qr","seq":13,"data":"JUAN DELA CRUZ\t2022100001\tBSCpE"}   a scanned QR
  {"type":"state","state":"sleeping"}                           after a sleep/wake command
  {"type":"error","message":"camera restart failed"}            camera problems
  Pi → ESP32 (power saving)
  {"cmd":"sleep"}    camera OFF (OV2640 power-down pin), no decoding, CPU 240 → 80 MHz
  {"cmd":"wake"}     camera back ON (about 1 s), decoding resumes
  ```
- The Pi side is `apps/raspberry-pi/src/hardware/real/` (`scanner-protocol.ts` and `serial-qr-scanner.ts`).

### Version 1.1.0: power saving (re-flash needed)
The kiosk now puts the scanner to sleep when nobody is using it, and wakes it when a button is pressed. Sleeping stops the camera (the main source of heat and current) and slows the CPU. Wake-up takes about a second.
- To do this, 1.1.0 runs its own decoding loop. It uses the library only for its camera settings and its QR decoder (quirc). The library's own `end()` can't stop the camera safely.
- The camera is restarted with `esp_camera_deinit()` / `esp_camera_init()`.
- **Re-flash the board** with this version (steps 2–3). With the old 1.0.0 the kiosk still works, but the camera never sleeps.
- Compiled with ESP32 core **2.0.17**, board **AI Thinker ESP32-CAM** (30% flash, 20% RAM).

> ⚠️ Version 1.1.0 compiles, but hasn't been run on your board yet. Steps 3 and 6 below are the test.

## 1. Install the tools (once)
1. Install the **Arduino IDE 2** from arduino.cc.
2. **File → Preferences → Additional boards manager URLs**: add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Tools → Board → Boards Manager**: search **esp32** (by Espressif) and install it.
   - If compiling fails with camera or `ledc` errors on version 3.x, install **2.0.17** instead. The QR library was written for the 2.x core.
4. **Tools → Manage Libraries**: install **ESP32QRCodeReader** (by Alvaro Viebrantz).
5. **Windows:** if the board doesn't appear as a COM port, install the **CH340 driver** (search "CH340 driver WCH").

## 2. Flash
1. Seat the ESP32-CAM on its USB-C base and connect it to your laptop.
2. Open `firmware/esp32-cam/esp32-cam-qr/esp32-cam-qr.ino`.
3. In **Tools**, set:
   - **Board:** AI Thinker ESP32-CAM
   - **Port:** the new COM port (Windows) or `/dev/ttyUSB0` (Linux)
   - **Partition Scheme:** Huge APP (3MB No OTA), if offered
4. Click **Upload**.
   - If it says *"Failed to connect… Wrong boot mode"*: hold the **IO0/BOOT** button on the base, press and release **RST**, release IO0, then upload again.
5. Press **RST** after uploading.

## 3. Check it in the Serial Monitor
Open **Tools → Serial Monitor** at **115200** baud. You should see:
```
{"type":"hello","fw":"1.1.0","state":"awake"}
{"type":"alive","seq":1}
```
If you see `{"type":"error",...}`, check the board type (AI Thinker ESP32-CAM) and the camera ribbon cable.
Show your school ID's QR about **10–20 cm** from the lens:
```
{"type":"qr","seq":5,"data":"YOUR NAME\t20XXXXXXXX\tBSCpE"}
```
**Close the Serial Monitor** before the next step, because only one program can use the port at a time.

## 4. Check it with the kiosk software (laptop)
From the repository root:
```bash
npm run scanner:pi
```
This lists ports; the ESP32 is marked `← likely the ESP32-CAM (CH340)`. Then:
```bash
npm run scanner:pi -- COM7
```
Use your port. Each scan prints `✔ valid school ID: NAME · NUMBER · COURSE`.

## 5. Use it in the kiosk
In `apps/raspberry-pi/.env`:
```
QR_SCANNER=serial
SCANNER_PORT=COM7          # Raspberry Pi: /dev/ttyUSB0
```
Run `npm run start:pi`. Now your real ID drives the kiosk. Coins, RFID and locks stay simulated with the console until Phase 11.

## 6. Check power saving (firmware 1.1.0)
In the Serial Monitor set the line ending to **Newline**, then type and send:
```
{"cmd":"sleep"}
```
It answers `{"type":"state","state":"sleeping"}`. QR codes are no longer read, `alive` lines continue, and the board runs cooler. Then send:
```
{"cmd":"wake"}
```
It answers `{"type":"state","state":"awake"}`, and QR codes read again after about 1 s. Repeat a few times. It must keep reading after every wake-up.

## Tips
- **Light:** QR decoding needs even light. A small diffuse white LED above the scan window works better than the very bright on-board flash. If you must use the flash, set `FLASH_LED_DUTY` to 5–20.
- **Focus:** the OV2640 lens is fixed. If codes only read far away, a ring/jig that holds the ID at the sweet spot (about 15 cm) helps.
- **Power:** the ESP32-CAM browns out (keeps resetting) on weak USB power or thin cables. Use a short, good cable to a Pi USB port.
- **Reset on connect:** opening the serial port can reset the ESP32 through the base's auto-reset circuit. The Pi driver releases DTR/RTS after opening, so the board boots normally.
