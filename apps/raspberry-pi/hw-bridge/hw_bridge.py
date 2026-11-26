#!/usr/bin/env python3
"""
Calculator Rental Kiosk — hardware bridge (I/O only).

The Node.js kiosk owns every rule and decision. This process only drives
the Raspberry Pi's pins/buses and reports what it sees, using the Pi's
official, preinstalled libraries (gpiozero) plus spidev and smbus2.

Protocol: one JSON object per line.
  Node -> bridge (stdin), each with an "id":
    {"id":1,"cmd":"ping"}
    {"id":2,"cmd":"unlock","channel":1,"ms":60000}    relay ON (solenoid unlocked) for up to ms
    {"id":7,"cmd":"lock","channel":1}                 relay OFF now (red button pressed)
    {"id":3,"cmd":"lcd","lines":["SYSTEM READY","SCAN STUDENT ID"]}
    {"id":4,"cmd":"beep","pattern":"ok"|"error"|"attention"|"tick"}
    {"id":5,"cmd":"read_rfid","channel":1}
    {"id":6,"cmd":"door","channel":1}
    {"id":8,"cmd":"backlight","on":false}             power saving: LCD backlight off/on
    {"id":9,"cmd":"rfid_power","on":false}            power saving: RC522s held in reset (needs RST pins)
    mock mode only: {"cmd":"mock_coin","pulses":5}  {"cmd":"mock_tag","channel":1,"uid":"04-..."|null}
                    {"cmd":"mock_button","kind":"select"|"close","channel":1}
  bridge -> Node (stdout):
    {"type":"ready","mode":"real"|"mock","version":"1.0.0","devices":{...}}
    {"type":"ok","id":2}  {"type":"pong","id":1}
    {"type":"rfid","id":5,"uid":"04-A1-B2-C3-D4"|null,"readerOk":true}
    {"type":"door","id":6,"state":"UNKNOWN"}
    {"type":"coin","pulses":5}                         one finished coin
    {"type":"button","kind":"select","channel":1}      blue (select) / red (close) button pressed
    {"type":"error","id":2,"message":"..."}  {"type":"log","level":"warn","message":"..."}

Run:  python3 hw_bridge.py --mock            (laptop / tests)
      python3 hw_bridge.py [pin options]     (Raspberry Pi; see --help)
"""
import argparse
import json
import sys
import threading
import time

VERSION = "1.3.0"
_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def log(level, message):
    emit({"type": "log", "level": level, "message": message})


# --------------------------------------------------------------------------
# Coin pulses: the Allan 1239 sends N pulses for a ₱N coin (via the PC817).
# A quiet gap longer than `gap_ms` ends one coin. Timing-sensitive, so it
# lives here next to the pin instead of in Node.
# --------------------------------------------------------------------------
class PulseCounter:
    def __init__(self, gap_ms):
        self.gap = gap_ms / 1000.0
        self.count = 0
        self.timer = None
        self.lock = threading.Lock()

    def pulse(self):
        with self.lock:
            self.count += 1
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(self.gap, self._finish)
            self.timer.daemon = True
            self.timer.start()

    def _finish(self):
        with self.lock:
            pulses, self.count, self.timer = self.count, 0, None
        if pulses:
            emit({"type": "coin", "pulses": pulses})


