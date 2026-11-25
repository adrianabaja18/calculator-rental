import { beforeEach, describe, expect, it } from 'vitest';
import { DoorState, RentalStatus } from '@calc-rental/shared';
import { DEV_RFID, DEV_SETTINGS, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { openLocalDatabase } from '../db/sqlite';
import { createMockHardware, type MockHardware } from '../hardware/mock';
import { PaymentService } from '../payment/payment-service';
import { RentalService } from '../rental/rental-service';
import { ReturnService } from '../rental/return-service';
import { KioskController } from './kiosk-controller';
import { KioskState, canMove } from './kiosk-states';

// Fake identities only.
const JUAN = 'JUAN DELA CRUZ\t2022100001\tBSCpE';
const ANA_BLOCKED = 'ANA GARCIA\t2022100004\tBSCpE';
const SECOND = 1000;
const HOUR = 3600 * SECOND;

let store: KioskStore;
let hw: MockHardware;
let kiosk: KioskController;
let clock: Date;

const lcd = () => hw.display.current.map((l) => l.trimEnd());
const advance = async (ms: number) => {
  clock = new Date(clock.getTime() + ms);
  await kiosk.tick();
};
const blue = (locker: number) => kiosk.handleButton('select', locker);
const red = (locker: number) => kiosk.handleButton('close', locker);
const coin = (pesos: number, id = `c${pesos}-${Math.random()}`) =>
  kiosk.handleCoin({ eventId: id, pulseCount: pesos, occurredAt: clock.toISOString() });
const rentalStatus = () => (store.db.prepare(`SELECT status FROM rentals`).get() as { status: string } | undefined)?.status;

async function boot(options: { clockSynced?: boolean } = {}) {
  store = new KioskStore(openLocalDatabase(':memory:'));
  clock = new Date('2026-10-20T02:00:00.000Z'); // 10:00 AM Manila
  seedDevData(store, { sensorsReady: false, nowIso: clock.toISOString() });
  hw = createMockHardware();
  hw.clock.synced = options.clockSynced ?? true;
  hw.rfid.place(1, DEV_RFID.calc1); // both calculators physically in their lockers
  hw.rfid.place(2, DEV_RFID.calc2);
  const now = () => clock;
  const rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now });
  const payments = new PaymentService(store, rentals, { now });
  const returns = new ReturnService(store, payments, { now });
  kiosk = new KioskController(store, hw, { rentals, payments, returns }, { now, messageMs: 3 * SECOND });
  await kiosk.start(); // no tick: the first scan must already see the calculators
}

/** Full borrow by Juan: scan → blue 1 → P20 → take calculator → red 1. */
async function borrow() {
  await kiosk.handleScan(JUAN);
  await blue(1);
  await coin(20);
  hw.rfid.place(1, null);
  await advance(SECOND);
  await red(1);
  const rentalId = (store.db.prepare(`SELECT id FROM rentals WHERE status = 'ACTIVE'`).get() as { id: string }).id;
  await advance(3 * SECOND); // success message times out
  return rentalId;
}

beforeEach(() => boot());

describe('state machine rules', () => {
  it('never allows skipping the locker choice or payment', () => {
    expect(canMove(KioskState.SYSTEM_READY, KioskState.OPENING_LOCKER)).toBe(false);
    expect(canMove(KioskState.VALIDATING_STUDENT, KioskState.WAITING_FOR_PAYMENT)).toBe(false);
    expect(canMove(KioskState.WAITING_FOR_PAYMENT, KioskState.WAITING_FOR_REMOVAL)).toBe(false);
    expect(canMove(KioskState.WAITING_FOR_REMOVAL, KioskState.RENTAL_ACTIVE)).toBe(false); // red button first
    expect(canMove(KioskState.SYSTEM_READY, KioskState.ERROR)).toBe(true);
  });

  it('boots to the scan screen showing both lockers, coin acceptor off', () => {
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    expect(lcd()).toEqual(['SCAN STUDENT ID', '1:READY 2:READY']);
    expect(hw.coins.enabled).toBe(false);
  });

  it('keeps the idle locker status up to date', async () => {
    hw.rfid.place(2, null); // calculator 2 missing
    await advance(SECOND);
    expect(lcd()).toEqual(['SCAN STUDENT ID', '1:READY 2:N/A']);
  });

  it('waits for the clock to sync before serving students (no RTC)', async () => {
    await boot({ clockSynced: false });
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_CLOCK);
    expect(lcd()).toEqual(['PLEASE WAIT', 'SYNCING CLOCK']);
    await kiosk.handleScan(JUAN);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_CLOCK); // scans ignored
    hw.clock.synced = true;
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('records the RFID readers in SQLite so lockers become lendable', () => {
    const lockers = store.db.prepare(`SELECT rfid_state, lock_state FROM lockers ORDER BY locker_number`).all();
    expect(lockers).toEqual([
      { rfid_state: 'EXPECTED_TAG', lock_state: 'LOCKED' },
      { rfid_state: 'EXPECTED_TAG', lock_state: 'LOCKED' },
    ]);
  });
});

