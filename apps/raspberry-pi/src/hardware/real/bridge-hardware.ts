import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DoorState } from '@calc-rental/shared';
import type { LcdScreen } from '../../kiosk/lcd';
import type { CoinInput } from '../../payment/payment-service';
import type {
  BeepPattern,
  BuzzerController,
  ClockSource,
  CoinAcceptor,
  DisplayController,
  LockerController,
  RFIDReader,
  RfidReading,
} from '../types';
import type { BridgeClient } from './bridge-client';

/**
 * Real hardware implementations of the kiosk interfaces, backed by the
 * Python bridge. Node decides; the bridge only performs the I/O.
 */

export class BridgeCoinAcceptor implements CoinAcceptor {
  constructor(private readonly bridge: BridgeClient) {}
  onCoin(handler: (coin: CoinInput) => void) {
    this.bridge.onCoin((pulses) => handler({ eventId: randomUUID(), pulseCount: pulses, occurredAt: new Date().toISOString() }));
  }
  /** No 3rd relay fitted: the selector is always powered (idle coins are logged for refund). */
  async setEnabled(_enabled: boolean) {}
}

export class BridgeRFIDReader implements RFIDReader {
  constructor(private readonly bridge: BridgeClient) {}
  async read(channel: number): Promise<RfidReading> {
    try {
      const reply = await this.bridge.request('read_rfid', { channel });
      return { uid: typeof reply.uid === 'string' ? reply.uid : null, readerOk: reply.readerOk === true };
    } catch {
      return { uid: null, readerOk: false };
    }
  }
}

export class BridgeLockerController implements LockerController {
  constructor(private readonly bridge: BridgeClient) {}
  async unlock(channel: number, pulseMs: number) {
    await this.bridge.request('unlock', { channel, ms: pulseMs });
  }
  async doorState(channel: number) {
    try {
      const reply = await this.bridge.request('door', { channel });
      return (reply.state as DoorState) ?? DoorState.UNKNOWN;
    } catch {
      return DoorState.UNKNOWN;
    }
  }
}

export class BridgeDisplay implements DisplayController {
  private last = '';
  constructor(
    private readonly bridge: BridgeClient,
    private readonly mirror?: (screen: LcdScreen) => void,
  ) {}
  async show(screen: LcdScreen) {
    const key = screen.join('\n');
    if (key === this.last) return; // the LCD is slow over I2C: only redraw on change
    this.last = key;
    this.mirror?.(screen);
    await this.bridge.request('lcd', { lines: screen });
  }
}

export class BridgeBuzzer implements BuzzerController {
  constructor(private readonly bridge: BridgeClient) {}
  async beep(pattern: BeepPattern) {
    await this.bridge.request('beep', { pattern }).catch(() => {}); // a silent buzzer must never stop a rental
  }
}

/**
 * Trusts the clock once the OS says NTP is synchronised (no RTC on the Pi).
 * Where `timedatectl` doesn't exist (Windows/macOS dev machines) the clock
 * is assumed correct.
 */
export class SystemClock implements ClockSource {
  isSynced(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 2000 }, (error, stdout) => {
        if (error) return resolve(process.platform !== 'linux');
        resolve(stdout.trim() === 'yes');
      });
    });
  }
}
