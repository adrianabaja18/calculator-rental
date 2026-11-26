/**
 * Loads the DEVELOPMENT seed (fake students, CALC-001/002, Locker 1/2,
 * current pricing, and default local Super Admin) into the kiosk's SQLite file.
 *
 *   npm run seed:pi                    sensors stay UNKNOWN (like unwired hardware)
 *   npm run seed:pi -- --sensors-ready simulate both calculators present
 *   npm run seed:pi -- --rfid1 FE-AC-31-03 --rfid2 57-99-3B-03
 *                                      use your REAL tag UIDs (from hwcheck:pi -> watch)
 */
import path from 'node:path';
import { normalizeRfidUid } from '@calc-rental/shared';
import { seedDevData } from '../src/db/dev-seed';
import { KioskStore } from '../src/db/kiosk-store';
import {
  DEFAULT_LOCAL_ADMIN_EMAIL,
  DEFAULT_LOCAL_ADMIN_PASSWORD,
  ensureDefaultLocalAdmin,
  openLocalDatabase,
} from '../src/db/sqlite';
import { config } from '../src/config';

const sensorsReady = process.argv.includes('--sensors-ready');
const db = openLocalDatabase(config.SQLITE_PATH);
const store = new KioskStore(db);
seedDevData(store, { sensorsReady, nowIso: new Date().toISOString() });

const adminInfo = ensureDefaultLocalAdmin(db, {
  email: process.env.LOCAL_ADMIN_EMAIL,
  password: process.env.LOCAL_ADMIN_PASSWORD,
  fullName: process.env.LOCAL_ADMIN_NAME,
});

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
for (const [name, code] of [['--rfid1', 'CALC-001'], ['--rfid2', 'CALC-002']] as const) {
  const raw = flag(name);
  if (raw === undefined) continue;
  const uid = normalizeRfidUid(raw);
  if (!uid) {
    console.error(`${name} "${raw}" is not a valid UID (expected hex bytes like FE-AC-31-03)`);
    process.exit(1);
  }
  db.prepare(`UPDATE calculators SET rfid_uid = ? WHERE code = ?`).run(uid, code);
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const tags = db.prepare(`SELECT code, rfid_uid FROM calculators ORDER BY code`).all() as { code: string; rfid_uid: string }[];
console.log(`Seeded ${path.resolve(config.SQLITE_PATH)}`);
console.log(`  students=${count('students')} lockers=${count('lockers')} calculators=${count('calculators')} settings=${count('settings')} local_admins=${count('local_admins')}`);
console.log(`  RFID tags: ${tags.map((t) => `${t.code}=${t.rfid_uid}`).join(', ')}`);
console.log(`  local Super Admin: ${adminInfo.email} (${adminInfo.created ? `created with password ${process.env.LOCAL_ADMIN_PASSWORD || DEFAULT_LOCAL_ADMIN_PASSWORD}` : 'already existed'})`);
console.log(`  sensors: ${sensorsReady ? 'simulated READY (both calculators detected)' : 'UNKNOWN (no locker is lendable until hardware reports)'}`);
db.close();
