import { MockBinding } from '@serialport/binding-mock';
import { SerialPortStream } from '@serialport/stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SerialQRScanner } from './serial-qr-scanner';

const PATH = '/dev/ttyUSB-TEST';
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const RETRY_MS = 150;

let scanner: SerialQRScanner | null = null;
afterEach(() => {
  scanner?.stop();
  MockBinding.reset();
});

function connect() {
  MockBinding.createPort(PATH, { echo: false, record: true });
  let current: SerialPortStream | null = null;
  const scans: string[] = [];
  const setCalls: unknown[] = [];
  scanner = new SerialQRScanner(
    PATH,
    () => {},
    (options) => {
      current = new SerialPortStream({ binding: MockBinding, autoOpen: false, ...options });
      const original = current.set.bind(current);
      vi.spyOn(current, 'set').mockImplementation((opts, cb) => {
        setCalls.push(opts);
        return original(opts, cb);
      });
      return current;
    },
    RETRY_MS,
  );
  scanner.onScan((raw) => scans.push(raw));
  scanner.start();
  /** Simulates the ESP32 printing bytes on the serial line. */
  const esp32 = (text: string) => (current!.port as unknown as { emitData(d: Buffer): void }).emitData(Buffer.from(text));
  return { scans, esp32, setCalls, port: () => current! };
}

describe('SerialQRScanner (mock serial port)', () => {
  it('opens the port and turns ESP32 lines into scans, even split across reads', async () => {
    const { scans, esp32 } = connect();
    await wait();
    expect(scanner!.status.connected).toBe(true);

    esp32('ets Jun  8 2016 boot noise\r\n{"type":"hello","fw":"1.0.0"}\n');
    esp32('{"type":"qr","seq":1,"data":"JUAN DELA CRUZ\\t20221');
    esp32('00001\\tBSCpE"}\r\n');
    await wait();

    expect(scans).toEqual(['JUAN DELA CRUZ\t2022100001\tBSCpE']);
    expect(scanner!.status.firmwareVersion).toBe('1.0.0');
  });

  it('releases DTR/RTS after opening (ESP32-CAM-MB auto-reset lines)', async () => {
    const { setCalls, port } = connect();
    await wait();
    expect(port().isOpen).toBe(true);
    expect(setCalls).toEqual([{ dtr: false, rts: false }]);
  });

  it('power saving: sends sleep/wake to the ESP32, and sleep again if it reboots while the kiosk sleeps', async () => {
    const { esp32, port } = connect();
    await wait();
    const written = () => (port().port as unknown as { recording: Buffer }).recording.toString();

    await scanner!.setActive(false);
    await wait();
    expect(written()).toBe('{"cmd":"sleep"}\n');

    esp32('{"type":"state","state":"sleeping"}\n');
    await wait();
    expect(scanner!.status.cameraState).toBe('sleeping');

    esp32('{"type":"hello","fw":"1.1.0","state":"awake"}\n'); // ESP32 rebooted (starts awake)
    await wait();
    expect(written()).toBe('{"cmd":"sleep"}\n{"cmd":"sleep"}\n');

    await scanner!.setActive(true);
    await wait();
    expect(written().endsWith('{"cmd":"wake"}\n')).toBe(true);
  });

  it('reconnects after the cable is unplugged', async () => {
    const { scans, esp32, port } = connect();
    await wait();
    port().close();
    await wait(30);
    expect(scanner!.status.connected).toBe(false);
    await wait(RETRY_MS + 100);
    expect(scanner!.status.connected).toBe(true);
    esp32('{"type":"qr","seq":2,"data":"MARIA SANTOS\\t2023100002\\tBSCE"}\n');
    await wait();
    expect(scans).toEqual(['MARIA SANTOS\t2023100002\tBSCE']);
  });
});
