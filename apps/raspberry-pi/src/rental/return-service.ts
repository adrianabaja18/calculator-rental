import { randomUUID } from 'node:crypto';
import {
  CalculatorStatus,
  ErrorCode,
  EventSeverity,
  EventType,
  LockerStatus,
  RentalStatus,
  SystemSettingsSchema,
  assertTransition,
  calculatePenalty,
  isOverdue,
  parseStudentQr,
  verifyReturnedCalculator,
  type DoorState,
} from '@calc-rental/shared';
import type { KioskStore, RentalRecord } from '../db/kiosk-store';
import type { PaymentService } from '../payment/payment-service';
import type { ServiceResult } from './rental-service';

/**
 * Returning flow on the kiosk (spec §6), SQLite-first, so it works offline (Rule 11).
 *
 *  startReturn(qr)          find the student's rental; if late, quote the penalty
 *                           and open a PENALTY coin session (team policy: pay first)
 *  openReturnLocker(id)     penalty settled (or none) → RETURNING, unlock ONLY that locker
 *  verifyReturn(id, …)      expected RFID present + door closed → COMPLETED (Rule 8)
 *  abandonReturn(id)        return timeout → back to ACTIVE/OVERDUE
 *  markOverdueRentals()     ACTIVE past due_at → OVERDUE (called periodically)
 *
 * The normal rental fee is never charged again on return.
 */

export interface ReturnPlan {
  rentalId: string;
  transactionCode: string;
  studentName: string;
  locker: { id: string; number: number };
  calculatorCode: string;
  dueAt: string;
  overdueMinutes: number;
  penaltyId: string | null;
  /** Still to pay before the locker opens (centavos). */
  penaltyDueCentavos: number;
  /** PAY_PENALTY: insert coins into `sessionId` first. OPEN_LOCKER: call openReturnLocker. */
  next: 'PAY_PENALTY' | 'OPEN_LOCKER';
  sessionId: string | null;
}

const fail = (code: ErrorCode, message: string) => ({ ok: false as const, code, message });

export class ReturnService {
  private readonly now: () => Date;

