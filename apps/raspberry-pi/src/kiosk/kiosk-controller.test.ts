import { beforeEach, describe, expect, it } from 'vitest';
import { DoorState, RentalStatus } from '@calc-rental/shared';
import { startScanSession, submitScan, takeScan } from '@calc-rental/shared/sqlite';
import { DEV_IDS, DEV_RFID, DEV_SETTINGS, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { openLocalDatabase } from '../db/sqlite';
import { createMockHardware, type MockHardware } from '../hardware/mock';
import { PaymentService } from '../payment/payment-service';
import { RentalService } from '../rental/rental-service';
import { ReturnService } from '../rental/return-service';
import { KioskController, SOLENOID_MAX_ON_MS, SOLENOID_REST_MS, type PhoneScan } from './kiosk-controller';
import { KioskState, canMove } from './kiosk-states';

// Fake identities only.
const JUAN = 'JUAN DELA CRUZ\t2022100001\tBSCpE';
const ANA_BLOCKED = 'ANA GARCIA\t2022100004\tBSCpE';
const DEV_STUDENT_QR_MARIA = 'MARIA SANTOS\t2023100002\tBSCE';
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

async function boot(options: { clockSynced?: boolean; sleepAfterMs?: number; phoneScan?: PhoneScan } = {}) {
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
  kiosk = new KioskController(store, hw, { rentals, payments, returns }, {
    now,
    messageMs: 3 * SECOND,
    sleepAfterMs: options.sleepAfterMs,
    phoneScan: options.phoneScan,
  });
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
    expect(hw.lockers.unlocks).toEqual([{ channel: 2, maxMs: SOLENOID_MAX_ON_MS }]); // only Locker 2, 10 s at most (heat)
    expect([...hw.lockers.open]).toEqual([2]);
    expect(lcd()).toEqual(['LOCKER 2 OPEN', 'LOCKS IN 10 SEC']);

    await red(2); // calculator still inside: not done
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_REMOVAL);
    expect([...hw.lockers.open]).toEqual([2]);

    hw.rfid.place(2, null); // student takes it
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_DOOR_CLOSE);
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'LOCKS IN 9 SEC']);
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

describe('10-second lock window (no door latch)', () => {
  const ticks = () => hw.buzzer.beeps.filter((b) => b === 'tick').length;

  it('counts down on the LCD with a buzzer tick each second, then drops the lock', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    expect(lcd()).toEqual(['LOCKER 1 OPEN', 'LOCKS IN 10 SEC']);
    const before = ticks();
    for (let s = 9; s >= 1; s--) {
      await advance(SECOND);
      expect(lcd()).toEqual(['LOCKER 1 OPEN', `LOCKS IN ${s} SEC`]);
    }
    expect(ticks() - before).toBe(9);
    expect([...hw.lockers.open]).toEqual([1]);

    await advance(SECOND); // 10 s: power off
    expect(hw.lockers.open.size).toBe(0);
    expect(lcd()).toEqual(['TAKE CALCULATOR', 'OPEN AGAIN: BLUE']);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_REMOVAL);
  });

  it('too slow: BLUE opens it for another 10 s, after a short rest', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    hw.rfid.place(1, null); // took it, but didn't shut the door in time
    await advance(SECOND);
    await advance(SOLENOID_MAX_ON_MS);
    expect(hw.lockers.open.size).toBe(0);
    expect(lcd()).toEqual(['CLOSED? PUSH RED', 'OPEN AGAIN: BLUE']);

    await blue(1); // the lock is still cooling down
    expect(hw.lockers.open.size).toBe(0);
    expect(hw.buzzer.beeps.at(-1)).toBe('error');

    await advance(SOLENOID_REST_MS);
    await blue(2); // the other locker's button does nothing
    expect(hw.lockers.open.size).toBe(0);
    await blue(1);
    expect([...hw.lockers.open]).toEqual([1]);
    expect(hw.lockers.unlocks.at(-1)).toEqual({ channel: 1, maxMs: SOLENOID_MAX_ON_MS });
    await advance(SECOND);
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'LOCKS IN 9 SEC']);

    await red(1); // shut: lock right away
    expect(hw.lockers.open.size).toBe(0);
    expect(kiosk.state).toBe(KioskState.RENTAL_ACTIVE);
  });
});

