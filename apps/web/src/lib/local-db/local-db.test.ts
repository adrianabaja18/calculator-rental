import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ActorType, AdminRole } from '@calc-rental/shared';
import { DEFAULT_LOCAL_ADMIN_EMAIL, DEFAULT_LOCAL_ADMIN_PASSWORD } from '@calc-rental/shared/sqlite';
import {
  createLocalAdminAccount,
  getLocalDb,
  getLocalSessionAdmin,
  listLocalAdmins,
  resetLocalAdminPassword,
  revokeLocalSession,
  signInLocalAdmin,
  updateLocalAdminAccount,
  writeLocalAuditLog,
} from './index';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-web-local-'));
  process.env.SQLITE_PATH = path.join(tempDir, 'kiosk.db');
  delete process.env.LOCAL_ADMIN_EMAIL;
  delete process.env.LOCAL_ADMIN_PASSWORD;
});

afterEach(() => {
  if (globalThis.__calcRentalWebSqlite) {
    globalThis.__calcRentalWebSqlite.db.close();
    globalThis.__calcRentalWebSqlite = undefined;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('local Raspberry Pi SQLite auth & admin management', () => {
  it('bootstraps default Super Admin, inventory, and settings on an empty database', () => {
    const db = getLocalDb();
    const admins = listLocalAdmins();
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({
      email: DEFAULT_LOCAL_ADMIN_EMAIL,
      role: AdminRole.SUPER_ADMIN,
      is_active: 1,
    });

    const calcs = db.prepare('SELECT code, rfid_uid FROM calculators ORDER BY code').all();
    expect(calcs).toEqual([
      { code: 'CALC-001', rfid_uid: 'FE-AC-31-03' },
      { code: 'CALC-002', rfid_uid: '57-99-3B-03' },
    ]);
  });

  it('authenticates valid credentials, tracks sessions, and revokes on sign-out', () => {
    expect(signInLocalAdmin(DEFAULT_LOCAL_ADMIN_EMAIL, 'wrong-password')).toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });

    const login = signInLocalAdmin(DEFAULT_LOCAL_ADMIN_EMAIL, DEFAULT_LOCAL_ADMIN_PASSWORD);
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const sessionAdmin = getLocalSessionAdmin(login.sessionToken);
    expect(sessionAdmin?.email).toBe(DEFAULT_LOCAL_ADMIN_EMAIL);

    revokeLocalSession(login.sessionToken);
    expect(getLocalSessionAdmin(login.sessionToken)).toBeNull();
  });

  it('manages Officer accounts and prevents locking out the last Super Admin', () => {
    const [superAdmin] = listLocalAdmins();
    expect(superAdmin).toBeDefined();

    // Cannot deactivate or demote yourself / the sole Super Admin
    expect(
      updateLocalAdminAccount({
        id: superAdmin!.id,
        fullName: 'Boss',
        role: AdminRole.SUPER_ADMIN,
        isActive: false,
        actorId: superAdmin!.id,
      }),
    ).toEqual({ ok: false, message: 'You cannot deactivate your own account.' });

    // Create an Officer account
    const created = createLocalAdminAccount({
      email: 'officer@calcrental.ph',
      fullName: 'Kiosk Officer',
      password: 'OfficerPass123!',
      role: AdminRole.OFFICER,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const officerLogin = signInLocalAdmin('officer@calcrental.ph', 'OfficerPass123!');
    expect(officerLogin.ok).toBe(true);
    if (!officerLogin.ok) return;

    // Deactivating the officer revokes their active session immediately
    expect(
      updateLocalAdminAccount({
        id: created.id,
        fullName: 'Kiosk Officer',
        role: AdminRole.OFFICER,
        isActive: false,
        actorId: superAdmin!.id,
      }).ok,
    ).toBe(true);
    expect(getLocalSessionAdmin(officerLogin.sessionToken)).toBeNull();
    expect(signInLocalAdmin('officer@calcrental.ph', 'OfficerPass123!')).toMatchObject({
      ok: false,
      reason: 'inactive',
    });

    // Resetting password works once reactivated
    updateLocalAdminAccount({
      id: created.id,
      fullName: 'Kiosk Officer',
      role: AdminRole.OFFICER,
      isActive: true,
      actorId: superAdmin!.id,
    });
    expect(resetLocalAdminPassword({ id: created.id, newPassword: 'NewOfficerPass456!' }).ok).toBe(true);
    expect(signInLocalAdmin('officer@calcrental.ph', 'NewOfficerPass456!').ok).toBe(true);
  });

  it('enforces append-only audit_logs in SQLite and queues audit entries for cloud sync', () => {
    const db = getLocalDb();
    writeLocalAuditLog({
      actorType: ActorType.ADMIN,
      actorLabel: DEFAULT_LOCAL_ADMIN_EMAIL,
      action: 'SETTINGS_UPDATED',
      targetType: 'system_settings',
      targetId: '1',
      newValue: { rentalFee: 25 },
    });

    expect(() => db.prepare(`UPDATE audit_logs SET action = 'TAMPERED'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM audit_logs`).run()).toThrow(/append-only/);

    const queued = db.prepare(`SELECT entity FROM sync_queue WHERE entity = 'audit_log'`).all();
    expect(queued).toHaveLength(1);
  });
});
