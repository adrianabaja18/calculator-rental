import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AdminRole,
  CalculatorCondition,
  CalculatorStatus,
  LockerStatus,
  PenaltyType,
  SystemSettingsSchema,
  type ActorType,
  type SyncEntity,
  type SystemSettings,
} from '@calc-rental/shared';
import {
  ensureDefaultLocalAdmin,
  getLocalConfig,
  hashPassword,
  openLocalDatabase,
  setLocalConfig,
  verifyPassword,
  type LocalDatabase,
} from '@calc-rental/shared/sqlite';

export const LOCAL_SESSION_COOKIE = 'calc_local_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Default real-hardware inventory matching docs/onboarding.md §3 #5. */
const BOOTSTRAP_IDS = {
  device: '00000000-0000-4000-8000-000000000001',
  locker1: '00000000-0000-4000-8000-000000000101',
  locker2: '00000000-0000-4000-8000-000000000102',
  calc1: '00000000-0000-4000-8000-000000000201',
  calc2: '00000000-0000-4000-8000-000000000202',
} as const;

export const DEFAULT_KIOSK_SETTINGS: SystemSettings = {
  rentalFee: 20,
  rentalDurationMinutes: 180,
  gracePeriodMinutes: 10,
  penaltyEnabled: true,
  penaltyType: PenaltyType.PER_INTERVAL,
  penaltyAmount: 10,
  penaltyIntervalMinutes: 90,
  penaltySteps: [],
  maxPenalty: null,
  maxConcurrentRentalsPerStudent: 1,
  unpaidPenaltyBlocksRental: true,
  acceptedCoinDenominations: [1, 5, 10, 20],
  paymentTimeoutSeconds: 120,
  removalTimeoutSeconds: 60,
  returnTimeoutSeconds: 90,
  allowOfflineReturns: true,
  allowOfflineRentals: true,
  operatingHoursStart: '09:00',
  operatingHoursEnd: '17:00',
  operatingDays: [1, 2, 3, 4, 5],
  closedDates: [],
  pauseClockOutsideHours: true,
};

export function resolveLocalSqlitePath(): string {
  const configured = process.env.SQLITE_PATH?.trim();
  if (configured) return path.resolve(configured);

  const cwd = process.cwd();
  // Running inside `apps/web` vs repository root:
  const fromWebWorkspace = path.resolve(cwd, '../raspberry-pi/data/kiosk.db');
  if (fs.existsSync(path.resolve(cwd, '../raspberry-pi'))) {
    return fromWebWorkspace;
  }
  return path.resolve(cwd, 'apps/raspberry-pi/data/kiosk.db');
}

declare global {
  var __calcRentalWebSqlite: { path: string; db: LocalDatabase } | undefined;
}

/**
 * Ensures a brand-new Raspberry Pi SQLite database has default settings,
 * lockers, calculators (with the team's real RFID tag UIDs), and a default
 * local Super Admin so both kiosk and dashboard work immediately offline.
 */
