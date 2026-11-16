import { z } from 'zod';
import { CourseProgramSchema, StudentFullNameSchema, StudentNumberSchema } from './validation';

/**
 * School-ID QR code parser.
 *
 * Confirmed format of the school ID QR content (one line, TAB-separated):
 *
 *   FULL NAME <TAB> STUDENT NUMBER <TAB> COURSE
 *   e.g. "JUAN DELA CRUZ\t2022100001\tBSCpE"
 *
 * - The ESP32-CAM forwards the RAW text; it never interprets it.
 * - The Pi parses it for the LCD, and the backend parses it AGAIN
 *   (never trust what the device says it decoded — Rule 14).
 * - The QR has no year level, so year_level stays null.
 */

/** Hard limit — school ID QR text is short; anything longer is suspicious. */
export const MAX_QR_LENGTH = 200;

export const StudentQrDataSchema = z.object({
  fullName: StudentFullNameSchema,
  studentNumber: StudentNumberSchema,
  courseProgram: CourseProgramSchema,
});
export type StudentQrData = z.infer<typeof StudentQrDataSchema>;

export type StudentQrParseResult =
  | { ok: true; data: StudentQrData }
  | { ok: false; reason: string };

/**
 * Fallback for scanners that turn TABs into spaces: the 10-digit student
 * number is the anchor — everything before it is the name, the single token
 * after it is the course.
 */
const SPACE_SEPARATED_PATTERN = /^(.+?)\s+(\d{10})\s+(\S+)$/;

export function parseStudentQr(raw: string): StudentQrParseResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'QR payload is empty' };
  }
  if (raw.length > MAX_QR_LENGTH) {
    return { ok: false, reason: `QR payload is longer than ${MAX_QR_LENGTH} characters` };
  }
  // Allow TAB, reject every other control character (CR/LF trimmed below).
  const text = raw.replace(/[\r\n]+$/g, '').trim();
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(text)) {
    return { ok: false, reason: 'QR payload contains control characters' };
  }

  let parts: string[];
  if (text.includes('\t')) {
    parts = text.split('\t').map((p) => p.trim()).filter((p) => p.length > 0);
  } else {
    const match = SPACE_SEPARATED_PATTERN.exec(text);
    parts = match ? [match[1]!, match[2]!, match[3]!] : [];
  }

  if (parts.length !== 3) {
    return { ok: false, reason: 'Expected 3 fields: full name, student number, course' };
  }

  const parsed = StudentQrDataSchema.safeParse({
    fullName: parts[0],
    studentNumber: parts[1],
    courseProgram: parts[2],
  });
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, data: parsed.data };
}
