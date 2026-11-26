import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { AdminRole } from './enums';
import { SQLITE_MIGRATIONS, SQL_UTC_NOW } from './sqlite-migrations';

const sqliteModuleId = ['node', 'sqlite'].join(':');
function loadDatabaseSync(): typeof DatabaseSyncType {
  const builtinLoader = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const mod = (
    typeof builtinLoader === 'function'
      ? builtinLoader(sqliteModuleId)
      : createRequire(path.join(process.cwd(), 'package.json'))(sqliteModuleId)
  ) as { DatabaseSync: typeof DatabaseSyncType } | undefined;
  if (!mod?.DatabaseSync) {
    throw new Error('Built-in node:sqlite module is unavailable. Node.js >= 22.12 is required.');
  }
  return mod.DatabaseSync;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function normalizeError(error: unknown): never {
  if (error && typeof error === 'object') {
    const e = error as { code?: string; errcode?: number; errstr?: string; message?: string };
    if (
      (typeof e.errcode === 'number' && (e.errcode & 0xff) === 19) ||
      (typeof e.errstr === 'string' && e.errstr.toLowerCase().includes('constraint')) ||
      (typeof e.message === 'string' && e.message.toLowerCase().includes('constraint'))
    ) {
      e.code = 'SQLITE_CONSTRAINT';
    }
  }
  throw error;
}

function toPlainObject(row: unknown): unknown {
  if (row === null || row === undefined || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>) };
}

function isNamedParamObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function extractNamedParams(sql: string): string[] {
  const names = new Set<string>();
  const regex = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

/**
 * Compatibility wrapper around Node's built-in `node:sqlite` (`DatabaseSync`)
 * providing synchronous prepared statements, `PRAGMA` helpers, and nested
 * savepoint transactions with zero C++ native addon compilation.
 */
export class SqliteDatabase {
  private readonly raw: DatabaseSyncType;
  private txDepth = 0;
  private savepointSeq = 0;

  constructor(filename: string) {
    const DatabaseSyncCtor = loadDatabaseSync();
    this.raw = new DatabaseSyncCtor(filename);
  }

  exec(sql: string): this {
    try {
      this.raw.exec(sql);
      return this;
    } catch (error) {
      normalizeError(error);
    }
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.raw.prepare(sql);
    const namedKeys = extractNamedParams(sql);
    if (namedKeys.length > 0) {
      stmt.setAllowBareNamedParameters(true);
    }

    const bindArgs = (params: unknown[]): SQLInputValue[] | [Record<string, SQLInputValue>] => {
      if (namedKeys.length > 0 && params.length === 1 && isNamedParamObject(params[0])) {
        const src = params[0];
        const filtered: Record<string, SQLInputValue> = {};
        for (const key of namedKeys) {
          filtered[key] = toSqlValue(src[key]);
        }
        return [filtered];
      }
      return params.map(toSqlValue);
    };

    return {
      run: (...params: unknown[]): RunResult => {
        try {
          const bound = bindArgs(params);
          const res = Array.isArray(bound) && bound.length === 1 && isNamedParamObject(bound[0])
            ? stmt.run(bound[0])
            : stmt.run(...(bound as SQLInputValue[]));
          return {
            changes: Number(res.changes),
            lastInsertRowid: Number(res.lastInsertRowid),
          };
        } catch (error) {
          normalizeError(error);
        }
      },
      get: (...params: unknown[]): unknown => {
        try {
          const bound = bindArgs(params);
          const row = Array.isArray(bound) && bound.length === 1 && isNamedParamObject(bound[0])
            ? stmt.get(bound[0])
            : stmt.get(...(bound as SQLInputValue[]));
          return toPlainObject(row);
        } catch (error) {
          normalizeError(error);
        }
      },
      all: (...params: unknown[]): unknown[] => {
        try {
          const bound = bindArgs(params);
          const rows = Array.isArray(bound) && bound.length === 1 && isNamedParamObject(bound[0])
            ? stmt.all(bound[0])
            : stmt.all(...(bound as SQLInputValue[]));
          return rows.map((r) => toPlainObject(r));
        } catch (error) {
          normalizeError(error);
        }
      },
    };
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const sql = `PRAGMA ${source}`;
    if (source.includes('=')) {
      const stmt = this.raw.prepare(sql);
      const rows = stmt.all().map((r) => toPlainObject(r) as Record<string, unknown>);
      if (options?.simple) {
        const first = rows[0] ? Object.values(rows[0])[0] : undefined;
        return typeof first === 'bigint' ? Number(first) : first;
      }
      return rows;
    }
    const rows = this.raw.prepare(sql).all().map((r) => toPlainObject(r) as Record<string, unknown>);
    if (options?.simple) {
      const first = rows[0] ? Object.values(rows[0])[0] : undefined;
      return typeof first === 'bigint' ? Number(first) : first;
    }
    return rows;
  }

  transaction<TArgs extends unknown[], TReturn>(fn: (...args: TArgs) => TReturn): (...args: TArgs) => TReturn {
    return (...args: TArgs): TReturn => {
      if (this.txDepth === 0) {
        this.exec('BEGIN IMMEDIATE');
        this.txDepth++;
        try {
          const result = fn(...args);
          this.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            this.exec('ROLLBACK');
          } catch {
            // Ignore rollback error if SQLite already rolled back.
          }
          throw error;
        } finally {
          this.txDepth--;
        }
      }

      const sp = `sp_${++this.savepointSeq}`;
      this.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const result = fn(...args);
        this.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        try {
          this.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          this.exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // Ignore savepoint cleanup error.
        }
        throw error;
      } finally {
        this.txDepth--;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

export type LocalDatabase = SqliteDatabase;

/**
 * Opens (or creates) the local SQLite database and brings its schema up to date.
 *
 * Durability settings chosen for a Raspberry Pi 4 kiosk:
 *  - journal_mode = WAL   : crash-safe, concurrent dashboard readers + kiosk writer.
 *  - synchronous  = FULL  : a committed transaction survives a power cut.
 *  - foreign_keys = ON    : enforce relational integrity.
 *  - busy_timeout = 5000  : wait up to 5 s instead of failing on brief lock contention.
 */
export function openLocalDatabase(sqlitePath: string): LocalDatabase {
  const inMemory = sqlitePath === ':memory:';
  const target = inMemory ? ':memory:' : path.resolve(sqlitePath);
  if (!inMemory) fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new SqliteDatabase(target);
  db.pragma('busy_timeout = 5000');
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

export function getSchemaVersion(db: LocalDatabase): number {
  return Number(db.pragma('user_version', { simple: true }) ?? 0);
}

function runMigrations(db: LocalDatabase): void {
  const current = getSchemaVersion(db);
  const pending = SQLITE_MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${Math.trunc(migration.version)}`);
    });
    apply();
  }
}

// ---------------------------------------------------------------------------
// local_config helpers
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

// ---------------------------------------------------------------------------
// Password hashing & default local Super Admin bootstrap
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_ADMIN_EMAIL = 'admin@calcrental.ph';
export const DEFAULT_LOCAL_ADMIN_PASSWORD = 'CalcAdmin2026!';
export const DEFAULT_LOCAL_ADMIN_NAME = 'Local Super Admin';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Ensures at least one local SUPER_ADMIN exists on the Raspberry Pi so an
 * officer can always sign in to `http://<pi-ip>:3000/login` offline.
 * Never overwrites existing accounts once created.
 */
export function ensureDefaultLocalAdmin(
  db: LocalDatabase,
  options?: { email?: string; password?: string; fullName?: string },
): { created: boolean; email: string } {
  const email = (options?.email?.trim().toLowerCase() || DEFAULT_LOCAL_ADMIN_EMAIL);
  const password = options?.password || DEFAULT_LOCAL_ADMIN_PASSWORD;
  const fullName = options?.fullName?.trim() || DEFAULT_LOCAL_ADMIN_NAME;

  return db.transaction(() => {
    const existingCount = (db.prepare('SELECT COUNT(*) AS n FROM local_admins').get() as { n: number }).n;
    if (existingCount > 0) {
      const first = db
        .prepare(`SELECT email FROM local_admins WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1`)
        .get() as { email: string } | undefined;
      return { created: false, email: first?.email ?? email };
    }
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO local_admins (id, email, full_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(randomUUID(), email, fullName, hashPassword(password), AdminRole.SUPER_ADMIN, nowIso, nowIso);
    return { created: true, email };
  })();
}
