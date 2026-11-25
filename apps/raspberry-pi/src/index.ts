import fs from 'node:fs';
import { APP_VERSION, HEARTBEAT_INTERVAL_SECONDS, MAX_CLOCK_DRIFT_SECONDS } from '@calc-rental/shared';
import { BackendClient } from './backend/client';
import { bridgeArgs, config } from './config';
import { KioskStore } from './db/kiosk-store';
import { getLocalConfig, getSchemaVersion, openLocalDatabase, setLocalConfig } from './db/sqlite';
import { createMockHardware } from './hardware/mock';
import { BridgeClient } from './hardware/real/bridge-client';
import {
  BridgeButtons,
  BridgeBuzzer,
  BridgeCoinAcceptor,
  BridgeDisplay,
  BridgeLockerController,
  BridgeRFIDReader,
  SystemClock,
} from './hardware/real/bridge-hardware';
import { SerialQRScanner } from './hardware/real/serial-qr-scanner';
import type { Hardware } from './hardware/types';
import { printLcd, startMockConsole } from './hardware/mock-console';
import { KioskController } from './kiosk/kiosk-controller';
import { logger } from './logger';
import { PaymentService } from './payment/payment-service';
import { RentalService } from './rental/rental-service';
import { ReturnService } from './rental/return-service';
import { SyncService } from './sync/sync-service';

/**
 * Raspberry Pi kiosk service.
 *
 *   1. validates configuration and opens the local SQLite database (main DB),
 *   2. builds the hardware: HARDWARE_MODE=mock (laptop console) or real (Pi, via the Python bridge),
 *   3. runs the kiosk state machine (tick every 250 ms),
 *   4. syncs with Supabase (Phase 12: outbox push every 10 s, officer data pull every 60 s)
 *      and sends a device-authenticated heartbeat every 30 s,
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

  // The ESP32-CAM scanner (Phase 10) works in both modes.
  const serialScanner =
    config.QR_SCANNER === 'serial'
      ? new SerialQRScanner(config.SCANNER_PORT, (level, message, data) => logger[level]({ event: 'QR_SCANNER', ...data }, message))
      : null;

  // Mock mode: a clock the console can move forward to try late returns. Real mode: the system clock.
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const mock = createMockHardware(printLcd);
  let bridge: BridgeClient | null = null;
  let hardware: Hardware;

  if (config.HARDWARE_MODE === 'real') {
    // Phase 11: relays, coin pulses, RC522 readers, LCD and buzzer through the Python bridge.
    bridge = new BridgeClient({
      pythonBin: config.PYTHON_BIN,
      args: bridgeArgs(config),
      log: (level, message, data) => logger[level]({ event: 'HW_BRIDGE', ...data }, message),
    });
    bridge.start();
    const ready = await Promise.race([bridge.ready, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    if (!ready) throw new Error('Hardware bridge did not start. Run: npm run hwcheck:pi');
    logger.info({ event: 'HW_BRIDGE', mode: ready.mode, devices: ready.devices }, 'Hardware bridge ready');
    hardware = {
      scanner: serialScanner ?? mock.scanner,
      coins: new BridgeCoinAcceptor(bridge),
      rfid: new BridgeRFIDReader(bridge),
      lockers: new BridgeLockerController(bridge),
      buttons: new BridgeButtons(bridge),
      display: new BridgeDisplay(bridge, config.LOG_PRETTY ? printLcd : undefined),
      buzzer: new BridgeBuzzer(bridge),
      clock: new SystemClock(),
    };
  } else {
    for (const locker of store.listLockerHardware()) {
      if (locker.expectedUid) mock.rfid.place(locker.channel, locker.expectedUid); // calculators start inside
    }
    hardware = { ...mock, scanner: serialScanner ?? mock.scanner };
  }

  const rentals = new RentalService(store, { deviceCode: config.DEVICE_ID, now });
  const payments = new PaymentService(store, rentals, { now });
  const returns = new ReturnService(store, payments, { now });
  const kiosk = new KioskController(store, hardware, { rentals, payments, returns }, {
    now,
    log: (level, message, data) => logger[level]({ event: 'KIOSK', ...data }, message),
  });
  await kiosk.start();
  serialScanner?.start();
  const ticker = setInterval(() => void kiosk.tick(), TICK_MS);
  // Keyboard console only with simulated hardware (the real kiosk has no keyboard).
  const console_ =
    config.HARDWARE_MODE === 'mock'
      ? startMockConsole({ hw: mock, kiosk, store, addMinutes: (m) => (offsetMs += m * 60_000) })
      : null;

  const backend = new BackendClient({
    baseUrl: config.BACKEND_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    deviceId: config.DEVICE_ID,
    deviceSecret: config.DEVICE_SECRET,
  });
  const sync = new SyncService(store, backend, {
    now,
    log: (level, message, data) => logger[level]({ event: 'SYNC', ...data }, message),
  });
  sync.start();

  let backendOnline: boolean | null = null;
  const heartbeat = async () => {
    const result = await backend.heartbeat({
      softwareVersion: APP_VERSION,
      kioskState: kiosk.state,
      syncQueueCount: store.pendingSyncCount(),
      localDbOk: db.pragma('quick_check', { simple: true }) === 'ok',
      cpuTempC: readCpuTemperature(),
      sentAt: now().toISOString(),
      lockers: store.lockerSensorReports(),
      sync: sync.status(),
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
    sync.stop();
    console_?.close();
    bridge?.stop();
    serialScanner?.stop();
    db.close(); // checkpoints the WAL; safe to power off afterwards
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    { event: 'SERVICE_READY', qrScanner: config.QR_SCANNER === 'serial' ? config.SCANNER_PORT : 'mock' },
    config.HARDWARE_MODE === 'mock' ? 'Kiosk running on SIMULATED hardware. Type "help" for controls, Ctrl+C to stop.' : 'Kiosk running on REAL hardware.',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ event: 'SYSTEM_ERROR', err: error }, 'Kiosk service crashed during startup');
  process.exitCode = 1;
});
