import type { DoorState } from '@calc-rental/shared';
import type { CoinInput } from '../payment/payment-service';
import type { LcdScreen } from '../kiosk/lcd';

/**
 * Hardware abstraction (spec §44). The kiosk logic only talks to these
 * interfaces, never to GPIO directly, so it runs unchanged with:
 *   - Mock* implementations (laptop, tests, demo)      → hardware/mock.ts
 *   - Real* implementations (Raspberry Pi, Phase 10–11) → hardware/real/*
 *
 * Lockers are addressed by `channel` = lockers.hardware_channel (1, 2, …).
 */

/** ESP32-CAM over USB serial (Phase 10). Emits the RAW QR text. */
export interface QRScanner {
  onScan(handler: (raw: string) => void): void;
}

/** Allan 1239 coin selector: pulses on GPIO 17, power via a relay (Phase 11). */
export interface CoinAcceptor {
  onCoin(handler: (coin: CoinInput) => void): void;
  /** Power the selector only while a payment is expected (if the 3rd relay is fitted). */
  setEnabled(enabled: boolean): Promise<void>;
}

export interface RfidReading {
  /** null = no tag in the field. */
  uid: string | null;
  /** false = the reader didn't answer (wiring, power). */
  readerOk: boolean;
}

/** One RC522 per locker on SPI (Phase 11). */
export interface RFIDReader {
  read(channel: number): Promise<RfidReading>;
}

/** 12 V solenoid locks through relays, optional reed switches (Phase 11). */
export interface LockerController {
  /** Energise the solenoid for `pulseMs` (never held: the latch re-locks when the door closes). */
  unlock(channel: number, pulseMs: number): Promise<void>;
  /** UNKNOWN when no door sensor is installed. */
  doorState(channel: number): Promise<DoorState>;
}

/** 16×2 I2C LCD (Phase 11). */
export interface DisplayController {
  show(screen: LcdScreen): Promise<void>;
}

export type BeepPattern = 'ok' | 'error' | 'attention';

export interface BuzzerController {
  beep(pattern: BeepPattern): Promise<void>;
}

/** Is the system clock trustworthy? (no RTC: wait for NTP after boot) */
export interface ClockSource {
  isSynced(): Promise<boolean>;
}

export interface Hardware {
  scanner: QRScanner;
  coins: CoinAcceptor;
  rfid: RFIDReader;
  lockers: LockerController;
  display: DisplayController;
  buzzer: BuzzerController;
  clock: ClockSource;
}
