import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DoorState, ErrorCode, RentalStatus } from '@calc-rental/shared';
import { DEV_IDS, DEV_RFID, DEV_SETTINGS, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { migrations } from '../db/migrations';
import { openLocalDatabase } from '../db/sqlite';
import { PaymentService } from '../payment/payment-service';
import { RentalService } from './rental-service';
import { ReturnService } from './return-service';

// Fake identities only.
const JUAN_QR = 'JUAN DELA CRUZ\t2022100001\tBSCpE';
const MARIA_QR = 'MARIA SANTOS\t2023100002\tBSCE';
const HOUR = 60 * 60_000;

let store: KioskStore;
let rentals: RentalService;
let payments: PaymentService;
let returns: ReturnService;
let clock: Date;
const start = new Date('2026-10-20T02:00:00.000Z'); // 10:00 AM Manila, due 1:00 PM

const coin = (pesos: number) => ({ eventId: randomUUID(), pulseCount: pesos, occurredAt: clock.toISOString() });
const at = (msAfterStart: number) => (clock = new Date(start.getTime() + msAfterStart));

/** Juan borrows CALC-001 from Locker 1 at 10:00. */
function borrowJuan() {
  const started = rentals.startRental(JUAN_QR);
  if (!started.ok) throw new Error(started.message);
  const { sessionId } = payments.openSession(started.quote.rentalId) as { sessionId: string };
  payments.insertCoin(sessionId, coin(20));
  rentals.startDispensing(started.quote.rentalId);
  rentals.confirmRemoval(started.quote.rentalId, { detectedRfidUid: null });
  return started.quote.rentalId;
}

const putBack = (rentalId: string, uid: string | null = DEV_RFID.calc1, doorState: DoorState = DoorState.CLOSED) =>
  returns.verifyReturn(rentalId, { detectedRfidUid: uid, doorState });

beforeEach(() => {
  store = new KioskStore(openLocalDatabase(':memory:'));
  clock = start;
  seedDevData(store, { sensorsReady: true, nowIso: clock.toISOString() });
  rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now: () => clock });
  payments = new PaymentService(store, rentals, { now: () => clock });
  returns = new ReturnService(store, payments, { now: () => clock });
});

it('migrates the kiosk database to the latest version', () => {
  expect(store.db.pragma('user_version', { simple: true })).toBe(migrations.at(-1)!.version);
});

