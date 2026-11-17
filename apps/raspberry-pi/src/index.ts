import { APP_VERSION } from '@calc-rental/shared';
import { BackendClient } from './backend/client';
import { config } from './config';
import { KioskStore } from './db/kiosk-store';
import { getLocalConfig, getSchemaVersion, openLocalDatabase, setLocalConfig } from './db/sqlite';
import { createMockHardware } from './hardware/mock';
import { printLcd, startMockConsole } from './hardware/mock-console';
import { KioskController } from './kiosk/kiosk-controller';
import { logger } from './logger';
import { PaymentService } from './payment/payment-service';
import { RentalService } from './rental/rental-service';
import { ReturnService } from './rental/return-service';

/**
 * Raspberry Pi kiosk service.
 *
 *   1. validates configuration and opens the local SQLite database (main DB),
 *   2. builds the hardware (mock now; real GPIO/SPI/I2C/serial in Phases 10–11),
 *   3. runs the kiosk state machine (tick every 250 ms),
 *   4. checks backend connectivity (heartbeat + sync arrive in Phases 9c/12),
 *   5. shuts down cleanly on Ctrl+C / systemd stop.
 */

const TICK_MS = 250;
const CONNECTIVITY_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  logger.info({ event: 'SERVICE_STARTING', version: APP_VERSION, hardwareMode: config.HARDWARE_MODE }, 'Kiosk service starting');

  const db = openLocalDatabase(config.SQLITE_PATH);
  const bootCount = Number(getLocalConfig(db, 'boot_count') ?? '0') + 1;
  setLocalConfig(db, 'boot_count', String(bootCount));
  setLocalConfig(db, 'last_boot_at', new Date().toISOString());
  setLocalConfig(db, 'device_id', config.DEVICE_ID);
  logger.info({ event: 'SQLITE_READY', schemaVersion: getSchemaVersion(db), bootCount }, 'Local SQLite database ready');

  const store = new KioskStore(db);
  if (!store.getSettings()) {
    logger.warn({ event: 'SYSTEM_ERROR' }, 'No settings in the kiosk database yet. For development run: npm run seed:pi');
  }

  if (config.HARDWARE_MODE === 'real') {
    throw new Error('Real hardware drivers arrive in Phases 10–11. Use HARDWARE_MODE=mock for now.');
  }

  // Mock mode: a clock the console can move forward to try late returns.
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const hw = createMockHardware(printLcd);
  for (const locker of store.listLockerHardware()) {
    if (locker.expectedUid) hw.rfid.place(locker.channel, locker.expectedUid); // calculators start inside
  }

  const rentals = new RentalService(store, { deviceCode: config.DEVICE_ID, now });
  const payments = new PaymentService(store, rentals, { now });
  const returns = new ReturnService(store, payments, { now });
  const kiosk = new KioskController(store, hw, { rentals, payments, returns }, {
    now,
    log: (level, message, data) => logger[level]({ event: 'KIOSK', ...data }, message),
  });
  await kiosk.start();
  const ticker = setInterval(() => void kiosk.tick(), TICK_MS);
  const console_ = startMockConsole({ hw, kiosk, store, addMinutes: (m) => (offsetMs += m * 60_000) });

  const backend = new BackendClient({ baseUrl: config.BACKEND_URL, timeoutMs: config.HTTP_TIMEOUT_MS });
  let backendOnline: boolean | null = null;
  const checkBackend = async () => {
    const result = await backend.getHealth();
    if (result.ok !== backendOnline) {
      if (result.ok) logger.info({ event: 'DEVICE_ONLINE', latencyMs: result.latencyMs }, 'Backend reachable');
      else logger.warn({ event: 'DEVICE_OFFLINE', code: result.code }, `${result.message} (kiosk keeps working offline)`);
      backendOnline = result.ok;
    }
  };
  await checkBackend();
  const connectivity = setInterval(() => void checkBackend(), CONNECTIVITY_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'SERVICE_STOPPING', signal }, 'Shutting down');
    clearInterval(ticker);
    clearInterval(connectivity);
    console_.close();
    db.close(); // checkpoints the WAL; safe to power off afterwards
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ event: 'SERVICE_READY' }, 'Kiosk running in MOCK mode. Type "help" for controls, Ctrl+C to stop.');
}

main().catch((error: unknown) => {
  logger.fatal({ event: 'SYSTEM_ERROR', err: error }, 'Kiosk service crashed during startup');
  process.exitCode = 1;
});
