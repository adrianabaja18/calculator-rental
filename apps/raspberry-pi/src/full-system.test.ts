import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_IDS, DEV_RFID, DEV_STUDENT_QR, seedDevData } from './db/dev-seed';
import { KioskStore } from './db/kiosk-store';
import { openLocalDatabase } from './db/sqlite';
import { createMockHardware, type MockHardware } from './hardware/mock';
import { KioskController } from './kiosk/kiosk-controller';
import { KioskState } from './kiosk/kiosk-states';
import { PaymentService } from './payment/payment-service';
import { RentalService } from './rental/rental-service';
import { ReturnService } from './rental/return-service';
import { SyncService } from './sync/sync-service';
import { pgTransport, startTestSupabase } from './sync/test-supabase';

/**
 * Phase 14 system tests: the WHOLE system except physical pins and the
 * network — kiosk state machine + services + SQLite + simulated hardware +
 * SyncService + the REAL Supabase migrations (PGlite). Each scenario is
 * what officers would check on the dashboard afterwards.
 */

const SECOND = 1000;
const HOUR = 3600 * SECOND;

let pg: PGlite;
let store: KioskStore;
let hw: MockHardware;
let kiosk: KioskController;
let sync: SyncService;
let net: ReturnType<typeof pgTransport>;
let clock: Date;

beforeAll(async () => {
  pg = await startTestSupabase();
}, 120_000);
afterAll(async () => {
  await pg?.close();
});

function buildKiosk() {
  const now = () => clock;
  const rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now });
  const payments = new PaymentService(store, rentals, { now });
  const returns = new ReturnService(store, payments, { now });
  kiosk = new KioskController(store, hw, { rentals, payments, returns }, { now, messageMs: 3 * SECOND });
  sync = new SyncService(store, net, { now });
  sync.onCommand(async (cmd) => {
    const r = await kiosk.handleOfficerUnlock(String(cmd.payload.lockerId), { commandId: cmd.id });
    return { status: r.ok ? 'DONE' : 'FAILED', message: r.message };
  });
}

beforeEach(async () => {
  await pg.exec('begin');
  clock = new Date('2026-10-20T02:00:00.000Z'); // Tue 10:00 AM Manila
  store = new KioskStore(openLocalDatabase(':memory:'));
  seedDevData(store, { sensorsReady: false, nowIso: clock.toISOString() });
  hw = createMockHardware();
  hw.rfid.place(1, DEV_RFID.calc1);
  hw.rfid.place(2, DEV_RFID.calc2);
  net = pgTransport(pg);
  buildKiosk();
  await kiosk.start();
  return async () => {
    await pg.exec('rollback');
  };
});

const advance = async (ms: number) => {
  clock = new Date(clock.getTime() + ms);
  await kiosk.tick();
};
const coin = (pesos: number) => kiosk.handleCoin({ eventId: crypto.randomUUID(), pulseCount: pesos, occurredAt: clock.toISOString() });
const lcd = () => hw.display.current.map((l) => l.trimEnd());
const one = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0]!;

async function borrow(qr: string, locker: 1 | 2) {
  await kiosk.handleScan(qr);
  await kiosk.handleButton('select', locker);
  await coin(20);
  hw.rfid.place(locker, null);
  await advance(SECOND);
  await kiosk.handleButton('close', locker);
  await advance(4 * SECOND);
}

