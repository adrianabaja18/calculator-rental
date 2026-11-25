import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, type SyncPullReply, type SyncPushReply, type SyncPushRequest } from '@calc-rental/shared';
import type { BackendResult } from '../backend/client';
import { DEV_IDS, DEV_RFID, seedDevData } from '../db/dev-seed';
import { KioskStore } from '../db/kiosk-store';
import { getLocalConfig, openLocalDatabase } from '../db/sqlite';
import { SyncService, type SyncTransport } from './sync-service';

let store: KioskStore;
let clock: Date;
let sent: SyncPushRequest[];
let pushReply: (req: SyncPushRequest) => BackendResult<SyncPushReply>;
let pullReplies: Array<BackendResult<SyncPullReply>>;
let pullCursors: Array<{ students: string | null; penalties: string | null }>;

const ok = <T>(data: T): BackendResult<T> => ({ ok: true, data, latencyMs: 1, httpStatus: 200 });
const offline: BackendResult<never> = { ok: false, code: ErrorCode.NETWORK_OFFLINE, message: 'offline', latencyMs: null, httpStatus: null };

const transport: SyncTransport = {
  syncPush: async (req) => {
    sent.push(req);
    return pushReply(req);
  },
  syncPull: async (cursors) => {
    pullCursors.push(cursors);
    return pullReplies.shift() ?? offline;
  },
};

/** The seeded Supabase settings row (₱20 / 3 h, ₱10 per 1.5 h). */
const SETTINGS_ROW = {
  rental_fee: '20.00',
  rental_duration_minutes: 180,
  grace_period_minutes: 10,
  penalty_enabled: true,
  penalty_type: 'PER_INTERVAL',
  penalty_amount: '10.00',
  penalty_interval_minutes: 90,
  penalty_steps: [],
  max_penalty: null,
  max_concurrent_rentals_per_student: 1,
  unpaid_penalty_blocks_rental: true,
  accepted_coin_denominations: [1, 5, 10, 20],
  payment_timeout_seconds: 120,
  removal_timeout_seconds: 60,
  return_timeout_seconds: 90,
  allow_offline_returns: true,
  allow_offline_rentals: false,
};

function pullReply(over: Partial<SyncPullReply> = {}): SyncPullReply {
  return {
    serverTime: '2026-10-20T02:00:00.000+00:00',
    settings: SETTINGS_ROW,
    lockers: [
      { id: DEV_IDS.locker1, locker_number: 1, name: 'Locker 1', hardware_channel: 1, status: 'AVAILABLE' },
      { id: DEV_IDS.locker2, locker_number: 2, name: 'Locker 2', hardware_channel: 2, status: 'AVAILABLE' },
    ],
    calculators: [
      { id: DEV_IDS.calc1, code: 'CALC-001', model: 'Casio fx-991EX ClassWiz', rfid_uid: DEV_RFID.calc1, locker_id: DEV_IDS.locker1, status: 'AVAILABLE', condition: 'GOOD' },
      { id: DEV_IDS.calc2, code: 'CALC-002', model: 'Casio fx-991EX ClassWiz', rfid_uid: DEV_RFID.calc2, locker_id: DEV_IDS.locker2, status: 'AVAILABLE', condition: 'GOOD' },
    ],
    students: [],
    penalties: [],
    cursors: { students: '2026-10-20T01:59:30.000+00:00', penalties: '2026-10-20T01:59:30.000+00:00' },
    hasMore: false,
    ...over,
  };
}

beforeEach(() => {
  store = new KioskStore(openLocalDatabase(':memory:'));
  clock = new Date('2026-10-20T02:00:00.000Z');
  seedDevData(store, { sensorsReady: true, nowIso: clock.toISOString() });
  sent = [];
  pullReplies = [];
  pullCursors = [];
  pushReply = (req) => ok({ appliedThroughSeq: req.items.at(-1)?.seq ?? null, applied: req.items.length, failure: null, serverTime: clock.toISOString() });
});

const sync = (opts = {}) => new SyncService(store, transport, { now: () => clock, batchSize: 3, ...opts });
const event = (message: string) => store.recordEvent({ type: 'SYSTEM_ERROR', severity: 'INFO', message, occurredAt: clock.toISOString() });

