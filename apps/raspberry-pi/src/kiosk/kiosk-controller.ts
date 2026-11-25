import {
  DoorState,
  ErrorCode,
  LockState,
  RentalStatus,
  RfidState,
  parseStudentQr,
  type SystemSettings,
} from '@calc-rental/shared';
import type { KioskStore } from '../db/kiosk-store';
import type { Hardware } from '../hardware/types';
import type { CoinInput, PaymentService } from '../payment/payment-service';
import type { RentalService } from '../rental/rental-service';
import type { ReturnService } from '../rental/return-service';
import { KioskState, canMove } from './kiosk-states';
import { LCD, errorScreen, type LcdScreen } from './lcd';

/**
 * The kiosk's brain (spec §21): turns hardware events into rental steps.
 *
 * Inputs, all funnelled through ONE queue so they never interleave:
 *   handleScan(raw)  — QR code from the ESP32-CAM
 *   handleCoin(coin) — coin from the coin selector
 *   tick()           — every ~250 ms: timeouts, RFID/door polling, overdue marking
 *
 * Business rules live in the services; this class only sequences them,
 * drives the hardware and the 16×2 LCD.
 */

export interface KioskOptions {
  /** How long the solenoid is energised per unlock. */
  lockPulseMs?: number;
  /** How long result/refusal screens stay up. */
  messageMs?: number;
  /** Sensor states are written to SQLite on change, and at least this often. */
  sensorWriteIntervalMs?: number;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
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
  lastWrongUid?: string | null;
  /** Set once the calculator is taken, while waiting for the door to close. */
  dueAt?: string;
}

interface SensorSnapshot {
  rfidState: RfidState;
  uid: string | null;
  door: DoorState;
  writtenAt: number;
}

export class KioskController {
  state: KioskState = KioskState.STARTING;
  private flow: Flow | null = null;
  private holdUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly sensors = new Map<string, SensorSnapshot>();
  private lastHousekeeping = 0;
  private readonly lockPulseMs: number;
  private readonly messageMs: number;
  private readonly sensorWriteIntervalMs: number;
  private readonly now: () => Date;
  private readonly log: NonNullable<KioskOptions['log']>;

