'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, formatPhilippineDateTime } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { getLocalConfig, getLocalDb, setLocalConfig } from '@/lib/local-db';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const READ_ONLY_MSG = 'The online monitoring dashboard is read-only. Perform actions on the local Raspberry Pi dashboard.';

const UnlockSchema = z.object({
  lockerId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function requestEmergencyUnlock(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = UnlockSchema.safeParse({ lockerId: formData.get('lockerId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const locker = db
      .prepare('SELECT id, name, locker_number FROM lockers WHERE id = ?')
      .get(parsed.data.lockerId) as { id: string; name: string; locker_number: number } | undefined;
    if (!locker) return actionFail('Locker not found.');

    const commandId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const deviceCode = getLocalConfig(db, 'device_id') ?? 'DEVICE-CALC-KIOSK-001';

    db.prepare(
      `INSERT INTO device_commands (id, device_code, command, payload, reason, status, requested_by, requested_at, expires_at)
       VALUES (?, ?, 'UNLOCK_LOCKER', ?, ?, 'PENDING', ?, ?, ?)`,
    ).run(
      commandId,
      deviceCode,
      JSON.stringify({ lockerId: locker.id, lockerNumber: locker.locker_number, requestedBy: admin.email }),
      parsed.data.reason,
      admin.id,
      now.toISOString(),
      expiresAt,
    );

    await writeAuditLog({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'LOCKER_EMERGENCY_UNLOCK',
      targetType: 'locker',
      targetId: locker.id,
      newValue: { commandId, locker: locker.name },
      reason: parsed.data.reason,
    });
    revalidatePath('/devices');
    return actionOk(
      `Emergency unlock queued locally. If the kiosk service is running and idle, ${locker.name} opens for 10 seconds within ~1 second.`,
    );
  }

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
    `Unlock sent. If the kiosk is online and no student is using it, ${locker.name} opens for 10 seconds within about 10 seconds.`,
  );
}

export async function requestDeviceSync(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = z.object({ deviceId: z.uuid() }).safeParse({ deviceId: formData.get('deviceId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const deviceCode = getLocalConfig(db, 'device_id') ?? 'DEVICE-CALC-KIOSK-001';

    db.prepare(
      `INSERT INTO device_commands (id, device_code, command, payload, status, requested_by, requested_at, expires_at)
       VALUES (?, ?, 'REFRESH', ?, 'PENDING', ?, ?, ?)`,
    ).run(
      randomUUID(),
      deviceCode,
      JSON.stringify({ requestedBy: admin.email }),
      admin.id,
      now.toISOString(),
      expiresAt,
    );
    revalidatePath('/devices');
    return actionOk('Cloud sync push requested on the kiosk service.');
  }

  const db = createSupabaseAdminClient();
  const { error } = await db.from('device_commands').insert({
    device_id: parsed.data.deviceId,
    command: 'REFRESH',
    payload: { requestedBy: admin.email },
    requested_by: admin.id,
  });
  if (error) return actionFromDbError(error);
  revalidatePath('/devices');
  return actionOk('Sync requested.');
}

const ClockSyncSchema = z.object({
  browserIso: z.iso.datetime(),
});

export async function syncLocalKioskClock(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (!isLocalBackend()) return actionFail('Clock sync is only available on the local Raspberry Pi dashboard.');

  const parsed = ClockSyncSchema.safeParse({ browserIso: formData.get('browserIso') });
  if (!parsed.success) return actionFail('Invalid browser timestamp.');

  const browserMs = new Date(parsed.data.browserIso).getTime();
  const systemMs = Date.now();
  const offsetMs = browserMs - systemMs;

  const db = getLocalDb();
  const bootCount = getLocalConfig(db, 'boot_count') ?? '0';
  db.transaction(() => {
    setLocalConfig(db, 'clock_offset_ms', String(offsetMs));
    setLocalConfig(db, 'clock_trusted_at', parsed.data.browserIso);
    setLocalConfig(db, 'clock_trusted_boot_count', bootCount);
  })();

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'KIOSK_CLOCK_SYNCED',
    targetType: 'device',
    targetId: getLocalConfig(db, 'device_id') ?? 'DEVICE-CALC-KIOSK-001',
    newValue: { browserTime: parsed.data.browserIso, offsetSeconds: Math.round(offsetMs / 1000) },
  });

  revalidatePath('/devices');
  return actionOk(`Kiosk clock synced to ${formatPhilippineDateTime(parsed.data.browserIso)} (PH time).`);
}
