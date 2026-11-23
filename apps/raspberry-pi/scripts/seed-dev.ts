/**
 * Loads the DEVELOPMENT seed (fake students, CALC-001/002, Locker 1/2,
 * current pricing) into the kiosk's real SQLite file (SQLITE_PATH).
 *
 *   npm run seed:pi                    sensors stay UNKNOWN (like unwired hardware)
 *   npm run seed:pi -- --sensors-ready simulate both calculators present
 *   npm run seed:pi -- --rfid1 A3-1F-22-9B --rfid2 63-0C-7E-11
 *                                      use your REAL tag UIDs (from hwcheck:pi -> watch)
 *
 * Safe to run more than once. Replaced by two-way sync in Phase 12.
 */
import path from 'node:path';
import { normalizeRfidUid } from '@calc-rental/shared';
import { seedDevData } from '../src/db/dev-seed';
import { KioskStore } from '../src/db/kiosk-store';
import { openLocalDatabase } from '../src/db/sqlite';
import { config } from '../src/config';

const sensorsReady = process.argv.includes('--sensors-ready');
const db = openLocalDatabase(config.SQLITE_PATH);
const store = new KioskStore(db);
seedDevData(store, { sensorsReady, nowIso: new Date().toISOString() });

// Real tag UIDs: --rfid1 -> CALC-001 (Locker 1), --rfid2 -> CALC-002 (Locker 2).
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
for (const [name, code] of [['--rfid1', 'CALC-001'], ['--rfid2', 'CALC-002']] as const) {
  const raw = flag(name);
  if (raw === undefined) continue;
  const uid = normalizeRfidUid(raw);
  if (!uid) {
    console.error(`${name} "${raw}" is not a valid UID (expected hex bytes like A3-1F-22-9B)`);
    process.exit(1);
  }
  db.prepare(`UPDATE calculators SET rfid_uid = ? WHERE code = ?`).run(uid, code);
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const tags = db.prepare(`SELECT code, rfid_uid FROM calculators ORDER BY code`).all() as { code: string; rfid_uid: string }[];
console.log(`Seeded ${path.resolve(config.SQLITE_PATH)}`);
console.log(`  students=${count('students')} lockers=${count('lockers')} calculators=${count('calculators')} settings=${count('settings')}`);
console.log(`  RFID tags: ${tags.map((t) => `${t.code}=${t.rfid_uid}`).join(', ')}`);
console.log(`  sensors: ${sensorsReady ? 'simulated READY (both calculators detected)' : 'UNKNOWN (no locker is lendable until hardware reports)'}`);
db.close();
