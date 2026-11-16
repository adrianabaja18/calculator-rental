'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ActorType,
  AdminRole,
  CalculatorCodeSchema,
  CalculatorCondition,
  CalculatorStatus,
  OPEN_RENTAL_STATUSES,
  RfidUidSchema,
} from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin, type CurrentAdmin } from '@/lib/auth/session';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Officer actions on the calculator inventory. Rules enforced here (on top
 * of the database constraints):
 *  - A calculator that is out with a student (open rental) can't change
 *    locker or RFID tag, and can't be put into maintenance.
 *  - Only a calculator sitting in a locker and not DAMAGED can be AVAILABLE.
 */

const UNIQUE_MESSAGES = {
  calculators_code_key: 'That calculator code is already used.',
  calculators_rfid_uid_key: 'That RFID tag is already assigned to another calculator.',
  calculators_locker_id_key: 'That locker already holds another calculator.',
};

const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(z.uuid({ message: 'Choose a valid locker' }).nullable());

const DetailsSchema = z.object({
  model: z.string().trim().min(1, { message: 'Enter the model' }).max(100),
  rfidUid: RfidUidSchema,
  lockerId: optionalUuid,
  condition: z.enum(Object.values(CalculatorCondition) as [CalculatorCondition, ...CalculatorCondition[]]),
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),
});

function readDetails(formData: FormData) {
  return {
    model: formData.get('model'),
    rfidUid: formData.get('rfidUid'),
    lockerId: formData.get('lockerId') ?? undefined,
    condition: formData.get('condition'),
    notes: formData.get('notes') ?? undefined,
  };
}

async function hasOpenRental(calculatorId: string): Promise<boolean> {
  const db = createSupabaseAdminClient();
  const { count } = await db
    .from('rental_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('calculator_id', calculatorId)
    .in('status', [...OPEN_RENTAL_STATUSES]);
  return (count ?? 0) > 0;
}

function audit(admin: CurrentAdmin, action: string, id: string, previousValue: object | null, newValue: object, reason?: string) {
  return writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action,
    targetType: 'calculator',
    targetId: id,
    previousValue: previousValue as never,
    newValue: newValue as never,
    reason,
  });
}

// ---------------------------------------------------------------------------

export async function createCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = DetailsSchema.extend({ code: CalculatorCodeSchema }).safeParse({
    ...readDetails(formData),
    code: formData.get('code'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);
  const input = parsed.data;

  // Ready to rent only if it is sitting in a locker and not damaged.
  const status =
    input.lockerId && input.condition !== CalculatorCondition.DAMAGED
      ? CalculatorStatus.AVAILABLE
      : CalculatorStatus.MAINTENANCE;

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from('calculators')
    .insert({
      code: input.code,
      model: input.model,
      rfid_uid: input.rfidUid,
      locker_id: input.lockerId,
      condition: input.condition,
      notes: input.notes,
      status,
    })
    .select('id')
    .single();
  if (error) return actionFromDbError(error, UNIQUE_MESSAGES);

  await audit(admin, 'CALCULATOR_CREATED', data.id, null, { ...input, status });
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(
    `${input.code} added${status === CalculatorStatus.MAINTENANCE ? ' in MAINTENANCE (assign a locker to make it available)' : ''}.`,
  );
}

export async function updateCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = DetailsSchema.extend({ calculatorId: z.uuid() }).safeParse({
    ...readDetails(formData),
    calculatorId: formData.get('calculatorId'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);
  const input = parsed.data;

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('calculators')
    .select('id, code, model, rfid_uid, locker_id, condition, notes, status')
    .eq('id', input.calculatorId)
    .maybeSingle();
  if (!before) return actionFail('Calculator not found.');

  const identityChanged = before.rfid_uid !== input.rfidUid || before.locker_id !== input.lockerId;
  if (identityChanged && (await hasOpenRental(before.id))) {
    return actionFail(`${before.code} is out with a student. Change its RFID tag or locker after it is returned.`);
  }
  if (before.status === CalculatorStatus.AVAILABLE && !input.lockerId) {
    return actionFail('An available calculator must stay in a locker. Move it to maintenance first.');
  }
  if (before.status === CalculatorStatus.AVAILABLE && input.condition === CalculatorCondition.DAMAGED) {
    return actionFail('A damaged calculator cannot stay available. Move it to maintenance first.');
  }

  const changes = {
    model: input.model,
    rfid_uid: input.rfidUid,
    locker_id: input.lockerId,
    condition: input.condition,
    notes: input.notes,
  };
  const { error } = await db.from('calculators').update(changes).eq('id', before.id);
  if (error) return actionFromDbError(error, UNIQUE_MESSAGES);

  await audit(admin, 'CALCULATOR_UPDATED', before.id, before, changes);
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(`${before.code} updated.`);
}

const StatusChangeSchema = z.object({
  calculatorId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function moveCalculatorToMaintenance(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = StatusChangeSchema.safeParse({
    calculatorId: formData.get('calculatorId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db.from('calculators').select('id, code, status').eq('id', parsed.data.calculatorId).maybeSingle();
  if (!before) return actionFail('Calculator not found.');
  if (before.status === CalculatorStatus.MAINTENANCE) return actionFail(`${before.code} is already in maintenance.`);
  if (before.status === CalculatorStatus.RENTED || (await hasOpenRental(before.id))) {
    return actionFail(`${before.code} is out with a student. Move it to maintenance after it is returned.`);
  }

  const { error } = await db.from('calculators').update({ status: CalculatorStatus.MAINTENANCE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await audit(admin, 'CALCULATOR_MAINTENANCE', before.id, { status: before.status }, { status: CalculatorStatus.MAINTENANCE }, parsed.data.reason);
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(`${before.code} moved to maintenance. The kiosk will not lend it out.`);
}

export async function reactivateCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = z.object({ calculatorId: z.uuid() }).safeParse({ calculatorId: formData.get('calculatorId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('calculators')
    .select('id, code, status, locker_id, condition')
    .eq('id', parsed.data.calculatorId)
    .maybeSingle();
  if (!before) return actionFail('Calculator not found.');
  if (before.status === CalculatorStatus.AVAILABLE || before.status === CalculatorStatus.RENTED) {
    return actionFail(`${before.code} is already in service.`);
  }
  if (!before.locker_id) return actionFail(`Assign ${before.code} to a locker first (Edit).`);
  if (before.condition === CalculatorCondition.DAMAGED) {
    return actionFail(`${before.code} is marked DAMAGED. Change its condition first (Edit).`);
  }

  const { error } = await db.from('calculators').update({ status: CalculatorStatus.AVAILABLE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await audit(admin, 'CALCULATOR_REACTIVATED', before.id, { status: before.status }, { status: CalculatorStatus.AVAILABLE });
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(
    `${before.code} is available again. The kiosk lends it out once its RFID reader confirms it is in the locker.`,
  );
}
