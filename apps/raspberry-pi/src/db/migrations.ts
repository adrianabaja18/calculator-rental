/**
 * Local SQLite schema migrations for the Raspberry Pi.
 *
 * Rules:
 *  - NEVER edit a migration that has already shipped. Add a new one instead.
 *  - Versions must be consecutive (1, 2, 3, ...). The applied version is kept
 *    in SQLite's built-in `PRAGMA user_version`.
 *  - Each migration runs inside a transaction: it applies fully or not at all,
 *    even if the Pi loses power halfway through.
 *
 * SQLite-first (docs/architecture.md §3.8): this is the kiosk's MAIN
 * operating database. Table and column names mirror Supabase so syncing is
 * a straight copy. Differences on purpose:
 *  - money is stored as INTEGER centavos (no floating-point rounding);
 *  - booleans are INTEGER 0/1; timestamps are ISO-8601 UTC TEXT.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** ISO-8601 UTC timestamp default, e.g. 2026-11-15T10:00:00.000Z */
export const SQL_UTC_NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Same list as OPEN_RENTAL_STATUSES in packages/shared (checked by a test). */
const OPEN = `('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING')`;

export const migrations: readonly Migration[] = [
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
      -- Business settings pulled from Supabase (validated camelCase JSON).
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

      -- Penalty balances (owned by Supabase once officers record payments/waivers).
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
      -- then pushed to Supabase in order (Phase 12). Survives reboots.
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
];
