import { SystemSettingsSchema, type SystemSettings } from '../validation';

/**
 * The system_settings row as stored in PostgreSQL / sent by the sync API
 * (snake_case). numeric columns may arrive as strings.
 */
export interface SystemSettingsRow {
  rental_fee: number | string;
  rental_duration_minutes: number;
  grace_period_minutes: number;
  penalty_enabled: boolean;
  penalty_type: string;
  penalty_amount: number | string;
  penalty_interval_minutes: number;
  penalty_steps: unknown;
  max_penalty: number | string | null;
  max_concurrent_rentals_per_student: number;
  unpaid_penalty_blocks_rental: boolean;
  accepted_coin_denominations: number[];
  payment_timeout_seconds: number;
  removal_timeout_seconds: number;
  return_timeout_seconds: number;
  allow_offline_returns: boolean;
  allow_offline_rentals: boolean;
}

/**
 * Converts a database row into validated, camelCase SystemSettings.
 * Throws if the row breaks a rule — the kiosk must never run on settings
 * it doesn't understand (it keeps its last good copy instead).
 */
export function systemSettingsFromRow(row: SystemSettingsRow): SystemSettings {
  const num = (v: number | string) => Number(v);
  return SystemSettingsSchema.parse({
    rentalFee: num(row.rental_fee),
    rentalDurationMinutes: row.rental_duration_minutes,
    gracePeriodMinutes: row.grace_period_minutes,
    penaltyEnabled: row.penalty_enabled,
    penaltyType: row.penalty_type,
    penaltyAmount: num(row.penalty_amount),
    penaltyIntervalMinutes: row.penalty_interval_minutes,
    penaltySteps: row.penalty_steps ?? [],
    maxPenalty: row.max_penalty === null ? null : num(row.max_penalty),
    maxConcurrentRentalsPerStudent: row.max_concurrent_rentals_per_student,
    unpaidPenaltyBlocksRental: row.unpaid_penalty_blocks_rental,
    acceptedCoinDenominations: row.accepted_coin_denominations,
    paymentTimeoutSeconds: row.payment_timeout_seconds,
    removalTimeoutSeconds: row.removal_timeout_seconds,
    returnTimeoutSeconds: row.return_timeout_seconds,
    allowOfflineReturns: row.allow_offline_returns,
    allowOfflineRentals: row.allow_offline_rentals,
  });
}