describe('a day at the kiosk, as the dashboard sees it', () => {
  it('rentals made while offline reach Supabase once the network is back; a late return settles the penalty', async () => {
    net.online = false;
    await borrow(DEV_STUDENT_QR.juan, 1);
    await borrow(DEV_STUDENT_QR.maria, 2);
    expect(await sync.push()).toMatchObject({ ok: false });
    expect(store.pendingSyncCount()).toBeGreaterThan(10);

    net.online = true;
    expect(await sync.push()).toMatchObject({ ok: true });
    expect(store.pendingSyncCount()).toBe(0);
    expect(await one(`select rented_calculators, available_calculators from public.v_dashboard_summary`)).toEqual({
      rented_calculators: 2,
      available_calculators: 0,
    });

    // Juan comes back 4 hours later: 1 h late → ₱10, paid at the kiosk before the locker opens.
    await advance(4 * HOUR);
    await kiosk.handleScan(DEV_STUDENT_QR.juan);
    expect(lcd()).toEqual(['LATE 1H00M', 'PAY PENALTY P10']);
    await coin(10);
    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(SECOND);
    await kiosk.handleButton('close', 1);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
    await sync.push();

    expect(
      await one(`select r.status, r.was_overdue, p.status as penalty, p.amount_paid::float as paid
                 from public.rental_transactions r join public.penalties p on p.rental_transaction_id = r.id
                 where r.student_id = $1`, [DEV_IDS.juan]),
    ).toEqual({ status: 'COMPLETED', was_overdue: true, penalty: 'PAID', paid: 10 });
    expect(await one(`select income_today::float as income from public.v_dashboard_summary`)).toMatchObject({ income: expect.any(Number) });
    expect(await one(`select status from public.calculators where id = $1`, [DEV_IDS.calc1])).toEqual({ status: 'AVAILABLE' });
  });

  it('a power cut after payment: the rental is marked FAILED for an officer refund, and the dashboard shows it', async () => {
    await kiosk.handleScan(DEV_STUDENT_QR.juan);
    await kiosk.handleButton('select', 1);
    await coin(20); // paid; the locker is open, then the power goes out

    buildKiosk(); // the kiosk boots again on the same SQLite database
    await kiosk.start();
    await sync.push();

    expect(
      await one(`select status, amount_paid::float as paid from public.rental_transactions where student_id = $1`, [DEV_IDS.juan]),
    ).toEqual({ status: 'FAILED', paid: 20 });
  });
});

describe('officer actions reach the kiosk', () => {
  it('a student blocked on the dashboard is refused at the kiosk after the next pull', async () => {
    await pg.query(`update public.students set status = 'BLOCKED', blocked_reason = 'Lost a calculator' where id = $1`, [DEV_IDS.pedro]);
    await sync.pull();
    await kiosk.handleScan(DEV_STUDENT_QR.pedro);
    expect(lcd()).toEqual(['ACCOUNT BLOCKED', 'SEE AN OFFICER']);
  });

  it('locker maintenance shows on the LCD and the kiosk will not lend from it', async () => {
    await pg.query(`update public.lockers set status = 'MAINTENANCE' where id = $1`, [DEV_IDS.locker2]);
    await sync.pull();
    await advance(SECOND);
    expect(lcd()).toEqual(['SCAN STUDENT ID', '1:READY 2:N/A']);
  });

  it('a new rental price set on the dashboard is what the next student pays', async () => {
    await pg.query(`update public.system_settings set rental_fee = 25 where id = 1`);
    await sync.pull();
    await kiosk.handleScan(DEV_STUDENT_QR.carlo);
    await kiosk.handleButton('select', 1);
    expect(lcd()).toEqual(['CARLO MENDOZA', 'P25 / 3 HOURS']);
  });

  it('emergency unlock: requested on the dashboard, done at the kiosk, result back on the dashboard', async () => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into public.device_commands (device_id, command, payload, reason)
       values ('00000000-0000-4000-8000-000000000001', 'UNLOCK_LOCKER', $1, 'test') returning id`,
      [JSON.stringify({ lockerId: DEV_IDS.locker1 })],
    );
    await sync.push();
    expect(kiosk.state).toBe(KioskState.OFFICER_UNLOCK);
    expect([...hw.lockers.open]).toEqual([1]);
    expect(await one(`select status from public.device_commands where id = $1`, [rows[0]!.id])).toEqual({ status: 'DONE' });
    await advance(11 * SECOND);
    expect(hw.lockers.open.size).toBe(0);
  });

  it("a penalty waived on the dashboard clears the student's unpaid balance on the kiosk", async () => {
    // Juan is late, sees the penalty and walks away without paying.
    await borrow(DEV_STUDENT_QR.juan, 1);
    await advance(4 * HOUR);
    await kiosk.handleScan(DEV_STUDENT_QR.juan);
    await advance(200 * SECOND); // penalty payment times out
    hw.rfid.place(1, DEV_RFID.calc1); // an officer collects the calculator by hand…
    await sync.push();

    const officer = crypto.randomUUID();
    await pg.query(`insert into auth.users (id, email) values ($1, 'officer@example.test')`, [officer]);
    await pg.query(
      `update public.penalties set waived_amount = calculated_amount - amount_paid, waived_by = $1, waive_reason = 'test', status = 'WAIVED'
       where student_id = $2`,
      [officer, DEV_IDS.juan],
    );
    await sync.pull();
    expect(store.getUnpaidPenaltyCentavos(DEV_IDS.juan)).toBe(0);
  });
});
