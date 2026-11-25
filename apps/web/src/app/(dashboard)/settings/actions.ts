'use server';

import { revalidatePath } from 'next/cache';
import { ActorType, AdminRole, SystemSettingsSchema, systemSettingsFromRow, type SystemSettings } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/** Reads the Settings form into the shape SystemSettingsSchema validates. */
function readForm(fd: FormData) {
  const num = (k: string) => Number(fd.get(k));
  const on = (k: string) => fd.get(k) === 'on';
  const steps = String(fd.get('penaltySteps') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [minutes, amount] = line.split('=').map((part) => Number(part.trim()));
      return { upToMinutes: minutes, amount };
    });
  const max = String(fd.get('maxPenalty') ?? '').trim();
  return {
    rentalFee: num('rentalFee'),
    rentalDurationMinutes: num('rentalDurationMinutes'),
    gracePeriodMinutes: num('gracePeriodMinutes'),
    penaltyEnabled: on('penaltyEnabled'),
    penaltyType: fd.get('penaltyType'),
    penaltyAmount: num('penaltyAmount'),
    penaltyIntervalMinutes: num('penaltyIntervalMinutes'),
    penaltySteps: steps,
    maxPenalty: max === '' ? null : Number(max),
    maxConcurrentRentalsPerStudent: 1,
    unpaidPenaltyBlocksRental: on('unpaidPenaltyBlocksRental'),
    acceptedCoinDenominations: fd.getAll('acceptedCoinDenominations').map(Number),
    paymentTimeoutSeconds: num('paymentTimeoutSeconds'),
    removalTimeoutSeconds: num('removalTimeoutSeconds'),
    returnTimeoutSeconds: num('returnTimeoutSeconds'),
    allowOfflineReturns: on('allowOfflineReturns'),
    allowOfflineRentals: on('allowOfflineRentals'),
    operatingHoursStart: String(fd.get('operatingHoursStart') ?? ''),
    operatingHoursEnd: String(fd.get('operatingHoursEnd') ?? ''),
    operatingDays: fd.getAll('operatingDays').map(Number),
    closedDates: String(fd.get('closedDates') ?? '')
      .split(/[\n,]/)
      .map((d) => d.trim())
      .filter(Boolean)
      .sort(),
    pauseClockOutsideHours: on('pauseClockOutsideHours'),
  };
}

function toRow(s: SystemSettings) {
  return {
    rental_fee: s.rentalFee,
    rental_duration_minutes: s.rentalDurationMinutes,
    grace_period_minutes: s.gracePeriodMinutes,
    penalty_enabled: s.penaltyEnabled,
    penalty_type: s.penaltyType,
    penalty_amount: s.penaltyAmount,
    penalty_interval_minutes: s.penaltyIntervalMinutes,
    penalty_steps: s.penaltySteps,
    max_penalty: s.maxPenalty,
    unpaid_penalty_blocks_rental: s.unpaidPenaltyBlocksRental,
    accepted_coin_denominations: s.acceptedCoinDenominations,
    payment_timeout_seconds: s.paymentTimeoutSeconds,
    removal_timeout_seconds: s.removalTimeoutSeconds,
    return_timeout_seconds: s.returnTimeoutSeconds,
    allow_offline_returns: s.allowOfflineReturns,
    allow_offline_rentals: s.allowOfflineRentals,
    operating_hours_start: s.operatingHoursStart,
    operating_hours_end: s.operatingHoursEnd,
    operating_days: s.operatingDays,
    closed_dates: s.closedDates,
    pause_clock_outside_hours: s.pauseClockOutsideHours,
  };
}

export async function updateSettings(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.SUPER_ADMIN);
  const parsed = SystemSettingsSchema.safeParse(readForm(formData));
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: row } = await db.from('system_settings').select('*').eq('id', 1).single();
  if (!row) return actionFail('Settings row is missing.');
  const before = systemSettingsFromRow(row);

  // Audit only what changed.
  const changedKeys = (Object.keys(parsed.data) as (keyof SystemSettings)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(parsed.data[k]),
  );
  if (changedKeys.length === 0) return actionOk('Nothing changed.');

  const { error } = await db
    .from('system_settings')
    .update({ ...toRow(parsed.data), updated_by: admin.id })
    .eq('id', 1);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'SETTINGS_UPDATED',
    targetType: 'system_settings',
    targetId: '1',
    previousValue: Object.fromEntries(changedKeys.map((k) => [k, before[k]])),
    newValue: Object.fromEntries(changedKeys.map((k) => [k, parsed.data[k]])),
  });
  revalidatePath('/settings');
  return actionOk(`Settings saved (${changedKeys.length} change${changedKeys.length === 1 ? '' : 's'}). The kiosk applies them on its next sync.`);
}