  constructor(
    private readonly store: KioskStore,
    private readonly payments: PaymentService,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  startReturn(qrRaw: string): ServiceResult<{ plan: ReturnPlan }> {
    const now = this.now();
    const nowIso = now.toISOString();

    const qr = parseStudentQr(qrRaw);
    if (!qr.ok) {
      this.store.recordEvent({ type: EventType.QR_INVALID, severity: EventSeverity.WARNING, message: qr.reason, occurredAt: nowIso });
      return fail(ErrorCode.INVALID_QR, 'This QR code is not a valid school ID.');
    }

    const student = this.store.findStudentByNumber(qr.data.studentNumber);
    const rental = student ? this.store.getOutstandingRentalForStudent(student.id) : null;
    if (!student || !rental) return fail(ErrorCode.NO_ACTIVE_RENTAL, 'You have no calculator to return.');

    return this.store.transaction(() => {
      // Persist the overdue status the moment we know it.
      let current = rental;
      if (current.status === RentalStatus.ACTIVE && isOverdue(current.due_at, now)) {
        this.move(current, RentalStatus.OVERDUE, {});
        current = this.store.getRental(current.id)!;
      }

      this.store.recordEvent({
        type: EventType.RETURN_STARTED,
        severity: EventSeverity.INFO,
        message: `Return scan for ${current.transaction_code}`,
        lockerId: current.locker_id,
        transactionId: current.id,
        occurredAt: nowIso,
      });

      // Penalty quote with the rules in force when the rental started.
      const quote = calculatePenalty(current.due_at!, now, this.settingsFor(current));
      let penaltyId: string | null = this.store.getOverduePenalty(current.id)?.id ?? null;
      let penaltyDue = 0;
      if (quote.amountCentavos > 0 && current.status !== RentalStatus.RETURNING) {
        const penalty = this.store.quoteOverduePenalty(
          current,
          { overdueMinutes: quote.overdueMinutes, calculatedCentavos: quote.amountCentavos },
          randomUUID(),
          nowIso,
        );
        penaltyId = penalty.id;
        penaltyDue = penalty.amount_due_centavos;
      }

      let sessionId: string | null = null;
      if (penaltyDue > 0 && penaltyId) {
        const session = this.payments.openPenaltySession(penaltyId);
        if (!session.ok) return session;
        sessionId = session.sessionId;
      }

      const locker = this.store.db.prepare('SELECT locker_number FROM lockers WHERE id = ?').get(current.locker_id) as { locker_number: number };
      const calculator = this.store.db.prepare('SELECT code FROM calculators WHERE id = ?').get(current.calculator_id) as { code: string };

      return {
        ok: true as const,
        plan: {
          rentalId: current.id,
          transactionCode: current.transaction_code,
          studentName: student.full_name,
          locker: { id: current.locker_id, number: locker.locker_number },
          calculatorCode: calculator.code,
          dueAt: current.due_at!,
          overdueMinutes: quote.overdueMinutes,
          penaltyId,
          penaltyDueCentavos: penaltyDue,
          next: penaltyDue > 0 ? ('PAY_PENALTY' as const) : ('OPEN_LOCKER' as const),
          sessionId,
        },
      };
    });
  }

  /** Unlocks the rental's OWN locker once nothing is owed (pay-first policy). */
  openReturnLocker(rentalId: string): ServiceResult<{ lockerId: string }> {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.NO_ACTIVE_RENTAL, 'Rental not found.');
    if (rental.status === RentalStatus.RETURNING) return { ok: true, lockerId: rental.locker_id }; // re-scan while open

    const penalty = this.store.getOverduePenalty(rental.id);
    if (penalty && penalty.amount_due_centavos > 0) {
      return fail(ErrorCode.UNPAID_PENALTY, `Pay the ₱${penalty.amount_due_centavos / 100} penalty first.`);
    }

    const nowIso = this.now().toISOString();
    return this.store.transaction(() => {
      const moved = this.move(rental, RentalStatus.RETURNING, { return_started_at: nowIso });
      if (!moved.ok) return moved;
      this.store.setLockerStatus(rental.locker_id, LockerStatus.RETURNING, nowIso);
      this.store.recordEvent({
        type: EventType.LOCKER_UNLOCK_REQUESTED,
        severity: EventSeverity.INFO,
        message: `Unlock for return of ${rental.transaction_code}`,
        lockerId: rental.locker_id,
        transactionId: rental.id,
        occurredAt: nowIso,
      });
      return { ok: true as const, lockerId: rental.locker_id };
    });
  }

