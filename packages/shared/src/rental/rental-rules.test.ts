import { describe, expect, it } from 'vitest';
import {
  CalculatorCondition,
  CalculatorStatus,
  LockState,
  LockerStatus,
  RentalStatus,
  RfidState,
  StudentStatus,
} from '../enums';
import { ErrorCode } from '../errors';
import {
  findInventoryMismatches,
  isLockerAssignable,
  selectLockerForRental,
  type LockerSnapshot,
} from './availability';
import { checkBorrowEligibility, type EligibilityInput } from './eligibility';
import {
  RENTAL_TRANSITIONS,
  assertTransition,
  canTransition,
  computeDueAt,
  effectiveRentalStatus,
  isOverdue,
  overdueMinutes,
  rentalCountdown,
} from './lifecycle';
import { systemSettingsFromRow, type SystemSettingsRow } from './settings';
import { TRANSACTION_CODE_PATTERN, generateTransactionCode } from './transaction-code';

// ---------------------------------------------------------------------------
describe('checkBorrowEligibility', () => {
  const base: EligibilityInput = {
    student: { status: StudentStatus.ACTIVE },
    openRental: null,
    unpaidPenaltyTotal: 0,
    settings: { unpaidPenaltyBlocksRental: true },
  };

  it('allows a valid student', () => {
    expect(checkBorrowEligibility(base)).toEqual({ ok: true });
  });

  it('allows a first-time student (not registered yet)', () => {
    expect(checkBorrowEligibility({ ...base, student: null }).ok).toBe(true);
  });

  it.each([StudentStatus.BLOCKED, StudentStatus.INACTIVE])('refuses a %s student', (status) => {
    expect(checkBorrowEligibility({ ...base, student: { status } })).toMatchObject({
      ok: false,
      code: ErrorCode.STUDENT_NOT_ALLOWED,
    });
  });

  it('refuses when an active rental exists (Rule 1)', () => {
    expect(checkBorrowEligibility({ ...base, openRental: { status: RentalStatus.ACTIVE } })).toMatchObject({
      ok: false,
      code: ErrorCode.ACTIVE_RENTAL_EXISTS,
    });
  });

  it('tells an overdue student to return the calculator first', () => {
    const result = checkBorrowEligibility({ ...base, openRental: { status: RentalStatus.OVERDUE } });
    expect(result).toMatchObject({ ok: false, code: ErrorCode.ACTIVE_RENTAL_EXISTS });
    expect(!result.ok && result.message).toMatch(/overdue/i);
  });

  it('refuses a duplicate scan while the first rental is still paying (duplicate rental prevention)', () => {
    expect(checkBorrowEligibility({ ...base, openRental: { status: RentalStatus.PAYMENT_PENDING } }).ok).toBe(false);
  });

  it('refuses unpaid penalties when the setting says so', () => {
    expect(checkBorrowEligibility({ ...base, unpaidPenaltyTotal: 20 })).toMatchObject({
      ok: false,
      code: ErrorCode.UNPAID_PENALTY,
    });
  });

  it('allows unpaid penalties when the setting is off', () => {
    expect(
      checkBorrowEligibility({ ...base, unpaidPenaltyTotal: 20, settings: { unpaidPenaltyBlocksRental: false } }).ok,
    ).toBe(true);
  });

  it('checks blocked before anything else', () => {
    const result = checkBorrowEligibility({
      ...base,
      student: { status: StudentStatus.BLOCKED },
      openRental: { status: RentalStatus.ACTIVE },
      unpaidPenaltyTotal: 50,
    });
    expect(result).toMatchObject({ code: ErrorCode.STUDENT_NOT_ALLOWED });
  });
});

// ---------------------------------------------------------------------------
function locker(n: number, overrides: Partial<LockerSnapshot> = {}, calc: Partial<NonNullable<LockerSnapshot['calculator']>> = {}): LockerSnapshot {
  const uid = n === 1 ? '04-A1-B2-C3-D4' : '04-E5-F6-A7-B8';
  return {
    id: `locker-${n}`,
    lockerNumber: n,
    status: LockerStatus.AVAILABLE,
    lockState: LockState.LOCKED,
    rfidState: RfidState.EXPECTED_TAG,
    detectedRfidUid: uid,
    hasOpenRental: false,
    calculator: {
      id: `calc-${n}`,
      code: `CALC-00${n}`,
      rfidUid: uid,
      status: CalculatorStatus.AVAILABLE,
      condition: CalculatorCondition.GOOD,
      ...calc,
    },
    ...overrides,
  };
}