  constructor(
    private readonly store: KioskStore,
    private readonly hw: Hardware,
    private readonly services: { rentals: RentalService; payments: PaymentService; returns: ReturnService },
    options: KioskOptions = {},
  ) {
    this.lockPulseMs = options.lockPulseMs ?? 3000;
    this.messageMs = options.messageMs ?? 4000;
    this.sensorWriteIntervalMs = options.sensorWriteIntervalMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ------------------------------------------------------------------ inputs
  async start(): Promise<void> {
    this.hw.scanner.onScan((raw) => void this.handleScan(raw));
    this.hw.coins.onCoin((coin) => void this.handleCoin(coin));
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

  tick(): Promise<void> {
    return this.enqueue(() => this.onTick());
  }

  // ------------------------------------------------------------------ scan
  private async onScan(raw: string) {
    if (this.state !== KioskState.SYSTEM_READY) {
      this.log('info', 'Scan ignored: kiosk busy', { state: this.state });
      return;
    }
    this.move(KioskState.VALIDATING_STUDENT);
    await this.show(LCD.checking());

    // One scanner for both flows: a student with a calculator out is returning it.
    const qr = parseStudentQr(raw);
    const student = qr.ok ? this.store.findStudentByNumber(qr.data.studentNumber) : null;
    const returning = student ? this.store.getOutstandingRentalForStudent(student.id) : null;
    if (returning) return this.beginReturn(raw);
    return this.beginBorrow(raw);
  }

  private async beginBorrow(raw: string) {
    const started = this.services.rentals.startRental(raw);
    if (!started.ok) return this.refuse(started.code);

    const q = started.quote;
    const session = this.services.payments.openSession(q.rentalId);
    if (!session.ok) return this.refuse(session.code);
    const locker = this.lockerHardware(q.locker.id);
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
    try {
      await this.hw.lockers.unlock(flow.channel, this.lockPulseMs);
    } catch (error) {
      this.services.rentals.failDispensing(flow.rentalId, 'LOCKER_OPEN_FAILED');
      throw error;
    }
    flow.deadline = this.now().getTime() + this.settings().removalTimeoutSeconds * 1000;
    this.move(KioskState.WAITING_FOR_REMOVAL);
    await this.show(LCD.lockerOpen(flow.lockerNumber));
  }

  private async openForReturn() {
    const flow = this.flow!;
    this.move(KioskState.RETURN_OPENING_LOCKER);
    const opened = this.services.returns.openReturnLocker(flow.rentalId);
    if (!opened.ok) throw new Error(opened.message);
    await this.hw.lockers.unlock(flow.channel, this.lockPulseMs);
    flow.deadline = this.now().getTime() + this.settings().returnTimeoutSeconds * 1000;
    this.move(KioskState.WAITING_FOR_RETURN);
    await this.show(LCD.returnTo(flow.calculatorCode, flow.lockerNumber));
  }

  // ------------------------------------------------------------------ tick
  private async onTick() {
    const now = this.now().getTime();

    if (this.state === KioskState.WAITING_FOR_CLOCK) {
      if (await this.hw.clock.isSynced()) await this.toReady();
      return;
    }

    await this.pollSensors(now);

    switch (this.state) {
      case KioskState.SYSTEM_READY:
        if (now - this.lastHousekeeping > 60_000) {
          this.lastHousekeeping = now;
          this.services.returns.markOverdueRentals();
          this.services.payments.expireSessions(); // leftovers from a crash/reboot
        }
        return;

      case KioskState.WAITING_FOR_PAYMENT:
      case KioskState.WAITING_FOR_PENALTY_PAYMENT:
        return this.checkPaymentExpiry();

      case KioskState.WAITING_FOR_REMOVAL:
        return this.checkRemoval(now);

      case KioskState.WAITING_FOR_DOOR_CLOSE:
        return this.checkDoorClosed(now);

      case KioskState.WAITING_FOR_RETURN:
        return this.checkReturn(now);

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
    const reading = await this.hw.rfid.read(flow.channel);
    if (reading.readerOk && reading.uid !== flow.expectedUid) {
      const removed = this.services.rentals.confirmRemoval(flow.rentalId, { detectedRfidUid: reading.uid });
      if (removed.ok) {
        // The rental is ACTIVE now (the calculator is out). With a door switch, finish only once the door is shut.
        if ((await this.hw.lockers.doorState(flow.channel)) === DoorState.OPEN) {
          flow.dueAt = removed.dueAt;
          flow.deadline = now + this.settings().removalTimeoutSeconds * 1000;
          this.move(KioskState.WAITING_FOR_DOOR_CLOSE);
          await this.hw.buzzer.beep('attention');
          await this.show(LCD.closeDoor());
          return;
        }
        return this.rentalSuccess(now, removed.dueAt);
      }
    }
    if (now > flow.deadline) {
      this.services.rentals.failDispensing(flow.rentalId, 'CALCULATOR_NOT_REMOVED');
      await this.message(LCD.removalTimeout(), 'error');
    }
  }

  private async checkDoorClosed(now: number) {
    const flow = this.flow!;
    if ((await this.hw.lockers.doorState(flow.channel)) !== DoorState.OPEN) return this.rentalSuccess(now, flow.dueAt!);
    if (now > flow.deadline) {
      this.log('warn', 'Locker door left open after a rental', { rentalId: flow.rentalId, locker: flow.lockerNumber });
      await this.message(LCD.doorLeftOpen(), 'attention');
    }
  }

  private async rentalSuccess(now: number, dueAt: string) {
    this.move(KioskState.RENTAL_ACTIVE);
    this.holdUntil = now + this.messageMs;
    await this.hw.buzzer.beep('ok');
    await this.show(LCD.rentalSuccess(dueAt));
  }

  private async checkReturn(now: number) {
    const flow = this.flow!;
    const reading = await this.hw.rfid.read(flow.channel);
    if (reading.readerOk && reading.uid) {
      const door = await this.hw.lockers.doorState(flow.channel);
      const result = this.services.returns.verifyReturn(flow.rentalId, { detectedRfidUid: reading.uid, doorState: door });
      if (result.ok) {
        this.move(KioskState.RETURN_COMPLETE);
        this.holdUntil = now + this.messageMs;
        await this.hw.buzzer.beep('ok');
        await this.show(LCD.returnSuccess(result.penaltyPaidCentavos));
        return;
      }
      if (result.code === ErrorCode.RFID_MISMATCH) {
        await this.show(LCD.wrongCalculator(flow.calculatorCode));
        if (flow.lastWrongUid !== reading.uid) {
          // The latch re-locked behind the wrong calculator: open again so it can be swapped.
          flow.lastWrongUid = reading.uid;
          await this.hw.buzzer.beep('error');
          await this.hw.lockers.unlock(flow.channel, this.lockPulseMs);
        }
      } else if (result.code === ErrorCode.LOCKER_CLOSE_FAILED) {
        await this.show(errorScreen(ErrorCode.LOCKER_CLOSE_FAILED));
      }
    }
    if (now > flow.deadline) {
      if (reading.readerOk && reading.uid && reading.uid === flow.expectedUid) {
        // The right calculator is back but the door was left open. Don't cancel the
        // return (the student would keep being charged): complete it and tell an officer.
        const result = this.services.returns.verifyReturn(flow.rentalId, { detectedRfidUid: reading.uid, doorState: DoorState.UNKNOWN });
        if (result.ok) {
          this.log('warn', 'Locker door left open after a return', { rentalId: flow.rentalId, locker: flow.lockerNumber });
          this.move(KioskState.RETURN_COMPLETE);
          this.holdUntil = now + this.messageMs;
          await this.hw.buzzer.beep('attention');
          await this.show(LCD.doorLeftOpen());
          return;
        }
      }
      this.services.returns.abandonReturn(flow.rentalId);
      await this.message(LCD.returnTimeout(), 'error');
    }
  }

  // ------------------------------------------------------------------ sensors
  /**
   * Reads every locker's RFID reader and records changes in SQLite, so the
   * availability rule (database AND reader must agree) always has fresh data.
   * Writes only on change or every `sensorWriteIntervalMs` (SD-card friendly).
   */
  private async pollSensors(now: number) {
    for (const locker of this.store.listLockerHardware()) {
      const reading = await this.hw.rfid.read(locker.channel);
      const rfidState = !reading.readerOk
        ? RfidState.UNKNOWN
        : reading.uid === null
          ? RfidState.NO_TAG
          : reading.uid === locker.expectedUid
            ? RfidState.EXPECTED_TAG
            : RfidState.WRONG_TAG;
      const door = await this.hw.lockers.doorState(locker.channel);
      const previous = this.sensors.get(locker.id);
      const changed = !previous || previous.rfidState !== rfidState || previous.uid !== reading.uid || previous.door !== door;
      if (!changed && now - previous.writtenAt < this.sensorWriteIntervalMs) continue;
      this.store.setLockerSensors(
        locker.id,
        { rfidState, detectedRfidUid: reading.uid, lockState: LockState.LOCKED, doorState: door },
        new Date(now).toISOString(),
      );
      this.sensors.set(locker.id, { rfidState, uid: reading.uid, door, writtenAt: now });
    }
  }

  // ------------------------------------------------------------------ helpers
  private async refuse(code: ErrorCode) {
    await this.message(errorScreen(code), 'error');
  }

  private async message(lcd: LcdScreen, beep: 'error' | 'attention') {
    this.move(KioskState.SHOWING_MESSAGE);
    this.flow = null;
    this.holdUntil = this.now().getTime() + this.messageMs;
    await this.hw.buzzer.beep(beep);
    await this.show(lcd);
  }

  private async toReady() {
    this.move(KioskState.SYSTEM_READY);
    this.flow = null;
    await this.hw.coins.setEnabled(false);
    await this.show(LCD.ready());
  }

  private move(to: KioskState) {
    if (!canMove(this.state, to)) throw new Error(`Kiosk cannot go from ${this.state} to ${to}`);
    this.log('info', `Kiosk ${this.state} -> ${to}`, { rentalId: this.flow?.rentalId });
    this.state = to;
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

  /** Runs `step` after every earlier input; any crash shows SYSTEM ERROR and recovers. */
  private enqueue(step: () => Promise<void> | void): Promise<void> {
    const run = this.queue.then(step).catch(async (error: unknown) => {
      this.log('error', 'Kiosk step failed', { error: error instanceof Error ? error.message : String(error), state: this.state });
      this.state = KioskState.ERROR;
      this.flow = null;
      this.holdUntil = this.now().getTime() + this.messageMs;
      await this.hw.coins.setEnabled(false).catch(() => {});
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