describe('returning (spec §6, red button)', () => {
  it('on time: opens only the borrowed locker, then completes on the red button', async () => {
    const rentalId = await borrow();
    hw.lockers.unlocks.length = 0;
    await advance(HOUR);

    await kiosk.handleScan(JUAN);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect(hw.lockers.unlocks).toEqual([{ channel: 1, maxMs: SOLENOID_MAX_ON_MS }]);
    expect(lcd()).toEqual(['LOCKER 1 OPEN', 'LOCKS IN 10 SEC']);

    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(SECOND);
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'LOCKS IN 9 SEC']);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);

    await red(1);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
    expect(lcd()).toEqual(['RETURN SUCCESS', 'THANK YOU']);
    expect(store.getRental(rentalId)!.status).toBe(RentalStatus.COMPLETED);
    expect(hw.lockers.open.size).toBe(0);
  });

  it('red button with nothing inside: refused, the lock keeps counting down', async () => {
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
    expect(lcd()).toEqual(['WRONG CALCULATOR', 'LOCKS IN 9 SEC']);
    await red(1);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
    expect([...hw.lockers.open]).toEqual([1]); // never locked on the wrong one

    hw.rfid.place(1, DEV_RFID.calc1);
    await advance(4 * SECOND); // the refusal message times out, live hint returns
    expect(lcd()).toEqual(['CLOSE THE DOOR', 'LOCKS IN 5 SEC']);
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

describe('operating hours (Mon–Fri 9 AM–5 PM, clock pauses while closed)', () => {
  it('a rental at 3 PM is due the next morning, shown with the weekday', async () => {
    clock = new Date('2026-10-20T07:00:00.000Z'); // Tue 3:00 PM Manila
    await kiosk.handleScan(JUAN);
    await blue(1);
    await coin(20);
    hw.rfid.place(1, null);
    await advance(SECOND);
    await red(1);
    expect(lcd()).toEqual(['RENTAL SUCCESS', 'DUE WED 10:00 AM']);
    expect(store.db.prepare(`SELECT due_at FROM rentals`).get()).toEqual({ due_at: '2026-10-21T02:00:01.000Z' });
  });

  it('after hours: idle screen says returns only, borrowing is refused, returns still work', async () => {
    const rentalId = await borrow(); // Tue 10:00 AM, due 1:00 PM
    clock = new Date('2026-10-20T11:00:00.000Z'); // Tue 7:00 PM: closed
    await advance(SECOND);
    expect(lcd()).toEqual(['RETURNS ONLY', 'OPEN WED 9:00AM']);

    await kiosk.handleScan(DEV_STUDENT_QR_MARIA);
    expect(lcd()).toEqual(['KIOSK CLOSED', 'OPEN WED 9:00AM']);
    await advance(3 * SECOND);

    // Juan returns at 7 PM: due 1 PM, the kiosk closed at 5 PM → 4 h late, not 6 h.
    await kiosk.handleScan(JUAN);
    expect(lcd()).toEqual(['LATE 3H59M', 'PAY PENALTY P30']);
    await coin(20);
    await coin(10);
    hw.rfid.place(1, DEV_RFID.calc1);
    await red(1);
    expect(kiosk.state).toBe(KioskState.RETURN_COMPLETE);
    expect(store.getRental(rentalId)!.overdue_minutes).toBe(239);
  });
});

describe('power saving', () => {
  const MIN = 60 * SECOND;
  beforeEach(() => boot({ sleepAfterMs: 2 * MIN }));

  it('sleeps after 2 min idle: backlight, camera and RFID readers off', async () => {
    await advance(MIN);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    await advance(MIN + SECOND);
    expect(kiosk.state).toBe(KioskState.SLEEPING);
    expect(lcd()).toEqual(['PRESS ANY BUTTON', 'TO START']);
    expect({ backlight: hw.display.backlight, camera: hw.scanner.active, rfid: hw.rfid.powered }).toEqual({
      backlight: false,
      camera: false,
      rfid: false,
    });
  });

  it('does not read the (powered-down) RFID readers while asleep', async () => {
    await advance(2 * MIN + SECOND);
    let reads = 0;
    const read = hw.rfid.read.bind(hw.rfid);
    hw.rfid.read = async (ch) => {
      reads++;
      return read(ch);
    };
    await advance(10 * SECOND);
    expect(reads).toBe(0);
  });

  it('a button press only wakes it (no locker is chosen), then everything is back on', async () => {
    await advance(2 * MIN + SECOND);
    await kiosk.handleButton('select', 1);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    expect(lcd()).toEqual(['SCAN STUDENT ID', '1:READY 2:READY']);
    expect({ backlight: hw.display.backlight, camera: hw.scanner.active, rfid: hw.rfid.powered }).toEqual({
      backlight: true,
      camera: true,
      rfid: true,
    });
    await kiosk.handleScan(JUAN); // then a normal borrow works
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
  });

  it('a coin wakes it and is still recorded for refund', async () => {
    await advance(2 * MIN + SECOND);
    await coin(5, 'idle-coin');
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    expect(store.db.prepare(`SELECT payment_id FROM coin_events WHERE id = 'idle-coin'`).get()).toEqual({ payment_id: null });
  });

  it('never sleeps in the middle of a rental, and the idle time restarts after it', async () => {
    await kiosk.handleScan(JUAN);
    await blue(1);
    await advance(3 * MIN); // waiting for coins
    expect(kiosk.state).not.toBe(KioskState.SLEEPING);
    await advance(MIN); // payment times out → message → ready
    await advance(4 * SECOND);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
    await advance(MIN);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('sleeps sooner (30 s) after closing time', async () => {
    clock = new Date('2026-10-20T11:00:00.000Z'); // Tue 7:00 PM: closed
    await advance(SECOND);
    await advance(31 * SECOND);
    expect(kiosk.state).toBe(KioskState.SLEEPING);
    expect(lcd()).toEqual(['PRESS ANY BUTTON', 'TO RETURN']);
  });

  it('an officer unlock wakes it first', async () => {
    await advance(2 * MIN + SECOND);
    expect(await kiosk.handleOfficerUnlock(DEV_IDS.locker1, { commandId: 'c' })).toMatchObject({ ok: true });
    expect(hw.display.backlight).toBe(true);
  });
});

describe('officer emergency unlock (Phase 13)', () => {
  it('unlocks the locker for 10 s while idle, logs a WARNING event, then locks and returns to ready', async () => {
    const result = await kiosk.handleOfficerUnlock(DEV_IDS.locker2, { commandId: 'cmd-1', requestedBy: 'officer@example.test' });
    expect(result).toEqual({ ok: true, message: 'Locker 2 unlocked for 10 s.' });
    expect(kiosk.state).toBe(KioskState.OFFICER_UNLOCK);
    expect([...hw.lockers.open]).toEqual([2]);
    expect(lcd()).toEqual(['OFFICER UNLOCK', 'LOCKER 2 OPEN']);
    expect(store.db.prepare(`SELECT severity FROM device_events WHERE event_type = 'LOCKER_UNLOCKED'`).get()).toEqual({ severity: 'WARNING' });

    await kiosk.handleScan(JUAN); // students can't start anything meanwhile
    expect(kiosk.state).toBe(KioskState.OFFICER_UNLOCK);

    await advance(11 * SECOND);
    expect(hw.lockers.open.size).toBe(0);
    expect(kiosk.state).toBe(KioskState.SYSTEM_READY);
  });

  it('refuses while a student is using the kiosk', async () => {
    await kiosk.handleScan(JUAN);
    const result = await kiosk.handleOfficerUnlock(DEV_IDS.locker1, { commandId: 'cmd-2' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/busy/);
    expect(hw.lockers.open.size).toBe(0);
  });

  it('refuses an unknown locker', async () => {
    expect(await kiosk.handleOfficerUnlock('00000000-0000-4000-8000-000000000999', { commandId: 'cmd-3' })).toMatchObject({ ok: false });
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

describe('phone ID scanning (no camera at the kiosk)', () => {
  /** The real scan-session functions on the kiosk's SQLite, as index.ts wires them. */
  const phoneScan = (): PhoneScan => ({
    start: (now) => startScanSession(store.db, now),
    take: (id, now) => takeScan(store.db, id, now),
  });
  /** The student's phone: reads the code off the LCD and sends the ID (what /api/scan does). */
  const sendFromPhone = (qr: string, code = /CODE (\d{6})/.exec(lcd()[1] ?? '')?.[1] ?? '000000') =>
    submitScan(store.db, { code, qr, clientHash: 'test-phone' }, clock);
  const codeLine = () => lcd()[1]!.replace(/\d{6}/, '######');

  beforeEach(() => boot({ phoneScan: phoneScan(), sleepAfterMs: 120 * SECOND }));

  it('idle screen asks for a button press', () => {
    expect(lcd()).toEqual(['PRESS TO START', '1:READY 2:READY']);
  });

  it('any button shows a code; the ID sent from the phone continues the normal borrow flow', async () => {
    await red(2);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PHONE);
    expect(lcd()[0]).toBe('SCAN ID ON PHONE');
    expect(codeLine()).toBe('CODE ###### 1:55');

    await advance(2 * SECOND);
    expect(codeLine()).toBe('CODE ###### 1:53');
    await blue(1); // pressing again while the code is up does nothing
    expect(store.db.prepare(`SELECT count(*) AS n FROM scan_sessions`).get()).toEqual({ n: 1 });

    expect(sendFromPhone(JUAN)).toBe('OK');
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
    expect(lcd()).toEqual(['PUSH BLUE BUTTON', '1:READY 2:READY']);

    await blue(2); // now the blue button picks the locker
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PAYMENT);
    expect(lcd()).toEqual(['JUAN DELA CRUZ', 'P20 / 3 HOURS']);
  });

  it('a wrong code from the phone is refused and the kiosk keeps waiting', async () => {
    await blue(1);
    const shown = /CODE (\d{6})/.exec(lcd()[1]!)![1]!;
    expect(sendFromPhone(JUAN, shown === '123456' ? '654321' : '123456')).toBe('BAD_CODE');
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PHONE);
  });

  it('a student with a calculator out is taken to the return', async () => {
    await kiosk.handleScan(JUAN); // (a local scan still works) borrow first
    await blue(1);
    await coin(20);
    hw.rfid.place(1, null);
    await advance(SECOND);
    await red(1);
    await advance(3 * SECOND);

    await red(1);
    sendFromPhone(JUAN);
    await advance(SECOND);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_RETURN);
  });

  it('the code runs out: TIME RAN OUT, then back to idle', async () => {
    await blue(1);
    await advance(116 * SECOND);
    expect(lcd()).toEqual(['TIME RAN OUT', 'PRESS TO RETRY']);
    await advance(3 * SECOND);
    expect(lcd()).toEqual(['PRESS TO START', '1:READY 2:READY']);
  });

  it('asleep: the press wakes it AND shows a code', async () => {
    await advance(121 * SECOND);
    expect(kiosk.state).toBe(KioskState.SLEEPING);
    await blue(1);
    expect(hw.display.backlight).toBe(true);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PHONE);
  });

  it('after closing time the idle screen says press to return', async () => {
    await boot({ phoneScan: phoneScan() }); // no power saving, so it stays awake
    clock = new Date('2026-10-20T10:00:00.000Z'); // 6 PM Manila
    await advance(SECOND);
    expect(lcd()).toEqual(['PRESS TO RETURN', 'OPEN WED 9:00AM']);
  });
});
