import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { SyncPullReply, SyncPushReply } from '@calc-rental/shared';
import type { BackendResult } from '../backend/client';
import type { SyncTransport } from './sync-service';

/**
 * TEST HELPER: a local "Supabase" = PGlite (Postgres in-process) with the
 * REAL migrations and seed, plus a SyncTransport that does what the
 * /api/device/sync route does (push via apply_kiosk_sync, commands, pull).
 * Never used by the kiosk itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const supabaseDir = path.resolve(here, '../../../../supabase');

export const SEED_DEVICE_ID = '00000000-0000-4000-8000-000000000001';

export async function startTestSupabase(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(supabaseDir, 'tests/supabase-stubs.sql'), 'utf8'));
  for (const file of fs.readdirSync(path.join(supabaseDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(supabaseDir, 'migrations', file), 'utf8'));
  }
  await pg.exec(fs.readFileSync(path.join(supabaseDir, 'seed.sql'), 'utf8'));
  return pg;
}

const ok = <T>(data: T): BackendResult<T> => ({ ok: true, data, latencyMs: 1, httpStatus: 200 });

/** Same behaviour as apps/web/src/app/api/device/sync/route.ts, against PGlite. */
export function pgTransport(pg: PGlite, deviceId = SEED_DEVICE_ID): SyncTransport & { online: boolean } {
  const transport = {
    online: true,
    async syncPush(batch: Parameters<SyncTransport['syncPush']>[0]): Promise<BackendResult<SyncPushReply>> {
      if (!transport.online) return { ok: false, code: 'NETWORK_OFFLINE', message: 'offline', latencyMs: null, httpStatus: null };
      const serverTime = new Date().toISOString();
      let result: Omit<SyncPushReply, 'serverTime' | 'commands'> = { appliedThroughSeq: null, applied: 0, failure: null };
      if (batch.items.length > 0) {
        const { rows } = await pg.query<{ r: typeof result }>('select public.apply_kiosk_sync($1, $2::jsonb) as r', [deviceId, JSON.stringify(batch.items)]);
        result = rows[0]!.r;
      }
      for (const r of batch.commandResults ?? []) {
        await pg.query(
          `update public.device_commands set status = $1, completed_at = now(), result_message = $2 where id = $3 and status in ('PENDING', 'SENT')`,
          [r.status, r.message, r.id],
        );
      }
      const { rows: commands } = await pg.query<{ id: string; command: 'UNLOCK_LOCKER' | 'REFRESH'; payload: Record<string, unknown>; requested_at: Date }>(
        `update public.device_commands set status = 'SENT', sent_at = now()
         where device_id = $1 and status = 'PENDING' and expires_at > now()
         returning id, command, payload, requested_at`,
        [deviceId],
      );
      return ok({
        ...result,
        serverTime,
        commands: commands.map((c) => ({ id: c.id, command: c.command, payload: c.payload, requestedAt: new Date(c.requested_at).toISOString() })),
      });
    },
    async syncPull(cursors: { students: string | null; penalties: string | null }): Promise<BackendResult<SyncPullReply>> {
      if (!transport.online) return { ok: false, code: 'NETWORK_OFFLINE', message: 'offline', latencyMs: null, httpStatus: null };
      const iso = (v: unknown) => new Date(v as string).toISOString();
      const settings = (await pg.query<Record<string, unknown>>('select * from public.system_settings where id = 1')).rows[0]!;
      const lockers = (await pg.query<SyncPullReply['lockers'][number]>(
        'select id, locker_number, name, hardware_channel, status from public.lockers where device_id = $1', [deviceId])).rows;
      const calculators = (await pg.query<SyncPullReply['calculators'][number]>(
        'select id, code, model, rfid_uid, locker_id, status, condition from public.calculators')).rows;
      const students = (await pg.query<SyncPullReply['students'][number]>(
        `select id, student_number, full_name, course_program, status, blocked_reason, updated_at from public.students
         where $1::timestamptz is null or updated_at > $1::timestamptz order by updated_at`, [cursors.students])).rows;
      const penalties = (await pg.query<SyncPullReply['penalties'][number]>(
        `select id, rental_transaction_id, student_id, reason, overdue_minutes, calculated_amount::float, waived_amount::float,
                amount_paid::float, status, updated_at from public.penalties
         where $1::timestamptz is null or updated_at > $1::timestamptz order by updated_at`, [cursors.penalties])).rows;
      const caughtUp = new Date(Date.now() - 30_000).toISOString();
      return ok({
        serverTime: new Date().toISOString(),
        settings: { ...settings, rental_fee: String(settings.rental_fee), penalty_amount: String(settings.penalty_amount) },
        lockers,
        calculators,
        students: students.map((s) => ({ ...s, updated_at: iso(s.updated_at) })),
        penalties: penalties.map((p) => ({ ...p, updated_at: iso(p.updated_at) })),
        cursors: { students: caughtUp, penalties: caughtUp },
        hasMore: false,
      });
    },
  };
  return transport;
}