describe('selectLockerForRental', () => {
  it('picks the lowest-numbered ready locker', () => {
    const result = selectLockerForRental([locker(2), locker(1)]);
    expect(result).toMatchObject({ ok: true, locker: { lockerNumber: 1 }, calculator: { code: 'CALC-001' } });
  });

  it('uses the locker the student chose, and refuses it if it is not ready', () => {
    expect(selectLockerForRental([locker(1), locker(2)], 2)).toMatchObject({ ok: true, locker: { lockerNumber: 2 } });
    expect(selectLockerForRental([locker(1), locker(2, { hasOpenRental: true })], 2)).toMatchObject({
      ok: false,
      code: ErrorCode.NO_CALCULATOR_AVAILABLE,
      message: 'Locker 2 is not available.',
    });
  });

  it('skips a locker whose RFID reader does NOT see the calculator (spec §5.14)', () => {
    const result = selectLockerForRental([
      locker(1, { rfidState: RfidState.NO_TAG, detectedRfidUid: null }),
      locker(2),
    ]);
    expect(result).toMatchObject({ ok: true, locker: { lockerNumber: 2 } });
  });

  it('reports NO_CALCULATOR_AVAILABLE when nothing is ready', () => {
    const result = selectLockerForRental([
      locker(1, { hasOpenRental: true }),
      locker(2, {}, { status: CalculatorStatus.RENTED }),
    ]);
    expect(result).toMatchObject({ ok: false, code: ErrorCode.NO_CALCULATOR_AVAILABLE });
  });

  it('reports NO_CALCULATOR_AVAILABLE for an empty kiosk', () => {
    expect(selectLockerForRental([]).ok).toBe(false);
  });
});

describe('isLockerAssignable', () => {
  it.each<[string, LockerSnapshot]>([
    ['locker in maintenance', locker(1, { status: LockerStatus.MAINTENANCE })],
    ['calculator in maintenance', locker(1, {}, { status: CalculatorStatus.MAINTENANCE })],
    ['damaged calculator', locker(1, {}, { condition: CalculatorCondition.DAMAGED })],
    ['lock not closed', locker(1, { lockState: LockState.UNLOCKED })],
    ['RFID reader not reporting', locker(1, { rfidState: RfidState.UNKNOWN })],
    ['wrong tag in locker', locker(1, { rfidState: RfidState.WRONG_TAG, detectedRfidUid: '04-E5-F6-A7-B8' })],
    ['reader says expected but UID differs', locker(1, { detectedRfidUid: '04-00-00-00-00' })],
    ['no calculator assigned', locker(1, { calculator: null })],
    ['already in an open rental', locker(1, { hasOpenRental: true })],
  ])('is false for %s', (_label, snapshot) => {
    expect(isLockerAssignable(snapshot)).toBe(false);
  });

  it('is true when database and sensors agree', () => {
    expect(isLockerAssignable(locker(1))).toBe(true);
  });
});

