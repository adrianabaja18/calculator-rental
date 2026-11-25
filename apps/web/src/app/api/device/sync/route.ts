import { z } from 'zod';
import {
  ErrorCode,
  SYNC_PULL_PAGE_SIZE,
  SyncPushRequestSchema,
  type SyncPullReply,
  type SyncPushReply,
} from '@calc-rental/shared';
import { authenticateDevice } from '@/lib/device-auth';
import { jsonError, jsonOk } from '@/lib/http';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';

/**
 * Kiosk ↔ Supabase sync (Phase 12, SQLite-first).
 *
 * POST  kiosk outbox → Supabase. Items are applied IN ORDER by the database
 *       function apply_kiosk_sync (one sub-transaction each). The reply says
 *       how far it got, so the kiosk marks exactly those items as synced.
 *       It also carries officer commands (Phase 13) both ways.
 * GET   officer data → kiosk: settings, this kiosk's lockers, all calculators,
 *       and students / penalties changed since the kiosk's cursors (paged).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
/** Re-send the last few seconds on every pull, in case a slow transaction committed late. */
const CURSOR_OVERLAP_MS = 30_000;

const RpcResultSchema = z.object({
  appliedThroughSeq: z.number().int().nullable(),
  applied: z.number().int().nonnegative(),
  failure: z.object({ seq: z.number().int(), entity: z.string().nullable(), message: z.string() }).nullable(),
});

export async function POST(request: Request) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(ErrorCode.VALIDATION_ERROR, 'Body must be JSON.', 400);
  }
  const parsed = SyncPushRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError(ErrorCode.VALIDATION_ERROR, 'Invalid sync batch.', 400);

  const serverTime = new Date().toISOString();
  const db = createSupabaseAdminClient();

  let result: z.infer<typeof RpcResultSchema> = { appliedThroughSeq: null, applied: 0, failure: null };
  if (parsed.data.items.length > 0) {
    const { data, error } = await db.rpc('apply_kiosk_sync', {
      p_device_id: auth.device.id,
      p_items: parsed.data.items as unknown as Json,
    });
    if (error) return jsonError(ErrorCode.DATABASE_UNAVAILABLE, 'Could not apply the sync batch.', 503);
    const rpc = RpcResultSchema.safeParse(data);
    if (!rpc.success) return jsonError(ErrorCode.INTERNAL_ERROR, 'Unexpected sync result.', 500);
    result = rpc.data;
  }

  const failure = result.failure;
  await db
    .from('device_registry')
    .update({
      ...(result.applied > 0 || !failure ? { last_sync_at: serverTime } : {}),
      last_sync_error: failure ? `seq ${failure.seq} (${failure.entity}): ${failure.message}`.slice(0, 500) : null,
    })
    .eq('id', auth.device.id);

  const commands = await exchangeCommands(db, auth.device.id, parsed.data.commandResults, serverTime);
  const reply: SyncPushReply = { ...result, serverTime, commands };
  return jsonOk(reply, NO_STORE);
}

/**
 * Phase 13 officer commands: record the kiosk's results, expire commands
 * nobody picked up in time, and hand out the pending ones (marked SENT).
 */
async function exchangeCommands(
  db: ReturnType<typeof createSupabaseAdminClient>,
  deviceId: string,
  results: { id: string; status: 'DONE' | 'FAILED'; message: string }[],
  serverTime: string,
): Promise<SyncPushReply['commands']> {
  for (const r of results) {
    await db
      .from('device_commands')
      .update({ status: r.status, completed_at: serverTime, result_message: r.message })
      .eq('id', r.id)
      .eq('device_id', deviceId)
      .in('status', ['PENDING', 'SENT']);
  }
  await db
    .from('device_commands')
    .update({ status: 'EXPIRED', completed_at: serverTime, result_message: 'The kiosk did not pick it up in time.' })
    .eq('device_id', deviceId)
    .in('status', ['PENDING', 'SENT'])
    .lt('expires_at', serverTime);

  const { data: pending } = await db
    .from('device_commands')
    .update({ status: 'SENT', sent_at: serverTime })
    .eq('device_id', deviceId)
    .eq('status', 'PENDING')
    .select('id, command, payload, requested_at');
  return (pending ?? [])
    .filter((c) => c.command === 'UNLOCK_LOCKER' || c.command === 'REFRESH')
    .map((c) => ({
      id: c.id,
      command: c.command as 'UNLOCK_LOCKER' | 'REFRESH',
      payload: (c.payload ?? {}) as Record<string, unknown>,
      requestedAt: c.requested_at,
    }));
}

const cursorParam = z.iso.datetime({ offset: true }).nullable().catch(null);

export async function GET(request: Request) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const studentsSince = cursorParam.parse(url.searchParams.get('students'));
  const penaltiesSince = cursorParam.parse(url.searchParams.get('penalties'));
  const serverNow = new Date();
  const db = createSupabaseAdminClient();

  let studentsQuery = db
    .from('students')
    .select('id, student_number, full_name, course_program, status, blocked_reason, updated_at')
    .order('updated_at')
    .limit(SYNC_PULL_PAGE_SIZE);
  if (studentsSince) studentsQuery = studentsQuery.gt('updated_at', studentsSince);

  let penaltiesQuery = db
    .from('penalties')
    .select('id, rental_transaction_id, student_id, reason, overdue_minutes, calculated_amount, waived_amount, amount_paid, status, updated_at')
    .order('updated_at')
    .limit(SYNC_PULL_PAGE_SIZE);
  if (penaltiesSince) penaltiesQuery = penaltiesQuery.gt('updated_at', penaltiesSince);

  const [settings, lockers, calculators, students, penalties] = await Promise.all([
    db.from('system_settings').select('*').eq('id', 1).single(),
    db.from('lockers').select('id, locker_number, name, hardware_channel, status').eq('device_id', auth.device.id),
    db.from('calculators').select('id, code, model, rfid_uid, locker_id, status, condition'),
    studentsQuery,
    penaltiesQuery,
  ]);
  if (settings.error || lockers.error || calculators.error || students.error || penalties.error) {
    return jsonError(ErrorCode.DATABASE_UNAVAILABLE, 'Could not read sync data.', 503);
  }

  // A full page: continue from its last row. Caught up: continue from "now",
  // minus a small overlap (applying a row twice is harmless).
  const caughtUp = new Date(serverNow.getTime() - CURSOR_OVERLAP_MS).toISOString();
  const nextCursor = (rows: { updated_at: string }[]) =>
    rows.length === SYNC_PULL_PAGE_SIZE ? rows[rows.length - 1]!.updated_at : caughtUp;

  await db.from('device_registry').update({ last_pull_at: serverNow.toISOString() }).eq('id', auth.device.id);

  const reply: SyncPullReply = {
    serverTime: serverNow.toISOString(),
    settings: settings.data as unknown as Record<string, unknown>,
    lockers: lockers.data,
    calculators: calculators.data,
    students: students.data,
    penalties: penalties.data.map((p) => ({
      ...p,
      calculated_amount: Number(p.calculated_amount),
      waived_amount: Number(p.waived_amount),
      amount_paid: Number(p.amount_paid),
    })),
    cursors: { students: nextCursor(students.data), penalties: nextCursor(penalties.data) },
    hasMore: students.data.length === SYNC_PULL_PAGE_SIZE || penalties.data.length === SYNC_PULL_PAGE_SIZE,
  };
  return jsonOk(reply, NO_STORE);
}
