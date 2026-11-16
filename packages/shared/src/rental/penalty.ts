import { DoorState, PenaltyType } from '../enums';
import { ErrorCode } from '../errors';
import type { SystemSettings } from '../validation';
import { refuse, type RuleResult } from './result';

export type PenaltySettings = Pick<
  SystemSettings,
  'penaltyEnabled' | 'penaltyType' | 'penaltyAmount' | 'penaltyIntervalMinutes' | 'penaltySteps' | 'maxPenalty' | 'gracePeriodMinutes'
>;

export interface PenaltyQuote {
  /** Whole minutes past due_at. */
  overdueMinutes: number;
  amountCentavos: number;
}

/**
 * Overdue penalty (spec §7). Rules come from Settings, never hard-coded.
 *  - Within the grace period: nothing.
 *  - After it, lateness is counted from due_at (grace is not subtracted).
 *  - FLAT: one amount. PER_INTERVAL: amount per STARTED interval.
 *    STEPPED: first tier whose upToMinutes covers the lateness (last tier beyond).
 *  - maxPenalty caps the total.
 *
 * Team policy 2026-11-17: PER_INTERVAL ₱10 per 90 min, 10-min grace
 *   1 h late → ₱10 · 2 h → ₱20 · 3 h → ₱20 · 4 h → ₱30
 */
export function calculatePenalty(dueAt: Date | string, at: Date, settings: PenaltySettings): PenaltyQuote {
  const overdueMinutes = Math.max(0, Math.floor((at.getTime() - new Date(dueAt).getTime()) / 60_000));
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
