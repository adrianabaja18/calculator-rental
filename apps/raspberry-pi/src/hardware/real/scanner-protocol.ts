import { MAX_QR_LENGTH } from '@calc-rental/shared';
import { z } from 'zod';

/**
 * ESP32-CAM → Raspberry Pi protocol (USB serial, 115200 baud, 8N1).
 * One JSON object per line ("\n"):
 *
 *   {"type":"hello","fw":"1.0.0"}                  after the ESP32 boots
 *   {"type":"alive","seq":12}                      every 5 s (scanner health)
 *   {"type":"qr","seq":13,"data":"<raw QR text>"}  a decoded QR code
 *
 * The ESP32 forwards the RAW text only; the Pi and backend parse and
 * validate it (never trust the scanner — Rule 14). Anything else on the line
 * (ESP32 boot ROM messages, noise) is ignored.
 */
export const SCANNER_BAUD_RATE = 115200;
const MAX_LINE_LENGTH = 1024;

const ScannerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('qr'), seq: z.number().int().nonnegative(), data: z.string().min(1).max(MAX_QR_LENGTH) }),
  z.object({ type: z.literal('hello'), fw: z.string().max(32) }),
  z.object({ type: z.literal('alive'), seq: z.number().int().nonnegative() }),
]);
export type ScannerMessage = z.infer<typeof ScannerMessageSchema>;

export type FeedResult = 'scan' | 'duplicate' | 'status' | 'ignored';

/**
 * Turns serial lines into scans. The camera sees the same ID on many
 * frames, so an identical payload within `duplicateWindowMs` is dropped.
 */
export class ScannerDecoder {
  /** When the scanner last said anything valid (for health reporting). */
  lastHeardAt: number | null = null;
  firmwareVersion: string | null = null;
  private lastScan: { data: string; at: number } | null = null;

  constructor(
    private readonly onScan: (raw: string) => void,
    private readonly options: { now?: () => number; duplicateWindowMs?: number } = {},
  ) {}

  feed(line: string): FeedResult {
    const text = line.trim();
    if (!text.startsWith('{') || text.length > MAX_LINE_LENGTH) return 'ignored';

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return 'ignored';
    }
    const parsed = ScannerMessageSchema.safeParse(json);
    if (!parsed.success) return 'ignored';

    const now = this.options.now?.() ?? Date.now();
    this.lastHeardAt = now;
    const message = parsed.data;
    if (message.type === 'hello') this.firmwareVersion = message.fw;
    if (message.type !== 'qr') return 'status';

    const window = this.options.duplicateWindowMs ?? 3000;
    if (this.lastScan && this.lastScan.data === message.data && now - this.lastScan.at < window) {
      this.lastScan.at = now; // still in front of the camera: keep suppressing
      return 'duplicate';
    }
    this.lastScan = { data: message.data, at: now };
    this.onScan(message.data);
    return 'scan';
  }
}
