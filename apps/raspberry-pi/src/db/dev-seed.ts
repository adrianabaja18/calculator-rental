import { PenaltyType, type SystemSettings } from '@calc-rental/shared';
import type { KioskStore } from './kiosk-store';

/**
 * DEVELOPMENT data for the kiosk's SQLite database — the same fake records
 * (same UUIDs) as supabase/seed.sql, so local rows line up with the cloud.
 *
 * Until two-way sync exists (Phase 12) this is how a laptop or test kiosk
 * gets its students, lockers, calculators and settings.
 */

export const DEV_IDS = {
  locker1: '00000000-0000-4000-8000-000000000101',
  locker2: '00000000-0000-4000-8000-000000000102',
  calc1: '00000000-0000-4000-8000-000000000201',
  calc2: '00000000-0000-4000-8000-000000000202',
  juan: '00000000-0000-4000-8000-000000000301',
  maria: '00000000-0000-4000-8000-000000000302',
  pedro: '00000000-0000-4000-8000-000000000303',
  ana: '00000000-0000-4000-8000-000000000304',
  carlo: '00000000-0000-4000-8000-000000000305',
} as const;

export const DEV_RFID = { calc1: '04-A1-B2-C3-D4', calc2: '04-E5-F6-A7-B8' } as const;

/** Team pricing: ₱20 / 3 h (2026-11-17); ₱10 per started 1.5 h overdue, 10-min grace (2026-11-18). */
export const DEV_SETTINGS: SystemSettings = {
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
  allowOfflineRentals: false,
};

/**
 * @param sensorsReady simulate the hardware reporting both calculators
 *   present and both locks closed (otherwise sensors stay UNKNOWN and no
 *   locker is lendable — exactly like a kiosk whose readers aren't wired yet).
 */
export function seedDevData(store: KioskStore, options: { sensorsReady: boolean; nowIso: string }): void {
  const { db } = store;
  store.transaction(() => {
    store.saveSettings(DEV_SETTINGS, options.nowIso);

    const insertLocker = db.prepare(
      `INSERT OR IGNORE INTO lockers (id, locker_number, name, hardware_channel) VALUES (?, ?, ?, ?)`,
    );
    insertLocker.run(DEV_IDS.locker1, 1, 'Locker 1', 1);
    insertLocker.run(DEV_IDS.locker2, 2, 'Locker 2', 2);

    const insertCalc = db.prepare(
      `INSERT OR IGNORE INTO calculators (id, code, model, rfid_uid, locker_id) VALUES (?, ?, 'Casio fx-991EX ClassWiz', ?, ?)`,
    );
    insertCalc.run(DEV_IDS.calc1, 'CALC-001', DEV_RFID.calc1, DEV_IDS.locker1);
    insertCalc.run(DEV_IDS.calc2, 'CALC-002', DEV_RFID.calc2, DEV_IDS.locker2);

    const insertStudent = db.prepare(
      `INSERT OR IGNORE INTO students (id, student_number, full_name, course_program, status, blocked_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertStudent.run(DEV_IDS.juan, '2022100001', 'JUAN DELA CRUZ', 'BSCpE', 'ACTIVE', null);
    insertStudent.run(DEV_IDS.maria, '2023100002', 'MARIA SANTOS', 'BSCE', 'ACTIVE', null);
    insertStudent.run(DEV_IDS.pedro, '2024100003', 'PEDRO REYES', 'BSIT', 'ACTIVE', null);
    insertStudent.run(DEV_IDS.ana, '2022100004', 'ANA GARCIA', 'BSCpE', 'BLOCKED', 'DEV SEED: sample blocked account');
    insertStudent.run(DEV_IDS.carlo, '2025100005', 'CARLO MENDOZA', 'BSEE', 'ACTIVE', null);

    if (options.sensorsReady) {
      store.setLockerSensors(DEV_IDS.locker1, { lockState: 'LOCKED', rfidState: 'EXPECTED_TAG', detectedRfidUid: DEV_RFID.calc1 }, options.nowIso);
      store.setLockerSensors(DEV_IDS.locker2, { lockState: 'LOCKED', rfidState: 'EXPECTED_TAG', detectedRfidUid: DEV_RFID.calc2 }, options.nowIso);
    }
  });
}
