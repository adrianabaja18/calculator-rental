import { createHash, randomUUID } from 'node:crypto';
import {
  CalculatorStatus,
  ErrorCode,
  EventSeverity,
  EventType,
  LockerStatus,
  RentalStatus,
  StudentStatus,
  assertTransition,
  checkBorrowEligibility,
  computeDueAt,
  findInventoryMismatches,
  generateTransactionCode,
  parseStudentQr,
  selectLockerForRental,
} from '@calc-rental/shared';
import type { KioskStore, RentalRecord } from '../db/kiosk-store';

/**
 * Borrowing flow on the kiosk (spec §5), SQLite-first.
 *
 *  startRental(qr)        scan → validate → eligibility → pick locker → reserve   → PAYMENT_PENDING
 *  markPaid(id, amount)   coins reached the fee (Phase 6 calls this)             → PAID
 *  startDispensing(id)    about to unlock the locker                              → DISPENSING
 *  confirmRemoval(id, …)  RFID reader no longer sees the calculator               → ACTIVE (rented_at, due_at)
 *  cancelRental(id, …)    timeout / student walked away before paying             → CANCELLED
 *  failDispensing(id, …)  locker didn't open or calculator wasn't taken           → FAILED
 *
 * The kiosk's state machine (Phase 9) drives these calls; hardware is not
 * touched here. Every method returns a result object instead of throwing
 * for expected refusals, so the caller can show the right LCD message.
 */

export type ServiceResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: ErrorCode; message: string };

export interface RentalQuote {
  rentalId: string;
  transactionCode: string;
  student: { id: string; fullName: string; studentNumber: string; isNew: boolean };
  locker: { id: string; number: number };
  calculator: { id: string; code: string };
  feeCentavos: number;
  durationMinutes: number;
  paymentExpiresAt: string;
}

export interface RentalServiceOptions {
  deviceCode: string;
  now?: () => Date;
  uuid?: () => string;
}

const fail = (code: ErrorCode, message: string) => ({ ok: false as const, code, message });

