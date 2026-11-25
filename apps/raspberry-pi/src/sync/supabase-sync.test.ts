import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DoorState, type SyncItem } from '@calc-rental/shared';
import { DEV_IDS, DEV_RFID, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { openLocalDatabase } from '../db/sqlite';
import { PaymentService } from '../payment/payment-service';
import { RentalService } from '../rental/rental-service';
import { ReturnService } from '../rental/return-service';

/**
 * End-to-end sync test: REAL kiosk flows on SQLite produce the outbox, and the
 * outbox is applied by the REAL Supabase migrations running in PGlite
 * (Postgres in-process). Proves the two schemas, the payload mapping and the
 * ownership rules fit together — no network, no Supabase project needed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const supabaseDir = path.resolve(here, '../../../../supabase');
const DEVICE = '00000000-0000-4000-8000-000000000001';
const JUAN_QR = 'JUAN DELA CRUZ\t2022100001\tBSCpE';
const HOUR = 3_600_000;

let pg: PGlite;
let store: KioskStore;
let rentals: RentalService;
let payments: PaymentService;
let returns: ReturnService;
let clock: Date;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(supabaseDir, 'tests/supabase-stubs.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(supabaseDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(supabaseDir, 'migrations', file), 'utf8'));
  }
  await pg.exec(fs.readFileSync(path.join(supabaseDir, 'seed.sql'), 'utf8'));
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec('begin'); // every test starts from the seed and is rolled back
  store = new KioskStore(openLocalDatabase(':memory:'));
  clock = new Date('2026-10-20T02:00:00.000Z');
  seedDevData(store, { sensorsReady: true, nowIso: clock.toISOString() });
  rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now: () => clock });
  payments = new PaymentService(store, rentals, { now: () => clock });
  returns = new ReturnService(store, payments, { now: () => clock });
  return async () => {
    await pg.exec('rollback');
  };
});

const coin = (pesos: number) => ({ eventId: randomUUID(), pulseCount: pesos, occurredAt: clock.toISOString() });

function outbox(): SyncItem[] {
  return store.nextSyncBatch(10_000, '9999-12-31').map((b) => ({ seq: b.seq, entity: b.entity, payload: JSON.parse(b.payload) }));
}

async function applyToSupabase(items: SyncItem[]) {
  const result = await pg.query<{ r: { appliedThroughSeq: number | null; applied: number; failure: { seq: number; message: string } | null } }>(
    'select public.apply_kiosk_sync($1, $2::jsonb) as r',
    [DEVICE, JSON.stringify(items)],
  );
  return result.rows[0]!.r;
}

const one = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;

/** Juan borrows CALC-001, comes back 4 h later (1 h late), pays the ₱10 penalty and returns it. */
function borrowAndReturnLate() {
  const started = rentals.startRental(JUAN_QR, 1);
  if (!started.ok) throw new Error(started.message);
  const id = started.quote.rentalId;
  const { sessionId } = payments.openSession(id) as { sessionId: string };
  payments.insertCoin(sessionId, coin(20));
  rentals.startDispensing(id);
  rentals.confirmRemoval(id, { detectedRfidUid: null });

  clock = new Date(clock.getTime() + 4 * HOUR);
  const plan = returns.startReturn(JUAN_QR);
  if (!plan.ok) throw new Error(plan.message);
  payments.insertCoin(plan.plan.sessionId!, coin(10));
  returns.openReturnLocker(id);
  const done = returns.verifyReturn(id, { detectedRfidUid: DEV_RFID.calc1, doorState: DoorState.CLOSED });
  if (!done.ok) throw new Error(done.message);
  return id;
}

describe('kiosk outbox → Supabase (apply_kiosk_sync)', () => {
  it('applies a whole late rental with its penalty, coins and events, in order', async () => {
    const id = borrowAndReturnLate();
    payments.insertCoin(null, coin(5)); // a stray coin while idle
    const items = outbox();

    const result = await applyToSupabase(items);
    expect(result.failure).toBeNull();
    expect(result.appliedThroughSeq).toBe(items.at(-1)!.seq);

    expect(
      await one(`select status, rental_fee::float as fee, amount_paid::float as paid, was_overdue, return_rfid_verified, device_id
                 from public.rental_transactions where id = $1`, [id]),
    ).toEqual({ status: 'COMPLETED', fee: 20, paid: 20, was_overdue: true, return_rfid_verified: true, device_id: DEVICE });
    expect(
      await one(`select calculated_amount::float as calc, amount_paid::float as paid, status from public.penalties where rental_transaction_id = $1`, [id]),
    ).toEqual({ calc: 10, paid: 10, status: 'PAID' });
    expect(await one(`select count(*)::int as n from public.payments where student_id = $1 and status = 'PAID'`, [DEV_IDS.juan])).toEqual({ n: 2 });
    expect(await one(`select count(*)::int as n, count(*) filter (where payment_id is null)::int as stray from public.coin_events`)).toEqual({ n: 3, stray: 1 });
    expect((await one<{ n: number }>(`select count(*)::int as n from public.device_events where transaction_id = $1`, [id])).n).toBeGreaterThan(3);
    expect(await one(`select status from public.lockers where id = $1`, [DEV_IDS.locker1])).toEqual({ status: 'AVAILABLE' });
    expect(await one(`select status from public.calculators where id = $1`, [DEV_IDS.calc1])).toEqual({ status: 'AVAILABLE' });
    expect((await one<{ t: string | null }>(`select last_transaction_at as t from public.students where id = $1`, [DEV_IDS.juan])).t).not.toBeNull();
  });

  it('is idempotent: re-sending the same items changes nothing and creates no duplicates', async () => {
    borrowAndReturnLate();
    const items = outbox();
    await applyToSupabase(items);
    const before = await one(`select (select count(*) from public.coin_events)::int as coins, (select count(*) from public.device_events)::int as events`);
    expect((await applyToSupabase(items)).failure).toBeNull();
    expect(await one(`select (select count(*) from public.coin_events)::int as coins, (select count(*) from public.device_events)::int as events`)).toEqual(before);
  });

  it('a mid-rental snapshot shows the calculator out (RENTED) on the dashboard', async () => {
    const started = rentals.startRental(JUAN_QR, 2);
    if (!started.ok) throw new Error(started.message);
    const { sessionId } = payments.openSession(started.quote.rentalId) as { sessionId: string };
    payments.insertCoin(sessionId, coin(20));
    rentals.startDispensing(started.quote.rentalId);
    rentals.confirmRemoval(started.quote.rentalId, { detectedRfidUid: null });

    expect((await applyToSupabase(outbox())).failure).toBeNull();
    expect(await one(`select status from public.rental_transactions where id = $1`, [started.quote.rentalId])).toEqual({ status: 'ACTIVE' });
    expect(await one(`select status from public.calculators where id = $1`, [DEV_IDS.calc2])).toEqual({ status: 'RENTED' });
    expect(await one(`select status from public.lockers where id = $1`, [DEV_IDS.locker2])).toEqual({ status: 'RENTED' });
  });

  it("officer maintenance is not undone by the kiosk's AVAILABLE", async () => {
    await pg.query(`update public.lockers set status = 'MAINTENANCE' where id = $1`, [DEV_IDS.locker2]);
    store.setLockerStatus(DEV_IDS.locker2, 'AVAILABLE', clock.toISOString());
    expect((await applyToSupabase(outbox())).failure).toBeNull();
    expect(await one(`select status from public.lockers where id = $1`, [DEV_IDS.locker2])).toEqual({ status: 'MAINTENANCE' });
  });

  it("an officer's penalty waiver survives later kiosk updates of that penalty", async () => {
    // Juan is 1 h late but walks away without paying: the ₱10 penalty is quoted, unpaid.
    const started = rentals.startRental(JUAN_QR, 1);
    if (!started.ok) throw new Error(started.message);
    const { sessionId } = payments.openSession(started.quote.rentalId) as { sessionId: string };
    payments.insertCoin(sessionId, coin(20));
    rentals.startDispensing(started.quote.rentalId);
    rentals.confirmRemoval(started.quote.rentalId, { detectedRfidUid: null });
    clock = new Date(clock.getTime() + 4 * HOUR);
    const plan = returns.startReturn(JUAN_QR);
    if (!plan.ok) throw new Error(plan.message);
    expect((await applyToSupabase(outbox())).failure).toBeNull();
    store.markSynced(Number.MAX_SAFE_INTEGER, clock.toISOString());

    const officer = randomUUID();
    await pg.query(`insert into auth.users (id, email) values ($1, 'officer@example.test')`, [officer]);
    await pg.query(
      `update public.penalties set waived_amount = 10, waived_by = $1, waive_reason = 'test', status = 'WAIVED' where id = $2`,
      [officer, plan.plan.penaltyId],
    );

    // The kiosk re-quotes the same penalty (Juan scans again) and pushes it.
    clock = new Date(clock.getTime() + 10 * 60_000);
    returns.startReturn(JUAN_QR);
    expect((await applyToSupabase(outbox())).failure).toBeNull();
    expect(
      await one(`select waived_amount::float as waived, status from public.penalties where id = $1`, [plan.plan.penaltyId]),
    ).toEqual({ waived: 10, status: 'WAIVED' });
  });

  it('stops at the first item Supabase refuses and reports it; earlier items stay applied', async () => {
    store.recordEvent({ type: 'SYSTEM_ERROR', severity: 'INFO', message: 'before', occurredAt: clock.toISOString() });
    store.enqueue('locker_state', 'nope', { id: randomUUID(), status: 'AVAILABLE' }); // not this kiosk's locker
    store.recordEvent({ type: 'SYSTEM_ERROR', severity: 'INFO', message: 'after', occurredAt: clock.toISOString() });
    const items = outbox();

    const result = await applyToSupabase(items);
    expect(result.appliedThroughSeq).toBe(items[0]!.seq);
    expect(result.failure).toMatchObject({ seq: items[1]!.seq, message: expect.stringMatching(/does not belong/) });
    expect(await one(`select count(*)::int as n from public.device_events where message in ('before', 'after')`)).toEqual({ n: 1 });
  });
});
