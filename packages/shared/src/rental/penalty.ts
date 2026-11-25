import { DoorState, PenaltyType } from '../enums';
import { ErrorCode } from '../errors';
import type { SystemSettings } from '../validation';
import { operatingCalendar, operatingMinutesBetween, type OperatingSettings } from './operating-hours';
import { refuse, type RuleResult } from './result';

export type PenaltySettings = Pick<
  SystemSettings,
  'penaltyEnabled' | 'penaltyType' | 'penaltyAmount' | 'penaltyIntervalMinutes' | 'penaltySteps' | 'maxPenalty' | 'gracePeriodMinutes'
> &
  /** Without these, every minute counts (as before operating hours existed). */
  Partial<OperatingSettings>;

export interface PenaltyQuote {
  /** Whole minutes past due_at. */
  overdueMinutes: number;
  amountCentavos: number;
}

/**
 * Overdue penalty (spec §7). Rules come from Settings, never hard-coded.
 *  - Lateness = minutes past due_at that fall inside operating hours (when
 *    the rental clock pauses outside them, team decision 2026-11-27).
 *  - Within the grace period: nothing. After it, lateness counts from due_at.
 *  - FLAT: one amount. PER_INTERVAL: amount per STARTED interval.
 *    STEPPED: first tier whose upToMinutes covers the lateness (last tier beyond).
 *  - maxPenalty caps the total.
 *
 * Team policy: PER_INTERVAL ₱10 per 90 min, 10-min grace
 *   1 h late → ₱10 · 2 h → ₱20 · 3 h → ₱20 · 4 h → ₱30
 *   due Tue 4:00 PM, back Wed 10:00 AM → 1 h Tue + 1 h Wed = 2 h late → ₱20
 */
export function calculatePenalty(dueAt: Date | string, at: Date, settings: PenaltySettings): PenaltyQuote {
  const overdue = operatingMinutesBetween(new Date(dueAt), at, operatingCalendar(settings));
  return penaltyForMinutes(overdue, settings);
}

/** The penalty for `overdueMinutes` of (operating-hours) lateness. */
export function penaltyForMinutes(overdueMinutes: number, settings: PenaltySettings): PenaltyQuote {
  if (!settings.penaltyEnabled || overdueMinutes <= settings.gracePeriodMinutes) {
    return { overdueMinutes, amountCentavos: 0 };
  }

  let pesos: number;
  switch (settings.penaltyType) {
    case PenaltyType.FLAT:
      pesos = settings.penaltyAmount;
      break;
    case PenaltyType.PER_INTERVAL:
      pesos = Math.ceil(overdueMinutes / settings.penaltyIntervalMinutes) * settings.penaltyAmount;
      break;
    case PenaltyType.STEPPED: {
      const tier = settings.penaltySteps.find((s) => overdueMinutes <= s.upToMinutes) ?? settings.penaltySteps.at(-1);
      pesos = tier?.amount ?? 0;
      break;
    }
  }
  if (settings.maxPenalty !== null) pesos = Math.min(pesos, settings.maxPenalty);
  return { overdueMinutes, amountCentavos: Math.round(pesos * 100) };
}

/**
 * Return verification (spec §6 steps 13–18, Rules 8–10): the expected tag
 * must be in the locker and, if a door sensor exists, the door closed.
 * doorState UNKNOWN = no sensor installed → not required.
 */
export function verifyReturnedCalculator(input: {
  expectedRfidUid: string;
  detectedRfidUid: string | null;
  doorState: DoorState;
}): RuleResult {
  if (!input.detectedRfidUid) {
    return refuse(ErrorCode.RFID_NOT_DETECTED, 'No calculator detected in the locker.');
  }
  if (input.detectedRfidUid !== input.expectedRfidUid) {
    return refuse(ErrorCode.RFID_MISMATCH, 'This is not the calculator you borrowed.');
  }
  if (input.doorState === DoorState.OPEN) {
    return refuse(ErrorCode.LOCKER_CLOSE_FAILED, 'Please close the locker door.');
  }
  return { ok: true };
}
