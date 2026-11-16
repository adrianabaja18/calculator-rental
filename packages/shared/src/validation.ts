import { z } from 'zod';
import { PenaltyType } from './enums';

/**
 * Reusable Zod validators for values that come from hardware, QR codes,
 * the dashboard or the network. Rule 14: never trust input without validation.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * School student number: exactly 10 digits (e.g. 2022100001).
 * If the school ever changes its format, change THIS pattern only.
 */
export const STUDENT_NUMBER_PATTERN = /^\d{10}$/;

export const StudentNumberSchema = z
  .string()
  .trim()
  .regex(STUDENT_NUMBER_PATTERN, { message: 'Student number must be exactly 10 digits' });

/** Full name as printed on the ID: letters (incl. Ñ), spaces, . , ' - */
export const StudentFullNameSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(2, { message: 'Full name is too short' })
      .max(100, { message: 'Full name is too long' })
      .regex(/^\p{L}[\p{L} .,'-]*$/u, { message: 'Full name contains invalid characters' }),
  );

/** Course/program abbreviation, e.g. BSCpE, BSIT, BSCE. Case is preserved. */
export const CourseProgramSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9-]{1,19}$/, { message: 'Course must be a short abbreviation like BSCpE' });

/** Human-readable calculator code, e.g. CALC-001. */
export const CalculatorCodeSchema = z
  .string()
  .trim()
  .regex(/^CALC-\d{3,}$/, { message: 'Calculator code must look like CALC-001' });

/** Kiosk device code, e.g. DEVICE-CALC-KIOSK-001. */
export const DeviceCodeSchema = z
  .string()
  .trim()
  .regex(/^DEVICE-[A-Z0-9-]+$/, { message: 'Device code must look like DEVICE-CALC-KIOSK-001' });

// ---------------------------------------------------------------------------
// RFID
// ---------------------------------------------------------------------------

/**
 * Canonical RFID UID format used everywhere (DB, API, Pi): uppercase hex
 * bytes separated by dashes, 4–10 bytes. RC522 tags have 4, 7 or 10-byte UIDs.
 *   "04-A1-B2-C3-D4"
 */
export const RFID_UID_PATTERN = /^[0-9A-F]{2}(-[0-9A-F]{2}){3,9}$/;

/**
 * Accepts common reader output styles and converts them to canonical form:
 *   "04:a1:b2:c3:d4", "04 A1 B2 C3 D4", "04a1b2c3d4" -> "04-A1-B2-C3-D4"
 * Returns null if the value can't be a valid UID.
 */
export function normalizeRfidUid(raw: string): string | null {
  const hex = raw.trim().replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const canonical = hex.match(/.{2}/g)?.join('-') ?? '';
  return RFID_UID_PATTERN.test(canonical) ? canonical : null;
}

export const RfidUidSchema = z
  .string()
  .transform((value, ctx) => {
    const normalized = normalizeRfidUid(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Invalid RFID UID (expected 4–10 hex bytes)' });
      return z.NEVER;
    }
    return normalized;
  });

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Peso amount: non-negative, at most 2 decimal places, sane upper bound. */
export const MoneySchema = z
  .number()
  .finite()
  .nonnegative({ message: 'Amount cannot be negative' })
  .max(10_000, { message: 'Amount is unrealistically large' })
  .refine((value) => Math.round(value * 100) === value * 100, {
    message: 'Amount can have at most 2 decimal places',
  });

/** Philippine coins the selector can be trained to accept. */
export const SUPPORTED_COIN_DENOMINATIONS = [1, 5, 10, 20] as const;

// ---------------------------------------------------------------------------
// System settings (mirrors the system_settings table, camelCase)
// ---------------------------------------------------------------------------

export const PenaltyStepSchema = z.object({
  /** This tier applies while overdue minutes (after grace) ≤ upToMinutes. */
  upToMinutes: z.number().int().positive(),
  amount: MoneySchema,
});
export type PenaltyStep = z.infer<typeof PenaltyStepSchema>;

export const SystemSettingsSchema = z
  .object({
    rentalFee: MoneySchema.refine((v) => Number.isInteger(v) && v > 0, {
      message: 'Rental fee must be a whole peso amount above 0 (coins only)',
    }),
    rentalDurationMinutes: z.number().int().min(15).max(24 * 60),
    gracePeriodMinutes: z.number().int().min(0).max(240),
    penaltyEnabled: z.boolean(),
    penaltyType: z.enum([PenaltyType.FLAT, PenaltyType.PER_INTERVAL, PenaltyType.STEPPED]),
    penaltyAmount: MoneySchema,
    penaltyIntervalMinutes: z.number().int().min(1).max(24 * 60),
    penaltySteps: z.array(PenaltyStepSchema).max(10),
    maxPenalty: MoneySchema.nullable(),
    maxConcurrentRentalsPerStudent: z.literal(1),
    unpaidPenaltyBlocksRental: z.boolean(),
    acceptedCoinDenominations: z
      .array(z.number().int())
      .min(1, { message: 'Accept at least one coin denomination' })
      .refine((list) => new Set(list).size === list.length, { message: 'Duplicate coin denominations' })
      .refine(
        (list) => list.every((c) => (SUPPORTED_COIN_DENOMINATIONS as readonly number[]).includes(c)),
        { message: `Coins must be among ₱${SUPPORTED_COIN_DENOMINATIONS.join(', ₱')}` },
      ),
    paymentTimeoutSeconds: z.number().int().min(30).max(600),
    removalTimeoutSeconds: z.number().int().min(15).max(300),
    returnTimeoutSeconds: z.number().int().min(15).max(300),
    allowOfflineReturns: z.boolean(),
    allowOfflineRentals: z.boolean(),
  })
  .superRefine((s, ctx) => {
    if (s.penaltyType === PenaltyType.STEPPED) {
      if (s.penaltySteps.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['penaltySteps'], message: 'Stepped penalties need at least one tier' });
      }
      for (let i = 1; i < s.penaltySteps.length; i++) {
        const prev = s.penaltySteps[i - 1]!;
        const curr = s.penaltySteps[i]!;
        if (curr.upToMinutes <= prev.upToMinutes || curr.amount < prev.amount) {
          ctx.addIssue({
            code: 'custom',
            path: ['penaltySteps', i],
            message: 'Tiers must be sorted by time and never decrease in amount',
          });
        }
      }
    }
    if (s.maxPenalty !== null && s.maxPenalty < s.penaltyAmount) {
      ctx.addIssue({ code: 'custom', path: ['maxPenalty'], message: 'Maximum penalty cannot be below the penalty amount' });
    }
    if (s.allowOfflineRentals && !s.allowOfflineReturns) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowOfflineReturns'],
        message: 'Offline returns must be allowed if offline rentals are allowed',
      });
    }
  });
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;
