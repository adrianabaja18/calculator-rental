import {
  DoorState,
  ErrorCode,
  LockState,
  RentalStatus,
  RfidState,
  isLockerAssignable,
  parseStudentQr,
  type SystemSettings,
} from '@calc-rental/shared';
import type { KioskStore } from '../db/kiosk-store';
import type { ButtonKind, Hardware } from '../hardware/types';
import type { CoinInput, PaymentService } from '../payment/payment-service';
import type { RentalService } from '../rental/rental-service';
import type { ReturnService } from '../rental/return-service';
import { KioskState, canMove } from './kiosk-states';
import { LCD, errorScreen, lockerStatusLine, type LcdScreen } from './lcd';

/**
 * The kiosk's brain (spec §21): turns hardware events into rental steps.
 *
 * Inputs, all funnelled through ONE queue so they never interleave:
 *   handleScan(raw)            QR code from the ESP32-CAM
 *   handleCoin(coin)           coin from the coin selector
 *   handleButton(kind, ch)     front panel: blue = choose locker ch, red = "door ch closed"
 *   tick()                     every ~250 ms: timeouts, RFID polling, overdue marking
 *
 * Lockers: a locker stays UNLOCKED from payment until the student presses its
 * red button (or the removal/return timeout ends), then it locks. The bridge
 * itself releases the solenoid at that limit, so a crash never leaves it open.
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
  /** A message (e.g. WRONG CALCULATOR) stays up until then before live hints resume. */
  noticeUntil?: number;
  /** Set once the calculator is taken, while waiting for the red button. */
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
  /** Between the scan and the blue button press. */
  private selection: { raw: string; deadline: number } | null = null;
  private holdUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly sensors = new Map<string, SensorSnapshot>();
  private lastHousekeeping = 0;
  private readonly messageMs: number;
  private readonly selectTimeoutMs: number;
  private readonly sensorWriteIntervalMs: number;
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
    return this.enqueue(() => (kind === 'select' ? this.onSelect(channel) : this.onClose(channel)));
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
    const holdMs = this.settings().removalTimeoutSeconds * 1000;
    try {
      await this.hw.lockers.unlock(flow.channel, holdMs);
    } catch (error) {
      this.services.rentals.failDispensing(flow.rentalId, 'LOCKER_OPEN_FAILED');
      throw error;
    }
    flow.deadline = this.now().getTime() + holdMs;
    this.move(KioskState.WAITING_FOR_REMOVAL);
    await this.show(LCD.lockerOpen(flow.lockerNumber));
  }

  private async openForReturn() {
    const flow = this.flow!;
    this.move(KioskState.RETURN_OPENING_LOCKER);
    const opened = this.services.returns.openReturnLocker(flow.rentalId);
    if (!opened.ok) throw new Error(opened.message);
    const holdMs = this.settings().returnTimeoutSeconds * 1000;
    await this.hw.lockers.unlock(flow.channel, holdMs);
    flow.deadline = this.now().getTime() + holdMs;
    this.move(KioskState.WAITING_FOR_RETURN);
    await this.show(LCD.returnTo(flow.calculatorCode, flow.lockerNumber));
  }

  /** Red button: "I closed the door". Only the locker in use reacts. */
  private async onClose(channel: number) {
    const flow = this.flow;
    if (!flow || flow.channel !== channel) return;
    const now = this.now().getTime();

    if (this.state === KioskState.WAITING_FOR_REMOVAL) {
      // The calculator is still inside: the locker stays open until it is taken.
      await this.hw.buzzer.beep('error');
      return;
    }

    if (this.state === KioskState.WAITING_FOR_DOOR_CLOSE) {
      if ((await this.hw.lockers.doorState(flow.channel)) === DoorState.OPEN) return this.notice(LCD.closeDoor()); // optional door sensor
      await this.hw.lockers.lock(flow.channel);
      return this.rentalSuccess(now, flow.dueAt!);
    }

    if (this.state === KioskState.WAITING_FOR_RETURN) {
      const reading = await this.hw.rfid.read(flow.channel);
      const door = await this.hw.lockers.doorState(flow.channel);
      const result = this.services.returns.verifyReturn(flow.rentalId, { detectedRfidUid: reading.uid, doorState: door });
      if (result.ok) {
        await this.hw.lockers.lock(flow.channel);
        this.move(KioskState.RETURN_COMPLETE);
        this.holdUntil = now + this.messageMs;
        await this.hw.buzzer.beep('ok');
        await this.show(LCD.returnSuccess(result.penaltyPaidCentavos));
        return;
      }
      // Not accepted: the locker stays unlocked so the student can fix it.
      return this.notice(result.code === ErrorCode.RFID_MISMATCH ? LCD.wrongCalculator(flow.calculatorCode) : errorScreen(result.code));
    }
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
        return this.show(LCD.ready(lockerStatusLine(this.lockerAvailability()))); // redrawn only on change

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
      // The rental is ACTIVE from this moment (the calculator is out); the locker locks on the red button.
      const removed = this.services.rentals.confirmRemoval(flow.rentalId, { detectedRfidUid: reading.uid });
      if (removed.ok) {
        flow.dueAt = removed.dueAt;
        this.move(KioskState.WAITING_FOR_DOOR_CLOSE);
        await this.hw.buzzer.beep('ok');
        await this.show(LCD.closeAndPressRed());
        return;
      }
    }
    if (now > flow.deadline) {
      await this.hw.lockers.lock(flow.channel);
      this.services.rentals.failDispensing(flow.rentalId, 'CALCULATOR_NOT_REMOVED');
      await this.message(LCD.removalTimeout(), 'error');
    }
  }

  private async checkDoorTimeout(now: number) {
    const flow = this.flow!;
    if (flow.noticeUntil === undefined || now >= flow.noticeUntil) await this.show(LCD.closeAndPressRed());
    if (now <= flow.deadline) return;
    await this.hw.lockers.lock(flow.channel);
    this.log('warn', 'Red button not pressed after a rental; locker locked at the timeout', { rentalId: flow.rentalId, locker: flow.lockerNumber });
    await this.message(LCD.doorLeftOpen(), 'attention');
  }

  /** Live hints while the student puts the calculator back; the red button decides. */
  private async checkReturn(now: number) {
    const flow = this.flow!;
    const reading = await this.hw.rfid.read(flow.channel);
    const rightOne = reading.readerOk && reading.uid !== null && reading.uid === flow.expectedUid;

    if (now > flow.deadline) {
      await this.hw.lockers.lock(flow.channel);
      if (rightOne) {
        // The right calculator is back but the red button was never pressed. Don't cancel the
        // return (the student would keep being charged): complete it and tell an officer.
        const result = this.services.returns.verifyReturn(flow.rentalId, { detectedRfidUid: reading.uid, doorState: DoorState.UNKNOWN });
        if (result.ok) {
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
    if (!reading.readerOk || reading.uid === null) await this.show(LCD.returnTo(flow.calculatorCode, flow.lockerNumber));
    else if (rightOne) await this.show(LCD.closeAndPressRed());
    else await this.show(LCD.wrongCalculator(flow.calculatorCode));
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
    await this.show(LCD.rentalSuccess(dueAt));
  }

  /** Error beep + a screen that stays up for messageMs before live hints resume (flow continues). */
  private async notice(lcd: LcdScreen) {
    this.flow!.noticeUntil = this.now().getTime() + this.messageMs;
    await this.hw.buzzer.beep('error');
    await this.show(lcd);
  }

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
    this.selection = null;
    await this.hw.coins.setEnabled(false);
    await this.show(LCD.ready(lockerStatusLine(this.lockerAvailability())));
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

  /** Runs `step` after every earlier input; any crash shows SYSTEM ERROR, locks the locker in use and recovers. */
  private enqueue(step: () => Promise<void> | void): Promise<void> {
    const run = this.queue.then(step).catch(async (error: unknown) => {
      this.log('error', 'Kiosk step failed', { error: error instanceof Error ? error.message : String(error), state: this.state });
      const channel = this.flow?.channel;
      this.state = KioskState.ERROR;
      this.flow = null;
      this.selection = null;
      this.holdUntil = this.now().getTime() + this.messageMs;
      if (channel !== undefined) await this.hw.lockers.lock(channel).catch(() => {});
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