# --------------------------------------------------------------------------
# MFRC522 (RC522) over SPI — enough to read a tag's UID (4 or 7 bytes).
# RST goes to a GPIO (--rfid-rst-pins, held HIGH by the bridge) or straight to 3.3 V;
# either way the chip is also soft-reset here.
# The antenna is switched on only while reading, so two readers don't
# interfere and the tag power-cycles (fresh REQA every poll).
# --------------------------------------------------------------------------
class MFRC522:
    CommandReg, ComIEnReg, ComIrqReg, DivIrqReg, ErrorReg = 0x01, 0x02, 0x04, 0x05, 0x06
    FIFODataReg, FIFOLevelReg, ControlReg, BitFramingReg, CollReg = 0x09, 0x0A, 0x0C, 0x0D, 0x0E
    ModeReg, TxControlReg, TxASKReg, CRCResultRegH, CRCResultRegL = 0x11, 0x14, 0x15, 0x21, 0x22
    TModeReg, TPrescalerReg, TReloadRegH, TReloadRegL, VersionReg = 0x2A, 0x2B, 0x2C, 0x2D, 0x37
    IDLE, CALC_CRC, TRANSCEIVE, SOFT_RESET = 0x00, 0x03, 0x0C, 0x0F
    REQA, SEL_CL1, SEL_CL2, CASCADE_TAG = 0x26, 0x93, 0x95, 0x88

    def __init__(self, bus, device):
        import spidev  # only on the Pi

        self.spi = spidev.SpiDev()
        self.spi.open(bus, device)
        self.spi.max_speed_hz = 1_000_000
        self.spi.mode = 0
        self.init()

    def init(self):
        """(Re)configures the chip. Also needed after a hard power-down (RST LOW), which clears its registers."""
        self.write(self.CommandReg, self.SOFT_RESET)
        time.sleep(0.05)
        self.write(self.TModeReg, 0x8D)  # timer: auto, prescaler
        self.write(self.TPrescalerReg, 0x3E)
        self.write(self.TReloadRegL, 30)  # ~25 ms timeout
        self.write(self.TReloadRegH, 0)
        self.write(self.TxASKReg, 0x40)  # 100% ASK
        self.write(self.ModeReg, 0x3D)  # CRC preset 0x6363
        self.antenna(False)

    def write(self, reg, value):
        self.spi.xfer2([(reg << 1) & 0x7E, value & 0xFF])

    def read(self, reg):
        return self.spi.xfer2([((reg << 1) & 0x7E) | 0x80, 0])[1]

    def set_bits(self, reg, mask):
        self.write(reg, self.read(reg) | mask)

    def clear_bits(self, reg, mask):
        self.write(reg, self.read(reg) & (~mask & 0xFF))

    def antenna(self, on):
        if on:
            self.set_bits(self.TxControlReg, 0x03)
        else:
            self.clear_bits(self.TxControlReg, 0x03)

    def healthy(self):
        # Genuine chips report 0x91/0x92; common clones 0x88/0x12. 0x00/0xFF = no chip / wiring fault.
        return self.read(self.VersionReg) not in (0x00, 0xFF)

    def transceive(self, data, last_bits=0):
        self.write(self.ComIEnReg, 0xF7)
        self.clear_bits(self.ComIrqReg, 0x80)
        self.set_bits(self.FIFOLevelReg, 0x80)  # flush FIFO
        self.write(self.CommandReg, self.IDLE)
        for b in data:
            self.write(self.FIFODataReg, b)
        self.write(self.BitFramingReg, last_bits & 0x07)
        self.write(self.CommandReg, self.TRANSCEIVE)
        self.set_bits(self.BitFramingReg, 0x80)  # StartSend
        deadline = time.monotonic() + 0.03
        while True:
            irq = self.read(self.ComIrqReg)
            if irq & 0x30:  # RxIRq | IdleIRq
                break
            if irq & 0x01 or time.monotonic() > deadline:  # timer
                self.clear_bits(self.BitFramingReg, 0x80)
                return None
        self.clear_bits(self.BitFramingReg, 0x80)
        if self.read(self.ErrorReg) & 0x13:  # BufferOvfl | ParityErr | ProtocolErr
            return None
        n = self.read(self.FIFOLevelReg)
        return [self.read(self.FIFODataReg) for _ in range(n)]

    def crc(self, data):
        self.write(self.CommandReg, self.IDLE)
        self.clear_bits(self.DivIrqReg, 0x04)
        self.set_bits(self.FIFOLevelReg, 0x80)
        for b in data:
            self.write(self.FIFODataReg, b)
        self.write(self.CommandReg, self.CALC_CRC)
        deadline = time.monotonic() + 0.01
        while not (self.read(self.DivIrqReg) & 0x04):
            if time.monotonic() > deadline:
                return None
        return [self.read(self.CRCResultRegL), self.read(self.CRCResultRegH)]

    def anticollision(self, sel):
        self.write(self.CollReg, 0x80)
        resp = self.transceive([sel, 0x20])
        if not resp or len(resp) != 5:
            return None
        if resp[0] ^ resp[1] ^ resp[2] ^ resp[3] != resp[4]:  # BCC check
            return None
        return resp

    def select(self, sel, uid5):
        frame = [sel, 0x70] + uid5
        c = self.crc(frame)
        return self.transceive(frame + c) if c else None

    def read_uid(self):
        """UID as 'AA-BB-CC-DD' (4 bytes) or 7 bytes, or None if no tag."""
        self.antenna(True)
        time.sleep(0.005)  # let the tag power up
        try:
            atqa = self.transceive([self.REQA], last_bits=7)
            if not atqa or len(atqa) != 2:
                return None
            cl1 = self.anticollision(self.SEL_CL1)
            if not cl1:
                return None
            if cl1[0] != self.CASCADE_TAG:
                uid = cl1[:4]
            else:  # 7-byte UID (e.g. NTAG stickers): select CL1, then cascade level 2
                if not self.select(self.SEL_CL1, cl1):
                    return None
                cl2 = self.anticollision(self.SEL_CL2)
                if not cl2:
                    return None
                uid = cl1[1:4] + cl2[:4]
            return "-".join("%02X" % b for b in uid)
        finally:
            self.antenna(False)


