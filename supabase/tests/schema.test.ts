/**
 * Database schema tests — run the REAL migrations + seed inside PGlite
 * (Postgres compiled to WebAssembly, in-process). No Docker, no Supabase
 * project and no internet needed:  npm run test:db
 *
 * Each test runs inside a transaction that is rolled back, so tests can't
 * affect each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_ENUMS } from '@calc-rental/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const supabaseDir = path.resolve(here, '..');

// Seed IDs (see supabase/seed.sql)
const STUDENT_1 = '00000000-0000-4000-8000-000000000301';
const STUDENT_2 = '00000000-0000-4000-8000-000000000302';
const CALC_1 = '00000000-0000-4000-8000-000000000201';
const CALC_2 = '00000000-0000-4000-8000-000000000202';
const LOCKER_1 = '00000000-0000-4000-8000-000000000101';
const LOCKER_2 = '00000000-0000-4000-8000-000000000102';
const DEVICE_1 = '00000000-0000-4000-8000-000000000001';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(here, 'supabase-stubs.sql'), 'utf8'));
  const migrationFiles = fs
    .readdirSync(path.join(supabaseDir, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    await db.exec(fs.readFileSync(path.join(supabaseDir, 'migrations', file), 'utf8'));
  }
  await db.exec(fs.readFileSync(path.join(supabaseDir, 'seed.sql'), 'utf8'));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

/** Runs `fn` inside a transaction that is always rolled back. */
async function isolated(fn: () => Promise<void>): Promise<void> {
  await db.exec('begin');
  try {
    await fn();
  } finally {
    await db.exec('rollback');
  }
}

/** Expects `sql` to fail with an error matching `pattern`, without aborting the outer transaction. */
async function expectSqlError(sql: string, pattern: RegExp, params: unknown[] = []): Promise<void> {
  await db.exec('savepoint expect_error');
  let error: unknown = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    error = e;
  }
  await db.exec('rollback to savepoint expect_error');
  expect(error, `expected failure for: ${sql}`).not.toBeNull();
  expect(String((error as Error).message)).toMatch(pattern);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return result.rows[0]!.n;
}

const insertPendingRental = (student: string, calculator: string, locker: string) =>
  db.query<{ id: string }>(
    `insert into public.rental_transactions (student_id, calculator_id, locker_id, device_id, status, rental_fee, rental_duration_minutes)
     values ($1, $2, $3, $4, 'PENDING', 5, 120) returning id`,
    [student, calculator, locker, DEVICE_1],
  );

// ---------------------------------------------------------------------------

