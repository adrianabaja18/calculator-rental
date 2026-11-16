/**
 * Machine-readable error codes used across the whole system.
 *
 * Every API failure returns one of these in `error.code`, so the Raspberry Pi
 * can map it to an LCD message and the dashboard can map it to a toast,
 * without comparing human-readable strings.
 */
export const ErrorCode = {
  // --- Business / hardware errors (project specification, section 29) ---
  INVALID_QR: 'INVALID_QR',
  STUDENT_NOT_ALLOWED: 'STUDENT_NOT_ALLOWED',
  ACTIVE_RENTAL_EXISTS: 'ACTIVE_RENTAL_EXISTS',
  UNPAID_PENALTY: 'UNPAID_PENALTY',
  NO_CALCULATOR_AVAILABLE: 'NO_CALCULATOR_AVAILABLE',
  PAYMENT_INCOMPLETE: 'PAYMENT_INCOMPLETE',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  LOCKER_OPEN_FAILED: 'LOCKER_OPEN_FAILED',
  LOCKER_CLOSE_FAILED: 'LOCKER_CLOSE_FAILED',
  RFID_NOT_DETECTED: 'RFID_NOT_DETECTED',
  RFID_MISMATCH: 'RFID_MISMATCH',
  CALCULATOR_NOT_REMOVED: 'CALCULATOR_NOT_REMOVED',
  CALCULATOR_NOT_RETURNED: 'CALCULATOR_NOT_RETURNED',
  NO_ACTIVE_RENTAL: 'NO_ACTIVE_RENTAL',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  DEVICE_UNAUTHORIZED: 'DEVICE_UNAUTHORIZED',
  SYNC_FAILED: 'SYNC_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // --- Generic HTTP-level errors needed by every API ---
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
