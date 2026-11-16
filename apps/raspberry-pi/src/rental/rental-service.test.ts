import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, OPEN_RENTAL_STATUSES, RentalStatus } from '@calc-rental/shared';
import { DEV_IDS, DEV_RFID, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { migrations } from '../db/migrations';
import { openLocalDatabase } from '../db/sqlite';
import { RentalService } from './rental-service';

// Fake identities only.
const JUAN_QR = 'JUAN DELA CRUZ\t2022100001\tBSCpE';
const MARIA_QR = 'MARIA SANTOS\t2023100002\tBSCE';
const PEDRO_QR = 'PEDRO REYES\t2024100003\tBSIT';
const BLOCKED_QR = 'ANA GARCIA\t2022100004\tBSCpE';
const NEW_QR = 'LIZA MAE TORRES\t2026100099\tBSCpE';

let store: KioskStore;
let service: RentalService;
let clock: Date;

function setup(sensorsReady = true) {
  const db = openLocalDatabase(':memory:');
  store = new KioskStore(db);
  clock = new Date('2026-10-20T02:00:00.000Z'); // 10:00 AM in Manila
  seedDevData(store, { sensorsReady, nowIso: clock.toISOString() });
  service = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now: () => clock });
}

/** Runs a full successful borrow and returns the rental id. */
function borrow(qr: string) {
  const started = service.startRental(qr);
  if (!started.ok) throw new Error(started.message);
  const id = started.quote.rentalId;
  expect(service.markPaid(id, started.quote.feeCentavos).ok).toBe(true);
  expect(service.startDispensing(id).ok).toBe(true);
  const removed = service.confirmRemoval(id, { detectedRfidUid: null });
  if (!removed.ok) throw new Error(removed.message);
  return { id, quote: started.quote, dueAt: removed.dueAt };
}

beforeEach(() => setup());

describe('local SQLite schema', () => {
  it('migrates to the latest version', () => {
    expect(store.db.pragma('user_version', { simple: true })).toBe(migrations.at(-1)!.version);
  });

  it('uses the same open-rental status list as the shared package', () => {
    const sql = migrations.find((m) => m.version === 2)!.sql;
    for (const status of OPEN_RENTAL_STATUSES) expect(sql).toContain(`'${status}'`);
  });
});

describe('startRental — eligibility', () => {
  it('reserves a calculator for a valid student and quotes ₱20 for 3 hours', () => {
    const result = service.startRental(JUAN_QR);
    expect(result).toMatchObject({
      ok: true,
      quote: {
        student: { fullName: 'JUAN DELA CRUZ', studentNumber: '2022100001', isNew: false },
        locker: { number: 1 },
        calculator: { code: 'CALC-001' },
        feeCentavos: 2000,
        durationMinutes: 180,
      },
    });
    const rental = store.getRental(result.ok ? result.quote.rentalId : '')!;
    expect(rental.status).toBe(RentalStatus.PAYMENT_PENDING);
    expect(rental.payment_expires_at).toBe('2026-10-20T02:02:00.000Z'); // 120 s timeout
  });

  it('registers a first-time student from the QR code', () => {
    const result = service.startRental(NEW_QR);
    expect(result).toMatchObject({ ok: true, quote: { student: { isNew: true, studentNumber: '2026100099' } } });
    expect(store.findStudentByNumber('2026100099')).toMatchObject({ full_name: 'LIZA MAE TORRES', status: 'ACTIVE' });
  });

  it('rejects an invalid QR code and logs it', () => {
    expect(service.startRental('https://example.com/not-an-id')).toMatchObject({ ok: false, code: ErrorCode.INVALID_QR });
    const events = store.db.prepare(`SELECT event_type FROM device_events`).all();
    expect(events).toEqual([{ event_type: 'QR_INVALID' }]);
  });

  it('rejects a blocked student', () => {
    expect(service.startRental(BLOCKED_QR)).toMatchObject({ ok: false, code: ErrorCode.STUDENT_NOT_ALLOWED });
  });

  it('rejects a student who already has an active rental', () => {
    borrow(JUAN_QR);
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: false, code: ErrorCode.ACTIVE_RENTAL_EXISTS });
  });

  it('rejects a duplicate scan while the first one is still waiting for payment', () => {
    expect(service.startRental(JUAN_QR).ok).toBe(true);
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: false, code: ErrorCode.ACTIVE_RENTAL_EXISTS });
    const open = store.db.prepare(`SELECT COUNT(*) AS n FROM rentals WHERE student_id = ?`).get(DEV_IDS.juan) as { n: number };
    expect(open.n).toBe(1);
  });

  it('rejects a student with an unpaid penalty', () => {
    store.db
      .prepare(`INSERT INTO penalties (id, student_id, amount_due_centavos, status) VALUES ('p1', ?, 2000, 'UNPAID')`)
      .run(DEV_IDS.juan);
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: false, code: ErrorCode.UNPAID_PENALTY });
  });

  it('refuses without settings (kiosk never synced)', () => {
    store.db.prepare('DELETE FROM settings').run();
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: false, code: ErrorCode.DATABASE_UNAVAILABLE });
  });
});

