import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  EventSeverity,
  EventType,
  PaymentStatus,
  RentalStatus,
  coinValueFromPulses,
  paymentProgress,
  type PaymentProgress,
} from '@calc-rental/shared';
import type { KioskStore } from '../db/kiosk-store';
import type { RentalService, ServiceResult } from '../rental/rental-service';

/**
 * Coin payment sessions (spec §5 steps 17–24), SQLite-first.
 *
 *  openSession(rentalId)          rental is PAYMENT_PENDING → RENTAL payment PENDING (coin acceptor enabled)
 *  openPenaltySession(penaltyId)  late return (pay-first policy) → PENALTY payment for the balance
 *  insertCoin(coin)               adds a coin → PARTIAL … PAID, then marks the rental PAID
 *                                 or credits the penalty, in the same transaction
 *  expireSessions()               window passed → RENTAL: payment + rental CANCELLED;
 *                                 PENALTY: coins so far are credited to the penalty
 *
 * Coin rules:
 *  - each coin event has its own id → the same pulses are never counted twice;
 *  - once PAID the payment is locked; later coins are recorded as
 *    unattributed (officer refund) and never applied to another rental (Rule 23);
 *  - coins the settings don't accept, or pulse noise, are logged and not credited.
 */

export interface CoinInput {
  /** Created by the coin hardware adapter when it detects the coin. */
  eventId: string;
  pulseCount: number;
  occurredAt: string;
}

export type CoinOutcome =
  | { kind: 'credited'; progress: PaymentProgress; paidNow: boolean }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unattributed'; valueCentavos: number };

const fail = (code: ErrorCode, message: string) => ({ ok: false as const, code, message });

export class PaymentService {
  private readonly now: () => Date;

