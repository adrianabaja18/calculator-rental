import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DEVICE_ID_HEADER,
  ErrorCode,
  EventSeverity,
  EventType,
  HeartbeatRequestSchema,
  MAX_CLOCK_DRIFT_SECONDS,
  type HeartbeatReply,
} from '@calc-rental/shared';
import { authenticateDevice } from '@/lib/device-auth';
import { jsonError, jsonOk } from '@/lib/http';
import { getLocalConfig, getLocalDb, setLocalConfig } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function verifyLocalDeviceRequest(request: Request): { ok: true; deviceCode: string } | { ok: false; response: Response } {
  const deviceCode = request.headers.get(DEVICE_ID_HEADER)?.trim() ?? '';
  const authHeader = request.headers.get('authorization') ?? '';
  const secret = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  const db = getLocalDb();
  const expectedDevice = getLocalConfig(db, 'device_id') ?? process.env.DEVICE_ID?.trim() ?? 'DEVICE-CALC-KIOSK-001';
  const expectedSecret = process.env.DEVICE_SECRET?.trim() || 'dev-only-placeholder-secret-change-me';

  const actualHash = createHash('sha256').update(secret).digest();
  const expectedHash = createHash('sha256').update(expectedSecret).digest();

  if (!deviceCode || deviceCode !== expectedDevice || !timingSafeEqual(actualHash, expectedHash)) {
    return { ok: false, response: jsonError(ErrorCode.UNAUTHORIZED, 'Invalid device credentials.', 401) };
  }
  return { ok: true, deviceCode };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(ErrorCode.VALIDATION_ERROR, 'Body must be JSON.', 400);
  }
  const parsed = HeartbeatRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError(ErrorCode.VALIDATION_ERROR, 'Invalid heartbeat.', 400);
  const beat = parsed.data;

  const serverNow = new Date();
  const clockDriftSeconds = Math.round((new Date(beat.sentAt).getTime() - serverNow.getTime()) / 1000);

  if (isLocalBackend()) {
    const auth = verifyLocalDeviceRequest(request);
    if (!auth.ok) return auth.response;

    const db = getLocalDb();
    db.transaction(() => {
      setLocalConfig(
        db,
        'kiosk_heartbeat',
        JSON.stringify({
          lastHeartbeatAt: serverNow.toISOString(),
          softwareVersion: beat.softwareVersion,
          kioskState: beat.kioskState,
          cpuTempC: beat.cpuTempC,
          clockDriftSeconds,
          localDbOk: beat.localDbOk,
          sync: beat.sync ?? null,
        }),
      );
      for (const l of beat.lockers ?? []) {
        db.prepare(
          `UPDATE lockers SET lock_state = ?, door_state = ?, rfid_state = ?, last_detected_rfid_uid = ?, last_seen_at = ?
           WHERE id = ?`,
        ).run(l.lockState, l.doorState, l.rfidState, l.detectedRfidUid, l.lastSeenAt, l.id);
      }
    })();

    const reply: HeartbeatReply = {
      deviceCode: auth.deviceCode,
      serverTime: serverNow.toISOString(),
      clockDriftSeconds,
    };
    return jsonOk(reply, { headers: { 'Cache-Control': 'no-store' } });
  }

  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;

  const clockOk = Math.abs(clockDriftSeconds) <= MAX_CLOCK_DRIFT_SECONDS;
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  const db = createSupabaseAdminClient();
  const { error } = await db
    .from('device_registry')
    .update({
      last_heartbeat_at: serverNow.toISOString(),
      software_version: beat.softwareVersion,
      ip_address: ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null,
      network_state: 'ONLINE',
      cpu_temp_c: beat.cpuTempC,
      sync_queue_count: beat.syncQueueCount,
      local_db_ok: beat.localDbOk,
      health: beat.localDbOk && clockOk && !beat.sync?.failedItems ? 'OK' : 'DEGRADED',
      last_health: { kioskState: beat.kioskState, clockDriftSeconds, sync: beat.sync ?? null },
    })
    .eq('id', auth.device.id);
  if (error) return jsonError(ErrorCode.DATABASE_UNAVAILABLE, 'Could not record heartbeat.', 503);

  await Promise.all(
    (beat.lockers ?? []).map((l) =>
      db
        .from('lockers')
        .update({
          lock_state: l.lockState,
          door_state: l.doorState,
          rfid_state: l.rfidState,
          last_detected_rfid_uid: l.detectedRfidUid,
          last_seen_at: l.lastSeenAt,
        })
        .eq('id', l.id)
        .eq('device_id', auth.device.id),
    ),
  );

  if (!clockOk) {
    await db.from('device_events').insert({
      device_id: auth.device.id,
      event_type: EventType.SYSTEM_ERROR,
      severity: EventSeverity.WARNING,
      message: `Kiosk clock is ${clockDriftSeconds} s off the server clock`,
      payload: { clockDriftSeconds, kioskTime: beat.sentAt, serverTime: serverNow.toISOString() },
      occurred_at: serverNow.toISOString(),
    });
  }

  const reply: HeartbeatReply = {
    deviceCode: auth.device.deviceCode,
    serverTime: serverNow.toISOString(),
    clockDriftSeconds,
  };
  return jsonOk(reply, { headers: { 'Cache-Control': 'no-store' } });
}