describe('startRental — availability', () => {
  it('assigns lockers in order and refuses when all are taken (no payment accepted)', () => {
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: true, quote: { locker: { number: 1 } } });
    expect(service.startRental(MARIA_QR)).toMatchObject({ ok: true, quote: { locker: { number: 2 } } });
    expect(service.startRental(PEDRO_QR)).toMatchObject({ ok: false, code: ErrorCode.NO_CALCULATOR_AVAILABLE });
  });

  it('does not lend from a locker whose RFID reader does not see the calculator, and logs a mismatch', () => {
    store.setLockerSensors(DEV_IDS.locker1, { rfidState: 'NO_TAG', detectedRfidUid: null }, clock.toISOString());
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: true, quote: { locker: { number: 2 } } });
    const mismatch = store.db.prepare(`SELECT locker_id FROM device_events WHERE event_type = 'INVENTORY_MISMATCH'`).get();
    expect(mismatch).toEqual({ locker_id: DEV_IDS.locker1 });
  });

  it('lends nothing while the sensors have not reported (hardware not connected)', () => {
    setup(false);
    expect(service.startRental(JUAN_QR)).toMatchObject({ ok: false, code: ErrorCode.NO_CALCULATOR_AVAILABLE });
  });

  it('reserves the locker so a second student cannot take it', () => {
    service.startRental(JUAN_QR);
    const locker = store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1);
    expect(locker).toEqual({ status: 'RESERVED' });
  });
});

describe('payment → dispensing → removal', () => {
  it('rejects insufficient payment', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    expect(service.markPaid(started.quote.rentalId, 1500)).toMatchObject({ ok: false, code: ErrorCode.PAYMENT_INCOMPLETE });
    expect(store.getRental(started.quote.rentalId)!.status).toBe(RentalStatus.PAYMENT_PENDING);
  });

  it('cannot open the locker before payment (no bypass)', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    expect(service.startDispensing(started.quote.rentalId).ok).toBe(false);
  });

  it('applies a payment only once', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    expect(service.markPaid(started.quote.rentalId, 2000).ok).toBe(true);
    expect(service.markPaid(started.quote.rentalId, 2000).ok).toBe(false);
  });

  it('opens only one locker per payment (Rule 4)', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    service.markPaid(started.quote.rentalId, 2000);
    expect(service.startDispensing(started.quote.rentalId)).toMatchObject({ ok: true, lockerId: DEV_IDS.locker1 });
    expect(service.startDispensing(started.quote.rentalId).ok).toBe(false);
  });

  it('stays DISPENSING while the calculator is still in the locker (Rule 7)', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    service.markPaid(started.quote.rentalId, 2000);
    service.startDispensing(started.quote.rentalId);
    expect(service.confirmRemoval(started.quote.rentalId, { detectedRfidUid: DEV_RFID.calc1 })).toMatchObject({
      ok: false,
      code: ErrorCode.CALCULATOR_NOT_REMOVED,
    });
    expect(store.getRental(started.quote.rentalId)!.status).toBe(RentalStatus.DISPENSING);
  });

  it('becomes ACTIVE after removal, due 3 hours later, and updates calculator + locker', () => {
    const { id, dueAt } = borrow(JUAN_QR);
    expect(dueAt).toBe('2026-10-20T05:00:00.000Z'); // 1:00 PM Manila
    expect(store.getRental(id)).toMatchObject({
      status: RentalStatus.ACTIVE,
      rented_at: '2026-10-20T02:00:00.000Z',
      rental_rfid_verified: 1,
      amount_paid_centavos: 2000,
    });
    expect(store.db.prepare(`SELECT status FROM calculators WHERE id = ?`).get(DEV_IDS.calc1)).toEqual({ status: 'RENTED' });
    expect(store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1)).toEqual({ status: 'RENTED' });
  });

  it('records a failed dispense for officer follow-up and frees the locker', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    service.markPaid(started.quote.rentalId, 2000);
    service.startDispensing(started.quote.rentalId);
    expect(service.failDispensing(started.quote.rentalId, 'CALCULATOR_NOT_REMOVED').ok).toBe(true);
    expect(store.getRental(started.quote.rentalId)!.status).toBe(RentalStatus.FAILED);
    expect(store.db.prepare(`SELECT status FROM lockers WHERE id = ?`).get(DEV_IDS.locker1)).toEqual({ status: 'AVAILABLE' });
  });
});

describe('cancellation', () => {
  it('cancels an unpaid reservation and frees the locker for the next student', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    expect(service.cancelRental(started.quote.rentalId, 'PAYMENT_TIMEOUT').ok).toBe(true);
    expect(service.startRental(MARIA_QR)).toMatchObject({ ok: true, quote: { locker: { number: 1 } } });
  });

  it('cannot cancel a paid rental (the student is owed a calculator)', () => {
    const started = service.startRental(JUAN_QR);
    if (!started.ok) throw new Error();
    service.markPaid(started.quote.rentalId, 2000);
    expect(service.cancelRental(started.quote.rentalId, 'CANCELLED_AT_KIOSK').ok).toBe(false);
  });
});

describe('sync outbox', () => {
  it('queues every change for upload to Supabase', () => {
    borrow(NEW_QR);
    const entities = store.db
      .prepare(`SELECT entity, COUNT(*) AS n FROM sync_queue GROUP BY entity ORDER BY entity`)
      .all() as Array<{ entity: string; n: number }>;
    const byEntity = Object.fromEntries(entities.map((e) => [e.entity, e.n]));
    expect(byEntity.student).toBeGreaterThanOrEqual(1); // new student registered
    expect(byEntity.rental).toBe(4); // PAYMENT_PENDING, PAID, DISPENSING, ACTIVE
    expect(byEntity.device_event).toBeGreaterThanOrEqual(3); // QR_SCANNED, UNLOCK_REQUESTED, RENTAL_STARTED
    expect(store.pendingSyncCount()).toBeGreaterThan(0);
  });

  it('keeps nothing half-saved when a step is refused', () => {
    const before = store.pendingSyncCount();
    service.startRental(BLOCKED_QR);
    const rentals = store.db.prepare(`SELECT COUNT(*) AS n FROM rentals`).get() as { n: number };
    expect(rentals.n).toBe(0);
    expect(store.pendingSyncCount()).toBeGreaterThan(before); // only the QR_SCANNED event
  });
});
