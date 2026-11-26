/**
 * Kiosk simulator (Phase 14): the REAL kiosk program (state machine, rental,
 * payment and return services, SQLite) on simulated hardware, operated from
 * a web page. For demos and testing without the physical kiosk.
 *
 *   npm run sim:pi                 → http://localhost:4040  (offline, own database)
 *   npm run sim:pi -- --fresh      start again from the development seed
 *   npm run sim:pi -- --sync       also sync with the backend in .env (BACKEND_URL)
 *
 * Only listens on this computer (127.0.0.1). Uses data/simulator.db, never
 * the kiosk's real database.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoorState, nextOpening, operatingCalendar } from '@calc-rental/shared';
import { DEV_RFID, DEV_STUDENT_QR, seedDevData } from '../src/db/dev-seed';
import { KioskStore } from '../src/db/kiosk-store';
import { openLocalDatabase } from '../src/db/sqlite';
import { createMockHardware } from '../src/hardware/mock';
import { KioskController } from '../src/kiosk/kiosk-controller';
import { PaymentService } from '../src/payment/payment-service';
import { RentalService } from '../src/rental/rental-service';
import { ReturnService } from '../src/rental/return-service';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIM_PORT ?? 4040);
const DB_FILE = path.resolve(here, '../data/simulator.db');
const withSync = process.argv.includes('--sync');

if (process.argv.includes('--fresh')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
}
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ------------------------------------------------------------ the kiosk
let offsetMs = 0; // "advance clock" moves the kiosk's time forward to try late returns
const now = () => new Date(Date.now() + offsetMs);

const store = new KioskStore(openLocalDatabase(DB_FILE));
if (!store.getSettings()) seedDevData(store, { sensorsReady: false, nowIso: now().toISOString() });

// Started outside operating hours (e.g. a demo at night)? Start the kiosk clock at the next opening.
const opensAt = nextOpening(new Date(), operatingCalendar(store.getSettings()!));
const jumpedToOpening = !!opensAt && opensAt.getTime() > Date.now();
if (jumpedToOpening) offsetMs = opensAt.getTime() - Date.now();

const hw = createMockHardware();
hw.clock.synced = true;
// Calculators that are not out with a student start inside their lockers.
const inside = store.db
  .prepare(`SELECT l.hardware_channel AS channel, c.rfid_uid AS uid FROM lockers l JOIN calculators c ON c.locker_id = l.id WHERE c.status <> 'RENTED'`)
  .all() as { channel: number; uid: string }[];
for (const { channel, uid } of inside) hw.rfid.place(channel, uid);

const log: { at: string; level: string; message: string }[] = [];
const addLog = (level: string, message: string, data?: Record<string, unknown>) => {
  const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  log.unshift({ at: now().toISOString(), level, message: message + extra });
  log.length = Math.min(log.length, 40);
};

const rentals = new RentalService(store, { deviceCode: 'DEVICE-SIMULATOR', now });
const payments = new PaymentService(store, rentals, { now });
const returns = new ReturnService(store, payments, { now });
// Power saving like the real kiosk (sleeps after 2 min idle; SIM_SLEEP_SECONDS=0 to turn it off).
const sleepSeconds = Number(process.env.SIM_SLEEP_SECONDS ?? 120);
const kiosk = new KioskController(
  store,
  hw,
  { rentals, payments, returns },
  { now, log: addLog, sleepAfterMs: sleepSeconds * 1000, closedSleepAfterMs: 30_000 },
);
if (jumpedToOpening) addLog('info', 'Started outside operating hours: kiosk clock set to the next opening time');
await kiosk.start();
setInterval(() => void kiosk.tick(), 250);

if (withSync) {
  const { config } = await import('../src/config');
  const { BackendClient } = await import('../src/backend/client');
  const { SyncService } = await import('../src/sync/sync-service');
  const backend = new BackendClient({
    baseUrl: config.BACKEND_URL,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    deviceId: config.DEVICE_ID,
    deviceSecret: config.DEVICE_SECRET,
  });
  const sync = new SyncService(store, backend, { now, log: addLog });
  sync.onCommand(async (cmd) => {
    const r = await kiosk.handleOfficerUnlock(String(cmd.payload.lockerId ?? ''), { commandId: cmd.id });
    return { status: r.ok ? 'DONE' : 'FAILED', message: r.message };
  });
  sync.start();
  addLog('info', `Syncing with ${config.BACKEND_URL}`);
}

// ------------------------------------------------------------ snapshot for the page
const channelOf = (lockerNumber: number) => store.listLockerHardware().find((l) => l.number === lockerNumber)?.channel;

async function snapshot() {
  const lockers = await Promise.all(
    store.listLockerHardware().map(async (l) => ({
      number: l.number,
      unlocked: hw.lockers.open.has(l.channel),
      tag: (await hw.rfid.read(l.channel)).uid,
      expected: l.expectedUid,
      door: await hw.lockers.doorState(l.channel),
    })),
  );
  return {
    lcd: hw.display.current,
    state: kiosk.state,
    time: now().toISOString(),
    offsetMinutes: Math.round(offsetMs / 60_000),
    coinsEnabled: hw.coins.enabled,
    power: { backlight: hw.display.backlight, camera: hw.scanner.active, rfid: hw.rfid.powered },
    beeps: hw.buzzer.beeps.length,
    lastBeep: hw.buzzer.beeps.at(-1) ?? null,
    lockers,
    outbox: store.pendingSyncCount(),
    sync: withSync,
    log,
  };
}

// ------------------------------------------------------------ actions from the page
type Action =
  | { type: 'scan'; qr: string }
  | { type: 'button'; kind: 'select' | 'close'; locker: number }
  | { type: 'coin'; pesos: number }
  | { type: 'take'; locker: number }
  | { type: 'put'; locker: number; tag: 'calc1' | 'calc2' | 'unknown' }
  | { type: 'door'; locker: number; open: boolean }
  | { type: 'advance'; minutes: number };

async function act(a: Action): Promise<string | null> {
  switch (a.type) {
    case 'scan':
      await kiosk.handleScan(a.qr);
      return null;
    case 'button': {
      const ch = channelOf(a.locker);
      if (!ch) return 'No such locker';
      await kiosk.handleButton(a.kind, ch);
      return null;
    }
    case 'coin':
      if (![1, 5, 10, 20].includes(a.pesos)) return 'Unknown coin';
      hw.coins.insert(a.pesos);
      return null;
    case 'take':
    case 'put': {
      const ch = channelOf(a.locker);
      if (!ch) return 'No such locker';
      if (!hw.lockers.open.has(ch)) return `Locker ${a.locker} is locked`;
      const uid = a.type === 'take' ? null : a.tag === 'unknown' ? '0A-0B-0C-0D' : DEV_RFID[a.tag];
      hw.rfid.place(ch, uid);
      return null;
    }
    case 'door': {
      const ch = channelOf(a.locker);
      if (!ch) return 'No such locker';
      hw.lockers.setDoor(ch, a.open ? DoorState.OPEN : DoorState.CLOSED);
      return null;
    }
    case 'advance':
      offsetMs += Math.max(0, Math.min(7 * 24 * 60, a.minutes)) * 60_000;
      addLog('info', `Clock moved forward ${a.minutes} min`);
      return null;
  }
}

// ------------------------------------------------------------ web server
const page = fs.readFileSync(path.join(here, 'simulator.html'), 'utf8');
const clients = new Set<http.ServerResponse>();
let lastSent = '';

setInterval(async () => {
  const body = JSON.stringify(await snapshot());
  if (body === lastSent) return;
  lastSent = body;
  for (const res of clients) res.write(`data: ${body}\n\n`);
}, 200);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.method === 'GET' && req.url === '/students') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(DEV_STUDENT_QR));
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && req.url === '/action') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let error: string | null;
    try {
      error = await act(JSON.parse(raw) as Action);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    res.writeHead(error ? 400 : 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !error, error }));
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nKiosk simulator running: http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}${withSync ? ' (syncing with the backend)' : ' (offline)'}`);
  console.log('Ctrl+C to stop. Start again from scratch with: npm run sim:pi -- --fresh\n');
});

process.on('SIGINT', () => {
  server.close();
  store.db.close();
  process.exit(0);
});
