import { CalculatorCondition, CalculatorStatus, LockState, LockerStatus, RfidState } from '../enums';
import { ErrorCode } from '../errors';
import { refuse, type RuleResult } from './result';

/**
 * Locker selection (spec §5 steps 12–15).
 *
 * Availability must NOT rely on database state alone: a locker is only
 * handed out when the database says "available" AND its RFID reader
 * physically sees the expected calculator AND the lock is closed.
 * Same rule as the `is_assignable` column of view v_lockers.
 */
export interface LockerSnapshot {
  id: string;
  lockerNumber: number;
  status: LockerStatus;
  lockState: LockState;
  rfidState: RfidState;
  detectedRfidUid: string | null;
  /** The calculator assigned to this locker, if any. */
  calculator: {
    id: string;
    code: string;
    rfidUid: string;
    status: CalculatorStatus;
    condition: CalculatorCondition;
  } | null;
  /** True if an open rental already uses this locker or its calculator. */
  hasOpenRental: boolean;
}

/** A locker the system believes is stocked, but whose sensors disagree. */
export interface InventoryMismatch {
  lockerId: string;
  lockerNumber: number;
  calculatorCode: string;
  reason: 'NO_TAG' | 'WRONG_TAG';
  detectedRfidUid: string | null;
}

export function isLockerAssignable(locker: LockerSnapshot): boolean {
  const calc = locker.calculator;
  return (
    calc !== null &&
    !locker.hasOpenRental &&
    locker.status === LockerStatus.AVAILABLE &&
    calc.status === CalculatorStatus.AVAILABLE &&
    calc.condition !== CalculatorCondition.DAMAGED &&
    locker.lockState === LockState.LOCKED &&
    locker.rfidState === RfidState.EXPECTED_TAG &&
    locker.detectedRfidUid === calc.rfidUid
  );
}

/** Lockers whose database state says "stocked" but whose RFID reader disagrees. */
export function findInventoryMismatches(lockers: LockerSnapshot[]): InventoryMismatch[] {
  const mismatches: InventoryMismatch[] = [];
  for (const locker of lockers) {
    const calc = locker.calculator;
    if (!calc || locker.hasOpenRental) continue;
    const expectedInside = locker.status === LockerStatus.AVAILABLE && calc.status === CalculatorStatus.AVAILABLE;
    if (!expectedInside) continue;

    const sees = locker.detectedRfidUid;
    if (locker.rfidState === RfidState.NO_TAG || (locker.rfidState === RfidState.EXPECTED_TAG && !sees)) {
      mismatches.push({ lockerId: locker.id, lockerNumber: locker.lockerNumber, calculatorCode: calc.code, reason: 'NO_TAG', detectedRfidUid: null });
    } else if (locker.rfidState === RfidState.WRONG_TAG || (sees !== null && sees !== calc.rfidUid)) {
      mismatches.push({ lockerId: locker.id, lockerNumber: locker.lockerNumber, calculatorCode: calc.code, reason: 'WRONG_TAG', detectedRfidUid: sees });
    }
    // rfidState UNKNOWN = reader not reporting: not assignable, but not proof of a mismatch either.
  }
  return mismatches;
}

/**
 * Picks the locker for a new rental: the one the student chose (blue button),
 * or else the lowest-numbered assignable locker.
 */
export function selectLockerForRental(
  lockers: LockerSnapshot[],
  lockerNumber?: number,
): RuleResult<{ locker: LockerSnapshot; calculator: NonNullable<LockerSnapshot['calculator']> }> {
  const candidate = [...lockers]
    .sort((a, b) => a.lockerNumber - b.lockerNumber)
    .find((l) => (lockerNumber === undefined || l.lockerNumber === lockerNumber) && isLockerAssignable(l));
  if (!candidate || !candidate.calculator) {
    return refuse(
      ErrorCode.NO_CALCULATOR_AVAILABLE,
      lockerNumber === undefined ? 'No calculator is available right now.' : `Locker ${lockerNumber} is not available.`,
    );
  }
  return { ok: true, locker: candidate, calculator: candidate.calculator };
}
