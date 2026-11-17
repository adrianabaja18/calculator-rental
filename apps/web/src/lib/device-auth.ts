import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DEVICE_ID_HEADER, DeviceCodeSchema, ErrorCode } from '@calc-rental/shared';
import { jsonError } from '@/lib/http';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Device authentication for kiosk APIs (spec §19, architecture §3.4).
 *
 * The Pi sends `x-device-id` + `Authorization: Bearer <secret>`. The server
 * stores only SHA-256(secret) in device_credentials, compares in constant
 * time, and checks the device is enabled. Every failure returns the same
 * 401, so a caller can't learn which part was wrong.
 */

export interface AuthenticatedDevice {
  id: string;
  deviceCode: string;
}

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret with the stored hash. */
export function deviceSecretMatches(secret: string, storedHashHex: string): boolean {
  const presented = Buffer.from(hashDeviceSecret(secret), 'hex');
  const stored = Buffer.from(storedHashHex, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

const unauthorized = () => jsonError(ErrorCode.DEVICE_UNAUTHORIZED, 'Device not authorized.', 401);

export async function authenticateDevice(
  request: Request,
): Promise<{ ok: true; device: AuthenticatedDevice } | { ok: false; response: Response }> {
  const code = DeviceCodeSchema.safeParse(request.headers.get(DEVICE_ID_HEADER) ?? '');
  const secret = /^Bearer (.{16,200})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!code.success || !secret) return { ok: false, response: unauthorized() };

  const db = createSupabaseAdminClient();
  const { data: device } = await db
    .from('device_registry')
    .select('id, device_code, is_enabled, device_credentials(secret_hash)')
    .eq('device_code', code.data)
    .maybeSingle();

  const credentials = device?.device_credentials as { secret_hash: string } | { secret_hash: string }[] | null | undefined;
  const hash = Array.isArray(credentials) ? credentials[0]?.secret_hash : credentials?.secret_hash;
  if (!device || !device.is_enabled || !hash || !deviceSecretMatches(secret, hash)) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, device: { id: device.id, deviceCode: device.device_code } };
}
