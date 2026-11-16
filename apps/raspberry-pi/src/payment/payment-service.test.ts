import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RentalStatus } from '@calc-rental/shared';
import { DEV_IDS, DEV_SETTINGS, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { openLocalDatabase } from '../db/sqlite';
import { RentalService } from '../rental/rental-service';
import { PaymentService } from './payment-service';

let store: KioskStore;
let rentals: RentalService;
let payments: PaymentService;
let clock: Date;

const coin = (pesos: number, eventId: string = randomUUID()) => ({ eventId, pulseCount: pesos, occurredAt: clock.toISOString() });

/** Reserves a calculator for Juan and opens the coin session. */
function startPaying() {
  const started = rentals.startRental('JUAN DELA CRUZ\t2022100001\tBSCpE');
  if (!started.ok) throw new Error(started.message);
  const session = payments.openSession(started.quote.rentalId);
  if (!session.ok) throw new Error(session.message);
  return { rentalId: started.quote.rentalId, sessionId: session.sessionId };
}

beforeEach(() => {
  store = new KioskStore(openLocalDatabase(':memory:'));
  clock = new Date('2026-10-20T02:00:00.000Z');
  seedDevData(store, { sensorsReady: true, nowIso: clock.toISOString() });
  rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now: () => clock });
  payments = new PaymentService(store, rentals, { now: () => clock });
});

describe('payment session', () => {
  it('opens one session per rental (opening twice returns the same one)', () => {
    const { rentalId, sessionId } = startPaying();
    const again = payments.openSession(rentalId);
    expect(again).toMatchObject({ ok: true, sessionId, progress: { requiredCentavos: 2000, receivedCentavos: 0 } });
  });

  it('refuses to open a session for a rental that is not waiting for payment', () => {
    expect(payments.openSession('no-such-rental').ok).toBe(false);
  });

  it('adds up coins (P5 + P5 + P10 = P20) and marks the rental PAID', () => {
    const { rentalId, sessionId } = startPaying();
    expect(payments.insertCoin(sessionId, coin(5))).toMatchObject({ kind: 'credited', progress: { receivedCentavos: 500 }, paidNow: false });
    expect(payments.insertCoin(sessionId, coin(5))).toMatchObject({ kind: 'credited', progress: { receivedCentavos: 1000 } });
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.PAYMENT_PENDING); // insufficient so far
    expect(payments.insertCoin(sessionId, coin(10))).toMatchObject({ kind: 'credited', paidNow: true, progress: { complete: true } });
    expect(store.getRental(rentalId)).toMatchObject({ status: RentalStatus.PAID, amount_paid_centavos: 2000 });
    expect(store.getPaymentBySession(sessionId)).toMatchObject({ status: 'PAID', received_centavos: 2000 });
  });

  it('accepts a single P20 coin', () => {
    const { rentalId, sessionId } = startPaying();
    expect(payments.insertCoin(sessionId, coin(20))).toMatchObject({ paidNow: true });
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.PAID);
  });

  it('records overpayment (P10 + P20 = P30 for a P20 fee)', () => {
    const { rentalId, sessionId } = startPaying();
    payments.insertCoin(sessionId, coin(10));
    expect(payments.insertCoin(sessionId, coin(20))).toMatchObject({ progress: { receivedCentavos: 3000, overpaidCentavos: 1000 } });
    expect(store.getRental(rentalId)!.amount_paid_centavos).toBe(3000);
  });
});

