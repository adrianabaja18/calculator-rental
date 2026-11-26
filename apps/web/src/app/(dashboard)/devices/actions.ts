'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Officer → kiosk commands (Phase 13). They are queued in device_commands;
 * the kiosk picks them up on its next sync (about every 10 s) and reports
 * the result. Unclaimed commands expire after 2 minutes.
 */

const UnlockSchema = z.object({
  lockerId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function requestEmergencyUnlock(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = UnlockSchema.safeParse({ lockerId: formData.get('lockerId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: locker } = await db
    .from('lockers')
    .select('id, name, locker_number, device_id')
    .eq('id', parsed.data.lockerId)
    .maybeSingle();
  if (!locker) return actionFail('Locker not found.');

  const { data: command, error } = await db
    .from('device_commands')
    .insert({
      device_id: locker.device_id,
      command: 'UNLOCK_LOCKER',
      payload: { lockerId: locker.id, lockerNumber: locker.locker_number, requestedBy: admin.email },
      reason: parsed.data.reason,
      requested_by: admin.id,
    })
    .select('id')
    .single();
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'LOCKER_EMERGENCY_UNLOCK',
    targetType: 'locker',
    targetId: locker.id,
    newValue: { commandId: command.id, locker: locker.name },
    reason: parsed.data.reason,
  });
  revalidatePath('/devices');
  return actionOk(
    `Unlock sent. If the kiosk is online and no student is using it, ${locker.name} opens for 10 seconds within about 10 seconds. The result appears under Recent commands.`,
  );
}

export async function requestDeviceSync(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = z.object({ deviceId: z.uuid() }).safeParse({ deviceId: formData.get('deviceId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { error } = await db.from('device_commands').insert({
    device_id: parsed.data.deviceId,
    command: 'REFRESH',
    payload: { requestedBy: admin.email },
    requested_by: admin.id,
  });
  if (error) return actionFromDbError(error);
  revalidatePath('/devices');
  return actionOk('Sync requested. The kiosk downloads the latest settings and data within about 10 seconds.');
}