export class RentalService {
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly store: KioskStore,
    private readonly options: RentalServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  // -------------------------------------------------------------------------
  startRental(qrRaw: string): ServiceResult<{ quote: RentalQuote }> {
    const now = this.now();
    const nowIso = now.toISOString();

    // 1. Never trust what the scanner decoded (Rule 14).
    const qr = parseStudentQr(qrRaw);
    if (!qr.ok) {
      this.store.recordEvent({
        type: EventType.QR_INVALID,
        severity: EventSeverity.WARNING,
        message: qr.reason,
        payload: { length: qrRaw.length },
        occurredAt: nowIso,
      });
      return fail(ErrorCode.INVALID_QR, 'This QR code is not a valid school ID.');
    }

    const settings = this.store.getSettings();
    if (!settings) {
      return fail(ErrorCode.DATABASE_UNAVAILABLE, 'The kiosk has not received its settings yet.');
    }

    // 2–6 run in ONE transaction: two scans can never both reserve the
    // last calculator, and nothing is half-saved after a power cut.
    try {
      return this.store.transaction(() => {
        // Register or refresh the student (spec §5 steps 8–9).
        const qrIdentifier = createHash('sha256').update(qrRaw).digest('hex');
        let student = this.store.findStudentByNumber(qr.data.studentNumber);
        const isNew = !student;
        student = student
          ? this.store.refreshStudentFromQr(
              student.id,
              { full_name: qr.data.fullName, course_program: qr.data.courseProgram, qr_identifier: qrIdentifier },
              nowIso,
            )
          : this.store.insertStudent(
              {
                id: this.uuid(),
                student_number: qr.data.studentNumber,
                full_name: qr.data.fullName,
                course_program: qr.data.courseProgram,
                status: StudentStatus.ACTIVE,
                blocked_reason: null,
                qr_identifier: qrIdentifier,
              },
              nowIso,
            );

        this.store.recordEvent({
          type: EventType.QR_SCANNED,
          severity: EventSeverity.INFO,
          message: `${isNew ? 'New' : 'Known'} student ${student.student_number} scanned to borrow`,
          payload: { studentId: student.id, isNew },
          occurredAt: nowIso,
        });

        // Eligibility (spec §5 steps 10–11).
        const openRental = this.store.getOpenRentalForStudent(student.id);
        const eligibility = checkBorrowEligibility({
          student: isNew ? null : { status: student.status },
          openRental: openRental ? { status: openRental.status } : null,
          unpaidPenaltyTotal: this.store.getUnpaidPenaltyCentavos(student.id) / 100,
          settings,
        });
        if (!eligibility.ok) return eligibility;

        // Availability: database AND RFID must agree (spec §5 steps 12–15).
        const lockers = this.store.getLockerSnapshots();
        for (const mismatch of findInventoryMismatches(lockers)) {
          this.store.recordEvent({
            type: EventType.INVENTORY_MISMATCH,
            severity: EventSeverity.WARNING,
            message: `Locker ${mismatch.lockerNumber} should hold ${mismatch.calculatorCode} but the reader reports ${mismatch.reason}`,
            lockerId: mismatch.lockerId,
            payload: { ...mismatch },
            occurredAt: nowIso,
          });
        }
        const choice = selectLockerForRental(lockers);
        if (!choice.ok) return choice;

        // Reserve: create the rental and hold the locker (spec §5 step 17).
        const rental: RentalRecord = {
          id: this.uuid(),
          transaction_code: generateTransactionCode(now, this.options.deviceCode),
          student_id: student.id,
          calculator_id: choice.calculator.id,
          locker_id: choice.locker.id,
          status: RentalStatus.PAYMENT_PENDING,
          rental_fee_centavos: Math.round(settings.rentalFee * 100),
          amount_paid_centavos: 0,
          rental_duration_minutes: settings.rentalDurationMinutes,
          settings_snapshot: JSON.stringify(settings),
          reserved_at: nowIso,
          payment_expires_at: new Date(now.getTime() + settings.paymentTimeoutSeconds * 1000).toISOString(),
          paid_at: null,
          rented_at: null,
          due_at: null,
          return_started_at: null,
          returned_at: null,
          ended_at: null,
          was_overdue: 0,
          overdue_minutes: 0,
          rental_rfid_verified: 0,
          return_rfid_verified: 0,
          return_rfid_uid: null,
          failure_reason: null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        this.store.insertRental(rental);
        this.store.setLockerStatus(choice.locker.id, LockerStatus.RESERVED, nowIso);

        return {
          ok: true as const,
          quote: {
            rentalId: rental.id,
            transactionCode: rental.transaction_code,
            student: { id: student.id, fullName: student.full_name, studentNumber: student.student_number, isNew },
            locker: { id: choice.locker.id, number: choice.locker.lockerNumber },
            calculator: { id: choice.calculator.id, code: choice.calculator.code },
            feeCentavos: rental.rental_fee_centavos,
            durationMinutes: rental.rental_duration_minutes,
            paymentExpiresAt: rental.payment_expires_at!,
          },
        };
      });
    } catch (error) {
      // The partial unique indexes are the last line of defence against races.
      if (error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
        return fail(ErrorCode.ACTIVE_RENTAL_EXISTS, 'This rental could not be reserved. Please scan again.');
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  /** Payment reached the fee. Called by the coin payment session (Phase 6). */
  markPaid(rentalId: string, amountPaidCentavos: number): ServiceResult {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.INTERNAL_ERROR, 'Rental not found.');
    if (!Number.isInteger(amountPaidCentavos) || amountPaidCentavos < 0) {
      return fail(ErrorCode.PAYMENT_INCOMPLETE, 'Invalid payment amount.');
    }
    if (amountPaidCentavos < rental.rental_fee_centavos) {
      return fail(ErrorCode.PAYMENT_INCOMPLETE, 'The full rental fee has not been paid yet.');
    }
    return this.transition(rental, RentalStatus.PAID, {
      amount_paid_centavos: amountPaidCentavos,
      paid_at: this.now().toISOString(),
    });
  }

  /** About to unlock the locker. One paid rental opens exactly one locker (Rule 4). */
  startDispensing(rentalId: string): ServiceResult<{ lockerId: string }> {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.INTERNAL_ERROR, 'Rental not found.');
    const nowIso = this.now().toISOString();
    const result = this.store.transaction(() => {
      const moved = this.transition(rental, RentalStatus.DISPENSING, {});
      if (moved.ok) {
        this.store.setLockerStatus(rental.locker_id, LockerStatus.OPEN, nowIso);
        this.store.recordEvent({
          type: EventType.LOCKER_UNLOCK_REQUESTED,
          severity: EventSeverity.INFO,
          message: `Unlock requested for rental ${rental.transaction_code}`,
          lockerId: rental.locker_id,
          transactionId: rental.id,
          occurredAt: nowIso,
        });
      }
      return moved;
    });
    return result.ok ? { ok: true, lockerId: rental.locker_id } : result;
  }

  /**
   * The rental becomes ACTIVE only when the RFID reader confirms the
   * calculator left the locker (Rule 7). `detectedRfidUid` is what the
   * reader sees NOW: null = empty slot.
   */
  confirmRemoval(rentalId: string, sensors: { detectedRfidUid: string | null }): ServiceResult<{ dueAt: string }> {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.INTERNAL_ERROR, 'Rental not found.');
    if (rental.status !== RentalStatus.DISPENSING) {
      return fail(ErrorCode.INTERNAL_ERROR, `Rental is ${rental.status}, not DISPENSING.`);
    }

    const expectedUid = this.store.getCalculatorRfidUid(rental.calculator_id);
    if (sensors.detectedRfidUid !== null && sensors.detectedRfidUid === expectedUid) {
      return fail(ErrorCode.CALCULATOR_NOT_REMOVED, 'The calculator is still in the locker.');
    }

    const now = this.now();
    const nowIso = now.toISOString();
    // Server-side spec said "server timestamps"; under SQLite-first the
    // kiosk clock is used, which is why the kiosk waits for time sync at boot.
    const dueAt = computeDueAt(now, rental.rental_duration_minutes).toISOString();

    return this.store.transaction(() => {
      const moved = this.transition(rental, RentalStatus.ACTIVE, {
        rented_at: nowIso,
        due_at: dueAt,
        rental_rfid_verified: 1,
      });
      if (!moved.ok) return moved;
      this.store.setCalculatorStatus(rental.calculator_id, CalculatorStatus.RENTED, nowIso);
      this.store.setLockerStatus(rental.locker_id, LockerStatus.RENTED, nowIso);
      this.store.touchStudentTransaction(rental.student_id, nowIso);
      this.store.recordEvent({
        type: EventType.RENTAL_STARTED,
        severity: EventSeverity.INFO,
        message: `Rental ${rental.transaction_code} started, due ${dueAt}`,
        lockerId: rental.locker_id,
        transactionId: rental.id,
        payload: { dueAt },
        occurredAt: nowIso,
      });
      return { ok: true as const, dueAt };
    });
  }

  /** Student didn't pay in time or walked away. Frees the locker. */
  cancelRental(rentalId: string, reason: 'PAYMENT_TIMEOUT' | 'CANCELLED_AT_KIOSK'): ServiceResult {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.INTERNAL_ERROR, 'Rental not found.');
    const nowIso = this.now().toISOString();
    return this.store.transaction(() => {
      const moved = this.transition(rental, RentalStatus.CANCELLED, { ended_at: nowIso, failure_reason: reason });
      if (!moved.ok) return moved;
      this.store.setLockerStatus(rental.locker_id, LockerStatus.AVAILABLE, nowIso);
      if (reason === 'PAYMENT_TIMEOUT') {
        this.store.recordEvent({
          type: EventType.PAYMENT_TIMEOUT,
          severity: EventSeverity.INFO,
          message: `Payment timed out for ${rental.transaction_code}`,
          transactionId: rental.id,
          payload: { amountPaidCentavos: rental.amount_paid_centavos },
          occurredAt: nowIso,
        });
      }
      return moved;
    });
  }