# --------------------------------------------------------------------------
# 16x2 HD44780 LCD on a PCF8574 I2C backpack (4-bit mode).
# Backpack bits: P0=RS, P1=RW, P2=E, P3=backlight, P4..P7=D4..D7.
# --------------------------------------------------------------------------
class Lcd:
    RS, EN, BACKLIGHT = 0x01, 0x04, 0x08

    def __init__(self, i2c_bus, address):
        try:
            from smbus2 import SMBus
        except ImportError:  # older images ship python3-smbus
            from smbus import SMBus
        self.bus = SMBus(i2c_bus)
        self.addr = address
        self.backlight_bit = self.BACKLIGHT
        time.sleep(0.05)
        for nibble in (0x03, 0x03, 0x03, 0x02):  # HD44780 4-bit init sequence
            self._write4(nibble, 0)
            time.sleep(0.005)
        for command in (0x28, 0x0C, 0x06, 0x01):  # 2 lines, display on, entry mode, clear
            self._send(command, 0)
        time.sleep(0.002)

    def _write4(self, nibble, rs):
        data = ((nibble & 0x0F) << 4) | self.backlight_bit | rs
        self.bus.write_byte(self.addr, data | self.EN)
        time.sleep(0.0005)
        self.bus.write_byte(self.addr, data)
        time.sleep(0.0001)

    def _send(self, byte, rs):
        self._write4(byte >> 4, rs)
        self._write4(byte & 0x0F, rs)

    def show(self, lines):
        for row, text in enumerate(lines[:2]):
            self._send(0x80 | (0x00 if row == 0 else 0x40), 0)
            for ch in str(text)[:16].ljust(16):
                self._send(ord(ch) if 32 <= ord(ch) < 127 else ord("?"), self.RS)

    def set_backlight(self, on):
        """Power saving: the backlight LED is most of the LCD's current (and heat)."""
        self.backlight_bit = self.BACKLIGHT if on else 0
        self.bus.write_byte(self.addr, self.backlight_bit)


# --------------------------------------------------------------------------
# Hardware back-ends
# --------------------------------------------------------------------------
class MockHardware:
    """Simulated I/O for laptops and automated tests (no Pi libraries needed)."""

    mode = "mock"

    def __init__(self, args, coins):
        self.coins = coins
        self.tags = {}
        self.lcd_lines = ["", ""]
        self.unlocks = []

    def devices(self):
        return {"relays": True, "coin": True, "rfid": True, "lcd": True, "buzzer": True, "buttons": True}

    def unlock(self, channel, ms):
        self.unlocks.append((channel, ms))

    def lock(self, channel):
        pass

    def lcd(self, lines):
        self.lcd_lines = lines

    def beep(self, pattern):
        pass

    def read_rfid(self, channel):
        return self.tags.get(channel), True

    def door(self, channel):
        return "UNKNOWN"

    def mock_coin(self, pulses, spacing_ms=50):
        def run():
            for _ in range(pulses):
                self.coins.pulse()
                time.sleep(spacing_ms / 1000.0)

        threading.Thread(target=run, daemon=True).start()

    def mock_tag(self, channel, uid):
        self.tags[channel] = uid

    def mock_button(self, kind, channel):
        emit({"type": "button", "kind": kind, "channel": channel})

    def backlight(self, on):
        self.backlight_on = on

    def rfid_power(self, on):
        self.rfid_on = on


