/**
 * Shared SQLite schema migrations used by both `apps/raspberry-pi` (kiosk)
 * and `apps/web` (local Raspberry Pi admin dashboard).
 *
 * Rules:
 *  - NEVER edit a migration that has already shipped. Add a new one instead.
 *  - Versions must be consecutive (1, 2, 3, ...). The applied version is kept
 *    in SQLite's built-in `PRAGMA user_version`.
 *  - Each migration runs inside a transaction: it applies fully or not at all,
 *    even if the Pi loses power halfway through.
 */

export interface SqliteMigration {
  version: number;
  name: string;
  sql: string;
}

/** ISO-8601 UTC timestamp default, e.g. 2026-11-15T10:00:00.000Z */
export const SQL_UTC_NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Same list as OPEN_RENTAL_STATUSES in packages/shared (checked by a test). */
const OPEN = `('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING')`;

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: 'create_local_config',
    sql: `
      CREATE TABLE local_config (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'kiosk_operating_tables',
    sql: `
      -- Business settings (validated camelCase JSON).
      CREATE TABLE settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        data       TEXT NOT NULL CHECK (json_valid(data)),
        updated_at TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;

      CREATE TABLE students (
        id                  TEXT PRIMARY KEY NOT NULL,
        student_number      TEXT NOT NULL UNIQUE,
        full_name           TEXT NOT NULL,
        course_program      TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'INACTIVE')),
        blocked_reason      TEXT,
        qr_identifier       TEXT,
        last_transaction_at TEXT,
        created_at          TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        updated_at          TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;

      CREATE TABLE lockers (
        id                     TEXT PRIMARY KEY NOT NULL,
        locker_number          INTEGER NOT NULL UNIQUE CHECK (locker_number > 0),
        name                   TEXT NOT NULL,
        hardware_channel       INTEGER NOT NULL UNIQUE CHECK (hardware_channel BETWEEN 1 AND 16),
        status                 TEXT NOT NULL DEFAULT 'AVAILABLE'
                               CHECK (status IN ('AVAILABLE', 'RESERVED', 'OPEN', 'RENTED', 'RETURNING', 'ERROR', 'MAINTENANCE', 'OFFLINE')),
        lock_state             TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (lock_state IN ('LOCKED', 'UNLOCKED', 'UNKNOWN')),
        door_state             TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (door_state IN ('OPEN', 'CLOSED', 'UNKNOWN')),
        rfid_state             TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (rfid_state IN ('EXPECTED_TAG', 'NO_TAG', 'WRONG_TAG', 'UNKNOWN')),
        last_detected_rfid_uid TEXT,
        last_seen_at           TEXT,
        updated_at             TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;

      CREATE TABLE calculators (
        id         TEXT PRIMARY KEY NOT NULL,
        code       TEXT NOT NULL UNIQUE,
        model      TEXT NOT NULL,
        rfid_uid   TEXT NOT NULL UNIQUE,
        locker_id  TEXT UNIQUE REFERENCES lockers (id),
        status     TEXT NOT NULL DEFAULT 'AVAILABLE'
                   CHECK (status IN ('AVAILABLE', 'RENTED', 'MAINTENANCE', 'MISSING', 'DISABLED')),
        condition  TEXT NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('GOOD', 'FAIR', 'DAMAGED')),
        updated_at TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;

      CREATE TABLE rentals (
        id                      TEXT PRIMARY KEY NOT NULL,
        transaction_code        TEXT NOT NULL UNIQUE,
        student_id              TEXT NOT NULL REFERENCES students (id),
        calculator_id           TEXT NOT NULL REFERENCES calculators (id),
        locker_id               TEXT NOT NULL REFERENCES lockers (id),
        status                  TEXT NOT NULL CHECK (status IN (
                                  'PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE',
                                  'OVERDUE', 'RETURNING', 'COMPLETED', 'CANCELLED', 'FAILED')),
        rental_fee_centavos     INTEGER NOT NULL CHECK (rental_fee_centavos >= 0),
        amount_paid_centavos    INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_centavos >= 0),
        rental_duration_minutes INTEGER NOT NULL CHECK (rental_duration_minutes > 0),
        settings_snapshot       TEXT NOT NULL CHECK (json_valid(settings_snapshot)),
        reserved_at             TEXT NOT NULL,
        payment_expires_at      TEXT,
        paid_at                 TEXT,
        rented_at               TEXT,
        due_at                  TEXT,
        return_started_at       TEXT,
        returned_at             TEXT,
        ended_at                TEXT,
        was_overdue             INTEGER NOT NULL DEFAULT 0 CHECK (was_overdue IN (0, 1)),
        overdue_minutes         INTEGER NOT NULL DEFAULT 0 CHECK (overdue_minutes >= 0),
        rental_rfid_verified    INTEGER NOT NULL DEFAULT 0 CHECK (rental_rfid_verified IN (0, 1)),
        return_rfid_verified    INTEGER NOT NULL DEFAULT 0 CHECK (return_rfid_verified IN (0, 1)),
        return_rfid_uid         TEXT,
        failure_reason          TEXT,
        created_at              TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        updated_at              TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        -- Same safety rules as Supabase (Rules 4 and 7):
        CHECK (status NOT IN ('PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')
               OR amount_paid_centavos >= rental_fee_centavos),
        CHECK (status NOT IN ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')
               OR (rented_at IS NOT NULL AND due_at IS NOT NULL AND rental_rfid_verified = 1))
      ) STRICT;

      -- Rules 1 & 2 + race conditions, enforced by SQLite itself.
      CREATE UNIQUE INDEX rentals_one_open_per_student    ON rentals (student_id)    WHERE status IN ${OPEN};
      CREATE UNIQUE INDEX rentals_one_open_per_calculator ON rentals (calculator_id) WHERE status IN ${OPEN};
      CREATE UNIQUE INDEX rentals_one_open_per_locker     ON rentals (locker_id)     WHERE status IN ${OPEN};
      CREATE INDEX rentals_status_due_idx ON rentals (status, due_at);

      -- Penalty balances.
      CREATE TABLE penalties (
        id                  TEXT PRIMARY KEY NOT NULL,
        rental_id           TEXT REFERENCES rentals (id),
        student_id          TEXT NOT NULL REFERENCES students (id),
        amount_due_centavos INTEGER NOT NULL CHECK (amount_due_centavos >= 0),
        status              TEXT NOT NULL CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID', 'WAIVED')),
        updated_at          TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;
      CREATE INDEX penalties_student_open_idx ON penalties (student_id) WHERE status IN ('UNPAID', 'PARTIAL');

      -- Hardware/kiosk event log (synced to Supabase device_events).
      CREATE TABLE device_events (
        id             TEXT PRIMARY KEY NOT NULL,
        event_type     TEXT NOT NULL,
        severity       TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
        locker_id      TEXT,
        transaction_id TEXT,
        message        TEXT,
        payload        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
        occurred_at    TEXT NOT NULL
      ) STRICT;

      -- Outbox: every local change is queued here IN THE SAME TRANSACTION,
      -- then pushed to Supabase in order. Survives reboots.
      CREATE TABLE sync_queue (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL CHECK (entity IN ('student', 'rental', 'device_event', 'coin_event', 'payment', 'locker_state')),
        entity_id       TEXT NOT NULL,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        created_at      TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at TEXT,
        synced_at       TEXT
      ) STRICT;
      CREATE INDEX sync_queue_pending_idx ON sync_queue (seq) WHERE synced_at IS NULL;
    `,
  },
  {
    version: 3,
    name: 'coin_payments',
    sql: `
      -- One coin payment session per rental attempt (mirrors Supabase payments).
      CREATE TABLE payments (
        id                 TEXT PRIMARY KEY NOT NULL,
        rental_id          TEXT NOT NULL REFERENCES rentals (id),
        student_id         TEXT NOT NULL REFERENCES students (id),
        payment_type       TEXT NOT NULL DEFAULT 'RENTAL' CHECK (payment_type IN ('RENTAL', 'PENALTY', 'MANUAL_ADJUSTMENT')),
        method             TEXT NOT NULL DEFAULT 'COIN' CHECK (method IN ('COIN', 'CASH', 'GCASH', 'OTHER')),
        required_centavos  INTEGER NOT NULL CHECK (required_centavos >= 0),
        received_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (received_centavos >= 0),
        status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PARTIAL', 'PAID', 'CANCELLED', 'REFUNDED')),
        session_id         TEXT NOT NULL UNIQUE,
        paid_at            TEXT,
        notes              TEXT,
        created_at         TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        updated_at         TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        CHECK (status <> 'PAID' OR (received_centavos >= required_centavos AND paid_at IS NOT NULL))
      ) STRICT;
      -- Rule 3: a rental has at most one live rental payment.
      CREATE UNIQUE INDEX payments_one_live_rental_payment ON payments (rental_id)
        WHERE payment_type = 'RENTAL' AND status <> 'CANCELLED';

      -- Every coin the selector reported. id is created when the coin is
      -- detected, so re-processing the same event is a no-op (Rule 23).
      -- payment_id NULL = coin inserted when no payment was open (refund).
      CREATE TABLE coin_events (
        id             TEXT PRIMARY KEY NOT NULL,
        payment_id     TEXT REFERENCES payments (id),
        session_id     TEXT,
        value_centavos INTEGER NOT NULL CHECK (value_centavos > 0),
        pulse_count    INTEGER NOT NULL CHECK (pulse_count BETWEEN 1 AND 100),
        occurred_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX coin_events_payment_idx ON coin_events (payment_id);
    `,
  },
  {
    version: 4,
    name: 'returns_and_penalties',
    sql: `
      -- Full penalty record (mirrors Supabase penalties). amount_due_centavos
      -- stays the remaining balance used by the eligibility check.
      ALTER TABLE penalties ADD COLUMN reason TEXT NOT NULL DEFAULT 'OVERDUE'
        CHECK (reason IN ('OVERDUE', 'DAMAGE', 'LOST', 'OTHER'));
      ALTER TABLE penalties ADD COLUMN overdue_minutes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE penalties ADD COLUMN calculated_centavos INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE penalties ADD COLUMN amount_paid_centavos INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE penalties ADD COLUMN paid_at TEXT;
      CREATE UNIQUE INDEX penalties_one_overdue_per_rental ON penalties (rental_id) WHERE reason = 'OVERDUE';

      -- Penalty payments point at their penalty; every session has its own expiry.
      ALTER TABLE payments ADD COLUMN penalty_id TEXT REFERENCES penalties (id);
      ALTER TABLE payments ADD COLUMN expires_at TEXT;
      UPDATE payments SET expires_at = (SELECT r.payment_expires_at FROM rentals r WHERE r.id = payments.rental_id)
        WHERE expires_at IS NULL;

      -- Allow 'penalty' in the outbox (SQLite can't alter a CHECK: rebuild, keeping rows).
      CREATE TABLE sync_queue_new (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL CHECK (entity IN ('student', 'rental', 'device_event', 'coin_event', 'payment', 'locker_state', 'penalty')),
        entity_id       TEXT NOT NULL,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        created_at      TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at TEXT,
        synced_at       TEXT
      ) STRICT;
      INSERT INTO sync_queue_new SELECT * FROM sync_queue;
      DROP TABLE sync_queue;
      ALTER TABLE sync_queue_new RENAME TO sync_queue;
      CREATE INDEX sync_queue_pending_idx ON sync_queue (seq) WHERE synced_at IS NULL;
    `,
  },
  {
    version: 5,
    name: 'two_way_sync',
    sql: `
      -- Officers can waive penalties on the dashboard.
      ALTER TABLE penalties ADD COLUMN waived_centavos INTEGER NOT NULL DEFAULT 0 CHECK (waived_centavos >= 0);

      -- Outbox rebuilt once more: the entity list is now checked in TypeScript
      -- (SYNC_ENTITIES), so new entities need no table rebuild; failed_at marks
      -- an item given up after too many attempts so it can't block the queue.
      CREATE TABLE sync_queue_new (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        entity          TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        payload         TEXT NOT NULL CHECK (json_valid(payload)),
        created_at      TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        next_attempt_at TEXT,
        synced_at       TEXT,
        failed_at       TEXT
      ) STRICT;
      INSERT INTO sync_queue_new (seq, entity, entity_id, payload, created_at, attempts, last_error, next_attempt_at, synced_at)
        SELECT seq, entity, entity_id, payload, created_at, attempts, last_error, next_attempt_at, synced_at FROM sync_queue;
      DROP TABLE sync_queue;
      ALTER TABLE sync_queue_new RENAME TO sync_queue;
      CREATE INDEX sync_queue_pending_idx ON sync_queue (seq) WHERE synced_at IS NULL AND failed_at IS NULL;
    `,
  },
  {
    version: 6,
    name: 'local_admin_and_dashboard',
    sql: `
      -- Officer-facing notes and penalty waiver metadata so the full dashboard
      -- runs natively against local SQLite on the Raspberry Pi 4.
      ALTER TABLE calculators ADD COLUMN notes TEXT;
      ALTER TABLE lockers ADD COLUMN notes TEXT;

      ALTER TABLE penalties ADD COLUMN calculated_at TEXT;
      ALTER TABLE penalties ADD COLUMN waived_by TEXT;
      ALTER TABLE penalties ADD COLUMN waived_at TEXT;
      ALTER TABLE penalties ADD COLUMN waive_reason TEXT;
      UPDATE penalties SET calculated_at = updated_at WHERE calculated_at IS NULL;

      -- Local administrator/officer accounts on the Raspberry Pi.
      CREATE TABLE local_admins (
        id            TEXT PRIMARY KEY NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        full_name     TEXT,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'OFFICER', 'VIEWER')),
        is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        last_login_at TEXT,
        created_at    TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        updated_at    TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;

      -- Server-side session store (stores SHA-256 hash of opaque HttpOnly cookie token).
      CREATE TABLE local_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        admin_id   TEXT NOT NULL REFERENCES local_admins (id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;
      CREATE INDEX local_sessions_admin_idx ON local_sessions (admin_id);

      -- Append-only local audit log (Rules 12 & 13).
      CREATE TABLE audit_logs (
        id             TEXT PRIMARY KEY NOT NULL,
        actor_type     TEXT NOT NULL CHECK (actor_type IN ('ADMIN', 'DEVICE', 'SYSTEM')),
        actor_id       TEXT,
        actor_label    TEXT,
        action         TEXT NOT NULL,
        target_type    TEXT,
        target_id      TEXT,
        previous_value TEXT CHECK (previous_value IS NULL OR json_valid(previous_value)),
        new_value      TEXT CHECK (new_value IS NULL OR json_valid(new_value)),
        reason         TEXT,
        created_at     TEXT NOT NULL DEFAULT ${SQL_UTC_NOW}
      ) STRICT;
      CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
      CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN
        SELECT RAISE(ABORT, 'audit_logs is append-only');
      END;
      CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN
        SELECT RAISE(ABORT, 'audit_logs is append-only');
      END;

      -- Local officer -> kiosk commands (emergency unlock, sync now).
      CREATE TABLE device_commands (
        id             TEXT PRIMARY KEY NOT NULL,
        device_code    TEXT NOT NULL,
        command        TEXT NOT NULL CHECK (command IN ('UNLOCK_LOCKER', 'REFRESH')),
        payload        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
        reason         TEXT,
        status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'DONE', 'FAILED', 'EXPIRED')),
        requested_by   TEXT,
        requested_at   TEXT NOT NULL DEFAULT ${SQL_UTC_NOW},
        expires_at     TEXT NOT NULL,
        sent_at        TEXT,
        completed_at   TEXT,
        result_message TEXT,
        CHECK (command <> 'UNLOCK_LOCKER' OR reason IS NOT NULL)
      ) STRICT;
      CREATE INDEX device_commands_open_idx ON device_commands (status, requested_at) WHERE status IN ('PENDING', 'SENT');
      CREATE INDEX device_commands_recent_idx ON device_commands (requested_at DESC);
    `,
  },
  {
    version: 7,
    name: 'phone_scan_sessions',
    sql: `
      -- Phone ID scanning (replaces the ESP32-CAM). The kiosk shows a 6-digit
      -- code; the student's phone sends the ID text to the Pi's /scan page;
      -- the kiosk takes it once. Every sent ID text is kept here as a record.
      CREATE TABLE scan_sessions (
        id           TEXT PRIMARY KEY NOT NULL,
        code         TEXT NOT NULL CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9]*'),
        status       TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'SUBMITTED', 'CONSUMED', 'EXPIRED')),
        qr_payload   TEXT CHECK (qr_payload IS NULL OR length(qr_payload) <= 512),
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        submitted_at TEXT,
        consumed_at  TEXT
      ) STRICT;
      -- A code identifies at most one waiting session at a time.
      CREATE UNIQUE INDEX scan_sessions_waiting_code ON scan_sessions (code) WHERE status = 'WAITING';
      CREATE INDEX scan_sessions_created_idx ON scan_sessions (created_at DESC);

      -- Wrong codes per phone (salted hash of its address), to stop guessing.
      CREATE TABLE scan_code_failures (
        id          INTEGER PRIMARY KEY,
        client_hash TEXT NOT NULL,
        at          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX scan_code_failures_client_idx ON scan_code_failures (client_hash, at);
    `,
  },
];
