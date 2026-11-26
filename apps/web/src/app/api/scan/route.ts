import { ErrorCode, PhoneScanRequestSchema, parseStudentQr, type PhoneScanReply } from '@calc-rental/shared';
import { scanClientHash, submitScan } from '@calc-rental/shared/sqlite';
import { jsonError, jsonOk } from '@/lib/http';
import { getLocalDb } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';

/**
 * Phone ID scanning, student side (PUBLIC — no login).
 * POST { code, qr }: attach the decoded school-ID text to the kiosk code the
 * student read on the LCD. Runs on the Pi (local SQLite): phones reach it over
 * the school LAN or the Pi's hotspot, no internet needed. The phone decodes the
 * photo; only the text arrives here. Wrong codes are limited per phone.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function POST(request: Request) {
  if (!isLocalBackend()) {
    return jsonError(ErrorCode.NOT_FOUND, 'Scan on the kiosk Wi-Fi page (the QR sticker on the kiosk), not the online dashboard.', 404, NO_STORE);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(ErrorCode.VALIDATION_ERROR, 'Body must be JSON.', 400, NO_STORE);
  }
  const parsed = PhoneScanRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError(ErrorCode.VALIDATION_ERROR, 'Type the 6-digit code from the kiosk screen.', 400, NO_STORE);

  // Never trust the phone's decoding: parse the text again here.
  const student = parseStudentQr(parsed.data.qr);
  if (!student.ok) return jsonError(ErrorCode.INVALID_QR, 'That QR code is not a school ID.', 400, NO_STORE);

  // The LAST forwarded address is the one our own server saw (earlier ones can be faked by the phone).
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((a) => a.trim()).filter(Boolean);
  const address = forwarded?.at(-1) || request.headers.get('x-real-ip') || 'unknown';

  const db = getLocalDb();
  const result = submitScan(db, { code: parsed.data.code, qr: parsed.data.qr, clientHash: scanClientHash(db, address) }, new Date());
  if (result === 'TOO_MANY_TRIES') return jsonError(ErrorCode.TOO_MANY_TRIES, 'Too many wrong codes. Wait a few minutes.', 429, NO_STORE);
  if (result === 'BAD_CODE') return jsonError(ErrorCode.SCAN_CODE_INVALID, 'That code is wrong or has expired. Check the kiosk screen.', 404, NO_STORE);

  const reply: PhoneScanReply = { fullName: student.data.fullName };
  return jsonOk(reply, NO_STORE);
}