class RealHardware:
    """Raspberry Pi I/O. Each device is optional: a missing one is reported, not fatal."""

    mode = "real"

    def __init__(self, args, coins):
        from gpiozero import Button, Buzzer, OutputDevice

        self.coins = coins
        self.relays = {}
        self.relay_timers = {}
        for channel, pin in enumerate(args.relay_pins, start=1):
            # Active-LOW relay board: "on" drives the pin LOW. initial_value=False keeps it off (HIGH).
            self.relays[channel] = OutputDevice(pin, active_high=not args.relay_active_low, initial_value=False)

        # PC817 output pulls GPIO LOW on each coin pulse -> "pressed" = falling edge.
        self.coin_input = Button(args.coin_pin, pull_up=True, bounce_time=None)
        self.coin_input.when_pressed = coins.pulse

        self.buzzer = None
        if args.buzzer_pin is not None:
            self.buzzer = Buzzer(args.buzzer_pin, active_high=not args.buzzer_active_low)

        self.doors = {}
        for channel, pin in enumerate(args.door_pins, start=1):
            self.doors[channel] = Button(pin, pull_up=True)  # reed switch to GND: closed door = pressed

        # Front-panel buttons (microswitch COM -> GND, NO -> pin): blue = select locker, red = door closed.
        self.buttons = []
        for kind, pins in (("select", args.select_pins), ("close", args.close_pins)):
            for channel, pin in enumerate(pins, start=1):
                button = Button(pin, pull_up=True, bounce_time=0.05)
                button.when_pressed = lambda k=kind, c=channel: emit({"type": "button", "kind": k, "channel": c})
                self.buttons.append(button)

        # RC522 RST wired to GPIOs (final wiring: GPIO 4 and 16). LOW = chip held in reset,
        # so hard-reset each reader once and then keep RST HIGH for as long as the bridge runs.
        # (GPIO 16 defaults to pull-DOWN at boot, which would keep reader 2 off.)
        self.rfid_resets = [OutputDevice(pin, initial_value=False) for pin in args.rfid_rst_pins]
        self.rfid_on = True
        if self.rfid_resets:
            time.sleep(0.05)
            for rst in self.rfid_resets:
                rst.on()
            time.sleep(0.05)  # oscillator start-up after reset

        self.readers = {}
        for channel, (bus, device) in enumerate(args.rfid, start=1):
            try:
                reader = MFRC522(bus, device)
                if not reader.healthy():
                    raise RuntimeError("no answer on SPI%d.%d" % (bus, device))
                self.readers[channel] = reader
            except Exception as exc:  # noqa: BLE001
                log("warn", "RFID reader %d not available: %s" % (channel, exc))

        self.display = None
        try:
            self.display = Lcd(args.i2c_bus, args.lcd_address)
        except Exception as exc:  # noqa: BLE001
            log("warn", "LCD not available at 0x%02X on I2C-%d: %s" % (args.lcd_address, args.i2c_bus, exc))

    def devices(self):
        return {
            "relays": len(self.relays),
            "coin": True,
            "rfid": sorted(self.readers.keys()),
            "lcd": self.display is not None,
            "buzzer": self.buzzer is not None,
            "doors": sorted(self.doors.keys()),
            "buttons": len(self.buttons),
        }

    def unlock(self, channel, ms):
        relay = self.relays.get(channel)
        if relay is None:
            raise ValueError("no relay for channel %d" % channel)
        self._cancel_timer(channel)
        relay.on()
        timer = threading.Timer(ms / 1000.0, relay.off)  # safety: always released after ms, even if Node dies
        timer.daemon = True
        timer.start()
        self.relay_timers[channel] = timer

    def lock(self, channel):
        relay = self.relays.get(channel)
        if relay is None:
            raise ValueError("no relay for channel %d" % channel)
        self._cancel_timer(channel)
        relay.off()

    def _cancel_timer(self, channel):
        timer = self.relay_timers.pop(channel, None)
        if timer:
            timer.cancel()

    def lcd(self, lines):
        if self.display:
            self.display.show(lines)

    def backlight(self, on):
        if self.display:
            self.display.set_backlight(on)

    def rfid_power(self, on):
        """Off: RST LOW = RC522 hard power-down (microamps). On: release RST and set the chips up again.
        Without RST wired to GPIOs (RST on 3.3 V) this does nothing: the antenna is already off between reads."""
        if not self.rfid_resets or on == self.rfid_on:
            return
        self.rfid_on = on
        for rst in self.rfid_resets:
            rst.on() if on else rst.off()
        if on:
            time.sleep(0.05)  # oscillator start-up
            for channel, reader in self.readers.items():
                try:
                    reader.init()
                except Exception as exc:  # noqa: BLE001
                    log("warn", "RFID reader %d did not wake up: %s" % (channel, exc))

    def beep(self, pattern):
        if not self.buzzer:
            return
        on, off, n = {"ok": (0.08, 0.05, 1), "error": (0.12, 0.08, 3), "attention": (0.2, 0.1, 2), "tick": (0.03, 0.02, 1)}.get(pattern, (0.08, 0.05, 1))
        self.buzzer.beep(on_time=on, off_time=off, n=n, background=True)

    def read_rfid(self, channel):
        reader = self.readers.get(channel)
        if reader is None or not self.rfid_on:
            return None, False
        try:
            return reader.read_uid(), True
        except Exception:  # noqa: BLE001
            return None, False

    def door(self, channel):
        sensor = self.doors.get(channel)
        if sensor is None:
            return "UNKNOWN"
        return "CLOSED" if sensor.is_pressed else "OPEN"