describe('push', () => {
  it('sends the outbox oldest-first in batches and marks it synced', async () => {
    for (let i = 0; i < 7; i++) event(`e${i}`);
    const result = await sync().push();
    expect(result).toEqual({ sent: 7, ok: true });
    expect(sent.map((b) => b.items.length)).toEqual([3, 3, 1]);
    expect(sent.flatMap((b) => b.items.map((i) => i.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(store.pendingSyncCount()).toBe(0);
  });

  it('keeps everything when offline, and sends it once the network is back', async () => {
    event('a');
    pushReply = () => offline;
    const s = sync();
    expect(await s.push()).toEqual({ sent: 0, ok: false });
    expect(store.pendingSyncCount()).toBe(1);
    expect(s.status().lastError).toMatch(/offline/);

    pushReply = (req) => ok({ appliedThroughSeq: req.items.at(-1)!.seq, applied: 1, failure: null, serverTime: clock.toISOString() });
    expect(await s.push()).toEqual({ sent: 1, ok: true });
    expect(s.status().lastError).toBeNull();
  });

  it('a refused item is retried later with back-off and nothing after it is skipped ahead', async () => {
    event('a');
    event('b');
    pushReply = (req) => ok({ appliedThroughSeq: null, applied: 0, failure: { seq: req.items[0]!.seq, entity: 'device_event', message: 'boom' }, serverTime: clock.toISOString() });
    const s = sync();
    await s.push();
    expect(sent).toHaveLength(1);
    await s.push(); // still inside the 10 s back-off: nothing is sent
    expect(sent).toHaveLength(1);
    clock = new Date(clock.getTime() + 11_000);
    await s.push();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.items[0]!.seq).toBe(1); // same item first, order kept
  });

  it('sets an item aside after too many attempts so the rest can sync, and logs a CRITICAL event', async () => {
    event('poison');
    event('fine');
    pushReply = (req) =>
      req.items[0]!.seq === 1
        ? ok({ appliedThroughSeq: null, applied: 0, failure: { seq: 1, entity: 'device_event', message: 'bad row' }, serverTime: clock.toISOString() })
        : ok({ appliedThroughSeq: req.items.at(-1)!.seq, applied: req.items.length, failure: null, serverTime: clock.toISOString() });
    const s = sync({ maxAttempts: 2 });
    await s.push();
    clock = new Date(clock.getTime() + 60_000);
    await s.push(); // 2nd attempt → given up
    expect(store.failedSyncCount()).toBe(1);
    expect(store.db.prepare(`SELECT severity FROM device_events WHERE event_type = 'SYNC_FAILED'`).get()).toEqual({ severity: 'CRITICAL' });

    await s.push();
    expect(store.pendingSyncCount()).toBe(0); // 'fine' and the SYNC_FAILED event went through
    expect(s.status().failedItems).toBe(1);
  });
});

describe('pull', () => {
  it('applies dashboard settings and saves the cursors for next time', async () => {
    pullReplies.push(ok(pullReply({ settings: { ...SETTINGS_ROW, rental_fee: '25.00' } })));
    const result = await sync().pull();
    expect(result.summary?.settingsChanged).toBe(true);
    expect(store.getSettings()?.rentalFee).toBe(25);
    expect(getLocalConfig(store.db, 'sync_cursor_students')).toBe('2026-10-20T01:59:30.000+00:00');
    expect(pullCursors[0]).toEqual({ students: null, penalties: null });
  });

  it('keeps the current settings when the dashboard sends invalid ones', async () => {
    pullReplies.push(ok(pullReply({ settings: { ...SETTINGS_ROW, rental_fee: '-1' } })));
    await sync().pull();
    expect(store.getSettings()?.rentalFee).toBe(20);
  });

  it('follows pages until hasMore is false', async () => {
    pullReplies.push(ok(pullReply({ hasMore: true, cursors: { students: 'A', penalties: null } as never })));
    pullReplies.push(ok(pullReply()));
    await sync().pull();
    expect(pullCursors).toHaveLength(2);
    expect(pullCursors[1]).toEqual({ students: 'A', penalties: null });
  });

  it('applies the real RFID UIDs officers typed on the dashboard (even swapped between calculators)', async () => {
    const reply = pullReply();
    reply.calculators[0]!.rfid_uid = DEV_RFID.calc2;
    reply.calculators[1]!.rfid_uid = DEV_RFID.calc1;
    pullReplies.push(ok(reply));
    const result = await sync().pull();
    expect(result.summary?.warnings).toEqual([]);
    expect(store.listLockerHardware().map((l) => l.expectedUid)).toEqual([DEV_RFID.calc2, DEV_RFID.calc1]);
  });

  it('officer maintenance and student blocks reach the kiosk', async () => {
    const reply = pullReply({
      students: [
        {
          id: DEV_IDS.juan,
          student_number: '2022100001',
          full_name: 'JUAN DELA CRUZ',
          course_program: 'BSCpE',
          status: 'BLOCKED',
          blocked_reason: 'Lost a calculator',
          updated_at: '2026-10-20T01:00:00.000+00:00',
        },
      ],
    });
    reply.lockers[1]!.status = 'MAINTENANCE';
    pullReplies.push(ok(reply));
    await sync().pull();
    expect(store.findStudentByNumber('2022100001')).toMatchObject({ status: 'BLOCKED', blocked_reason: 'Lost a calculator' });
    expect(store.db.prepare('SELECT status FROM lockers WHERE id = ?').get(DEV_IDS.locker2)).toEqual({ status: 'MAINTENANCE' });

    const back = pullReply();
    pullReplies.push(ok(back));
    await sync().pull();
    expect(store.db.prepare('SELECT status FROM lockers WHERE id = ?').get(DEV_IDS.locker2)).toEqual({ status: 'AVAILABLE' });
  });

  it('a waived penalty no longer blocks the student; nothing goes back into the outbox', async () => {
    store.db
      .prepare(
        `INSERT INTO penalties (id, rental_id, student_id, overdue_minutes, calculated_centavos, amount_due_centavos, status)
         VALUES ('00000000-0000-4000-8000-0000000009a1', NULL, ?, 60, 1000, 1000, 'UNPAID')`,
      )
      .run(DEV_IDS.juan);
    expect(store.getUnpaidPenaltyCentavos(DEV_IDS.juan)).toBe(1000);

    pullReplies.push(
      ok(
        pullReply({
          penalties: [
            {
              id: '00000000-0000-4000-8000-0000000009a1',
              rental_transaction_id: '00000000-0000-4000-8000-0000000009b1',
              student_id: DEV_IDS.juan,
              reason: 'OVERDUE',
              overdue_minutes: 60,
              calculated_amount: 10,
              waived_amount: 10,
              amount_paid: 0,
              status: 'WAIVED',
              updated_at: '2026-10-20T01:00:00.000+00:00',
            },
          ],
        }),
      ),
    );
    await sync().pull();
    expect(store.getUnpaidPenaltyCentavos(DEV_IDS.juan)).toBe(0);
    expect(store.db.prepare('SELECT status FROM penalties').get()).toEqual({ status: 'WAIVED' });
    expect(store.pendingSyncCount()).toBe(0);
  });
});