  constructor(
    private readonly store: KioskStore,
    private readonly rentals: RentalService,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Opens (or returns the already-open) coin session for a reserved rental. */
  openSession(rentalId: string): ServiceResult<{ sessionId: string; progress: PaymentProgress }> {
    const rental = this.store.getRental(rentalId);
    if (!rental || rental.status !== RentalStatus.PAYMENT_PENDING) {
      return fail(ErrorCode.PAYMENT_INCOMPLETE, 'This rental is not waiting for payment.');
    }
    const existing = this.store.getLivePaymentForRental(rentalId);
    if (existing) {
      return { ok: true, sessionId: existing.session_id, progress: paymentProgress(existing.required_centavos, existing.received_centavos) };
    }
    const nowIso = this.now().toISOString();
    const payment = this.store.insertPayment({
      id: randomUUID(),
      rental_id: rental.id,
      student_id: rental.student_id,
      payment_type: 'RENTAL',
      method: 'COIN',
      required_centavos: rental.rental_fee_centavos,
      received_centavos: 0,
      status: PaymentStatus.PENDING,
      session_id: randomUUID(),
      penalty_id: null,
      expires_at: rental.payment_expires_at,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return { ok: true, sessionId: payment.session_id, progress: paymentProgress(payment.required_centavos, 0) };
  }

  /** Opens (or returns the open) coin session for a penalty's remaining balance. */
  openPenaltySession(penaltyId: string): ServiceResult<{ sessionId: string; progress: PaymentProgress }> {
    const penalty = this.store.db.prepare('SELECT * FROM penalties WHERE id = ?').get(penaltyId) as
      | { id: string; rental_id: string; student_id: string; amount_due_centavos: number }
      | undefined;
    if (!penalty || penalty.amount_due_centavos <= 0) {
      return fail(ErrorCode.PAYMENT_INCOMPLETE, 'Nothing is owed on this penalty.');
    }
    const existing = this.store.getOpenPaymentForPenalty(penaltyId);
    if (existing) {
      return { ok: true, sessionId: existing.session_id, progress: paymentProgress(existing.required_centavos, existing.received_centavos) };
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const timeoutSeconds = this.store.getSettings()?.paymentTimeoutSeconds ?? 120;
    const payment = this.store.insertPayment({
      id: randomUUID(),
      rental_id: penalty.rental_id,
      student_id: penalty.student_id,
      payment_type: 'PENALTY',
      method: 'COIN',
      required_centavos: penalty.amount_due_centavos,
      received_centavos: 0,
      status: PaymentStatus.PENDING,
      session_id: randomUUID(),
      penalty_id: penalty.id,
      expires_at: new Date(now.getTime() + timeoutSeconds * 1000).toISOString(),
      created_at: nowIso,
      updated_at: nowIso,
    });
    return { ok: true, sessionId: payment.session_id, progress: paymentProgress(payment.required_centavos, 0) };
  }

  /**
   * Handles one coin. `sessionId` is the session the kiosk currently has
   * open, or null when idle (a coin inserted while no payment is expected).
   */
  insertCoin(sessionId: string | null, coin: CoinInput): CoinOutcome {
    const accepted = this.store.getSettings()?.acceptedCoinDenominations ?? [];
    const pesos = coinValueFromPulses(coin.pulseCount, accepted);
    if (pesos === null) {
      this.store.recordEvent({
        type: EventType.COIN_INSERTED,
        severity: EventSeverity.WARNING,
        message: `Ignored ${coin.pulseCount} pulse(s): not an accepted coin`,
        payload: { pulseCount: coin.pulseCount, eventId: coin.eventId },
        occurredAt: coin.occurredAt,
      });
      return { kind: 'rejected', reason: 'Not an accepted coin' };
    }
    const valueCentavos = pesos * 100;

    return this.store.transaction((): CoinOutcome => {
      const payment = sessionId ? this.store.getPaymentBySession(sessionId) : null;
      const open = payment && (payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.PARTIAL);

      if (!open) {
        // No payment expected (idle, already paid, or cancelled): keep the coin on record for a refund.
        const inserted = this.store.insertCoinEvent({
          id: coin.eventId,
          payment_id: null,
          session_id: sessionId,
          value_centavos: valueCentavos,
          pulse_count: coin.pulseCount,
          occurred_at: coin.occurredAt,
        });
        if (!inserted) return { kind: 'duplicate' };
        this.store.recordEvent({
          type: EventType.COIN_UNATTRIBUTED,
          severity: EventSeverity.WARNING,
          message: `₱${pesos} inserted while no payment was open: refund needed`,
          payload: { eventId: coin.eventId, valueCentavos },
          occurredAt: coin.occurredAt,
        });
        return { kind: 'unattributed', valueCentavos };
      }

      const inserted = this.store.insertCoinEvent({
        id: coin.eventId,
        payment_id: payment.id,
        session_id: payment.session_id,
        value_centavos: valueCentavos,
        pulse_count: coin.pulseCount,
        occurred_at: coin.occurredAt,
      });
      if (!inserted) return { kind: 'duplicate' };

      const received = payment.received_centavos + valueCentavos;
      const progress = paymentProgress(payment.required_centavos, received);
      const nowIso = this.now().toISOString();
      this.store.updatePayment(payment.id, payment.status, {
        received_centavos: received,
        status: progress.complete ? PaymentStatus.PAID : PaymentStatus.PARTIAL,
        paid_at: progress.complete ? nowIso : null,
        updated_at: nowIso,
      });
      this.store.recordEvent({
        type: EventType.COIN_INSERTED,
        severity: EventSeverity.INFO,
        message: `₱${pesos} coin (${received / 100}/${payment.required_centavos / 100})`,
        transactionId: payment.rental_id,
        payload: { eventId: coin.eventId, valueCentavos, receivedCentavos: received },
        occurredAt: coin.occurredAt,
      });

      if (progress.complete) {
        if (payment.payment_type === 'PENALTY' && payment.penalty_id) {
          this.store.applyPenaltyPayment(payment.penalty_id, received, nowIso);
        } else {
          const paid = this.rentals.markPaid(payment.rental_id, received);
          if (!paid.ok) throw new Error(`Payment complete but rental could not be marked paid: ${paid.message}`);
        }
        this.store.recordEvent({
          type: EventType.PAYMENT_COMPLETE,
          severity: EventSeverity.INFO,
          message: `Payment complete: ₱${received / 100}${progress.overpaidCentavos ? ` (₱${progress.overpaidCentavos / 100} over, no change given)` : ''}`,
          transactionId: payment.rental_id,
          payload: { receivedCentavos: received, overpaidCentavos: progress.overpaidCentavos },
          occurredAt: nowIso,
        });
      }
      return { kind: 'credited', progress, paidNow: progress.complete };
    });
  }

  /**
   * Cancels sessions whose payment window passed. Coins already inserted
   * can't be returned by the selector, so they're flagged for an officer refund.
   * Call periodically (the kiosk state machine does this in Phase 9).
   */
  expireSessions(options: { all?: boolean } = {}): { expired: number } {
    const nowIso = this.now().toISOString();
    let expired = 0;
    // all: after a restart nobody can still be mid-payment, so close every open session.
    const cutoff = options.all ? '9999-12-31T00:00:00.000Z' : nowIso;
    for (const payment of this.store.listExpiredPaymentSessions(cutoff)) {
      this.store.transaction(() => {
        if (!this.store.updatePayment(payment.id, payment.status, { status: PaymentStatus.CANCELLED, updated_at: nowIso })) return;
        expired += 1;
        if (payment.payment_type === 'PENALTY' && payment.penalty_id) {
          // The student owes this money anyway: keep the coins as part-payment, no refund.
          if (payment.received_centavos > 0) this.store.applyPenaltyPayment(payment.penalty_id, payment.received_centavos, nowIso);
          // Pay-first policy: the calculator is still out. Officers should follow up.
          this.store.recordEvent({
            type: EventType.PAYMENT_TIMEOUT,
            severity: EventSeverity.WARNING,
            message: `Late return not completed: penalty not fully paid (₱${payment.received_centavos / 100} of ₱${payment.required_centavos / 100}), calculator still with the student`,
            transactionId: payment.rental_id,
            payload: { paymentId: payment.id, penaltyId: payment.penalty_id, receivedCentavos: payment.received_centavos },
            occurredAt: nowIso,
          });
          return;
        }
        this.rentals.cancelRental(payment.rental_id, 'PAYMENT_TIMEOUT');
        if (payment.received_centavos > 0) {
          this.store.recordEvent({
            type: EventType.PAYMENT_TIMEOUT,
            severity: EventSeverity.WARNING,
            message: `Payment timed out after ₱${payment.received_centavos / 100} of ₱${payment.required_centavos / 100}: refund needed`,
            transactionId: payment.rental_id,
            payload: { paymentId: payment.id, receivedCentavos: payment.received_centavos },
            occurredAt: nowIso,
          });
        }
      });
    }
    return { expired };
  }
}