describe('findInventoryMismatches', () => {
  it('flags a stocked locker whose reader sees nothing', () => {
    expect(findInventoryMismatches([locker(1, { rfidState: RfidState.NO_TAG, detectedRfidUid: null })])).toEqual([
      { lockerId: 'locker-1', lockerNumber: 1, calculatorCode: 'CALC-001', reason: 'NO_TAG', detectedRfidUid: null },
    ]);
  });

  it('flags a stocked locker holding the wrong calculator', () => {
    const result = findInventoryMismatches([
      locker(1, { rfidState: RfidState.WRONG_TAG, detectedRfidUid: '04-E5-F6-A7-B8' }),
    ]);
    expect(result[0]).toMatchObject({ reason: 'WRONG_TAG', detectedRfidUid: '04-E5-F6-A7-B8' });
  });

  it('does not flag lockers that are legitimately empty or unknown', () => {
    expect(
      findInventoryMismatches([
        locker(1, { rfidState: RfidState.NO_TAG, detectedRfidUid: null, hasOpenRental: true }),
        locker(2, { rfidState: RfidState.UNKNOWN, detectedRfidUid: null }),
        locker(1, { rfidState: RfidState.NO_TAG, detectedRfidUid: null, status: LockerStatus.MAINTENANCE }),
      ]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('rental lifecycle', () => {
  it('follows the happy path PENDING → … → COMPLETED', () => {
    const path = [
      RentalStatus.PENDING,
      RentalStatus.PAYMENT_PENDING,
      RentalStatus.PAID,
      RentalStatus.DISPENSING,
      RentalStatus.ACTIVE,
      RentalStatus.RETURNING,
      RentalStatus.COMPLETED,
    ];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it.each<[RentalStatus, RentalStatus]>([
    [RentalStatus.PENDING, RentalStatus.ACTIVE], // skipping payment
    [RentalStatus.PAYMENT_PENDING, RentalStatus.DISPENSING], // opening a locker without payment
    [RentalStatus.PAID, RentalStatus.CANCELLED], // a paid rental can't silently vanish
    [RentalStatus.DISPENSING, RentalStatus.COMPLETED],
    [RentalStatus.COMPLETED, RentalStatus.ACTIVE], // double return / reuse
    [RentalStatus.CANCELLED, RentalStatus.PAYMENT_PENDING],
  ])('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(/cannot go/);
  });

  it('has an entry for every status and terminal states lead nowhere', () => {
    expect(Object.keys(RENTAL_TRANSITIONS).sort()).toEqual(Object.values(RentalStatus).sort());
    for (const terminal of [RentalStatus.COMPLETED, RentalStatus.CANCELLED, RentalStatus.FAILED]) {
      expect(RENTAL_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('computes due_at from rented_at + duration (3 hours)', () => {
    const rentedAt = new Date('2026-10-20T02:00:00Z'); // 10:00 AM Manila
    expect(computeDueAt(rentedAt, 180).toISOString()).toBe('2026-10-20T05:00:00.000Z'); // 1:00 PM Manila
  });

  it('rejects invalid durations', () => {
    expect(() => computeDueAt(new Date(), 0)).toThrow();
    expect(() => computeDueAt(new Date(), 1.5)).toThrow();
  });

  it('becomes overdue only after due_at', () => {
    const due = '2026-10-20T05:00:00Z';
    expect(isOverdue(due, new Date('2026-10-20T05:00:00Z'))).toBe(false);
    expect(isOverdue(due, new Date('2026-10-20T05:00:01Z'))).toBe(true);
    expect(isOverdue(null, new Date())).toBe(false);
  });

  it('reports an ACTIVE rental past due as OVERDUE and counts minutes', () => {
    const now = new Date('2026-10-20T06:32:30Z');
    expect(effectiveRentalStatus(RentalStatus.ACTIVE, '2026-10-20T05:00:00Z', now)).toBe(RentalStatus.OVERDUE);
    expect(effectiveRentalStatus(RentalStatus.RETURNING, '2026-10-20T05:00:00Z', now)).toBe(RentalStatus.RETURNING);
    expect(overdueMinutes('2026-10-20T05:00:00Z', now)).toBe(92);
    expect(overdueMinutes('2026-10-20T07:00:00Z', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('generateTransactionCode', () => {
  it('uses the Philippine date, kiosk number and random hex', () => {
    // 2026-11-16 17:30 UTC is already 2026-11-17 in Manila.
    const code = generateTransactionCode(new Date('2026-11-16T17:30:00Z'), 'DEVICE-CALC-KIOSK-001', () =>
      Uint8Array.from([0x7f, 0x3a]),
    );
    expect(code).toBe('RNT-20261117-K001-7F3A');
    expect(code).toMatch(TRANSACTION_CODE_PATTERN);
  });

  it('produces different codes for the same moment', () => {
    const now = new Date();
    const codes = new Set(Array.from({ length: 50 }, () => generateTransactionCode(now, 'DEVICE-CALC-KIOSK-001')));
    expect(codes.size).toBeGreaterThan(45);
  });
});

// ---------------------------------------------------------------------------
describe('systemSettingsFromRow', () => {
  const row: SystemSettingsRow = {
    rental_fee: '20.00',
    rental_duration_minutes: 180,
    grace_period_minutes: 10,
    penalty_enabled: true,
    penalty_type: 'PER_INTERVAL',
    penalty_amount: '20.00',
    penalty_interval_minutes: 60,
    penalty_steps: [],
    max_penalty: null,
    max_concurrent_rentals_per_student: 1,
    unpaid_penalty_blocks_rental: true,
    accepted_coin_denominations: [1, 5, 10, 20],
    payment_timeout_seconds: 120,
    removal_timeout_seconds: 60,
    return_timeout_seconds: 90,
    allow_offline_returns: true,
    allow_offline_rentals: false,
  };

  it('converts the database row (numeric strings included) to camelCase settings', () => {
    expect(systemSettingsFromRow(row)).toMatchObject({ rentalFee: 20, rentalDurationMinutes: 180, penaltyAmount: 20 });
  });

  it('refuses invalid settings instead of running on them', () => {
    expect(() => systemSettingsFromRow({ ...row, rental_fee: '0' })).toThrow();
  });
});

describe('rentalCountdown', () => {
  const due = '2026-10-20T05:00:00.000Z';
  it.each([
    ['2026-10-20T03:17:45.000Z', false, '01:42:15'],
    ['2026-10-20T05:00:00.000Z', false, '00:00:00'],
    ['2026-10-20T05:32:16.000Z', true, '00:32:16'],
    ['2026-10-21T07:05:00.000Z', true, '26:05:00'],
  ])('at %s → overdue=%s %s', (now, overdue, text) => {
    // No calendar = every minute counts (operating-hours countdowns: operating-hours.test.ts).
    expect(rentalCountdown(due, new Date(now))).toEqual({ overdue, text, paused: false });
  });
});
