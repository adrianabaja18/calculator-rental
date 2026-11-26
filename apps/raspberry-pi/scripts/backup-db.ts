/**
 * Creates a consistent, crash-safe snapshot backup of the local SQLite database
 * using SQLite's `VACUUM INTO`, safe to run even while the kiosk and web app
 * are actively serving requests on the Raspberry Pi 4.
 *
 *   npm run backup:pi
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import { openLocalDatabase } from '../src/db/sqlite';

const db = openLocalDatabase(config.SQLITE_PATH);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupsDir = path.resolve(process.cwd(), '../../backups');
fs.mkdirSync(backupsDir, { recursive: true });

const target = path.join(backupsDir, `kiosk-${stamp}.db`);
const escaped = target.replace(/'/g, "''");
db.exec(`VACUUM INTO '${escaped}'`);
db.close();

const sizeKb = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`Backup saved: ${target} (${sizeKb} KB)`);