  /** Locker didn't open, or the calculator was never taken. Officer follows up (refund). */
  failDispensing(rentalId: string, reason: 'LOCKER_OPEN_FAILED' | 'CALCULATOR_NOT_REMOVED'): ServiceResult {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.INTERNAL_ERROR, 'Rental not found.');
    const nowIso = this.now().toISOString();
    return this.store.transaction(() => {
      const moved = this.transition(rental, RentalStatus.FAILED, { ended_at: nowIso, failure_reason: reason });
      if (!moved.ok) return moved;
      this.store.setLockerStatus(rental.locker_id, LockerStatus.AVAILABLE, nowIso);
      this.store.recordEvent({
        type: EventType.SYSTEM_ERROR,
        severity: EventSeverity.ERROR,
        message: `Rental ${rental.transaction_code} failed: ${reason}. Paid ₱${rental.amount_paid_centavos / 100}, needs officer follow-up.`,
        lockerId: rental.locker_id,
        transactionId: rental.id,
        payload: { reason, amountPaidCentavos: rental.amount_paid_centavos },
        occurredAt: nowIso,
      });
      return moved;
    });
  }

  // -------------------------------------------------------------------------
  /** Applies an allowed status change, guarded against duplicate/late calls. */
  private transition(rental: RentalRecord, to: RentalStatus, changes: Partial<RentalRecord>): ServiceResult {
    try {
      assertTransition(rental.status, to);
    } catch {
      return fail(ErrorCode.INTERNAL_ERROR, `Rental is ${rental.status}; it cannot become ${to}.`);
    }
    const applied = this.store.updateRental(rental.id, rental.status, {
      ...changes,
      status: to,
      updated_at: this.now().toISOString(),
    });
    return applied
      ? { ok: true }
      : fail(ErrorCode.INTERNAL_ERROR, 'This rental was already updated by another step.');
  }
}
