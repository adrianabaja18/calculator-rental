'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, LockerStatus, OPEN_RENTAL_STATUSES } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Officer actions on lockers.
 * Physical states (lock, door, RFID) are reported by the kiosk and are
 * read-only here; officers only control maintenance and labels.
 * Emergency unlock lives on the Devices page (device commands, Phase 13).
 */

const MaintenanceSchema = z.object({
  lockerId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function setLockerMaintenance(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = MaintenanceSchema.safeParse({ lockerId: formData.get('lockerId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db.from('lockers').select('id, name, status').eq('id', parsed.data.lockerId).maybeSingle();
  if (!before) return actionFail('Locker not found.');
  if (before.status === LockerStatus.MAINTENANCE) return actionFail(`${before.name} is already in maintenance.`);

  const { count } = await db
    .from('rental_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('locker_id', before.id)
    .in('status', [...OPEN_RENTAL_STATUSES]);
  if ((count ?? 0) > 0) {
    return actionFail(`${before.name} is part of an ongoing rental. Put it in maintenance after the calculator is returned.`);
  }

  const { error } = await db.from('lockers').update({ status: LockerStatus.MAINTENANCE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'LOCKER_MAINTENANCE',
    targetType: 'locker',
    targetId: before.id,
    previousValue: { status: before.status },
    newValue: { status: LockerStatus.MAINTENANCE },
    reason: parsed.data.reason,
  });
  revalidatePath('/lockers');
  revalidatePath('/calculators');
  return actionOk(`${before.name} is in maintenance. The kiosk will not use it.`);
}

export async function endLockerMaintenance(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = z.object({ lockerId: z.uuid() }).safeParse({ lockerId: formData.get('lockerId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db.from('lockers').select('id, name, status').eq('id', parsed.data.lockerId).maybeSingle();
  if (!before) return actionFail('Locker not found.');
  if (before.status !== LockerStatus.MAINTENANCE) return actionFail(`${before.name} is not in maintenance.`);

  const { error } = await db.from('lockers').update({ status: LockerStatus.AVAILABLE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'LOCKER_MAINTENANCE_ENDED',
    targetType: 'locker',
    targetId: before.id,
    previousValue: { status: before.status },
    newValue: { status: LockerStatus.AVAILABLE },
  });
  revalidatePath('/lockers');
  revalidatePath('/calculators');
  return actionOk(`${before.name} is back in service. It is lent out only when its RFID reader sees the expected calculator.`);
}

const UpdateSchema = z.object({
  lockerId: z.uuid(),
  name: z.string().trim().min(1, { message: 'Enter a name' }).max(50),
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),
});

export async function updateLocker(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = UpdateSchema.safeParse({
    lockerId: formData.get('lockerId'),
    name: formData.get('name'),
    notes: formData.get('notes') ?? undefined,
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db.from('lockers').select('id, name, notes').eq('id', parsed.data.lockerId).maybeSingle();
  if (!before) return actionFail('Locker not found.');

  const changes = { name: parsed.data.name, notes: parsed.data.notes };
  const { error } = await db.from('lockers').update(changes).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'LOCKER_UPDATED',
    targetType: 'locker',
    targetId: before.id,
    previousValue: before,
    newValue: changes,
  });
  revalidatePath('/lockers');
  revalidatePath('/calculators');
  return actionOk(`${parsed.data.name} updated.`);
}