# --------------------------------------------------------------------------
def handle(hw, msg):
    rid = msg.get("id")
    cmd = msg.get("cmd")
    try:
        if cmd == "ping":
            return {"type": "pong", "id": rid}
        if cmd == "unlock":
            ms = int(msg.get("ms", 3000))
            if not 100 <= ms <= 300000:
                raise ValueError("unlock time must be 100..300000 ms")
            hw.unlock(int(msg["channel"]), ms)
            return {"type": "ok", "id": rid}
        if cmd == "lock":
            hw.lock(int(msg["channel"]))
            return {"type": "ok", "id": rid}
        if cmd == "backlight":
            hw.backlight(bool(msg.get("on", True)))
            return {"type": "ok", "id": rid}
        if cmd == "rfid_power":
            hw.rfid_power(bool(msg.get("on", True)))
            return {"type": "ok", "id": rid}
        if cmd == "lcd":
            lines = msg.get("lines") or ["", ""]
            hw.lcd([str(l)[:16] for l in lines[:2]])
            return {"type": "ok", "id": rid}
        if cmd == "beep":
            hw.beep(str(msg.get("pattern", "ok")))
            return {"type": "ok", "id": rid}
        if cmd == "read_rfid":
            uid, ok = hw.read_rfid(int(msg["channel"]))
            return {"type": "rfid", "id": rid, "uid": uid, "readerOk": ok}
        if cmd == "door":
            return {"type": "door", "id": rid, "state": hw.door(int(msg["channel"]))}
        if cmd == "mock_coin" and hw.mode == "mock":
            hw.mock_coin(int(msg["pulses"]), int(msg.get("spacingMs", 50)))
            return {"type": "ok", "id": rid}
        if cmd == "mock_tag" and hw.mode == "mock":
            hw.mock_tag(int(msg["channel"]), msg.get("uid"))
            return {"type": "ok", "id": rid}
        if cmd == "mock_button" and hw.mode == "mock":
            hw.mock_button(str(msg["kind"]), int(msg["channel"]))
            return {"type": "ok", "id": rid}
        raise ValueError("unknown command: %s" % cmd)
    except Exception as exc:  # noqa: BLE001
        return {"type": "error", "id": rid, "message": str(exc)}


def parse_args(argv):
    def int_list(text):
        return [int(x) for x in text.split(",") if x.strip()]

    def spi_list(text):  # "0.0,0.1" -> [(0,0),(0,1)]
        return [tuple(int(p) for p in item.split(".")) for item in text.split(",") if item.strip()]

    p = argparse.ArgumentParser(description="Calculator kiosk hardware bridge")
    p.add_argument("--mock", action="store_true", help="simulate all hardware")
    p.add_argument("--relay-pins", type=int_list, default=[5, 6], help="BCM pins, channel 1,2,... (default 5,6)")
    p.add_argument("--relay-active-high", dest="relay_active_low", action="store_false", help="relay board is active-HIGH")
    p.add_argument("--coin-pin", type=int, default=17)
    p.add_argument("--coin-gap-ms", type=int, default=200)
    p.add_argument("--buzzer-pin", type=int, default=18)
    p.add_argument("--buzzer-active-low", action="store_true", help="buzzer module sounds when the pin is LOW")
    p.add_argument("--door-pins", type=int_list, default=[], help="reed switch BCM pins per channel (optional)")
    p.add_argument("--select-pins", type=int_list, default=[], help="blue 'select locker' button pins per channel")
    p.add_argument("--close-pins", type=int_list, default=[], help="red 'door closed' button pins per channel")
    p.add_argument("--rfid", type=spi_list, default=[(0, 0), (0, 1)], help="SPI bus.device per channel (default 0.0,0.1)")
    p.add_argument("--rfid-rst-pins", type=int_list, default=[], help="RC522 RST BCM pins (held HIGH); empty = RST tied to 3.3 V")
    p.add_argument("--i2c-bus", type=int, default=1)
    p.add_argument("--lcd-address", type=lambda s: int(s, 0), default=0x27)
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    coins = PulseCounter(args.coin_gap_ms)
    hw = MockHardware(args, coins) if args.mock else RealHardware(args, coins)
    emit({"type": "ready", "mode": hw.mode, "version": VERSION, "devices": hw.devices()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            emit({"type": "error", "id": None, "message": "invalid JSON"})
            continue
        emit(handle(hw, msg))


if __name__ == "__main__":
    main()
