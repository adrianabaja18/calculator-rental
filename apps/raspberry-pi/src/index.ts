import fs from 'node:fs';
import { APP_VERSION, HEARTBEAT_INTERVAL_SECONDS, MAX_CLOCK_DRIFT_SECONDS } from '@calc-rental/shared';
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
 *   4. sends a heartbeat every 30 s (device-authenticated; sync arrives in Phase 12),
 *   5. shuts down cleanly on Ctrl+C / systemd stop.
 */

const TICK_MS = 250;

/** Raspberry Pi CPU temperature in °C, or null on other machines. */
function readCpuTemperature(): number | null {
  try {
    return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
  } catch {
    return null;
  }
}

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

  const backend = new BackendClient({
    baseUrl: config.BACKEND_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    deviceId: config.DEVICE_ID,
    deviceSecret: config.DEVICE_SECRET,
  });
  let backendOnline: boolean | null = null;
  const heartbeat = async () => {
    const result = await backend.heartbeat({
      softwareVersion: APP_VERSION,
      kioskState: kiosk.state,
      syncQueueCount: store.pendingSyncCount(),
      localDbOk: db.pragma('quick_check', { simple: true }) === 'ok',
      cpuTempC: readCpuTemperature(),
      sentAt: now().toISOString(),
    });
    if (result.ok !== backendOnline) {
      if (result.ok) logger.info({ event: 'DEVICE_ONLINE', latencyMs: result.latencyMs }, 'Backend reachable, heartbeat accepted');
      else logger.warn({ event: 'DEVICE_OFFLINE', code: result.code }, `${result.message} (kiosk keeps working offline)`);
      backendOnline = result.ok;
    }
    if (result.ok && Math.abs(result.data.clockDriftSeconds) > MAX_CLOCK_DRIFT_SECONDS) {
      logger.warn({ event: 'SYSTEM_ERROR', clockDriftSeconds: result.data.clockDriftSeconds }, 'Kiosk clock differs from the server');
    }
  };
  await heartbeat();
  const connectivity = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_SECONDS * 1000);

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
