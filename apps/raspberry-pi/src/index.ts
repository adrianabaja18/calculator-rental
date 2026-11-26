import fs from 'node:fs';
import {
  APP_VERSION,
  CalculatorCondition,
  CalculatorStatus,
  EventSeverity,
  EventType,
  HEARTBEAT_INTERVAL_SECONDS,
  LockerStatus,
  MAX_CLOCK_DRIFT_SECONDS,
} from '@calc-rental/shared';
import { startScanSession, takeScan } from '@calc-rental/shared/sqlite';
import { BackendClient } from './backend/client';
import { bridgeArgs, config } from './config';
import { DEV_IDS, DEV_SETTINGS } from './db/dev-seed';
import { KioskStore } from './db/kiosk-store';
import {
  ensureDefaultLocalAdmin,
  getLocalConfig,
  getSchemaVersion,
  openLocalDatabase,
  setLocalConfig,
  type LocalDatabase,
} from './db/sqlite';
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

const TICK_MS = 250;
const LOCAL_COMMAND_POLL_MS = 1000;
const LOCAL_HEARTBEAT_MS = 10_000;

function readCpuTemperature(): number | null {
  try {
    return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
  } catch {
    return null;
  }
}

/**
 * Bootstraps initial settings, lockers (1 & 2), calculators (with the team's
 * real RFID UIDs), and the default local Super Admin if `kiosk.db` is empty,
 * so the Raspberry Pi 4 runs standalone right out of the box.
 */
