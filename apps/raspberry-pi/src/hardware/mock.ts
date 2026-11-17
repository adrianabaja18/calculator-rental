import { randomUUID } from 'node:crypto';
import { DoorState } from '@calc-rental/shared';
import type { CoinInput } from '../payment/payment-service';
import type { LcdScreen } from '../kiosk/lcd';
import type {
  BeepPattern,
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
  private handler: ((raw: string) => void) | null = null;
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
  private readonly tags = new Map<number, string | null>();
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
  readonly unlocks: Array<{ channel: number; pulseMs: number }> = [];
  private readonly doors = new Map<number, DoorState>();
  async unlock(channel: number, pulseMs: number) {
    this.unlocks.push({ channel, pulseMs });
  }
  async doorState(channel: number) {
    return this.doors.get(channel) ?? DoorState.UNKNOWN; // UNKNOWN = no reed switch fitted
  }
  /** Simulate: a reed switch reports the door. */
  setDoor(channel: number, state: DoorState) {
    this.doors.set(channel, state);
  }
}

export class MockDisplay implements DisplayController {
  current: LcdScreen = ['', ''];
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
    display: new MockDisplay(onShow),
    buzzer: new MockBuzzer(),
    clock: new MockClock(),
  };
}
