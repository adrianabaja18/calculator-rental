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
 * Phase 1 creates only `local_config`. Later phases add:
 *   locker_state, active_session, cached_students,
 *   offline_transactions, offline_device_events, sync_queue.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** ISO-8601 UTC timestamp default, e.g. 2026-11-15T10:00:00.000Z */
export const SQL_UTC_NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

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
];
