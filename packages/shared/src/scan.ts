import { z } from 'zod';
import { MAX_QR_LENGTH } from './qr';

/**
 * Phone ID scanning (replaces the ESP32-CAM). The kiosk shows a 6-digit code
 * (scan sessions live in the Pi's SQLite, see sqlite-node.ts); the student's
 * phone sends POST /api/scan { code, qr } to the web app on the Pi.
 */
export const PhoneScanRequestSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/, 'The code is 6 digits'),
  qr: z.string().min(1).max(MAX_QR_LENGTH),
});
export type PhoneScanRequest = z.infer<typeof PhoneScanRequestSchema>;

export type PhoneScanReply = { fullName: string };
