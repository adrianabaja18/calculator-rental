/**
 * Phase 1 system check for the Raspberry Pi service.
 *
 *   npm run check:pi          (from the repository root)
 *
 * Verifies:
 *   1. Configuration (.env) is valid.
 *   2. Local SQLite is accessible: open, migrate, integrity check, WAL mode,
 *      and a write -> read -> delete round-trip inside a transaction.
 *   3. The backend API is reachable and returns a valid /api/health response.
 *
 * Exit code 0 = all required checks passed, 1 = at least one FAILED.
 * Supabase problems are WARNINGS here: the Pi only talks to the backend,
 * never to Supabase directly.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { APP_VERSION, formatPhilippineDateTime } from '@calc-rental/shared';
import { BackendClient } from '../src/backend/client';
import { config } from '../src/config';
import {
  deleteLocalConfig,
  getLocalConfig,
  getSchemaVersion,
  openLocalDatabase,
  setLocalConfig,
} from '../src/db/sqlite';
import { migrations } from '../src/db/migrations';

type Outcome = 'PASS' | 'WARN' | 'FAIL';
const results: { name: string; outcome: Outcome; detail: string }[] = [];

function record(name: string, outcome: Outcome, detail: string): void {
  results.push({ name, outcome, detail });
  const icon = outcome === 'PASS' ? '✔' : outcome === 'WARN' ? '!' : '✘';
  console.log(`  [${outcome}] ${icon} ${name} — ${detail}`);
}

function checkSqlite(): void {
  console.log('\n2) Local SQLite database');
  let db;
  try {
    db = openLocalDatabase(config.SQLITE_PATH);
    record('Open database', 'PASS', path.resolve(config.SQLITE_PATH));
  } catch (error) {
    record('Open database', 'FAIL', error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    const latest = migrations.at(-1)?.version ?? 0;
    const version = getSchemaVersion(db);
    record(
      'Schema migrations',
      version === latest ? 'PASS' : 'FAIL',
      `user_version=${version}, expected=${latest}`,
    );

    const integrity = db.pragma('integrity_check', { simple: true });
    record('Integrity check', integrity === 'ok' ? 'PASS' : 'FAIL', String(integrity));

    const journal = db.pragma('journal_mode', { simple: true });
    record('Journal mode', journal === 'wal' ? 'PASS' : 'WARN', String(journal));

    const probeKey = `__phase1_probe_${randomUUID()}`;
    const probeValue = new Date().toISOString();
    const roundTrip = db.transaction(() => {
      setLocalConfig(db, probeKey, probeValue);
      const readBack = getLocalConfig(db, probeKey);
      deleteLocalConfig(db, probeKey);
      return readBack;
    })();
    record(
      'Write / read / delete',
      roundTrip === probeValue ? 'PASS' : 'FAIL',
      roundTrip === probeValue ? 'round-trip succeeded inside a transaction' : `read back ${String(roundTrip)}`,
    );

    const bootCount = getLocalConfig(db, 'boot_count');
    record(
      'local_config table',
      'PASS',
      bootCount ? `service has booted ${bootCount} time(s)` : 'reachable (service not started yet)',
    );
  } catch (error) {
    record('SQLite operations', 'FAIL', error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

async function checkBackend(): Promise<void> {
  console.log('\n3) Backend API');
  const client = new BackendClient({ baseUrl: config.BACKEND_URL, timeoutMs: config.HTTP_TIMEOUT_MS });
  const result = await client.getHealth();

  if (!result.ok) {
    record('GET /api/health', 'FAIL', `${result.code}: ${result.message}`);
    return;
  }

  const report = result.data;
  record(
    'GET /api/health',
    'PASS',
    `HTTP ${result.httpStatus} in ${result.latencyMs} ms · ${report.service} v${report.version} (${report.environment})`,
  );
  record('Backend server time', 'PASS', `${formatPhilippineDateTime(report.serverTime)} PH (${report.serverTime} UTC)`);

  const supabase = report.checks.supabase;
  record('Backend → Supabase (public key)', supabase.status === 'ok' ? 'PASS' : 'WARN', supabase.message);

  const admin = report.checks.supabaseAdmin;
  record('Backend → Supabase (service role)', admin.status === 'ok' ? 'PASS' : 'WARN', admin.message);
}

async function main(): Promise<void> {
  console.log('==============================================================');
  console.log(' Calculator Rental Kiosk — Raspberry Pi System Check (Phase 1)');
  console.log('==============================================================');

  console.log('\n1) Configuration');
  record('Environment file', 'PASS', 'apps/raspberry-pi/.env loaded and validated');
  record('Device', 'PASS', `${config.DEVICE_ID} · software v${APP_VERSION} · hardware=${config.HARDWARE_MODE}`);
  record('Backend URL', 'PASS', config.BACKEND_URL);
  record('Node.js', 'PASS', `${process.version} on ${process.platform}/${process.arch}`);

  checkSqlite();
  await checkBackend();

  const failed = results.filter((r) => r.outcome === 'FAIL').length;
  const warned = results.filter((r) => r.outcome === 'WARN').length;
  const passed = results.length - failed - warned;

  console.log('\n--------------------------------------------------------------');
  console.log(` Result: ${passed} passed, ${warned} warning(s), ${failed} failed`);
  console.log(failed === 0 ? ' SYSTEM CHECK PASSED' : ' SYSTEM CHECK FAILED');
  console.log('--------------------------------------------------------------\n');

  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
