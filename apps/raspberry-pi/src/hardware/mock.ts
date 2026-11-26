import { randomUUID } from 'node:crypto';
import { DoorState } from '@calc-rental/shared';
import type { CoinInput } from '../payment/payment-service';
import type { LcdScreen } from '../kiosk/lcd';
import type {
  BeepPattern,
  ButtonKind,
  ButtonPanel,
  BuzzerController,
  ClockSource,
  CoinAcceptor,
  DisplayController,
  Hardware,
  LockerController,
  QRScanner,
  RFIDReader,
  RfidReading,
} from './types';

/**
 * In-memory hardware for laptops, tests and the demo. Each mock has a
 * "simulate" method that plays the part of the student or the sensor.
 */

export class MockQRScanner implements QRScanner {
  /** false while the kiosk sleeps (camera off). */
  active = true;
  private handler: ((raw: string) => void) | null = null;
  async setActive(active: boolean) {
    this.active = active;
  }
  onScan(handler: (raw: string) => void) {
    this.handler = handler;
  }
  /** Simulate: a student shows their ID. */
  scan(raw: string) {
    this.handler?.(raw);
  }
}

export class MockCoinAcceptor implements CoinAcceptor {
  enabled = false;
  private handler: ((coin: CoinInput) => void) | null = null;
  onCoin(handler: (coin: CoinInput) => void) {
    this.handler = handler;
  }
  async setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
  /** Simulate: a coin worth `pesos` (= pulses) is inserted. Without a power relay the selector accepts it even when "disabled". */
  insert(pesos: number, eventId: string = randomUUID()) {
    this.handler?.({ eventId, pulseCount: pesos, occurredAt: new Date().toISOString() });
  }
}

export class MockRFIDReader implements RFIDReader {
  /** false while the kiosk sleeps (readers held in reset). */
  powered = true;
  private readonly tags = new Map<number, string | null>();
  async setPower(on: boolean) {
    this.powered = on;
  }
  private readonly broken = new Set<number>();
  async read(channel: number): Promise<RfidReading> {
    return { uid: this.tags.get(channel) ?? null, readerOk: !this.broken.has(channel) };
  }
  /** Simulate: put a tagged calculator in (uid) or take it out (null). */
  place(channel: number, uid: string | null) {
    this.tags.set(channel, uid);
  }
  /** Simulate: the reader stops answering. */
  setBroken(channel: number, broken: boolean) {
    if (broken) this.broken.add(channel);
    else this.broken.delete(channel);
  }
}

export class MockLockerController implements LockerController {
  readonly unlocks: Array<{ channel: number; maxMs: number }> = [];
  /** Channels whose solenoid is energised right now. */
  readonly open = new Set<number>();
  private readonly doors = new Map<number, DoorState>();
  async unlock(channel: number, maxMs: number) {
    this.unlocks.push({ channel, maxMs });
    this.open.add(channel);
  }
  async lock(channel: number) {
    this.open.delete(channel);
  }
  async doorState(channel: number) {
    return this.doors.get(channel) ?? DoorState.UNKNOWN; // UNKNOWN = no reed switch fitted
  }
  /** Simulate: a reed switch reports the door. */
  setDoor(channel: number, state: DoorState) {
    this.doors.set(channel, state);
  }
}

export class MockButtons implements ButtonPanel {
  private handler: ((kind: ButtonKind, channel: number) => void) | null = null;
  onPress(handler: (kind: ButtonKind, channel: number) => void) {
    this.handler = handler;
  }
  /** Simulate: the student presses a front-panel button. */
  press(kind: ButtonKind, channel: number) {
    this.handler?.(kind, channel);
  }
}

export class MockDisplay implements DisplayController {
  current: LcdScreen = ['', ''];
  backlight = true;
  async setBacklight(on: boolean) {
    this.backlight = on;
  }
  readonly history: LcdScreen[] = [];
  constructor(private readonly onShow?: (screen: LcdScreen) => void) {}
  async show(screen: LcdScreen) {
    if (screen[0] === this.current[0] && screen[1] === this.current[1]) return;
    this.current = screen;
    this.history.push(screen);
    this.onShow?.(screen);
  }
}

export class MockBuzzer implements BuzzerController {
  readonly beeps: BeepPattern[] = [];
  async beep(pattern: BeepPattern) {
    this.beeps.push(pattern);
  }
}

export class MockClock implements ClockSource {
  synced = true;
  async isSynced() {
    return this.synced;
  }
}

export interface MockHardware extends Hardware {
  scanner: MockQRScanner;
  coins: MockCoinAcceptor;
  rfid: MockRFIDReader;
  lockers: MockLockerController;
  buttons: MockButtons;
  display: MockDisplay;
  buzzer: MockBuzzer;
  clock: MockClock;
}

export function createMockHardware(onShow?: (screen: LcdScreen) => void): MockHardware {
  return {
    scanner: new MockQRScanner(),
    coins: new MockCoinAcceptor(),
    rfid: new MockRFIDReader(),
    lockers: new MockLockerController(),
    buttons: new MockButtons(),
    display: new MockDisplay(onShow),
    buzzer: new MockBuzzer(),
    clock: new MockClock(),
  };
}