export function bootstrapLocalDatabase(db: LocalDatabase): void {
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    const hasSettings = db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
    if (!hasSettings) {
      const validated = SystemSettingsSchema.parse(DEFAULT_KIOSK_SETTINGS);
      db.prepare('INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)').run(
        JSON.stringify(validated),
        nowIso,
      );
    }

    const lockerCount = (db.prepare('SELECT COUNT(*) AS n FROM lockers').get() as { n: number }).n;
    if (lockerCount === 0) {
      const insLocker = db.prepare(
        `INSERT INTO lockers (id, locker_number, name, hardware_channel, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insLocker.run(BOOTSTRAP_IDS.locker1, 1, 'Locker 1', 1, LockerStatus.AVAILABLE, nowIso);
      insLocker.run(BOOTSTRAP_IDS.locker2, 2, 'Locker 2', 2, LockerStatus.AVAILABLE, nowIso);
    }

    const calcCount = (db.prepare('SELECT COUNT(*) AS n FROM calculators').get() as { n: number }).n;
    if (calcCount === 0) {
      const l1 = db.prepare('SELECT id FROM lockers WHERE locker_number = 1').get() as { id: string } | undefined;
      const l2 = db.prepare('SELECT id FROM lockers WHERE locker_number = 2').get() as { id: string } | undefined;
      const insCalc = db.prepare(
        `INSERT INTO calculators (id, code, model, rfid_uid, locker_id, status, condition, updated_at)
         VALUES (?, ?, 'Casio fx-991EX ClassWiz', ?, ?, ?, ?, ?)`,
      );
      insCalc.run(
        BOOTSTRAP_IDS.calc1,
        'CALC-001',
        'FE-AC-31-03',
        l1?.id ?? null,
        l1 ? CalculatorStatus.AVAILABLE : CalculatorStatus.MAINTENANCE,
        CalculatorCondition.GOOD,
        nowIso,
      );
      insCalc.run(
        BOOTSTRAP_IDS.calc2,
        'CALC-002',
        '57-99-3B-03',
        l2?.id ?? null,
        l2 ? CalculatorStatus.AVAILABLE : CalculatorStatus.MAINTENANCE,
        CalculatorCondition.GOOD,
        nowIso,
      );
    }

    if (!getLocalConfig(db, 'device_id')) {
      setLocalConfig(db, 'device_id', process.env.DEVICE_ID?.trim() || 'DEVICE-CALC-KIOSK-001');
    }
  })();

  ensureDefaultLocalAdmin(db, {
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
    fullName: process.env.LOCAL_ADMIN_NAME,
  });
}

export function getLocalDb(): LocalDatabase {
  const target = resolveLocalSqlitePath();
  if (globalThis.__calcRentalWebSqlite && globalThis.__calcRentalWebSqlite.path === target) {
    return globalThis.__calcRentalWebSqlite.db;
  }
  if (globalThis.__calcRentalWebSqlite) {
    try {
      globalThis.__calcRentalWebSqlite.db.close();
    } catch {
      // ignore close error
    }
  }
  const db = openLocalDatabase(target);
  bootstrapLocalDatabase(db);
  globalThis.__calcRentalWebSqlite = { path: target, db };
  return db;
}

/** Appends a local officer change to `sync_queue` so `SyncService` pushes it to cloud when online. */
export function enqueueLocalSync(db: LocalDatabase, entity: SyncEntity, entityId: string, payload: unknown): void {
  db.prepare('INSERT INTO sync_queue (entity, entity_id, payload) VALUES (?, ?, ?)').run(
    entity,
    entityId,
    JSON.stringify(payload),
  );
}

// ---------------------------------------------------------------------------
// Local Audit Log
// ---------------------------------------------------------------------------

export function writeLocalAuditLog(entry: {
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}): void {
  const db = getLocalDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const prevJson = entry.previousValue === undefined || entry.previousValue === null ? null : JSON.stringify(entry.previousValue);
  const newJson = entry.newValue === undefined || entry.newValue === null ? null : JSON.stringify(entry.newValue);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, actor_label, action, target_type, target_id, previous_value, new_value, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      entry.actorType,
      entry.actorId ?? null,
      entry.actorLabel ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      prevJson,
      newJson,
      entry.reason ?? null,
      createdAt,
    );
    enqueueLocalSync(db, 'audit_log', id, {
      id,
      actor_type: entry.actorType,
      actor_id: entry.actorId ?? null,
      actor_label: entry.actorLabel ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      previous_value: entry.previousValue ?? null,
      new_value: entry.newValue ?? null,
      reason: entry.reason ?? null,
      created_at: createdAt,
    });
  })();
}

// ---------------------------------------------------------------------------
// Local Sessions & Authentication
// ---------------------------------------------------------------------------

export interface LocalAdminRow {
  id: string;
  email: string;
  full_name: string | null;
  role: AdminRole;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function signInLocalAdmin(
  email: string,
  password: string,
):
  | { ok: true; admin: LocalAdminRow; sessionToken: string; expiresAt: Date }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'inactive'; admin: LocalAdminRow } {
  const db = getLocalDb();
  const normalizedEmail = email.trim().toLowerCase();
  const row = db
    .prepare('SELECT * FROM local_admins WHERE LOWER(email) = ?')
    .get(normalizedEmail) as (LocalAdminRow & { password_hash: string }) | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  const { password_hash: _ignored, ...admin } = row;
  if (row.is_active !== 1) {
    return { ok: false, reason: 'inactive', admin };
  }

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.transaction(() => {
    db.prepare('DELETE FROM local_sessions WHERE expires_at <= ?').run(nowIso);
    db.prepare('INSERT INTO local_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      tokenHash,
      admin.id,
      expiresAt.toISOString(),
      nowIso,
    );
    db.prepare('UPDATE local_admins SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, admin.id);
  })();

  return { ok: true, admin: { ...admin, last_login_at: nowIso }, sessionToken: rawToken, expiresAt };
}

export function getLocalSessionAdmin(rawToken: string | undefined | null): LocalAdminRow | null {
  if (!rawToken) return null;
  const db = getLocalDb();
  const nowIso = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT a.id, a.email, a.full_name, a.role, a.is_active, a.last_login_at, a.created_at, a.updated_at
       FROM local_sessions s
       JOIN local_admins a ON a.id = s.admin_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(rawToken), nowIso) as LocalAdminRow | undefined;
  return row ?? null;
}

export function revokeLocalSession(rawToken: string | undefined | null): LocalAdminRow | null {
  if (!rawToken) return null;
  const db = getLocalDb();
  const admin = getLocalSessionAdmin(rawToken);
  db.prepare('DELETE FROM local_sessions WHERE token_hash = ?').run(hashToken(rawToken));
  return admin;
}

// ---------------------------------------------------------------------------
// Local Admin Account Management (SUPER_ADMIN)
// ---------------------------------------------------------------------------

export function listLocalAdmins(): LocalAdminRow[] {
  const db = getLocalDb();
  return db
    .prepare(
      `SELECT id, email, full_name, role, is_active, last_login_at, created_at, updated_at
       FROM local_admins
       ORDER BY created_at ASC`,
    )
    .all() as LocalAdminRow[];
}

export function createLocalAdminAccount(input: {
  email: string;
  fullName: string | null;
  password: string;
  role: AdminRole;
}): { ok: true; id: string } | { ok: false; message: string } {
  const db = getLocalDb();
  const email = input.email.trim().toLowerCase();
  const exists = db.prepare('SELECT 1 FROM local_admins WHERE LOWER(email) = ?').get(email);
  if (exists) return { ok: false, message: 'An account with that email already exists.' };

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO local_admins (id, email, full_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, email, input.fullName, hashPassword(input.password), input.role, nowIso, nowIso);
  return { ok: true, id };
}

export function updateLocalAdminAccount(input: {
  id: string;
  fullName: string | null;
  role: AdminRole;
  isActive: boolean;
  actorId: string;
}): { ok: true; before: LocalAdminRow } | { ok: false; message: string } {
  const db = getLocalDb();
  const before = db
    .prepare('SELECT id, email, full_name, role, is_active, last_login_at, created_at, updated_at FROM local_admins WHERE id = ?')
    .get(input.id) as LocalAdminRow | undefined;
  if (!before) return { ok: false, message: 'Admin account not found.' };

  if (before.id === input.actorId) {
    if (!input.isActive) return { ok: false, message: 'You cannot deactivate your own account.' };
    if (input.role !== AdminRole.SUPER_ADMIN) return { ok: false, message: 'You cannot lower your own Super Admin role.' };
  }

  if (before.role === AdminRole.SUPER_ADMIN && before.is_active === 1 && (!input.isActive || input.role !== AdminRole.SUPER_ADMIN)) {
    const activeSuperCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM local_admins WHERE role = 'SUPER_ADMIN' AND is_active = 1`)
        .get() as { n: number }
    ).n;
    if (activeSuperCount <= 1) {
      return { ok: false, message: 'At least one active Super Admin account must remain.' };
    }
  }

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE local_admins SET full_name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?`,
    ).run(input.fullName, input.role, input.isActive ? 1 : 0, nowIso, before.id);
    if (!input.isActive) {
      db.prepare('DELETE FROM local_sessions WHERE admin_id = ?').run(before.id);
    }
  })();

  return { ok: true, before };
}

export function resetLocalAdminPassword(input: {
  id: string;
  newPassword: string;
  keepToken?: string | null;
}): { ok: true; email: string } | { ok: false; message: string } {
  const db = getLocalDb();
  const before = db.prepare('SELECT id, email FROM local_admins WHERE id = ?').get(input.id) as
    | { id: string; email: string }
    | undefined;
  if (!before) return { ok: false, message: 'Admin account not found.' };

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE local_admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(input.newPassword),
      nowIso,
      before.id,
    );
    if (input.keepToken) {
      db.prepare('DELETE FROM local_sessions WHERE admin_id = ? AND token_hash <> ?').run(
        before.id,
        hashToken(input.keepToken),
      );
    } else {
      db.prepare('DELETE FROM local_sessions WHERE admin_id = ?').run(before.id);
    }
  })();
  return { ok: true, email: before.email };
}

export { getLocalConfig, setLocalConfig };
