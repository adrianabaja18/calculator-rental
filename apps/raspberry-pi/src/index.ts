import { APP_VERSION } from '@calc-rental/shared';
import { BackendClient } from './backend/client';
import { config } from './config';
import { getLocalConfig, getSchemaVersion, openLocalDatabase, setLocalConfig } from './db/sqlite';
import { logger } from './logger';

/**
 * Raspberry Pi kiosk service — Phase 1 skeleton.
 *
 * Right now it only:
 *   1. validates configuration,
 *   2. opens/migrates the local SQLite database and records the boot,
 *   3. checks backend connectivity every 60 seconds,
 *   4. shuts down cleanly on Ctrl+C / systemd stop.
 *
 * Later phases plug in: the kiosk state machine (Phase 9), hardware adapters
 * (Phases 10–11), heartbeat + offline sync (Phases 12–13).
 */

const CONNECTIVITY_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  logger.info(
    { event: 'SERVICE_STARTING', version: APP_VERSION, hardwareMode: config.HARDWARE_MODE },
    'Raspberry Pi kiosk service starting',
  );

  const db = openLocalDatabase(config.SQLITE_PATH);
  const bootCount = Number(getLocalConfig(db, 'boot_count') ?? '0') + 1;
  setLocalConfig(db, 'boot_count', String(bootCount));
  setLocalConfig(db, 'last_boot_at', new Date().toISOString());
  setLocalConfig(db, 'device_id', config.DEVICE_ID);
  logger.info(
    { event: 'SQLITE_READY', path: config.SQLITE_PATH, schemaVersion: getSchemaVersion(db), bootCount },
    'Local SQLite database ready',
  );

  const backend = new BackendClient({ baseUrl: config.BACKEND_URL, timeoutMs: config.HTTP_TIMEOUT_MS });
  let backendOnline: boolean | null = null;

  const checkBackend = async () => {
    const result = await backend.getHealth();
    const online = result.ok;
    if (online !== backendOnline) {
      // Log only on CHANGE, to avoid flooding logs every minute.
      if (result.ok) {
        logger.info(
          { event: 'DEVICE_ONLINE', latencyMs: result.latencyMs, backendStatus: result.data.status },
          'Backend reachable',
        );
      } else {
        logger.warn({ event: 'DEVICE_OFFLINE', code: result.code }, result.message);
      }
      backendOnline = online;
    }
  };

  await checkBackend();
  const timer = setInterval(() => void checkBackend(), CONNECTIVITY_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'SERVICE_STOPPING', signal }, 'Shutting down');
    clearInterval(timer);
    db.close(); // checkpoints the WAL; safe to power off afterwards
    // No process.exit(): with nothing left scheduled, Node exits by itself
    // after the logger has flushed its last lines.
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ event: 'SERVICE_READY' }, 'Kiosk service running (Phase 1 skeleton). Press Ctrl+C to stop.');
}

main().catch((error: unknown) => {
  logger.fatal({ event: 'SYSTEM_ERROR', err: error }, 'Kiosk service crashed during startup');
  process.exitCode = 1;
});
