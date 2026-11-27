import { setTimeout as delay } from 'node:timers/promises';
import {
  DoorState,
  ErrorCode,
  EventSeverity,
  EventType,
  LockState,
  RentalStatus,
  RfidState,
  isLockerAssignable,
  isOpenAt,
  nextOpening,
  operatingCalendar,
  parseStudentQr,
  type SystemSettings,
} from '@calc-rental/shared';
import { SCAN_SESSION_SECONDS, type ScanSessionStatus } from '@calc-rental/shared/sqlite';
import type { KioskStore } from '../db/kiosk-store';
import type { ButtonKind, Hardware } from '../hardware/types';
import type { CoinInput, PaymentService } from '../payment/payment-service';
import type { RentalService } from '../rental/rental-service';
import type { ReturnService } from '../rental/return-service';
import { KioskState, canMove } from './kiosk-states';
import { LCD, calcNumber, errorScreen, lockerStatusLine, type LcdScreen } from './lcd';

/**
 * The kiosk's brain (spec §21): turns hardware events into rental steps.
 *
 * Inputs, all funnelled through ONE queue so they never interleave:
 *   handleScan(raw)            QR text from a local scanner (console / old ESP32-CAM)
 *   phone scan                 any button at idle → 6-digit code on the LCD → the
 *                              student sends their ID from their phone → read from SQLite
 *   handleCoin(coin)           coin from the coin selector
 *   handleButton(kind, ch)     front panel: blue = choose locker ch, red = "door ch closed"
 *   tick()                     every ~250 ms: timeouts, RFID polling, overdue marking
 *
 * Lockers: after payment the solenoid is powered for SOLENOID_MAX_ON_MS (10 s,
 * so it can't overheat) while the LCD counts down and the buzzer ticks. The
 * doors have no latch, so the student opens, takes/returns and shuts the door
 * in that time; when the power drops the bolt locks the shut door. Too slow?
 * That locker's BLUE button powers it for another 10 s. RED finishes. The
 * bridge itself releases the solenoid at the limit, so a crash never leaves it
 * powered.
 *
 * Business rules live in the services; this class only sequences them,
 * drives the hardware and the 16×2 LCD.
 */

export interface KioskOptions {
  /** How long result/refusal screens stay up. */
  messageMs?: number;
  /** How long a student has to press a blue button after scanning. */
  selectTimeoutMs?: number;
  /** Sensor states are written to SQLite on change, and at least this often. */
  sensorWriteIntervalMs?: number;
  /**
   * Power saving: idle this long on the ready screen → sleep (LCD backlight,
   * camera and RFID readers off; any button wakes it). 0 = never sleep.
   */
  sleepAfterMs?: number;
  /** Shorter idle time before sleeping while closed (outside operating hours). */
  closedSleepAfterMs?: number;
  /**
   * Phone ID scanning (scan sessions in the shared SQLite). When set, a button press at idle starts a
   * scan session instead of waiting for a local scanner.
   */
  phoneScan?: PhoneScan;
  /** How often to check SQLite for the ID the phone sent. */
  phonePollMs?: number;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

/** Scan sessions in the Pi's SQLite (startScanSession / takeScan), shared with the web app's /scan page. */
export interface PhoneScan {
  start(now: Date): { id: string; code: string };
  take(id: string, now: Date): { status: ScanSessionStatus; qr: string | null };
}

interface PhoneSession {
  id: string;
  code: string;
  deadline: number;
  lastPollAt: number;
}

interface Flow {
  rentalId: string;
  sessionId: string | null;
  lockerId: string;
  channel: number;
  lockerNumber: number;
  calculatorCode: string;
  expectedUid: string | null;
  deadline: number;
  /** A message (e.g. WRONG CALCULATOR) stays up until then before live hints resume. */
  noticeUntil?: number;
  /** Set once the calculator is taken, while waiting for the red button. */
  dueAt?: string;
  /** While the solenoid is powered: when it drops. */
  lockOnUntil?: number;
  /** When the solenoid last dropped (BLUE waits SOLENOID_REST_MS after this). */
  lockOffAt?: number;
  /** Last countdown second the buzzer ticked for. */
  tickedSecond?: number;
}

/**
 * Longest the solenoid is powered in one go. Cabinet solenoid locks are made for short pulses and
 * overheat if held on. The removal/return timeouts in Settings still decide how long the kiosk
 * waits for the student; BLUE re-powers the lock, after a short rest so it can cool.
 */
export const SOLENOID_MAX_ON_MS = 10_000;
export const SOLENOID_REST_MS = 5_000;
/** How long an officer's emergency unlock keeps the solenoid open. */
export const OFFICER_UNLOCK_MS = SOLENOID_MAX_ON_MS;

/** States where the student is at an open (or re-openable) locker. */
const LOCK_STATES: ReadonlySet<KioskState> = new Set([
  KioskState.WAITING_FOR_REMOVAL,
  KioskState.WAITING_FOR_DOOR_CLOSE,
  KioskState.WAITING_FOR_RETURN,
]);

/** Calculator out (or back in): shut the door while the lock is still powered, then RED. */
const doneScreen = (secondsLeft: number) => (secondsLeft ? LCD.lockOpen('CLOSE THE DOOR', secondsLeft) : LCD.lockClosed('CLOSED? PUSH RED'));

const RFID_RETRY_DELAY_MS = 75;

interface SensorSnapshot {
  rfidState: RfidState;
  uid: string | null;
  door: DoorState;
  writtenAt: number;
}

export class KioskController {
  state: KioskState = KioskState.STARTING;
  private flow: Flow | null = null;
  /** Between the scan and the blue button press. */
  private selection: { raw: string; deadline: number } | null = null;
  private officerUnlock: { channel: number; until: number } | null = null;
  /** While the LCD shows a phone code. */
  private phone: PhoneSession | null = null;
  private holdUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly sensors = new Map<string, SensorSnapshot>();
  private lastHousekeeping = 0;
  /** Last input or state change (power saving idles from here). */
  private lastActivity = 0;
  private readonly messageMs: number;
  private readonly selectTimeoutMs: number;
  private readonly sensorWriteIntervalMs: number;
  private readonly sleepAfterMs: number;
  private readonly closedSleepAfterMs: number;
  private readonly phoneScan: PhoneScan | null;
  private readonly phonePollMs: number;
  private readonly now: () => Date;
  private readonly log: NonNullable<KioskOptions['log']>;