describe('coin safety', () => {
  it('counts a repeated coin event only once (duplicate coin event)', () => {
    const { sessionId } = startPaying();
    const same = coin(10, 'coin-event-1');
    payments.insertCoin(sessionId, same);
    expect(payments.insertCoin(sessionId, same)).toEqual({ kind: 'duplicate' });
    expect(store.getPaymentBySession(sessionId)!.received_centavos).toBe(1000);
  });

  it('ignores pulse noise and coins the settings do not accept', () => {
    const { sessionId } = startPaying();
    expect(payments.insertCoin(sessionId, coin(7))).toMatchObject({ kind: 'rejected' });
    store.saveSettings({ ...DEV_SETTINGS, acceptedCoinDenominations: [1, 5, 10] }, clock.toISOString());
    expect(payments.insertCoin(sessionId, coin(20))).toMatchObject({ kind: 'rejected' });
    expect(store.getPaymentBySession(sessionId)!.received_centavos).toBe(0);
  });

  it('locks the payment once paid: later coins are never applied to another rental (Rule 23)', () => {
    const { sessionId } = startPaying();
    payments.insertCoin(sessionId, coin(20));
    expect(payments.insertCoin(sessionId, coin(5))).toEqual({ kind: 'unattributed', valueCentavos: 500 });
    expect(store.getPaymentBySession(sessionId)!.received_centavos).toBe(2000);
    const flagged = store.db.prepare(`SELECT COUNT(*) AS n FROM device_events WHERE event_type = 'COIN_UNATTRIBUTED'`).get();
    expect(flagged).toEqual({ n: 1 });
  });

  it('records a coin inserted while idle for refund', () => {
    expect(payments.insertCoin(null, coin(10))).toEqual({ kind: 'unattributed', valueCentavos: 1000 });
    const row = store.db.prepare(`SELECT payment_id, value_centavos FROM coin_events`).get();
    expect(row).toEqual({ payment_id: null, value_centavos: 1000 });
  });

  it('applies a rental payment only once even if the session is reopened after paying', () => {
    const { rentalId, sessionId } = startPaying();
    payments.insertCoin(sessionId, coin(20));
    expect(payments.openSession(rentalId).ok).toBe(false); // rental is PAID, no new session
  });
});

describe('payment timeout', () => {
  it('cancels an unpaid session, frees the locker and flags partial coins for refund', () => {
    const { rentalId, sessionId } = startPaying();
    payments.insertCoin(sessionId, coin(5));
    clock = new Date(clock.getTime() + (DEV_SETTINGS.paymentTimeoutSeconds + 1) * 1000);

    expect(payments.expireSessions()).toEqual({ expired: 1 });
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.CANCELLED);
    expect(store.getPaymentBySession(sessionId)).toMatchObject({ status: 'CANCELLED', received_centavos: 500 });
    expect(store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1)).toEqual({ status: 'AVAILABLE' });
    const refund = store.db
      .prepare(`SELECT severity FROM device_events WHERE event_type = 'PAYMENT_TIMEOUT' AND message LIKE '%refund%'`)
      .get();
    expect(refund).toEqual({ severity: 'WARNING' });
  });

  it('does not expire a session that is still within its window', () => {
    startPaying();
    clock = new Date(clock.getTime() + 60_000);
    expect(payments.expireSessions()).toEqual({ expired: 0 });
  });

  it('a coin arriving after the timeout is not credited to the cancelled rental', () => {
    const { sessionId } = startPaying();
    clock = new Date(clock.getTime() + 10 * 60_000);
    payments.expireSessions();
    expect(payments.insertCoin(sessionId, coin(20))).toMatchObject({ kind: 'unattributed' });
  });
});

describe('sync outbox', () => {
  it('queues payments and coin events for upload', () => {
    const { sessionId } = startPaying();
    payments.insertCoin(sessionId, coin(10));
    payments.insertCoin(sessionId, coin(10));
    const counts = Object.fromEntries(
      (store.db.prepare(`SELECT entity, COUNT(*) AS n FROM sync_queue GROUP BY entity`).all() as Array<{ entity: string; n: number }>).map(
        (r) => [r.entity, r.n],
      ),
    );
    expect(counts.coin_event).toBe(2);
    expect(counts.payment).toBe(3); // opened, PARTIAL, PAID
  });
});