describe('starting a return', () => {
  it('refuses a student with no active rental (no locker opens)', () => {
    expect(returns.startReturn(MARIA_QR)).toMatchObject({ ok: false, code: ErrorCode.NO_ACTIVE_RENTAL });
  });

  it('refuses an invalid QR code', () => {
    expect(returns.startReturn('not a school id')).toMatchObject({ ok: false, code: ErrorCode.INVALID_QR });
  });

  it('on time: no penalty, the locker can open right away', () => {
    const id = borrowJuan();
    at(2 * HOUR);
    expect(returns.startReturn(JUAN_QR)).toMatchObject({
      ok: true,
      plan: { rentalId: id, locker: { number: 1 }, calculatorCode: 'CALC-001', penaltyDueCentavos: 0, next: 'OPEN_LOCKER' },
    });
  });

  it('within the 10-minute grace period: no penalty', () => {
    borrowJuan();
    at(3 * HOUR + 10 * 60_000);
    expect(returns.startReturn(JUAN_QR)).toMatchObject({ ok: true, plan: { penaltyDueCentavos: 0, next: 'OPEN_LOCKER' } });
  });

  it('never charges the rental fee again', () => {
    const id = borrowJuan();
    at(HOUR);
    returns.startReturn(JUAN_QR);
    const rentalPayments = store.db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE rental_id = ? AND payment_type = 'RENTAL'`).get(id);
    expect(rentalPayments).toEqual({ n: 1 });
  });
});

describe('late return (pay first, team policy ₱10 per started 1.5 h)', () => {
  it('1 h late (returned at 4 h): ₱10 must be paid before the locker opens', () => {
    const id = borrowJuan();
    at(4 * HOUR);
    const result = returns.startReturn(JUAN_QR);
    expect(result).toMatchObject({ ok: true, plan: { overdueMinutes: 60, penaltyDueCentavos: 1000, next: 'PAY_PENALTY' } });
    expect(store.getRental(id)!.status).toBe(RentalStatus.OVERDUE);
    expect(returns.openReturnLocker(id)).toMatchObject({ ok: false, code: ErrorCode.UNPAID_PENALTY });
  });

  it('3 h late (returned at 6 h): ₱20', () => {
    borrowJuan();
    at(6 * HOUR);
    expect(returns.startReturn(JUAN_QR)).toMatchObject({ ok: true, plan: { penaltyDueCentavos: 2000 } });
  });

  it('paying the penalty in coins opens the locker, and the return completes', () => {
    const id = borrowJuan();
    at(4 * HOUR);
    const result = returns.startReturn(JUAN_QR);
    if (!result.ok) throw new Error(result.message);
    expect(payments.insertCoin(result.plan.sessionId, coin(5))).toMatchObject({ kind: 'credited', paidNow: false });
    expect(returns.openReturnLocker(id).ok).toBe(false); // ₱5 of ₱10 is not enough
    expect(payments.insertCoin(result.plan.sessionId, coin(5))).toMatchObject({ kind: 'credited', paidNow: true });
    expect(store.getOverduePenalty(id)).toMatchObject({ status: 'PAID', calculated_centavos: 1000, amount_paid_centavos: 1000 });

    expect(returns.openReturnLocker(id)).toMatchObject({ ok: true, lockerId: DEV_IDS.locker1 });
    expect(putBack(id)).toMatchObject({ ok: true, wasOverdue: true, overdueMinutes: 60, penaltyPaidCentavos: 1000 });
    expect(store.getRental(id)).toMatchObject({ status: RentalStatus.COMPLETED, was_overdue: 1, overdue_minutes: 60 });
  });

  it('walking away mid-payment keeps the coins as part-payment and logs it for officers', () => {
    const id = borrowJuan();
    at(4 * HOUR);
    const result = returns.startReturn(JUAN_QR);
    if (!result.ok) throw new Error(result.message);
    payments.insertCoin(result.plan.sessionId, coin(5));
    at(4 * HOUR + (DEV_SETTINGS.paymentTimeoutSeconds + 5) * 1000);
    expect(payments.expireSessions()).toEqual({ expired: 1 });

    expect(store.getOverduePenalty(id)).toMatchObject({ status: 'PARTIAL', amount_paid_centavos: 500, amount_due_centavos: 500 });
    expect(store.getRental(id)!.status).toBe(RentalStatus.OVERDUE); // calculator still out
    const followUp = store.db.prepare(`SELECT severity FROM device_events WHERE message LIKE 'Late return not completed%'`).get();
    expect(followUp).toEqual({ severity: 'WARNING' });
  });

  it('coming back later charges only the extra time since what was already paid', () => {
    const id = borrowJuan();
    at(4 * HOUR); // 60 min late → ₱10
    const first = returns.startReturn(JUAN_QR);
    if (!first.ok) throw new Error(first.message);
    payments.insertCoin(first.plan.sessionId, coin(10));
    // Leaves without returning; comes back at 5 h (120 min late → ₱20 total).
    at(5 * HOUR);
    expect(returns.startReturn(JUAN_QR)).toMatchObject({ ok: true, plan: { penaltyDueCentavos: 1000, next: 'PAY_PENALTY' } });
    expect(store.getOverduePenalty(id)).toMatchObject({ calculated_centavos: 2000, amount_paid_centavos: 1000, status: 'PARTIAL' });
  });
});

describe('verifying the returned calculator', () => {
  let id: string;
  beforeEach(() => {
    id = borrowJuan();
    at(HOUR);
    returns.startReturn(JUAN_QR);
    returns.openReturnLocker(id);
  });

  it('opens only the borrowed locker (Locker 1); Locker 2 stays locked', () => {
    const states = store.db.prepare(`SELECT locker_number, status FROM lockers ORDER BY locker_number`).all();
    expect(states).toEqual([
      { locker_number: 1, status: 'RETURNING' },
      { locker_number: 2, status: 'AVAILABLE' },
    ]);
  });

  it('correct RFID: COMPLETED, calculator and locker AVAILABLE again', () => {
    expect(putBack(id)).toMatchObject({ ok: true, wasOverdue: false });
    expect(store.getRental(id)).toMatchObject({ status: RentalStatus.COMPLETED, return_rfid_verified: 1, return_rfid_uid: DEV_RFID.calc1 });
    expect(store.db.prepare(`SELECT status FROM calculators WHERE id = ?`).get(DEV_IDS.calc1)).toEqual({ status: 'AVAILABLE' });
    expect(store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1)).toEqual({ status: 'AVAILABLE' });
  });

  it('wrong calculator: not completed, mismatch logged (Rule 10)', () => {
    expect(putBack(id, DEV_RFID.calc2)).toMatchObject({ ok: false, code: ErrorCode.RFID_MISMATCH });
    expect(store.getRental(id)!.status).toBe(RentalStatus.RETURNING);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM device_events WHERE event_type = 'RFID_MISMATCH'`).get()).toEqual({ n: 1 });
  });

  it('nothing detected (or a random object): not completed (Rule 9)', () => {
    expect(putBack(id, null)).toMatchObject({ ok: false, code: ErrorCode.RFID_NOT_DETECTED });
  });

  it('door still open: waits before completing', () => {
    expect(putBack(id, DEV_RFID.calc1, DoorState.OPEN)).toMatchObject({ ok: false, code: ErrorCode.LOCKER_CLOSE_FAILED });
    expect(putBack(id, DEV_RFID.calc1, DoorState.CLOSED).ok).toBe(true);
  });

  it('cannot be completed twice (duplicate return)', () => {
    expect(putBack(id).ok).toBe(true);
    expect(putBack(id)).toMatchObject({ ok: false, code: ErrorCode.CALCULATOR_NOT_RETURNED });
  });

  it('abandoned return goes back to ACTIVE and the locker is locked up as RENTED', () => {
    expect(returns.abandonReturn(id).ok).toBe(true);
    expect(store.getRental(id)!.status).toBe(RentalStatus.ACTIVE);
    expect(store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1)).toEqual({ status: 'RENTED' });
  });

  it('after the return the student can borrow again', () => {
    putBack(id);
    expect(rentals.startRental(JUAN_QR).ok).toBe(true);
  });
});

describe('overdue status and offline operation', () => {
  it('markOverdueRentals flips ACTIVE rentals past due to OVERDUE, once', () => {
    const id = borrowJuan();
    at(3 * HOUR + 60_000);
    expect(returns.markOverdueRentals()).toEqual({ marked: 1 });
    expect(store.getRental(id)!.status).toBe(RentalStatus.OVERDUE);
    expect(returns.markOverdueRentals()).toEqual({ marked: 0 });
  });

  it('works fully offline: returns need only the local database (Rule 11)', () => {
    // ReturnService has no network dependency at all; everything above ran without a backend.
    const id = borrowJuan();
    at(HOUR);
    returns.startReturn(JUAN_QR);
    returns.openReturnLocker(id);
    expect(putBack(id).ok).toBe(true);
    expect(store.pendingSyncCount()).toBeGreaterThan(0); // queued for Supabase when back online
  });

  it('queues the penalty for upload', () => {
    borrowJuan();
    at(4 * HOUR);
    returns.startReturn(JUAN_QR);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity = 'penalty'`).get()).toEqual({ n: 1 });
  });
});
