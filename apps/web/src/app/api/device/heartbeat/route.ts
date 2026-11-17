import {
  ErrorCode,
  EventSeverity,
  EventType,
  HeartbeatRequestSchema,
  MAX_CLOCK_DRIFT_SECONDS,
  type HeartbeatReply,
} from '@calc-rental/shared';
import { authenticateDevice } from '@/lib/device-auth';
import { jsonError, jsonOk } from '@/lib/http';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/device/heartbeat  — kiosk → backend every 30 s (spec §32).
 *
 * Records the kiosk as alive (v_device_status turns ONLINE) with its software
 * version, kiosk state, sync backlog and CPU temperature, and returns the
 * server clock so the kiosk can detect drift (no RTC on the Pi).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;

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
      health: beat.localDbOk && clockOk ? 'OK' : 'DEGRADED',
      last_health: { kioskState: beat.kioskState, clockDriftSeconds },
    })
    .eq('id', auth.device.id);
  if (error) return jsonError(ErrorCode.DATABASE_UNAVAILABLE, 'Could not record heartbeat.', 503);

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