function ensureStandaloneBootstrap(db: LocalDatabase, store: KioskStore): void {
  const nowIso = new Date().toISOString();
  store.transaction(() => {
    if (!store.getSettings()) {
      store.saveSettings({ ...DEV_SETTINGS, allowOfflineRentals: true }, nowIso);
    }
    const lockerCount = (db.prepare('SELECT COUNT(*) AS n FROM lockers').get() as { n: number }).n;
    if (lockerCount === 0) {
      const insLocker = db.prepare(
        `INSERT INTO lockers (id, locker_number, name, hardware_channel, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insLocker.run(DEV_IDS.locker1, 1, 'Locker 1', 1, LockerStatus.AVAILABLE, nowIso);
      insLocker.run(DEV_IDS.locker2, 2, 'Locker 2', 2, LockerStatus.AVAILABLE, nowIso);
    }
    const calcCount = (db.prepare('SELECT COUNT(*) AS n FROM calculators').get() as { n: number }).n;
    if (calcCount === 0) {
      const l1 = db.prepare('SELECT id FROM lockers WHERE locker_number = 1').get() as { id: string } | undefined;
      const l2 = db.prepare('SELECT id FROM lockers WHERE locker_number = 2').get() as { id: string } | undefined;
      const insCalc = db.prepare(
        `INSERT INTO calculators (id, code, model, rfid_uid, locker_id, status, condition, updated_at)
         VALUES (?, ?, 'Casio fx-991EX ClassWiz', ?, ?, ?, ?, ?)`,
      );
      insCalc.run(DEV_IDS.calc1, 'CALC-001', 'FE-AC-31-03', l1?.id ?? null, CalculatorStatus.AVAILABLE, CalculatorCondition.GOOD, nowIso);
      insCalc.run(DEV_IDS.calc2, 'CALC-002', '57-99-3B-03', l2?.id ?? null, CalculatorStatus.AVAILABLE, CalculatorCondition.GOOD, nowIso);
    }
  });

  ensureDefaultLocalAdmin(db, {
    email: process.env.LOCAL_ADMIN_EMAIL,
    password: process.env.LOCAL_ADMIN_PASSWORD,
    fullName: process.env.LOCAL_ADMIN_NAME,
  });
}

async function main(): Promise<void> {
  logger.info(
    {
      event: 'SERVICE_STARTING',
      version: APP_VERSION,
      hardwareMode: config.HARDWARE_MODE,
      cloudSync: config.CLOUD_SYNC_ENABLED,
    },
    'Kiosk service starting',
  );

  const db = openLocalDatabase(config.SQLITE_PATH);
  const bootCount = Number(getLocalConfig(db, 'boot_count') ?? '0') + 1;
  setLocalConfig(db, 'boot_count', String(bootCount));
  setLocalConfig(db, 'last_boot_at', new Date().toISOString());
  setLocalConfig(db, 'device_id', config.DEVICE_ID);
  logger.info({ event: 'SQLITE_READY', schemaVersion: getSchemaVersion(db), bootCount }, 'Local SQLite database ready');

  const store = new KioskStore(db);
  ensureStandaloneBootstrap(db, store);

  const serialScanner =
    config.QR_SCANNER === 'serial'
      ? new SerialQRScanner(config.SCANNER_PORT, (level, message, data) => logger[level]({ event: 'QR_SCANNER', ...data }, message))
      : null;

  let consoleOffsetMs = 0;
  let browserClockOffsetMs = Number(getLocalConfig(db, 'clock_offset_ms') ?? '0') || 0;
  const isOfficerClockTrusted = () => getLocalConfig(db, 'clock_trusted_boot_count') === String(bootCount);
  const now = () => new Date(Date.now() + browserClockOffsetMs + consoleOffsetMs);

  const mock = createMockHardware(printLcd);
  let bridge: BridgeClient | null = null;
  let hardware: Hardware;

  if (config.HARDWARE_MODE === 'real') {
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
      clock: new SystemClock(() => !config.REQUIRE_NTP_SYNC || isOfficerClockTrusted()),
    };
  } else {
    for (const locker of store.listLockerHardware()) {
      if (locker.expectedUid) mock.rfid.place(locker.channel, locker.expectedUid);
    }
    hardware = { ...mock, scanner: serialScanner ?? mock.scanner };
  }

  const rentals = new RentalService(store, { deviceCode: config.DEVICE_ID, now });
  const payments = new PaymentService(store, rentals, { now });
  const returns = new ReturnService(store, payments, { now });
  const kiosk = new KioskController(store, hardware, { rentals, payments, returns }, {
    now,
    sleepAfterMs: config.POWER_SAVE ? config.SLEEP_AFTER_SECONDS * 1000 : 0,
    // Students send their ID from their phone to the web app on this Pi (same SQLite file).
    phoneScan:
      config.QR_SCANNER === 'phone'
        ? { start: (at) => startScanSession(db, at), take: (id, at) => takeScan(db, id, at) }
        : undefined,
    closedSleepAfterMs: config.CLOSED_SLEEP_AFTER_SECONDS * 1000,
    log: (level, message, data) => logger[level]({ event: 'KIOSK', ...data }, message),
  });
  await kiosk.start();
  serialScanner?.start();
  const ticker = setInterval(() => void kiosk.tick(), TICK_MS);
  const console_ =
    config.HARDWARE_MODE === 'mock'
      ? startMockConsole({ hw: mock, kiosk, store, addMinutes: (m) => (consoleOffsetMs += m * 60_000) })
      : null;

  // Optional outbound cloud sync for online read-only monitoring.
  const cloudUrl = config.CLOUD_BACKEND_URL || config.BACKEND_URL;
  const backend = config.CLOUD_SYNC_ENABLED
    ? new BackendClient({
        baseUrl: cloudUrl,
        timeoutMs: config.HTTP_TIMEOUT_MS,
        deviceId: config.DEVICE_ID,
        deviceSecret: config.DEVICE_SECRET,
      })
    : null;

  const sync = backend
    ? new SyncService(store, backend, {
        now,
        pullEnabled: config.SYNC_PULL_ENABLED,
        log: (level, message, data) => logger[level]({ event: 'SYNC', ...data }, message),
      })
    : null;

  if (sync) {
    sync.onCommand(async (cmd) => {
      const lockerId = typeof cmd.payload.lockerId === 'string' ? cmd.payload.lockerId : '';
      const requestedBy = typeof cmd.payload.requestedBy === 'string' ? cmd.payload.requestedBy : undefined;
      const result = await kiosk.handleOfficerUnlock(lockerId, { commandId: cmd.id, requestedBy });
      return { status: result.ok ? 'DONE' : 'FAILED', message: result.message };
    });
    sync.start();
  }

  // Poll local SQLite commands + officer browser clock offset every 1 s.
  let runningLocalCommands = false;
  const pollLocalCommands = async () => {
    if (runningLocalCommands) return;
    runningLocalCommands = true;
    try {
      browserClockOffsetMs = Number(getLocalConfig(db, 'clock_offset_ms') ?? '0') || 0;
      const cmds = store.claimLocalCommands(now().toISOString());
      for (const cmd of cmds) {
        if (cmd.command === 'UNLOCK_LOCKER') {
          const lockerId = typeof cmd.payload.lockerId === 'string' ? cmd.payload.lockerId : '';
          const requestedBy = typeof cmd.payload.requestedBy === 'string' ? cmd.payload.requestedBy : undefined;
          const res = await kiosk.handleOfficerUnlock(lockerId, { commandId: cmd.id, requestedBy });
          store.completeLocalCommand(cmd.id, res.ok ? 'DONE' : 'FAILED', res.message, now().toISOString());
        } else if (cmd.command === 'REFRESH') {
          if (sync) {
            const pushed = await sync.push();
            store.completeLocalCommand(
              cmd.id,
              pushed.ok ? 'DONE' : 'FAILED',
              pushed.ok ? `Uploaded ${pushed.sent} pending item(s) to cloud.` : 'Cloud sync unreachable; queued in SQLite.',
              now().toISOString(),
            );
          } else {
            store.completeLocalCommand(
              cmd.id,
              'DONE',
              'Local SQLite is live (set CLOUD_SYNC_ENABLED=true in .env for online cloud sync).',
              now().toISOString(),
            );
          }
        }
      }
    } finally {
      runningLocalCommands = false;
    }
  };
  const localCmdTimer = setInterval(() => void pollLocalCommands(), LOCAL_COMMAND_POLL_MS);

  // Write live kiosk heartbeat straight to local SQLite every 10 s so the local Pi dashboard sees it offline.
  let lastHeatWarning = 0;
  const writeLocalHeartbeat = async () => {
    const cpuTempC = readCpuTemperature();
    if (cpuTempC !== null && cpuTempC >= 75 && Date.now() - lastHeatWarning > 30 * 60_000) {
      lastHeatWarning = Date.now();
      const critical = cpuTempC >= 80;
      store.recordEvent({
        type: EventType.SYSTEM_ERROR,
        severity: critical ? EventSeverity.CRITICAL : EventSeverity.WARNING,
        message: `Raspberry Pi CPU is ${cpuTempC.toFixed(1)} °C${critical ? ' (throttling): check ventilation now' : ': check ventilation'}`,
        payload: { cpuTempC },
        occurredAt: now().toISOString(),
      });
      logger.warn({ event: 'SYSTEM_ERROR', cpuTempC }, 'Raspberry Pi is running hot');
    }

    const clockSynced = await hardware.clock.isSynced();
    setLocalConfig(
      db,
      'kiosk_heartbeat',
      JSON.stringify({
        lastHeartbeatAt: new Date().toISOString(),
        softwareVersion: APP_VERSION,
        kioskState: kiosk.state,
        cpuTempC,
        clockDriftSeconds: 0,
        localDbOk: db.pragma('quick_check', { simple: true }) === 'ok',
        clockSynced,
        sync: sync
          ? sync.status()
          : {
              lastPushAt: null,
              lastPullAt: null,
              lastError: null,
              failedItems: store.failedSyncCount(),
            },
      }),
    );
  };
  await writeLocalHeartbeat();
  const localBeatTimer = setInterval(() => void writeLocalHeartbeat(), LOCAL_HEARTBEAT_MS);

  // Optional remote cloud heartbeat (every 30 s when CLOUD_SYNC_ENABLED=true).
  let backendOnline: boolean | null = null;
  const cloudHeartbeat = async () => {
    if (!backend || !sync) return;
    const cpuTempC = readCpuTemperature();
    const result = await backend.heartbeat({
      softwareVersion: APP_VERSION,
      kioskState: kiosk.state,
      syncQueueCount: store.pendingSyncCount(),
      localDbOk: db.pragma('quick_check', { simple: true }) === 'ok',
      cpuTempC,
      sentAt: now().toISOString(),
      lockers: store.lockerSensorReports(),
      sync: sync.status(),
    });
    if (result.ok !== backendOnline) {
      if (result.ok) logger.info({ event: 'DEVICE_ONLINE', latencyMs: result.latencyMs }, 'Cloud monitor reachable, heartbeat accepted');
      else logger.warn({ event: 'DEVICE_OFFLINE', code: result.code }, `${result.message} (local kiosk & local dashboard unaffected)`);
      backendOnline = result.ok;
    }
    if (result.ok && Math.abs(result.data.clockDriftSeconds) > MAX_CLOCK_DRIFT_SECONDS) {
      logger.warn({ event: 'SYSTEM_ERROR', clockDriftSeconds: result.data.clockDriftSeconds }, 'Kiosk clock differs from cloud server');
    }
  };
  if (backend) void cloudHeartbeat();
  const cloudBeatTimer = backend ? setInterval(() => void cloudHeartbeat(), HEARTBEAT_INTERVAL_SECONDS * 1000) : null;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'SERVICE_STOPPING', signal }, 'Shutting down');
    clearInterval(ticker);
    clearInterval(localCmdTimer);
    clearInterval(localBeatTimer);
    if (cloudBeatTimer) clearInterval(cloudBeatTimer);
    sync?.stop();
    console_?.close();
    bridge?.stop();
    serialScanner?.stop();
    db.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    { event: 'SERVICE_READY', qrScanner: config.QR_SCANNER === 'serial' ? config.SCANNER_PORT : config.QR_SCANNER },
    config.HARDWARE_MODE === 'mock'
      ? 'Kiosk running on SIMULATED hardware (local SQLite). Type "help" for controls, Ctrl+C to stop.'
      : 'Kiosk running on REAL hardware (local SQLite).',
  );
}

main().catch((error: unknown) => {
  logger.fatal({ event: 'SYSTEM_ERROR', err: error }, 'Kiosk service crashed during startup');
  process.exitCode = 1;
});