describe('migrations & seed', () => {
  it('every shared TypeScript enum matches its PostgreSQL enum', async () => {
    const { rows } = await db.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
       group by t.typname`,
    );
    const dbEnums = Object.fromEntries(rows.map((r) => [r.typname, [...r.labels].sort()]));
    for (const [typeName, tsEnum] of Object.entries(DB_ENUMS)) {
      expect(dbEnums[typeName], `PostgreSQL enum ${typeName}`).toEqual(Object.values(tsEnum).sort());
    }
    expect(Object.keys(dbEnums).sort()).toEqual(Object.keys(DB_ENUMS).sort());
  });

  it('seeds 1 device, 2 lockers, 2 calculators and 5 students', async () => {
    expect(await count('select * from public.device_registry')).toBe(1);
    expect(await count('select * from public.lockers')).toBe(2);
    expect(await count('select * from public.calculators')).toBe(2);
    expect(await count('select * from public.students')).toBe(5);
  });

  it('has the current pricing: ₱20 for 3 hours, then ₱10 per started 1.5 h overdue', async () => {
    const { rows } = await db.query<Record<string, unknown>>('select * from public.system_settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rental_duration_minutes: 180,
      grace_period_minutes: 10,
      penalty_enabled: true,
      penalty_type: 'PER_INTERVAL',
      penalty_interval_minutes: 90,
      max_concurrent_rentals_per_student: 1,
      unpaid_penalty_blocks_rental: true,
      allow_offline_returns: true,
      allow_offline_rentals: false,
    });
    expect(Number(rows[0]!.rental_fee)).toBe(20);
    expect(Number(rows[0]!.penalty_amount)).toBe(10);
  });

  it('seed is idempotent (can be run twice)', async () => {
    await isolated(async () => {
      await db.exec(fs.readFileSync(path.join(supabaseDir, 'seed.sql'), 'utf8'));
      expect(await count('select * from public.students')).toBe(5);
    });
  });
});

describe('inventory constraints', () => {
  it('rejects a duplicate RFID UID (Rule 5)', () =>
    isolated(async () => {
      await expectSqlError(
        `insert into public.calculators (code, model, rfid_uid, status) values ('CALC-003', 'X', '04-A1-B2-C3-D4', 'MAINTENANCE')`,
        /calculators_rfid_uid_key|duplicate key/,
      );
    }));

  it('rejects a badly formatted RFID UID', () =>
    isolated(async () => {
      await expectSqlError(
        `insert into public.calculators (code, model, rfid_uid, status) values ('CALC-003', 'X', '04:a1:b2:c3', 'MAINTENANCE')`,
        /check constraint/,
      );
    }));

  it('rejects two calculators in the same locker (Rule 6)', () =>
    isolated(async () => {
      await expectSqlError(
        `insert into public.calculators (code, model, rfid_uid, locker_id) values ('CALC-003', 'X', '04-11-22-33-44', $1)`,
        /calculators_locker_id_key|duplicate key/,
        [LOCKER_1],
      );
    }));

  it('rejects a duplicate student number', () =>
    isolated(async () => {
      await expectSqlError(
        `insert into public.students (student_number, full_name, course_program) values ('2022100001', 'SOMEONE ELSE', 'BSIT')`,
        /students_student_number_key|duplicate key/,
      );
    }));

  it('requires a reason when blocking a student', () =>
    isolated(async () => {
      await expectSqlError(
        `update public.students set status = 'BLOCKED' where id = $1`,
        /students_blocked_needs_reason/,
        [STUDENT_1],
      );
    }));
});

describe('rental rules', () => {
  it('allows only ONE open rental per student (Rule 1)', () =>
    isolated(async () => {
      await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      await expectSqlError(
        `insert into public.rental_transactions (student_id, calculator_id, locker_id, status, rental_fee, rental_duration_minutes)
         values ($1, $2, $3, 'PENDING', 5, 120)`,
        /rentals_one_open_per_student/,
        [STUDENT_1, CALC_2, LOCKER_2],
      );
    }));

  it('allows only ONE open rental per calculator — the race for the last calculator (Rule 2)', () =>
    isolated(async () => {
      await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      await expectSqlError(
        `insert into public.rental_transactions (student_id, calculator_id, locker_id, status, rental_fee, rental_duration_minutes)
         values ($1, $2, $3, 'PENDING', 5, 120)`,
        /rentals_one_open_per_calculator/,
        [STUDENT_2, CALC_1, LOCKER_1],
      );
    }));

  it('keeps history: a completed rental does not block the next one (Rule 12)', () =>
    isolated(async () => {
      await db.query(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, returned_at, rental_rfid_verified, return_rfid_verified, return_rfid_uid)
         values ($1, $2, $3, 'COMPLETED', 5, 5, 120,
           now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours',
           true, true, '04-A1-B2-C3-D4')`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      expect(await count('select * from public.rental_transactions where student_id = $1', [STUDENT_1])).toBe(2);
    }));

  it('generates a readable transaction code', () =>
    isolated(async () => {
      const { rows } = await db.query<{ transaction_code: string }>(
        `insert into public.rental_transactions (student_id, calculator_id, locker_id, rental_fee, rental_duration_minutes)
         values ($1, $2, $3, 5, 120) returning transaction_code`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      expect(rows[0]!.transaction_code).toMatch(/^RNT-\d{8}-\d{5}$/);
    }));

  it('cannot become PAID without full payment (no payment bypass)', () =>
    isolated(async () => {
      const { rows } = await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      await expectSqlError(
        `update public.rental_transactions set status = 'PAID', amount_paid = 3 where id = $1`,
        /rentals_paid_in_full/,
        [rows[0]!.id],
      );
    }));

  it('cannot become ACTIVE until calculator removal is confirmed (Rule 7)', () =>
    isolated(async () => {
      const { rows } = await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      const id = rows[0]!.id;
      await expectSqlError(
        `update public.rental_transactions
         set status = 'ACTIVE', amount_paid = 5, rented_at = now(), due_at = now() + interval '2 hours'
         where id = $1`,
        /rentals_active_requires_removal/,
        [id],
      );
      await db.query(
        `update public.rental_transactions
         set status = 'ACTIVE', amount_paid = 5, rented_at = now(), due_at = now() + interval '2 hours',
             rental_rfid_verified = true
         where id = $1`,
        [id],
      );
    }));

  it('cannot become COMPLETED until the expected RFID is verified (Rule 8)', () =>
    isolated(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, rental_rfid_verified)
         values ($1, $2, $3, 'ACTIVE', 5, 5, 120, now() - interval '1 hour', now() + interval '1 hour', true)
         returning id`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      await expectSqlError(
        `update public.rental_transactions set status = 'COMPLETED', returned_at = now() where id = $1`,
        /rentals_completed_requires_return_verification/,
        [rows[0]!.id],
      );
    }));

  it('rental history cannot be deleted, even by the server (Rule 12)', () =>
    isolated(async () => {
      const { rows } = await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      await expectSqlError(`delete from public.rental_transactions where id = $1`, /not allowed/, [rows[0]!.id]);
    }));
});

describe('payments & penalties', () => {
  it('a rental can have only one live rental payment (Rule 3)', () =>
    isolated(async () => {
      const { rows } = await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      const rentalId = rows[0]!.id;
      const insertPayment = `insert into public.payments (rental_transaction_id, student_id, payment_type, required_amount)
                             values ($1, $2, 'RENTAL', 5) returning id`;
      const first = await db.query<{ id: string }>(insertPayment, [rentalId, STUDENT_1]);
      await expectSqlError(insertPayment, /payments_one_live_rental_payment/, [rentalId, STUDENT_1]);
      // After cancelling the first one, a new payment session is allowed.
      await db.query(`update public.payments set status = 'CANCELLED' where id = $1`, [first.rows[0]!.id]);
      await db.query(insertPayment, [rentalId, STUDENT_1]);
    }));

  it('computes penalty amount_due and blocks over-clearing', () =>
    isolated(async () => {
      const { rows } = await insertPendingRental(STUDENT_1, CALC_1, LOCKER_1);
      const penalty = await db.query<{ id: string; amount_due: string }>(
        `insert into public.penalties (rental_transaction_id, student_id, overdue_minutes, calculated_amount)
         values ($1, $2, 75, 10) returning id, amount_due`,
        [rows[0]!.id, STUDENT_1],
      );
      expect(Number(penalty.rows[0]!.amount_due)).toBe(10);
      await expectSqlError(
        `update public.penalties set amount_paid = 11 where id = $1`,
        /penalties_not_overcleared/,
        [penalty.rows[0]!.id],
      );
      await expectSqlError(`delete from public.penalties where id = $1`, /not allowed/, [penalty.rows[0]!.id]);
    }));
});

describe('settings validation', () => {
  it('rejects a second settings row', () =>
    isolated(async () => {
      await expectSqlError(
        `insert into public.system_settings (id, rental_fee, rental_duration_minutes, grace_period_minutes, penalty_enabled,
           penalty_type, penalty_amount, penalty_interval_minutes, unpaid_penalty_blocks_rental, accepted_coin_denominations)
         values (2, 5, 120, 10, true, 'FLAT', 5, 60, true, array[1])`,
        /check constraint|system_settings_id_check/,
      );
    }));

  it('rejects a non-whole-peso rental fee and unsupported coins', () =>
    isolated(async () => {
      await expectSqlError(`update public.system_settings set rental_fee = 5.50`, /check constraint/);
      await expectSqlError(`update public.system_settings set accepted_coin_denominations = array[1, 2]`, /check constraint/);
    }));

  it('requires tiers for STEPPED penalties', () =>
    isolated(async () => {
      await expectSqlError(`update public.system_settings set penalty_type = 'STEPPED'`, /system_settings_stepped_needs_steps/);
    }));
});

describe('audit log', () => {
  it('is append-only', () =>
    isolated(async () => {
      const { rows } = await db.query<{ id: number }>(
        `insert into public.audit_logs (actor_type, action, target_type, target_id)
         values ('SYSTEM', 'TEST_ACTION', 'student', 'x') returning id`,
      );
      await expectSqlError(`update public.audit_logs set action = 'CHANGED' where id = $1`, /append-only/, [rows[0]!.id]);
      await expectSqlError(`delete from public.audit_logs where id = $1`, /not allowed/, [rows[0]!.id]);
    }));
});

describe('views', () => {
  it('v_rentals reports OVERDUE as soon as due_at has passed (no job needed)', () =>
    isolated(async () => {
      await db.query(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, rental_rfid_verified)
         values ($1, $2, $3, 'ACTIVE', 5, 5, 120, now() - interval '150 minutes', now() - interval '30 minutes', true)`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      const { rows } = await db.query<{ status: string; effective_status: string; overdue_minutes_now: number }>(
        `select status, effective_status, overdue_minutes_now from public.v_rentals where student_id = $1`,
        [STUDENT_1],
      );
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', effective_status: 'OVERDUE' });
      expect(rows[0]!.overdue_minutes_now).toBeGreaterThanOrEqual(29);
    }));

  it('v_lockers only marks a locker assignable when the RFID reader sees the expected tag', () =>
    isolated(async () => {
      const assignable = () =>
        db.query<{ is_assignable: boolean; has_inventory_mismatch: boolean }>(
          `select is_assignable, has_inventory_mismatch from public.v_lockers where id = $1`,
          [LOCKER_1],
        );

      // Seed state: RFID UNKNOWN, kiosk never seen -> not assignable.
      expect((await assignable()).rows[0]!.is_assignable).toBe(false);

      // Kiosk online, lock closed, reader sees the right tag -> assignable.
      await db.query(`update public.device_registry set last_heartbeat_at = now() where id = $1`, [DEVICE_1]);
      await db.query(
        `update public.lockers set rfid_state = 'EXPECTED_TAG', last_detected_rfid_uid = '04-A1-B2-C3-D4', lock_state = 'LOCKED'
         where id = $1`,
        [LOCKER_1],
      );
      expect((await assignable()).rows[0]!.is_assignable).toBe(true);

      // DB says AVAILABLE but the reader sees nothing -> inconsistency, not assignable (spec §5.14).
      await db.query(`update public.lockers set rfid_state = 'NO_TAG', last_detected_rfid_uid = null where id = $1`, [LOCKER_1]);
      expect((await assignable()).rows[0]).toEqual({ is_assignable: false, has_inventory_mismatch: true });
    }));

  it('v_students shows the current rental, history counts and unpaid penalties', () =>
    isolated(async () => {
      const completed = await db.query<{ id: string }>(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, returned_at, rental_rfid_verified, return_rfid_verified, return_rfid_uid,
           was_overdue, overdue_minutes)
         values ($1, $2, $3, 'COMPLETED', 20, 20, 180,
           now() - interval '6 hours', now() - interval '3 hours', now() - interval '2 hours',
           true, true, '04-A1-B2-C3-D4', true, 60) returning id`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      await db.query(
        `insert into public.penalties (rental_transaction_id, student_id, overdue_minutes, calculated_amount)
         values ($1, $2, 60, 20)`,
        [completed.rows[0]!.id, STUDENT_1],
      );
      await db.query(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, rental_rfid_verified)
         values ($1, $2, $3, 'ACTIVE', 20, 20, 180, now() - interval '1 hour', now() + interval '2 hours', true)`,
        [STUDENT_1, CALC_2, LOCKER_2],
      );

      const { rows } = await db.query<Record<string, unknown>>(
        `select open_rental_status, open_rental_calculator_code, rental_count, overdue_count,
                unpaid_penalty_total, unpaid_penalty_count
         from public.v_students where id = $1`,
        [STUDENT_1],
      );
      expect(rows[0]).toMatchObject({
        open_rental_status: 'ACTIVE',
        open_rental_calculator_code: 'CALC-002',
        rental_count: 2,
        overdue_count: 1,
        unpaid_penalty_count: 1,
      });
      expect(Number(rows[0]!.unpaid_penalty_total)).toBe(20);

      const other = await db.query<Record<string, unknown>>(
        `select open_rental_id, rental_count, unpaid_penalty_total from public.v_students where id = $1`,
        [STUDENT_2],
      );
      expect(other.rows[0]).toMatchObject({ open_rental_id: null, rental_count: 0 });
    }));

  it('v_calculators shows the locker and the current borrower', () =>
    isolated(async () => {
      await db.query(
        `insert into public.rental_transactions (
           student_id, calculator_id, locker_id, status, rental_fee, amount_paid, rental_duration_minutes,
           rented_at, due_at, rental_rfid_verified)
         values ($1, $2, $3, 'ACTIVE', 20, 20, 180, now(), now() + interval '3 hours', true)`,
        [STUDENT_2, CALC_1, LOCKER_1],
      );
      const { rows } = await db.query<Record<string, unknown>>(
        `select code, locker_number, borrower_full_name, rental_count from public.v_calculators order by code`,
      );
      expect(rows).toEqual([
        { code: 'CALC-001', locker_number: 1, borrower_full_name: 'MARIA SANTOS', rental_count: 1 },
        { code: 'CALC-002', locker_number: 2, borrower_full_name: null, rental_count: 0 },
      ]);
    }));

  it('v_device_status derives ONLINE / OFFLINE from the heartbeat', () =>
    isolated(async () => {
      const status = async () =>
        (await db.query<{ connection_status: string }>(`select connection_status from public.v_device_status`)).rows[0]!
          .connection_status;
      expect(await status()).toBe('NEVER_SEEN');
      await db.query(`update public.device_registry set last_heartbeat_at = now() - interval '10 seconds'`);
      expect(await status()).toBe('ONLINE');
      await db.query(`update public.device_registry set last_heartbeat_at = now() - interval '5 minutes'`);
      expect(await status()).toBe('OFFLINE');
      await db.query(`update public.device_registry set is_enabled = false`);
      expect(await status()).toBe('DISABLED');
    }));

  it('v_dashboard_summary counts the 8 dashboard cards', () =>
    isolated(async () => {
      const summary = async () =>
        (await db.query<Record<string, unknown>>(`select * from public.v_dashboard_summary`)).rows[0]!;
      expect(await summary()).toMatchObject({
        total_calculators: 2,
        available_calculators: 2,
        rented_calculators: 0,
        overdue_rentals: 0,
        rentals_today: 0,
        returns_today: 0,
      });

      // Juan has CALC-001 and is overdue; Maria borrowed and returned CALC-002 today.
      const juan = await db.query<{ id: string }>(
        `insert into public.rental_transactions (student_id, calculator_id, locker_id, status, rental_fee, amount_paid,
           rental_duration_minutes, rented_at, due_at, rental_rfid_verified)
         values ($1, $2, $3, 'ACTIVE', 20, 20, 180, now() - interval '1 minute', now() - interval '30 seconds', true) returning id`,
        [STUDENT_1, CALC_1, LOCKER_1],
      );
      await db.query(`update public.calculators set status = 'RENTED' where id = $1`, [CALC_1]);
      await db.query(
        `insert into public.payments (rental_transaction_id, student_id, payment_type, required_amount, amount_received, status, paid_at)
         values ($1, $2, 'RENTAL', 20, 20, 'PAID', now())`,
        [juan.rows[0]!.id, STUDENT_1],
      );
      await db.query(
        `insert into public.rental_transactions (student_id, calculator_id, locker_id, status, rental_fee, amount_paid,
           rental_duration_minutes, rented_at, due_at, returned_at, rental_rfid_verified, return_rfid_verified, return_rfid_uid)
         values ($1, $2, $3, 'COMPLETED', 20, 20, 180, now() - interval '2 minutes', now() + interval '3 hours', now() - interval '1 minute',
           true, true, '04-E5-F6-A7-B8')`,
        [STUDENT_2, CALC_2, LOCKER_2],
      );
      await db.query(
        `insert into public.penalties (rental_transaction_id, student_id, overdue_minutes, calculated_amount) values ($1, $2, 60, 10)`,
        [juan.rows[0]!.id, STUDENT_1],
      );

      const s = await summary();
      expect(s).toMatchObject({
        total_calculators: 2,
        available_calculators: 1,
        rented_calculators: 1,
        overdue_rentals: 1,
        returns_today: 1,
        rentals_today: 2,
      });
      expect(Number(s.income_today)).toBe(20);
      expect(Number(s.outstanding_penalties)).toBe(10);
    }));
});