  /**
   * Completes the return only if the reader sees the EXPECTED tag (Rules 8–10)
   * and, when a door sensor exists, the door is closed.
   */
  verifyReturn(rentalId: string, sensors: { detectedRfidUid: string | null; doorState: DoorState }): ServiceResult<{
    wasOverdue: boolean;
    overdueMinutes: number;
    penaltyPaidCentavos: number;
  }> {
    const rental = this.store.getRental(rentalId);
    if (!rental || rental.status !== RentalStatus.RETURNING) {
      return fail(ErrorCode.CALCULATOR_NOT_RETURNED, 'This rental is not being returned.');
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const expected = this.store.getCalculatorRfidUid(rental.calculator_id)!;
    const check = verifyReturnedCalculator({ expectedRfidUid: expected, detectedRfidUid: sensors.detectedRfidUid, doorState: sensors.doorState });

    if (!check.ok) {
      if (check.code === ErrorCode.RFID_MISMATCH) {
        this.store.recordEvent({
          type: EventType.RFID_MISMATCH,
          severity: EventSeverity.WARNING,
          message: `Wrong tag in locker for ${rental.transaction_code}: expected ${expected}, saw ${sensors.detectedRfidUid}`,
          lockerId: rental.locker_id,
          transactionId: rental.id,
          payload: { expected, detected: sensors.detectedRfidUid },
          occurredAt: nowIso,
        });
      }
      return check;
    }

    // Lateness in operating minutes (time while the kiosk is closed doesn't count).
    const late = calculatePenalty(rental.due_at!, now, this.settingsFor(rental)).overdueMinutes;
    const penalty = this.store.getOverduePenalty(rental.id);
    return this.store.transaction(() => {
      const moved = this.move(rental, RentalStatus.COMPLETED, {
        returned_at: nowIso,
        was_overdue: late > 0 ? 1 : 0,
        overdue_minutes: late,
        return_rfid_verified: 1,
        return_rfid_uid: sensors.detectedRfidUid,
      });
      if (!moved.ok) return moved;
      this.store.setCalculatorStatus(rental.calculator_id, CalculatorStatus.AVAILABLE, nowIso);
      this.store.setLockerStatus(rental.locker_id, LockerStatus.AVAILABLE, nowIso);
      this.store.touchStudentTransaction(rental.student_id, nowIso);
      this.store.recordEvent({
        type: EventType.RETURN_VERIFIED,
        severity: EventSeverity.INFO,
        message: `Return of ${rental.transaction_code} verified${late > 0 ? ` (${late} min late)` : ''}`,
        lockerId: rental.locker_id,
        transactionId: rental.id,
        payload: { rfidUid: sensors.detectedRfidUid, overdueMinutes: late },
        occurredAt: nowIso,
      });
      return {
        ok: true as const,
        wasOverdue: late > 0,
        overdueMinutes: late,
        penaltyPaidCentavos: penalty?.amount_paid_centavos ?? 0,
      };
    });
  }

  /** Student left without placing the calculator: lock up again, rental continues. */
  abandonReturn(rentalId: string): ServiceResult {
    const rental = this.store.getRental(rentalId);
    if (!rental) return fail(ErrorCode.NO_ACTIVE_RENTAL, 'Rental not found.');
    const now = this.now();
    const back = isOverdue(rental.due_at, now) ? RentalStatus.OVERDUE : RentalStatus.ACTIVE;
    return this.store.transaction(() => {
      const moved = this.move(rental, back, {});
      if (!moved.ok) return moved;
      this.store.setLockerStatus(rental.locker_id, LockerStatus.RENTED, now.toISOString());
      this.store.recordEvent({
        type: EventType.SYSTEM_ERROR,
        severity: EventSeverity.WARNING,
        message: `Return of ${rental.transaction_code} abandoned: calculator not placed in time`,
        lockerId: rental.locker_id,
        transactionId: rental.id,
        occurredAt: now.toISOString(),
      });
      return moved;
    });
  }

  /** ACTIVE rentals past due become OVERDUE. Safe to call as often as you like. */
  markOverdueRentals(): { marked: number } {
    const nowIso = this.now().toISOString();
    let marked = 0;
    for (const rental of this.store.listActiveRentalsPastDue(nowIso)) {
      if (this.move(rental, RentalStatus.OVERDUE, {}).ok) marked += 1;
    }
    return { marked };
  }

  // -------------------------------------------------------------------------
  private settingsFor(rental: RentalRecord) {
    const snapshot = SystemSettingsSchema.safeParse(JSON.parse(rental.settings_snapshot));
    return snapshot.success ? snapshot.data : this.store.getSettings()!;
  }

  private move(rental: RentalRecord, to: RentalStatus, changes: Partial<RentalRecord>): ServiceResult {
    try {
      assertTransition(rental.status, to);
    } catch {
      return fail(ErrorCode.INTERNAL_ERROR, `Rental is ${rental.status}; it cannot become ${to}.`);
    }
    return this.store.updateRental(rental.id, rental.status, { ...changes, status: to, updated_at: this.now().toISOString() })
      ? { ok: true }
      : fail(ErrorCode.INTERNAL_ERROR, 'This rental was already updated by another step.');
  }
}
