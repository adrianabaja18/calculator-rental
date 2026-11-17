import type { SerialPortStream } from '@serialport/stream';
import { ReadlineParser, SerialPort } from 'serialport';
import type { QRScanner } from '../types';
import { SCANNER_BAUD_RATE, ScannerDecoder } from './scanner-protocol';

/**
 * Real QR scanner: the ESP32-CAM on its USB-C programmer board (CH340),
 * plugged into the Pi → /dev/ttyUSB0 (Windows: COMx).
 *
 * - Lines are decoded and de-duplicated by ScannerDecoder.
 * - DTR/RTS are released after opening: on the ESP32-CAM-MB board they
 *   drive EN/IO0 (auto-reset), and leaving them asserted can hold the
 *   ESP32 in reset or bootloader mode.
 * - If the cable is unplugged or the port fails, it retries every 3 s.
 */
export class SerialQRScanner implements QRScanner {
  private handler: ((raw: string) => void) | null = null;
  private readonly decoder = new ScannerDecoder((raw) => this.handler?.(raw));
  private port: SerialPortStream | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private warnedUnavailable = false;
  connected = false;

  constructor(
    private readonly path: string,
    private readonly log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void = () => {},
    /** Tests pass a mock-binding port here. */
    private readonly createPort: (options: { path: string; baudRate: number }) => SerialPortStream = (options) =>
      new SerialPort({ ...options, autoOpen: false, hupcl: false }),
    private readonly retryMs = 3000,
  ) {}

  onScan(handler: (raw: string) => void) {
    this.handler = handler;
  }

  /** Scanner health for the heartbeat / device status. */
  get status() {
    return {
      connected: this.connected,
      lastHeardAt: this.decoder.lastHeardAt,
      firmwareVersion: this.decoder.firmwareVersion,
    };
  }

  start() {
    this.stopped = false;
    const port = this.createPort({ path: this.path, baudRate: SCANNER_BAUD_RATE });
    this.port = port;

    port.on('open', () => {
      this.connected = true;
      this.warnedUnavailable = false;
      port.set({ dtr: false, rts: false }, () => {});
      this.log('info', 'QR scanner connected', { port: this.path });
    });
    port.on('close', () => this.reconnect('closed'));
    port.on('error', (error) => this.log('warn', 'QR scanner serial error', { port: this.path, error: error.message }));
    port.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (line: string) => this.decoder.feed(line));

    port.open((error) => {
      if (error) this.reconnect(error.message);
    });
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.port?.isOpen) this.port.close();
  }

  private reconnect(reason: string) {
    if (this.stopped) return;
    // Warn when a working connection drops, and once when the port can't be opened at all.
    if (this.connected || !this.warnedUnavailable) {
      this.log('warn', `QR scanner unavailable on ${this.path}; retrying every ${this.retryMs / 1000} s`, { reason });
      this.warnedUnavailable = true;
    }
    this.connected = false;
    this.port?.removeAllListeners();
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.start(), this.retryMs);
  }
}
