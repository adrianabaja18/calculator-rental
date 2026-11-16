import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations, SQL_UTC_NOW } from './migrations';

export type LocalDatabase = Database.Database;

/**
 * Opens (or creates) the local SQLite database and brings its schema up to date.
 *
 * Durability settings chosen for a kiosk that can lose power at any time:
 *  - journal_mode = WAL   : crash-safe, readers don't block the writer.
 *  - synchronous  = FULL  : a committed transaction survives a power cut.
 *                           (Slightly slower, irrelevant at kiosk volumes.)
 *  - foreign_keys = ON    : SQLite does NOT enforce FKs unless asked.
 *  - busy_timeout = 5000  : wait instead of failing if the file is briefly locked.
 */
export function openLocalDatabase(sqlitePath: string): LocalDatabase {
  // ':memory:' = throwaway database for tests and the demo script.
  const inMemory = sqlitePath === ':memory:';
  const target = inMemory ? ':memory:' : path.resolve(sqlitePath);
  if (!inMemory) fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new Database(target);
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

export function getSchemaVersion(db: LocalDatabase): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function runMigrations(db: LocalDatabase): void {
  const current = getSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA cannot take bound parameters; version is a trusted integer constant.
      db.pragma(`user_version = ${Math.trunc(migration.version)}`);
    });
    apply();
  }
}

// ---------------------------------------------------------------------------
// local_config helpers (simple key/value store for device-local state)
// ---------------------------------------------------------------------------

export function getLocalConfig(db: LocalDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM local_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setLocalConfig(db: LocalDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO local_config (key, value, updated_at)
     VALUES (?, ?, ${SQL_UTC_NOW})
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function deleteLocalConfig(db: LocalDatabase, key: string): void {
  db.prepare('DELETE FROM local_config WHERE key = ?').run(key);
}