describe('borrowing (spec §5, blue/red buttons)', () => {
  it('runs the whole flow: scan → blue → pay → locker open → take → red → RENTAL SUCCESS', async () => {
    await kiosk.handleScan(JUAN);
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
    expect(lcd()).toEqual(['PUSH BLUE BUTTON', '1:READY 2:READY']);
    expect(hw.coins.enabled).toBe(false);

    await blue(2);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PAYMENT);
    expect(lcd()).toEqual(['JUAN DELA CRUZ', 'P20 / 3 HOURS']);
    expect(hw.coins.enabled).toBe(true);

    await coin(10);
    expect(lcd()).toEqual(['PAYMENT P10/P20', 'INSERT COINS']);
    await coin(10);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_REMOVAL);
    expect(hw.coins.enabled).toBe(false);
    expect(hw.lockers.unlocks).toEqual([{ channel: 2, maxMs: DEV_SETTINGS.removalTimeoutSeconds * SECOND }]); // only Locker 2
    expect([...hw.lockers.open]).toEqual([2]);
    expect(lcd()).toEqual(['LOCKER 2 OPEN', 'TAKE CALCULATOR']);

    await red(2); // calculator still inside: stays open
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_REMOVAL);
    expect([...hw.lockers.open]).toEqual([2]);

    hw.rfid.place(2, null); // student takes it
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_DOOR_CLOSE);
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'PUSH RED BUTTON']);
    expect(rentalStatus()).toBe('ACTIVE'); // the calculator is out

    await red(1); // the other locker's button does nothing
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_DOOR_CLOSE);

    await red(2);
    expect(kiosk.state).toBe(KioskState.RENTAL_ACTIVE);
    expect(hw.lockers.open.size).toBe(0); // locked
    expect(lcd()).toEqual(['RENTAL SUCCESS', 'DUE AT 01:00 PM']);

    await advance(3 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    expect(lcd()).toEqual(['SCAN STUDENT ID', '1:READY 2:N/A']);
  });

  it('a blue button on an empty locker is refused; the student picks the other one', async () => {
    hw.rfid.place(2, null);
    await advance(SECOND);
    await kiosk.handleScan(JUAN);
    expect(lcd()).toEqual(['PUSH BLUE BUTTON', '1:READY 2:N/A']);
    await blue(2);
    expect(lcd()).toEqual(['LOCKER 2 N/A', '1:READY 2:N/A']);
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
    expect(rentalStatus()).toBeUndefined();
    await blue(1);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PAYMENT);
  });

  it('gives up if no locker is picked', async () => {
    await kiosk.handleScan(JUAN);
    await advance(31 * SECOND);
    expect(lcd()).toEqual(['NO LOCKER PICKED', 'PLEASE TRY AGAIN']);
    expect(rentalStatus()).toBeUndefined();
    await advance(3 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('refuses a blocked student before the locker choice', async () => {
    await kiosk.handleScan(ANA_BLOCKED);
    expect(lcd()).toEqual(['ACCOUNT BLOCKED', 'SEE AN OFFICER']);
    expect(hw.buzzer.beeps).toContain('error');
    await advance(3 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('refuses when no calculator is physically present, without taking payment', async () => {
    hw.rfid.place(1, null);
    hw.rfid.place(2, null);
    await kiosk.tick();
    await kiosk.handleScan(JUAN);
    expect(lcd()).toEqual(['NO CALCULATOR', 'AVAILABLE']);
    expect(hw.coins.enabled).toBe(false);
  });

  it('ignores a second scan and extra blue presses while busy', async () => {
    await kiosk.handleScan(JUAN);
    await kiosk.handleScan(JUAN);
    await blue(1);
    await blue(2);
    expect(store.db.prepare(`SELECT COUNT(*) AS n FROM rentals`).get()).toEqual({ n: 1 });
  });

  it('cancels after the payment timeout and frees the locker', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await advance((DEV_SETTINGS.paymentTimeoutSeconds + 1) * SECOND);
    expect(lcd()).toEqual(['PAYMENT TIMEOUT', 'PLEASE TRY AGAIN']);
    expect(hw.coins.enabled).toBe(false);
    expect(rentalStatus()).toBe('CANCELLED');
  });

  it('fails safely and locks if the calculator is never taken', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    await advance((DEV_SETTINGS.removalTimeoutSeconds + 1) * SECOND);
    expect(lcd()).toEqual(['NOT TAKEN', 'SEE AN OFFICER']);
    expect(rentalStatus()).toBe('FAILED');
    expect(hw.lockers.open.size).toBe(0);
  });

  it('red button never pressed: locks at the timeout, reported, rental stays active', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    hw.rfid.place(1, null);
    await advance(SECOND);
    await advance(DEV_SETTINGS.removalTimeoutSeconds * SECOND);
    expect(lcd()).toEqual(['DOOR LEFT OPEN', 'SEE AN OFFICER']);
    expect(rentalStatus()).toBe('ACTIVE');
    expect(hw.lockers.open.size).toBe(0);
    await advance(3 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('with an optional door sensor: the red button only counts once the door is shut', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    hw.lockers.setDoor(1, DoorState.OPEN);
    hw.rfid.place(1, null);
    await advance(SECOND);
    await red(1);
    expect(lcd()).toEqual(['PLEASE CLOSE', 'THE LOCKER DOOR']);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_DOOR_CLOSE);
    hw.lockers.setDoor(1, DoorState.CLOSED);
    await red(1);
    expect(kiosk.state).toBe(KioskState.RENTAL_ACTIVE);
  });

  it('records a coin inserted while idle for refund', async () => {
    await coin(5, 'stray');
    expect(store.db.prepare(`SELECT payment_id FROM coin_events`).get()).toEqual({ payment_id: null });
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });
});

describe('returning (spec §6, red button)', () => {
  it('on time: opens only the borrowed locker, then completes on the red button', async () => {
    const rentalId = await borrow();
    hw.lockers.unlocks.length = 0;
    await advance(HOUR);

    await kiosk.handleScan(JUAN);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect(hw.lockers.unlocks).toEqual([{ channel: 1, maxMs: DEV_SETTINGS.returnTimeoutSeconds * SECOND }]);
    expect(lcd()).toEqual(['RETURN CALC #1', 'TO LOCKER 1']);

    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(SECOND);
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'PUSH RED BUTTON']);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);

    await red(1);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
    expect(lcd()).toEqual(['RETURN SUCCESS', 'THANK YOU']);
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.COMPLETED);
    expect(hw.lockers.open.size).toBe(0);
  });

  it('red button with nothing inside: refused, locker stays unlocked', async () => {
    await borrow();
    await kiosk.handleScan(JUAN);
    await red(1);
    expect(lcd()).toEqual(['CALCULATOR', 'NOT DETECTED']);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect([...hw.lockers.open]).toEqual([1]);
  });

  it('late: asks for the penalty first, then opens the locker', async () => {
    await borrow();
    await advance(4 * HOUR); // 1 h late
    await kiosk.handleScan(JUAN);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PENALTY_PAYMENT);
    expect(lcd()).toEqual(['LATE 1H00M', 'PAY PENALTY P10']);
    hw.lockers.unlocks.length = 0;

    await coin(10);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect(hw.lockers.unlocks).toHaveLength(1);

    hw.rfid.place(1, DEV_RFID.calc1);
    await red(1);
    expect(lcd()).toEqual(['RETURN SUCCESS', 'PENALTY: P10']);
  });

  it('late and not paying: return cancelled, calculator still out', async () => {
    const rentalId = await borrow();
    await advance(4 * HOUR);
    await kiosk.handleScan(JUAN);
    await advance((DEV_SETTINGS.paymentTimeoutSeconds + 1) * SECOND);
    expect(lcd()).toEqual(['RETURN CANCELLED', 'PENALTY NOT PAID']);
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.OVERDUE);
  });

  it('wrong calculator: refused with the locker still open, then accepts the right one', async () => {
    await borrow();
    hw.rfid.place(2, null); // pretend CALC-002 is in the student's hands instead
    await advance(HOUR);
    await kiosk.handleScan(JUAN);

    hw.rfid.place(1, DEV_RFID.calc2);
    await advance(SECOND);
    expect(lcd()).toEqual(['WRONG CALCULATOR', 'RETURN CALC #1']);
    await red(1);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect([...hw.lockers.open]).toEqual([1]); // never locked on the wrong one

    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(4 * SECOND); // the refusal message times out, live hint returns
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'PUSH RED BUTTON']);
    await red(1);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
  });

  it('right calculator back but red never pressed: completes at the timeout instead of cancelling', async () => {
    const rentalId = await borrow();
    await kiosk.handleScan(JUAN);
    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(SECOND);
    await advance(DEV_SETTINGS.returnTimeoutSeconds * SECOND);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
    expect(lcd()).toEqual(['DOOR LEFT OPEN', 'SEE AN OFFICER']);
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.COMPLETED);
    expect(hw.lockers.open.size).toBe(0);
  });

  it('gives up after the return timeout, locks, and keeps the rental open', async () => {
    const rentalId = await borrow();
    await kiosk.handleScan(JUAN);
    await advance((DEV_SETTINGS.returnTimeoutSeconds + 1) * SECOND);
    expect(lcd()).toEqual(['RETURN CANCELLED', 'NOT RETURNED']);
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.ACTIVE);
    expect(hw.lockers.open.size).toBe(0);
  });
});

