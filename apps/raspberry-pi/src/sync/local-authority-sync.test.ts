import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CalculatorCondition, CalculatorStatus, LockerStatus, PenaltyStatus, StudentStatus, type SyncItem } from '@calc-rental/shared';
import { DEV_IDS, DEV_SETTINGS, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { openLocalDatabase } from '../db/sqlite';
import { SEED_DEVICE_ID as DEVICE, startTestSupabase } from './test-supabase';

let pg: PGlite;
let store: KioskStore;

beforeAll(async () => {
  pg = await startTestSupabase();
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec('begin');
  store = new KioskStore(openLocalDatabase(':memory:'));
  seedDevData(store, { sensorsReady: true, nowIso: '2026-10-20T02:00:00.000Z' });
  return async () => {
    await pg.exec('rollback');
  };
});

async function applyToSupabase(items: SyncItem[]) {
  const result = await pg.query<{ r: { appliedThroughSeq: number | null; applied: number; failure: { seq: number; message: string } | null } }>(
    'select public.apply_kiosk_sync($1, $2::jsonb) as r',
    [DEVICE, JSON.stringify(items)],
  );
  return result.rows[0]!.r;
}

describe('local Raspberry Pi officer actions → online read-only Supabase sync', () => {
  it('syncs local student block, locker maintenance, calculator edit, settings, penalty waiver, and audit log to Supabase', async () => {
    const nowIso = '2026-10-20T03:00:00.000Z';

    // 1. Block student locally
    store.db
      .prepare('UPDATE students SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
      .run(StudentStatus.BLOCKED, 'Damaged keypad on local Pi', nowIso, DEV_IDS.juan);
    store.enqueue('student_admin', DEV_IDS.juan, store.db.prepare('SELECT * FROM students WHERE id = ?').get(DEV_IDS.juan));

    // 2. Locker maintenance + notes locally
    store.db
      .prepare('UPDATE lockers SET status = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(LockerStatus.MAINTENANCE, 'Solenoid inspection', nowIso, DEV_IDS.locker2);
    store.enqueue('locker', DEV_IDS.locker2, store.db.prepare('SELECT * FROM lockers WHERE id = ?').get(DEV_IDS.locker2));

    // 3. Update calculator RFID UID locally
    store.db
      .prepare('UPDATE calculators SET rfid_uid = ?, condition = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run('FE-AC-31-03', CalculatorCondition.GOOD, 'Tag A installed', nowIso, DEV_IDS.calc1);
    store.enqueue('calculator', DEV_IDS.calc1, store.db.prepare('SELECT * FROM calculators WHERE id = ?').get(DEV_IDS.calc1));

    // 4. Create new calculator locally
    const calc3Id = randomUUID();
    store.db
      .prepare(
        `INSERT INTO calculators (id, code, model, rfid_uid, locker_id, status, condition, notes, updated_at)
         VALUES (?, 'CALC-003', 'Casio fx-991CW', 'AA-BB-CC-DD', NULL, ?, ?, 'Spare unit', ?)`,
      )
      .run(calc3Id, CalculatorStatus.MAINTENANCE, CalculatorCondition.GOOD, nowIso);
    store.enqueue('calculator', calc3Id, store.db.prepare('SELECT * FROM calculators WHERE id = ?').get(calc3Id));

    // 5. Update settings locally
    const updatedSettings = { ...DEV_SETTINGS, rentalFee: 25, gracePeriodMinutes: 15 };
    store.saveSettings(updatedSettings, nowIso);
    store.enqueue('settings', '1', updatedSettings);

    // 6. Create a completed rental + locally waived penalty (by local admin, no Supabase profile UUID)
    const rentalId = randomUUID();
    store.insertRental({
      id: rentalId,
      transaction_code: 'RNT-20261020-LOCAL1',
      student_id: DEV_IDS.maria,
      calculator_id: DEV_IDS.calc1,
      locker_id: DEV_IDS.locker1,
      status: 'COMPLETED',
      rental_fee_centavos: 2000,
      amount_paid_centavos: 2000,
      rental_duration_minutes: 180,
      settings_snapshot: JSON.stringify(DEV_SETTINGS),
      reserved_at: '2026-10-20T01:00:00.000Z',
      payment_expires_at: null,
      paid_at: '2026-10-20T01:01:00.000Z',
      rented_at: '2026-10-20T01:02:00.000Z',
      due_at: '2026-10-20T02:00:00.000Z',
      return_started_at: '2026-10-20T02:50:00.000Z',
      returned_at: '2026-10-20T02:55:00.000Z',
      ended_at: null,
      was_overdue: 1,
      overdue_minutes: 55,
      rental_rfid_verified: 1,
      return_rfid_verified: 1,
      return_rfid_uid: 'FE-AC-31-03',
      failure_reason: null,
      created_at: '2026-10-20T01:00:00.000Z',
      updated_at: nowIso,
    });
    const penalty = store.quoteOverduePenalty({ id: rentalId, student_id: DEV_IDS.maria }, { overdueMinutes: 55, calculatedCentavos: 1000 }, randomUUID(), nowIso);
    store.db
      .prepare(
        `UPDATE penalties SET waived_centavos = 1000, amount_due_centavos = 0, status = ?, waived_by = ?, waived_at = ?, waive_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(PenaltyStatus.WAIVED, randomUUID(), nowIso, 'First-time courtesy waiver on Pi', nowIso, penalty.id);
    store.enqueue('penalty', penalty.id, store.db.prepare('SELECT * FROM penalties WHERE id = ?').get(penalty.id));

    // 7. Local audit log entry
    const auditId = randomUUID();
    store.enqueue('audit_log', auditId, {
      id: auditId,
      actor_type: 'ADMIN',
      actor_id: randomUUID(),
      actor_label: 'admin@calcrental.ph',
      action: 'PENALTY_WAIVED',
      target_type: 'penalty',
      target_id: penalty.id,
      previous_value: { status: 'UNPAID' },
      new_value: { status: 'WAIVED' },
      reason: 'First-time courtesy waiver on Pi',
      created_at: nowIso,
    });

    const items: SyncItem[] = store.nextSyncBatch(100, '9999-12-31').map((b) => ({
      seq: b.seq,
      entity: b.entity,
      payload: JSON.parse(b.payload),
    }));

    const res = await applyToSupabase(items);
    expect(res.failure).toBeNull();
    expect(res.applied).toBe(items.length);

    const student = (await pg.query(`SELECT status, blocked_reason FROM public.students WHERE id = $1`, [DEV_IDS.juan])).rows[0];
    expect(student).toEqual({ status: 'BLOCKED', blocked_reason: 'Damaged keypad on local Pi' });

    const locker = (await pg.query(`SELECT status, notes FROM public.lockers WHERE id = $1`, [DEV_IDS.locker2])).rows[0];
    expect(locker).toEqual({ status: 'MAINTENANCE', notes: 'Solenoid inspection' });

    const calc1 = (await pg.query(`SELECT rfid_uid, notes FROM public.calculators WHERE id = $1`, [DEV_IDS.calc1])).rows[0];
    expect(calc1).toEqual({ rfid_uid: 'FE-AC-31-03', notes: 'Tag A installed' });

    const calc3 = (await pg.query(`SELECT code, status FROM public.calculators WHERE id = $1`, [calc3Id])).rows[0];
    expect(calc3).toEqual({ code: 'CALC-003', status: 'MAINTENANCE' });

    const settings = (await pg.query(`SELECT rental_fee::float AS fee, grace_period_minutes AS grace FROM public.system_settings WHERE id = 1`)).rows[0];
    expect(settings).toEqual({ fee: 25, grace: 15 });

    const cloudPenalty = (await pg.query(`SELECT status, waived_amount::float AS waived, waive_reason FROM public.penalties WHERE id = $1`, [penalty.id])).rows[0];
    expect(cloudPenalty).toEqual({
      status: 'WAIVED',
      waived: 10,
      waive_reason: 'First-time courtesy waiver on Pi',
    });

    const cloudAudit = (await pg.query(`SELECT actor_label, action FROM public.audit_logs WHERE sync_id = $1`, [auditId])).rows[0];
    expect(cloudAudit).toEqual({ actor_label: 'admin@calcrental.ph', action: 'PENALTY_WAIVED' });
  });

  it('claims and completes local SQLite device commands', () => {
    const cmdId = randomUUID();
    const nowIso = '2026-10-20T03:00:00.000Z';
    store.db
      .prepare(
        `INSERT INTO device_commands (id, device_code, command, payload, reason, status, requested_by, requested_at, expires_at)
         VALUES (?, 'DEVICE-CALC-KIOSK-001', 'UNLOCK_LOCKER', ?, 'Stuck door', 'PENDING', 'admin', ?, '2026-10-20T03:02:00.000Z')`,
      )
      .run(cmdId, JSON.stringify({ lockerId: DEV_IDS.locker1, lockerNumber: 1 }), nowIso);

    const claimed = store.claimLocalCommands('2026-10-20T03:00:05.000Z');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe(cmdId);

    store.completeLocalCommand(cmdId, 'DONE', 'Unlocked Locker 1 for 10s.', '2026-10-20T03:00:06.000Z');
    const finalRow = store.db.prepare('SELECT status, result_message FROM device_commands WHERE id = ?').get(cmdId);
    expect(finalRow).toEqual({ status: 'DONE', result_message: 'Unlocked Locker 1 for 10s.' });
  });
});
