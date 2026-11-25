import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DoorState } from '@calc-rental/shared';
import { DEV_RFID, seedDevData } from '../../db/dev-seed';
import { KioskStore } from '../../db/kiosk-store';
import { openLocalDatabase } from '../../db/sqlite';
import { KioskController } from '../../kiosk/kiosk-controller';
import { KioskState } from '../../kiosk/kiosk-states';
import { PaymentService } from '../../payment/payment-service';
import type { CoinInput } from '../../payment/payment-service';
import { RentalService } from '../../rental/rental-service';
import { ReturnService } from '../../rental/return-service';
import { createMockHardware } from '../mock';
import { BridgeClient } from './bridge-client';
import { BridgeButtons, BridgeBuzzer, BridgeCoinAcceptor, BridgeDisplay, BridgeLockerController, BridgeRFIDReader } from './bridge-hardware';

/**
 * Runs the REAL Python bridge (hw-bridge/hw_bridge.py --mock) and talks to it
 * through the real Node adapters — everything but the physical pins.
 */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const pythonAvailable = (() => {
  try {
    execFileSync(PYTHON, ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TUESDAY_10AM = new Date('2026-10-20T02:00:00.000Z'); // Manila time

let bridge: BridgeClient | null = null;
afterEach(() => bridge?.stop());

async function startBridge() {
  bridge = new BridgeClient({ pythonBin: PYTHON, args: ['--mock', '--coin-gap-ms', '120'], restartDelayMs: 100 });
  bridge.start();
  const ready = await bridge.ready;
  return { bridge, ready };
}

describe.skipIf(!pythonAvailable)('Python hardware bridge (mock mode)', () => {
  it('starts and reports its devices', async () => {
    const { ready } = await startBridge();
    expect(ready).toMatchObject({ type: 'ready', mode: 'mock', version: '1.2.0' });
  });

  it('holds a relay, locks it early, and refuses unsafe hold times', async () => {
    const { bridge } = await startBridge();
    const lockers = new BridgeLockerController(bridge);
    await expect(lockers.unlock(1, 60_000)).resolves.toBeUndefined();
    await expect(lockers.lock(1)).resolves.toBeUndefined();
    await expect(lockers.unlock(1, 600_000)).rejects.toThrow(/100..300000/);
    expect(await lockers.doorState(1)).toBe(DoorState.UNKNOWN); // no reed switches fitted
  });

  it('reads RFID tags per locker channel', async () => {
    const { bridge } = await startBridge();
    const rfid = new BridgeRFIDReader(bridge);
    expect(await rfid.read(1)).toEqual({ uid: null, readerOk: true });
    await bridge.request('mock_tag', { channel: 1, uid: DEV_RFID.calc1 });
    expect(await rfid.read(1)).toEqual({ uid: DEV_RFID.calc1, readerOk: true });
    expect(await rfid.read(2)).toEqual({ uid: null, readerOk: true });
  });

  it('groups coin pulses into coins (5 pulses = P5, then 1 pulse = P1)', async () => {
    const { bridge } = await startBridge();
    const coins: CoinInput[] = [];
    new BridgeCoinAcceptor(bridge).onCoin((coin) => coins.push(coin));
    await bridge.request('mock_coin', { pulses: 5, spacingMs: 30 });
    await wait(400);
    await bridge.request('mock_coin', { pulses: 1 });
    await wait(300);
    expect(coins.map((c) => c.pulseCount)).toEqual([5, 1]);
    expect(new Set(coins.map((c) => c.eventId)).size).toBe(2); // each coin gets its own id
  });

  it('reports front-panel button presses', async () => {
    const { bridge } = await startBridge();
    const presses: string[] = [];
    new BridgeButtons(bridge).onPress((kind, channel) => presses.push(`${kind}${channel}`));
    await bridge.request('mock_button', { kind: 'select', channel: 2 });
    await bridge.request('mock_button', { kind: 'close', channel: 1 });
    await wait(50);
    expect(presses).toEqual(['select2', 'close1']);
  });

  it('updates the LCD and beeps', async () => {
    const { bridge } = await startBridge();
    await expect(new BridgeDisplay(bridge).show(['SYSTEM READY    ', 'SCAN STUDENT ID '])).resolves.toBeUndefined();
    await expect(new BridgeBuzzer(bridge).beep('ok')).resolves.toBeUndefined();
  });

  it('restarts after the bridge process dies, and never hangs the kiosk', async () => {
    const { bridge } = await startBridge();
    (bridge as unknown as { child: { kill(): void } }).child.kill();
    await wait(50);
    expect(await new BridgeRFIDReader(bridge).read(1)).toEqual({ uid: null, readerOk: false }); // reported, not thrown
    await wait(800);
    await expect(bridge.request('ping')).resolves.toMatchObject({ type: 'pong' });
  });

  it('drives a full kiosk borrow through the bridge (coins and RFID via Python)', async () => {
    const { bridge } = await startBridge();
    const store = new KioskStore(openLocalDatabase(':memory:'));
    seedDevData(store, { sensorsReady: false, nowIso: new Date().toISOString() });
    await bridge.request('mock_tag', { channel: 1, uid: DEV_RFID.calc1 });
    await bridge.request('mock_tag', { channel: 2, uid: DEV_RFID.calc2 });

    const mock = createMockHardware();
    const now = () => TUESDAY_10AM;
    const rentals = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001', now });
    const payments = new PaymentService(store, rentals, { now });
    const returns = new ReturnService(store, payments, { now });
    const kiosk = new KioskController(
      store,
      {
        scanner: mock.scanner,
        clock: mock.clock,
        coins: new BridgeCoinAcceptor(bridge),
        rfid: new BridgeRFIDReader(bridge),
        lockers: new BridgeLockerController(bridge),
        buttons: new BridgeButtons(bridge),
        display: new BridgeDisplay(bridge),
        buzzer: new BridgeBuzzer(bridge),
      },
      { rentals, payments, returns },
      { messageMs: 200, now }, // inside operating hours whatever time the test runs
    );
    await kiosk.start();
    await kiosk.handleScan('JUAN DELA CRUZ\t2022100001\tBSCpE');
    expect(kiosk.state).toBe(KioskState.SELECTING_LOCKER);
    await bridge.request('mock_button', { kind: 'select', channel: 1 }); // blue button, locker 1
    await wait(100);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_PAYMENT);

    // Real start() wiring: coin events from the bridge reach the kiosk on their own.
    await bridge.request('mock_coin', { pulses: 20, spacingMs: 5 });
    await wait(500);
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_REMOVAL);

    await bridge.request('mock_tag', { channel: 1, uid: null }); // student takes CALC-001
    await kiosk.tick();
    expect(kiosk.state).toBe(KioskState.WAITING_FOR_DOOR_CLOSE);
    await bridge.request('mock_button', { kind: 'close', channel: 1 }); // red button
    await wait(100);
    expect(kiosk.state).toBe(KioskState.RENTAL_ACTIVE);
    expect(store.db.prepare(`SELECT status FROM rentals`).get()).toEqual({ status: 'ACTIVE' });
  });
});