describe('restart recovery', () => {
  /** Simulates a power cut: a brand-new kiosk process on the same SQLite database. */
  async function restart() {
    const now = () => clock;
    const rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now });
    const payments = new PaymentService(store, rentals, { now });
    const returns = new ReturnService(store, payments, { now });
    kiosk = new KioskController(store, hw, { rentals, payments, returns }, { now, messageMs: 3 * SECOND });
    await kiosk.start();
  }

  it('frees a reservation left waiting for payment', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await restart();
    expect(rentalStatus()).toBe('CANCELLED');
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    await kiosk.handleScan(JUAN); // Juan can start again right away
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
  });

  it('marks a paid-but-not-handed-out rental FAILED for an officer refund', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    await restart();
    expect(store.db.prepare(`SELECT status, amount_paid_centavos FROM rentals`).get()).toEqual({
      status: 'FAILED',
      amount_paid_centavos: 2000,
    });
  });

  it('puts an interrupted return back to ACTIVE', async () => {
    const rentalId = await borrow();
    await kiosk.handleScan(JUAN);
    await restart();
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.ACTIVE);
  });
});

describe('fault handling', () => {
  it('a hardware failure shows SYSTEM ERROR and recovers to ready', async () => {
    hw.lockers.unlock = async () => {
      throw new Error('relay not responding');
    };
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    expect(kiosk.state).toBe(KioskState.ERROR);
    expect(lcd()).toEqual(['SYSTEM ERROR', 'SEE AN OFFICER']);
    expect(store.db.prepare(`SELECT status, failure_reason FROM rentals`).get()).toEqual({
      status: 'FAILED',
      failure_reason: 'LOCKER_OPEN_FAILED',
    });
    await advance(3 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });
});
