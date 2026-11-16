/**
 * Loads the DEVELOPMENT seed (fake students, CALC-001/002, Locker 1/2,
 * current pricing) into the kiosk's real SQLite file (SQLITE_PATH).
 *
 *   npm run seed:pi                    sensors stay UNKNOWN (like unwired hardware)
 *   npm run seed:pi -- --sensors-ready simulate both calculators present
 *
 * Safe to run more than once. Replaced by two-way sync in Phase 12.
 */
import path from 'node:path';
import { seedDevData } from '../src/db/dev-seed';
import { KioskStore } from '../src/db/kiosk-store';
import { openLocalDatabase } from '../src/db/sqlite';
import { config } from '../src/config';

const sensorsReady = process.argv.includes('--sensors-ready');
const db = openLocalDatabase(config.SQLITE_PATH);
const store = new KioskStore(db);
seedDevData(store, { sensorsReady, nowIso: new Date().toISOString() });

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(`Seeded ${path.resolve(config.SQLITE_PATH)}`);
console.log(`  students=${count('students')} lockers=${count('lockers')} calculators=${count('calculators')} settings=${count('settings')}`);
console.log(`  sensors: ${sensorsReady ? 'simulated READY (both calculators detected)' : 'UNKNOWN (no locker is lendable until hardware reports)'}`);
db.close();