  constructor(
    private readonly store: KioskStore,
    private readonly hw: Hardware,
    private readonly services: { rentals: RentalService; payments: PaymentService; returns: ReturnService },
    options: KioskOptions = {},
  ) {
    this.messageMs = options.messageMs ?? 4000;
    this.selectTimeoutMs = options.selectTimeoutMs ?? 30_000;
    this.sensorWriteIntervalMs = options.sensorWriteIntervalMs ?? 30_000;
    this.sleepAfterMs = options.sleepAfterMs ?? 0;
    this.closedSleepAfterMs = options.closedSleepAfterMs ?? 30_000;
    this.phoneScan = options.phoneScan ?? null;
    this.phonePollMs = options.phonePollMs ?? 500;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ------------------------------------------------------------------ inputs
  async start(): Promise<void> {
    this.hw.scanner.onScan((raw) => void this.handleScan(raw));
    this.hw.coins.onCoin((coin) => void this.handleCoin(coin));
    this.hw.buttons.onPress((kind, channel) => void this.handleButton(kind, channel));
    await this.enqueue(async () => {
      await this.hw.coins.setEnabled(false);
      await this.show(LCD.starting());
      this.recoverAfterRestart();
      // Read every locker once BEFORE accepting students, so the first scan sees real stock.
      await this.pollSensors(this.now().getTime());
      if (await this.hw.clock.isSynced()) await this.toReady();
      else {
        this.move(KioskState.WAITING_FOR_CLOCK);
        await this.show(LCD.waitingForClock());
      }
    });
  }

  /**
   * After a reboot or power cut nobody is standing at the kiosk mid-step, so
   * any half-finished flow is closed safely (records are kept, never deleted):
   *  - open payment sessions → cancelled (rental reservations freed, coins flagged/credited)
   *  - paid but not handed out (PAID / DISPENSING) → FAILED, logged for an officer refund
   *  - return left open (RETURNING) → back to ACTIVE/OVERDUE
   */
  private recoverAfterRestart() {
    const { payments, rentals, returns } = this.services;
    const closed = payments.expireSessions({ all: true }).expired;
    const stuck = this.store.listRentalsInStatus([RentalStatus.PAID, RentalStatus.DISPENSING]);
    for (const rental of stuck) rentals.failDispensing(rental.id, 'LOCKER_OPEN_FAILED');
    const returning = this.store.listRentalsInStatus([RentalStatus.RETURNING]);
    for (const rental of returning) returns.abandonReturn(rental.id);
    if (closed + stuck.length + returning.length > 0) {
      this.log('warn', 'Recovered unfinished kiosk steps after restart', {
        paymentSessions: closed,
        failedDispenses: stuck.length,
        abandonedReturns: returning.length,
      });
    }
  }

  handleScan(raw: string): Promise<void> {
    return this.enqueue(() => this.onScan(raw));
  }

  handleCoin(coin: CoinInput): Promise<void> {
    return this.enqueue(() => this.onCoin(coin));
  }

  handleButton(kind: ButtonKind, channel: number): Promise<void> {
    return this.enqueue(async () => {
      // Asleep: the press only wakes the kiosk (a student shouldn't pick a locker by accident)…
      if (this.state === KioskState.SLEEPING) {
        await this.wake(`${kind} button`);
        // …except with phone scanning, where waking up IS "I want to start".
        if (this.phoneScan) await this.startPhoneScan();
        return;
      }
      if (this.phoneScan && this.state === KioskState.SYSTEM_READY) return this.startPhoneScan();
      return kind === 'select' ? this.onSelect(channel) : this.onClose(channel);
    });
  }

  tick(): Promise<void> {
    return this.enqueue(() => this.onTick());
  }

  /**
   * Officer emergency unlock from the dashboard (Phase 13). Only while no
   * student is using the kiosk; the locker stays unlocked `OFFICER_UNLOCK_MS`.
   */
  handleOfficerUnlock(lockerId: string, info: { commandId: string; requestedBy?: string }): Promise<{ ok: boolean; message: string }> {
    let outcome = { ok: false, message: 'Not run.' };
    return this.enqueue(async () => {
      outcome = await this.onOfficerUnlock(lockerId, info);
    }).then(() => outcome);
  }

  // ------------------------------------------------------------------ scan
  private async onScan(raw: string) {
    if (this.state === KioskState.SLEEPING) await this.wake('scan'); // camera was still on: serve the student
    if (this.state !== KioskState.SYSTEM_READY) {
      this.log('info', 'Scan ignored: kiosk busy', { state: this.state });
      return;
    }
    return this.identify(raw);
  }

  /** Phone scanning: a fresh code in the shared SQLite, shown with a countdown. */
  private async startPhoneScan() {
    const now = this.now();
    const started = this.phoneScan!.start(now);
    // A little shorter than the code's real limit, so the LCD never shows a dead code.
    const deadline = now.getTime() + (SCAN_SESSION_SECONDS - 5) * 1000;
    this.phone = { id: started.id, code: started.code, deadline, lastPollAt: 0 };
    this.move(KioskState.WAITING_FOR_PHONE);
    await this.hw.buzzer.beep('ok');
    await this.showPhoneCode(now.getTime());
  }

  private showPhoneCode(now: number) {
    const phone = this.phone!;
    return this.show(LCD.phoneCode(phone.code, Math.max(0, Math.ceil((phone.deadline - now) / 1000))));
  }

  /** Every tick while the code is up: countdown, and has the phone sent the ID yet? */
  private async checkPhone(now: number) {
    const phone = this.phone!;
    if (now > phone.deadline) {
      this.phone = null;
      return this.message(LCD.phoneTimeout(), 'error');
    }
    await this.showPhoneCode(now);
    if (now - phone.lastPollAt < this.phonePollMs) return;
    phone.lastPollAt = now;
    const { status, qr } = this.phoneScan!.take(phone.id, new Date(now));
    if (status === 'SUBMITTED' && qr) {
      this.phone = null;
      return this.identify(qr);
    }
    if (status !== 'WAITING') {
      this.phone = null;
      return this.message(LCD.phoneTimeout(), 'error');
    }
  }

  /** The student's ID text arrived (local scanner or phone): borrow or return? */
  private async identify(raw: string) {
    this.move(KioskState.VALIDATING_STUDENT);
    await this.show(LCD.checking());

    // One scanner for both flows: a student with a calculator out is returning it.
    const qr = parseStudentQr(raw);
    const student = qr.ok ? this.store.findStudentByNumber(qr.data.studentNumber) : null;
    const returning = student ? this.store.getOutstandingRentalForStudent(student.id) : null;
    if (returning) return this.beginReturn(raw);
    return this.beginBorrow(raw);
  }

  /** Borrow step 1: check the student, then show the lockers and wait for a blue button. */
  private async beginBorrow(raw: string) {
    const check = this.services.rentals.checkRental(raw);
    if (!check.ok) return this.refuse(check.code);
    const lockers = this.lockerAvailability();
    if (!lockers.some((l) => l.available)) return this.refuse(ErrorCode.NO_CALCULATOR_AVAILABLE);
    this.selection = { raw, deadline: this.now().getTime() + this.selectTimeoutMs };
    this.move(KioskState.SELECTING_LOCKER);
    await this.hw.buzzer.beep('ok');
    await this.show(LCD.pickLocker(lockerStatusLine(lockers)));
  }

  /** Borrow step 2: blue button → reserve that locker and ask for payment. */
  private async onSelect(channel: number) {
    if (this.flow?.channel === channel && LOCK_STATES.has(this.state)) return this.reopen(this.flow);
    if (this.state !== KioskState.SELECTING_LOCKER || !this.selection) return;
    const locker = this.store.listLockerHardware().find((l) => l.channel === channel);
    if (!locker) return;
    const lockers = this.lockerAvailability();
    if (!lockers.find((l) => l.number === locker.number)?.available) {
      await this.hw.buzzer.beep('error');
      await this.show(LCD.lockerUnavailable(locker.number, lockerStatusLine(lockers)));
      return; // still choosing: they can press the other blue button
    }

    const started = this.services.rentals.startRental(this.selection.raw, locker.number);
    this.selection = null;
    if (!started.ok) return this.refuse(started.code);
    const q = started.quote;
    const session = this.services.payments.openSession(q.rentalId);
    if (!session.ok) return this.refuse(session.code);
    this.flow = {
      rentalId: q.rentalId,
      sessionId: session.sessionId,
      lockerId: q.locker.id,
      channel: locker.channel,
      lockerNumber: q.locker.number,
      calculatorCode: q.calculator.code,
      expectedUid: locker.expectedUid,
      deadline: this.now().getTime() + this.settings().paymentTimeoutSeconds * 1000,
    };
    this.move(KioskState.WAITING_FOR_PAYMENT);
    await this.hw.coins.setEnabled(true);
    await this.show(LCD.quote(q.student.fullName, q.feeCentavos, q.durationMinutes));
  }

  private async beginReturn(raw: string) {
    const result = this.services.returns.startReturn(raw);
    if (!result.ok) return this.refuse(result.code);
    const plan = result.plan;
    const locker = this.lockerHardware(plan.locker.id);
    this.flow = {
      rentalId: plan.rentalId,
      sessionId: plan.sessionId,
      lockerId: plan.locker.id,
      channel: locker.channel,
      lockerNumber: plan.locker.number,
      calculatorCode: plan.calculatorCode,
      expectedUid: locker.expectedUid,
      deadline: this.now().getTime() + this.settings().paymentTimeoutSeconds * 1000,
    };
    this.move(KioskState.RETURN_IDENTIFIED);
    if (plan.next === 'PAY_PENALTY') {
      this.move(KioskState.WAITING_FOR_PENALTY_PAYMENT);
      await this.hw.coins.setEnabled(true);
      await this.show(LCD.penaltyDue(plan.overdueMinutes, plan.penaltyDueCentavos));
      return;
    }
    return this.openForReturn();
  }

  // ------------------------------------------------------------------ coins
  private async onCoin(coin: CoinInput) {
    if (this.state === KioskState.SLEEPING) await this.wake('coin');
    const paying = this.state === KioskState.WAITING_FOR_PAYMENT || this.state === KioskState.WAITING_FOR_PENALTY_PAYMENT;
    if (!paying || !this.flow) {
      this.services.payments.insertCoin(null, coin); // recorded for refund (Rule 23)
      await this.hw.buzzer.beep('attention');
      return;
    }
    const outcome = this.services.payments.insertCoin(this.flow.sessionId, coin);
    if (outcome.kind === 'rejected') return this.hw.buzzer.beep('error');
    if (outcome.kind !== 'credited') return;

    await this.show(LCD.payment(outcome.progress.receivedCentavos, outcome.progress.requiredCentavos));
    if (!outcome.paidNow) return;

    await this.hw.coins.setEnabled(false);
    await this.hw.buzzer.beep('ok');
    if (this.state === KioskState.WAITING_FOR_PAYMENT) return this.dispense();
    return this.openForReturn();
  }

  // ------------------------------------------------------------------ lockers
  private async dispense() {
    const flow = this.flow!;
    this.move(KioskState.OPENING_LOCKER);
    const dispensing = this.services.rentals.startDispensing(flow.rentalId);
    if (!dispensing.ok) throw new Error(dispensing.message);
    const now = this.now().getTime();
    try {
      await this.openLock(flow, now);
    } catch (error) {
      this.services.rentals.failDispensing(flow.rentalId, 'LOCKER_OPEN_FAILED');
      throw error;
    }
    flow.deadline = now + this.settings().removalTimeoutSeconds * 1000;
    this.move(KioskState.WAITING_FOR_REMOVAL);
    await this.show(LCD.lockOpen(`LOCKER ${flow.lockerNumber} OPEN`, SOLENOID_MAX_ON_MS / 1000));
  }

  private async openForReturn() {
    const flow = this.flow!;
    this.move(KioskState.RETURN_OPENING_LOCKER);
    const opened = this.services.returns.openReturnLocker(flow.rentalId);
    if (!opened.ok) throw new Error(opened.message);
    const now = this.now().getTime();
    await this.openLock(flow, now);
    flow.deadline = now + this.settings().returnTimeoutSeconds * 1000;
    this.move(KioskState.WAITING_FOR_RETURN);
    await this.show(LCD.lockOpen(`LOCKER ${flow.lockerNumber} OPEN`, SOLENOID_MAX_ON_MS / 1000));
  }

  /** Power the lock for SOLENOID_MAX_ON_MS; the tick counts it down on the LCD and buzzer. */
  private async openLock(flow: Flow, now: number) {
    await this.hw.lockers.unlock(flow.channel, SOLENOID_MAX_ON_MS);
    flow.lockOnUntil = now + SOLENOID_MAX_ON_MS;
    flow.tickedSecond = undefined;
  }

  private async lockNow(flow: Flow, now: number) {
    if (flow.lockOnUntil !== undefined) flow.lockOffAt = now;
    flow.lockOnUntil = undefined;
    await this.hw.lockers.lock(flow.channel);
  }

  /** Seconds of lock power left (0 = locked). Ticks the buzzer once a second and drops the lock at 0. */
  private async lockCountdown(flow: Flow, now: number): Promise<number> {
    if (flow.lockOnUntil === undefined) return 0;
    if (now >= flow.lockOnUntil) {
      await this.lockNow(flow, now); // the bridge already dropped it; this keeps both in step
      return 0;
    }
    const left = Math.ceil((flow.lockOnUntil - now) / 1000);
    if (left !== flow.tickedSecond) {
      flow.tickedSecond = left;
      await this.hw.buzzer.beep('tick');
    }
    return left;
  }

  /** BLUE of the locker in use: power the lock for another 10 s (after a short rest). */
  private async reopen(flow: Flow) {
    const now = this.now().getTime();
    if (flow.lockOnUntil !== undefined) return; // already open
    if (flow.lockOffAt !== undefined && now - flow.lockOffAt < SOLENOID_REST_MS) return this.hw.buzzer.beep('error');
    await this.openLock(flow, now);
    await this.hw.buzzer.beep('ok');
  }

  /** Red button: "I closed the door". Only the locker in use reacts. */
  private async onClose(channel: number) {
    const flow = this.flow;
    if (!flow || flow.channel !== channel) return;
    const now = this.now().getTime();

    if (this.state === KioskState.WAITING_FOR_REMOVAL) {
      // The calculator is still inside: not done yet.
      await this.hw.buzzer.beep('error');
      return;
    }

    if (this.state === KioskState.WAITING_FOR_DOOR_CLOSE) {
      if ((await this.hw.lockers.doorState(flow.channel)) === DoorState.OPEN) return this.notice(LCD.closeDoor()); // optional door sensor
      await this.lockNow(flow, now);
      return this.rentalSuccess(now, flow.dueAt!);
    }

    if (this.state === KioskState.WAITING_FOR_RETURN) {
      const reading = await this.hw.rfid.read(flow.channel);
      const door = await this.hw.lockers.doorState(flow.channel);
      const result = this.services.returns.verifyReturn(flow.rentalId, {
        detectedRfidUid: reading.readerOk ? reading.uid : null,
        doorState: door,
      });
      if (result.ok) {
        await this.lockNow(flow, now);
        this.recordSensors(flow.lockerId, { rfidState: RfidState.EXPECTED_TAG, uid: reading.uid, door }, this.now().getTime());
        this.move(KioskState.RETURN_COMPLETE);
        this.holdUntil = now + this.messageMs;
        await this.hw.buzzer.beep('ok');
        await this.show(LCD.returnSuccess(result.penaltyPaidCentavos));
        return;
      }
      // Not accepted: the student fixes it (BLUE opens the lock again).
      return this.notice(result.code === ErrorCode.RFID_MISMATCH ? LCD.wrongCalculator(flow.calculatorCode) : errorScreen(result.code));
    }
  }

  private async onOfficerUnlock(lockerId: string, info: { commandId: string; requestedBy?: string }) {
    if (this.state === KioskState.SLEEPING) await this.wake('officer unlock');
    if (this.state !== KioskState.SYSTEM_READY) {
      return { ok: false, message: `The kiosk is busy (${this.state}). Try again when no student is using it.` };
    }
    const locker = this.store.listLockerHardware().find((l) => l.id === lockerId);
    if (!locker) return { ok: false, message: 'This kiosk has no such locker.' };

    await this.hw.lockers.unlock(locker.channel, OFFICER_UNLOCK_MS);
    this.officerUnlock = { channel: locker.channel, until: this.now().getTime() + OFFICER_UNLOCK_MS };
    this.move(KioskState.OFFICER_UNLOCK);
    await this.hw.buzzer.beep('attention');
    await this.show(LCD.officerUnlock(locker.number));
    this.store.recordEvent({
      type: EventType.LOCKER_UNLOCKED,
      severity: EventSeverity.WARNING,
      message: `Officer emergency unlock of Locker ${locker.number}${info.requestedBy ? ` by ${info.requestedBy}` : ''}`,
      lockerId,
      payload: { commandId: info.commandId, requestedBy: info.requestedBy ?? null, seconds: OFFICER_UNLOCK_MS / 1000 },
      occurredAt: this.now().toISOString(),
    });
    this.log('warn', 'Officer emergency unlock', { locker: locker.number, commandId: info.commandId });
    return { ok: true, message: `Locker ${locker.number} unlocked for ${OFFICER_UNLOCK_MS / 1000} s.` };
  }

  // ------------------------------------------------------------------ tick
  private async onTick() {
    const now = this.now().getTime();

    if (this.state === KioskState.WAITING_FOR_CLOCK) {
      if (await this.hw.clock.isSynced()) await this.toReady();
      return;
    }

    // Asleep the RFID readers are powered down: nothing to read until a button wakes the kiosk.
    if (this.state !== KioskState.SLEEPING) await this.pollSensors(now);

    switch (this.state) {
      case KioskState.SYSTEM_READY:
        this.housekeeping(now);
        await this.show(this.idleScreen()); // redrawn only on change
        return this.maybeSleep(now);

      case KioskState.SLEEPING:
        this.housekeeping(now);
        return;

      case KioskState.WAITING_FOR_PHONE:
        return this.checkPhone(now);

      case KioskState.SELECTING_LOCKER:
        if (now > this.selection!.deadline) {
          this.selection = null;
          await this.message(LCD.selectTimeout(), 'error');
        }
        return;

      case KioskState.WAITING_FOR_PAYMENT:
      case KioskState.WAITING_FOR_PENALTY_PAYMENT:
        return this.checkPaymentExpiry();

      case KioskState.WAITING_FOR_REMOVAL:
        return this.checkRemoval(now);

      case KioskState.WAITING_FOR_DOOR_CLOSE:
        return this.checkDoorTimeout(now);

      case KioskState.WAITING_FOR_RETURN:
        return this.checkReturn(now);

      case KioskState.OFFICER_UNLOCK:
        if (this.officerUnlock && now >= this.officerUnlock.until) {
          await this.hw.lockers.lock(this.officerUnlock.channel);
          this.officerUnlock = null;
          await this.toReady();
        }
        return;

      case KioskState.RENTAL_ACTIVE:
      case KioskState.RETURN_COMPLETE:
      case KioskState.SHOWING_MESSAGE:
      case KioskState.ERROR:
        if (now >= this.holdUntil) await this.toReady();
        return;

      default:
        return;
    }
  }

  private async checkPaymentExpiry() {
    const flow = this.flow!;
    this.services.payments.expireSessions();
    const payment = flow.sessionId ? this.store.getPaymentBySession(flow.sessionId) : null;
    if (payment?.status !== 'CANCELLED') return;
    await this.hw.coins.setEnabled(false);
    const penalty = this.state === KioskState.WAITING_FOR_PENALTY_PAYMENT;
    await this.message(penalty ? LCD.penaltyNotPaid() : LCD.paymentTimeout(), 'error');
  }

  private async checkRemoval(now: number) {
    const flow = this.flow!;
    const left = await this.lockCountdown(flow, now);
    const reading = await this.hw.rfid.read(flow.channel);
    if (reading.readerOk && reading.uid !== flow.expectedUid) {
      // The rental is ACTIVE from this moment (the calculator is out); the locker locks on the red button.
      const removed = this.services.rentals.confirmRemoval(flow.rentalId, { detectedRfidUid: reading.uid });
      if (removed.ok) {
        flow.dueAt = removed.dueAt;
        this.move(KioskState.WAITING_FOR_DOOR_CLOSE);
        await this.hw.buzzer.beep('ok');
        await this.show(doneScreen(left));
        return;
      }
    }
    if (now > flow.deadline) {
      await this.lockNow(flow, now);
      this.services.rentals.failDispensing(flow.rentalId, 'CALCULATOR_NOT_REMOVED');
      await this.message(LCD.removalTimeout(), 'error');
      return;
    }
    await this.show(left ? LCD.lockOpen(`LOCKER ${flow.lockerNumber} OPEN`, left) : LCD.lockClosed('TAKE CALCULATOR'));
  }

  private async checkDoorTimeout(now: number) {
    const flow = this.flow!;
    const left = await this.lockCountdown(flow, now);
    if (flow.noticeUntil === undefined || now >= flow.noticeUntil) await this.show(doneScreen(left));
    if (now <= flow.deadline) return;
    await this.lockNow(flow, now);
    this.log('warn', 'Red button not pressed after a rental; locker locked at the timeout', { rentalId: flow.rentalId, locker: flow.lockerNumber });
    await this.message(LCD.doorLeftOpen(), 'attention');
  }

  /** Live hints while the student puts the calculator back; the red button decides. */
  private async checkReturn(now: number) {
    const flow = this.flow!;
    const left = await this.lockCountdown(flow, now);
    const reading = await this.hw.rfid.read(flow.channel);
    const rightOne = reading.readerOk && reading.uid !== null && reading.uid === flow.expectedUid;

    if (now > flow.deadline) {
      await this.lockNow(flow, now);
      if (rightOne) {
        // The right calculator is back but the red button was never pressed. Don't cancel the
        // return (the student would keep being charged): complete it and tell an officer.
        const result = this.services.returns.verifyReturn(flow.rentalId, { detectedRfidUid: reading.uid, doorState: DoorState.UNKNOWN });
        if (result.ok) {
          const door = this.sensors.get(flow.lockerId)?.door ?? DoorState.UNKNOWN;
          this.recordSensors(flow.lockerId, { rfidState: RfidState.EXPECTED_TAG, uid: reading.uid, door }, now);
          this.log('warn', 'Red button not pressed after a return; completed at the timeout', { rentalId: flow.rentalId, locker: flow.lockerNumber });
          this.move(KioskState.RETURN_COMPLETE);
          this.holdUntil = now + this.messageMs;
          await this.hw.buzzer.beep('attention');
          await this.show(LCD.doorLeftOpen());
          return;
        }
      }
      this.services.returns.abandonReturn(flow.rentalId);
      await this.message(LCD.returnTimeout(), 'error');
      return;
    }

    if (flow.noticeUntil !== undefined && now < flow.noticeUntil) return;
    if (rightOne) return this.show(doneScreen(left));
    const what = reading.readerOk && reading.uid !== null ? 'WRONG CALCULATOR'
      : left ? `LOCKER ${flow.lockerNumber} OPEN` : `RETURN CALC #${calcNumber(flow.calculatorCode)}`;
    await this.show(left ? LCD.lockOpen(what, left) : LCD.lockClosed(what));
  }

  // ------------------------------------------------------------------ sensors
  /**
   * Reads every locker's RFID reader and records changes in SQLite, so the
   * availability rule (database AND reader must agree) always has fresh data.
   * Writes only on change or every `sensorWriteIntervalMs` (SD-card friendly).
   */
  private async pollSensors(now: number) {
    for (const locker of this.store.listLockerHardware()) {
      let reading = await this.hw.rfid.read(locker.channel);
      // Confirm an empty read before invalidating a tag we just verified.
      if (reading.readerOk && reading.uid === null && this.sensors.get(locker.id)?.rfidState === RfidState.EXPECTED_TAG) {
        await delay(RFID_RETRY_DELAY_MS);
        reading = await this.hw.rfid.read(locker.channel);
      }
      const rfidState = !reading.readerOk
        ? RfidState.UNKNOWN
        : reading.uid === null
          ? RfidState.NO_TAG
          : reading.uid === locker.expectedUid
            ? RfidState.EXPECTED_TAG
            : RfidState.WRONG_TAG;
      const door = await this.hw.lockers.doorState(locker.channel);
      this.recordSensors(locker.id, { rfidState, uid: reading.uid, door }, now);
    }
  }

  private recordSensors(lockerId: string, snapshot: Omit<SensorSnapshot, 'writtenAt'>, now: number) {
    const { rfidState, uid, door } = snapshot;
    const previous = this.sensors.get(lockerId);
    const changed = !previous || previous.rfidState !== rfidState || previous.uid !== uid || previous.door !== door;
    if (!changed && now - previous.writtenAt < this.sensorWriteIntervalMs) return;

    this.store.setLockerSensors(
      lockerId,
      { rfidState, detectedRfidUid: uid, lockState: LockState.LOCKED, doorState: door },
      new Date(now).toISOString(),
    );
    this.sensors.set(lockerId, { ...snapshot, writtenAt: now });
  }

  // ------------------------------------------------------------------ helpers
  /** Every locker with "can a student rent from it right now?" (database AND reader agree). */
  private lockerAvailability() {
    return this.store
      .getLockerSnapshots()
      .sort((a, b) => a.lockerNumber - b.lockerNumber)
      .map((l) => ({ number: l.lockerNumber, available: isLockerAssignable(l) }));
  }

  private async rentalSuccess(now: number, dueAt: string) {
    this.move(KioskState.RENTAL_ACTIVE);
    this.holdUntil = now + this.messageMs;
    await this.hw.buzzer.beep('ok');
    await this.show(LCD.rentalSuccess(dueAt, new Date(now)));
  }

  /** Idle screen: locker status during operating hours, "returns only" outside them. */
  private idleScreen(): LcdScreen {
    const settings = this.store.getSettings();
    const cal = settings ? operatingCalendar(settings) : null;
    const now = this.now();
    const phone = this.phoneScan !== null;
    if (cal && !isOpenAt(now, cal)) return LCD.closedIdle(nextOpening(now, cal), phone);
    return LCD.ready(lockerStatusLine(this.lockerAvailability()), phone);
  }

  /** Error beep + a screen that stays up for messageMs before live hints resume (flow continues). */
  private async notice(lcd: LcdScreen) {
    this.flow!.noticeUntil = this.now().getTime() + this.messageMs;
    await this.hw.buzzer.beep('error');
    await this.show(lcd);
  }

  private async refuse(code: ErrorCode) {
    if (code === ErrorCode.KIOSK_CLOSED) {
      return this.message(LCD.closedForBorrowing(nextOpening(this.now(), operatingCalendar(this.settings()))), 'attention');
    }
    await this.message(errorScreen(code), 'error');
  }

  private async message(lcd: LcdScreen, beep: 'error' | 'attention') {
    this.move(KioskState.SHOWING_MESSAGE);
    this.flow = null;
    this.phone = null;
    this.holdUntil = this.now().getTime() + this.messageMs;
    await this.hw.buzzer.beep(beep);
    await this.show(lcd);
  }

  private async toReady() {
    this.move(KioskState.SYSTEM_READY);
    this.flow = null;
    this.selection = null;
    this.phone = null;
    await this.hw.coins.setEnabled(false);
    await this.show(this.idleScreen());
  }

  private housekeeping(now: number) {
    if (now - this.lastHousekeeping <= 60_000) return;
    this.lastHousekeeping = now;
    this.services.returns.markOverdueRentals();
    this.services.payments.expireSessions(); // leftovers from a crash/reboot
  }

  // ------------------------------------------------------------------ power saving
  /** Idle long enough on the ready screen (shorter while closed) → sleep. */
  private async maybeSleep(now: number) {
    if (this.sleepAfterMs <= 0) return;
    const settings = this.store.getSettings();
    const closed = !!settings && !isOpenAt(new Date(now), operatingCalendar(settings));
    const limit = closed ? Math.min(this.sleepAfterMs, this.closedSleepAfterMs) : this.sleepAfterMs;
    if (now - this.lastActivity < limit) return;

    this.move(KioskState.SLEEPING);
    await this.show(LCD.sleeping(closed));
    await this.hw.display.setBacklight(false);
    await this.hw.scanner.setActive(false);
    await this.hw.rfid.setPower(false);
    this.log('info', 'Power saving: asleep (LCD backlight, camera and RFID readers off)');
  }

  /** Back to normal: readers, camera and backlight on, fresh sensor readings, ready screen. */
  private async wake(reason: string) {
    await this.hw.rfid.setPower(true);
    await this.hw.scanner.setActive(true);
    await this.hw.display.setBacklight(true);
    this.move(KioskState.SYSTEM_READY);
    await this.pollSensors(this.now().getTime());
    await this.show(this.idleScreen());
    await this.hw.buzzer.beep('ok');
    this.log('info', `Woke up (${reason})`);
  }

  private move(to: KioskState) {
    if (!canMove(this.state, to)) throw new Error(`Kiosk cannot go from ${this.state} to ${to}`);
    this.log('info', `Kiosk ${this.state} -> ${to}`, { rentalId: this.flow?.rentalId });
    this.state = to;
    this.lastActivity = this.now().getTime(); // any step counts as activity for power saving
  }

  private show(lcd: LcdScreen) {
    return this.hw.display.show(lcd);
  }

  private settings(): SystemSettings {
    const settings = this.store.getSettings();
    if (!settings) throw new Error('Kiosk has no settings');
    return settings;
  }

  private lockerHardware(lockerId: string) {
    const locker = this.store.listLockerHardware().find((l) => l.id === lockerId);
    if (!locker) throw new Error(`Locker ${lockerId} has no hardware mapping`);
    return locker;
  }

  /** Runs `step` after every earlier input; any crash shows SYSTEM ERROR, locks the locker in use and recovers. */
  private enqueue(step: () => Promise<void> | void): Promise<void> {
    const run = this.queue.then(step).catch(async (error: unknown) => {
      this.log('error', 'Kiosk step failed', { error: error instanceof Error ? error.message : String(error), state: this.state });
      const channel = this.flow?.channel ?? this.officerUnlock?.channel;
      this.state = KioskState.ERROR;
      this.flow = null;
      this.selection = null;
      this.officerUnlock = null;
      this.phone = null;
      this.holdUntil = this.now().getTime() + this.messageMs;
      if (channel !== undefined) await this.hw.lockers.lock(channel).catch(() => {});
      await this.hw.coins.setEnabled(false).catch(() => {});
      // Never leave the kiosk dark or blind after a failure (e.g. during sleep/wake).
      await this.hw.display.setBacklight(true).catch(() => {});
      await this.hw.scanner.setActive(true).catch(() => {});
      await this.hw.rfid.setPower(true).catch(() => {});
      await this.hw.buzzer.beep('error').catch(() => {});
      await this.show(LCD.systemError()).catch(() => {});
    });
    this.queue = run;
    return run;
  }

  /** For tests and diagnostics. */
  get currentRentalId(): string | null {
    return this.flow?.rentalId ?? null;
  }
}
