import type { BadgeTone } from '@/components/status-badge';

/**
 * One place that decides the badge colour for every status.
 * Spec §24: AVAILABLE green · RENTED blue · OVERDUE red ·
 * RETURNING amber · MAINTENANCE gray.
 */
const tones: Record<string, BadgeTone> = {
  // calculators / lockers / rentals
  AVAILABLE: 'green',
  RENTED: 'blue',
  ACTIVE: 'blue',
  OVERDUE: 'red',
  RETURNING: 'amber',
  RESERVED: 'amber',
  OPEN: 'amber',
  PENDING: 'amber',
  PAYMENT_PENDING: 'amber',
  PAID: 'blue',
  DISPENSING: 'amber',
  COMPLETED: 'green',
  CANCELLED: 'gray',
  FAILED: 'red',
  MAINTENANCE: 'gray',
  DISABLED: 'gray',
  MISSING: 'red',
  ERROR: 'red',
  OFFLINE: 'gray',
  // students
  BLOCKED: 'red',
  INACTIVE: 'gray',
  // condition
  GOOD: 'green',
  FAIR: 'amber',
  DAMAGED: 'red',
  // sensors
  LOCKED: 'green',
  UNLOCKED: 'amber',
  CLOSED: 'green',
  EXPECTED_TAG: 'green',
  NO_TAG: 'red',
  WRONG_TAG: 'red',
  UNKNOWN: 'gray',
  // devices
  ONLINE: 'green',
  NEVER_SEEN: 'gray',
  OK: 'green',
  DEGRADED: 'amber',
  FAULT: 'red',
  // device commands
  SENT: 'amber',
  DONE: 'green',
  EXPIRED: 'gray',
  // payments & penalties
  PARTIAL: 'amber',
  UNPAID: 'red',
  WAIVED: 'gray',
  REFUNDED: 'gray',
  // event severity
  INFO: 'blue',
  WARNING: 'amber',
  CRITICAL: 'red',
};

export function toneFor(status: string | null | undefined): BadgeTone {
  return (status && tones[status]) || 'gray';
}

/** "PAYMENT_PENDING" -> "Payment pending" */
export function humanize(status: string | null | undefined): string {
  if (!status) return '—';
  const text = status.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