describe('row level security', () => {
  const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';

  async function actAs(role: 'anon' | 'authenticated', userId?: string) {
    await db.exec(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
  }

  it('creates an INACTIVE VIEWER profile for every new auth user', () =>
    isolated(async () => {
      await db.query(`insert into auth.users (id, email) values ($1, 'officer@example.com')`, [ADMIN_ID]);
      const { rows } = await db.query(`select role, is_active from public.profiles where id = $1`, [ADMIN_ID]);
      expect(rows[0]).toEqual({ role: 'VIEWER', is_active: false });
    }));

  it('anonymous users (students, the public key) cannot read anything', () =>
    isolated(async () => {
      await actAs('anon');
      await expectSqlError(`select * from public.students`, /permission denied/);
      await expectSqlError(`select * from public.v_rentals`, /permission denied/);
    }));

  it('a logged-in user WITHOUT an active profile sees no rows', () =>
    isolated(async () => {
      await db.query(`insert into auth.users (id, email) values ($1, 'new@example.com')`, [ADMIN_ID]);
      await actAs('authenticated', ADMIN_ID);
      expect(await count('select * from public.students')).toBe(0);
      expect(await count('select * from public.calculators')).toBe(0);
    }));

  it('an active VIEWER can read operational data but not the audit log', () =>
    isolated(async () => {
      await db.query(`insert into auth.users (id, email) values ($1, 'viewer@example.com')`, [ADMIN_ID]);
      await db.query(`update public.profiles set is_active = true where id = $1`, [ADMIN_ID]);
      await actAs('authenticated', ADMIN_ID);
      expect(await count('select * from public.students')).toBe(5);
      expect(await count('select * from public.v_lockers')).toBe(2);
      expect(await count('select * from public.audit_logs')).toBe(0);
    }));

  it('dashboard users can never write directly — only the server API can (Rule 15)', () =>
    isolated(async () => {
      await db.query(`insert into auth.users (id, email) values ($1, 'boss@example.com')`, [ADMIN_ID]);
      await db.query(`update public.profiles set is_active = true, role = 'SUPER_ADMIN' where id = $1`, [ADMIN_ID]);
      await actAs('authenticated', ADMIN_ID);
      await expectSqlError(
        `insert into public.students (student_number, full_name, course_program) values ('2026999999', 'HACKER', 'BSCS')`,
        /permission denied/,
      );
      await expectSqlError(`update public.system_settings set rental_fee = 1`, /permission denied/);
      await expectSqlError(`update public.profiles set role = 'SUPER_ADMIN'`, /permission denied/);
    }));

  it('device secrets are invisible to every dashboard user', () =>
    isolated(async () => {
      await db.query(`insert into auth.users (id, email) values ($1, 'boss@example.com')`, [ADMIN_ID]);
      await db.query(`update public.profiles set is_active = true, role = 'SUPER_ADMIN' where id = $1`, [ADMIN_ID]);
      await actAs('authenticated', ADMIN_ID);
      await expectSqlError(`select * from public.device_credentials`, /permission denied/);
    }));
});
