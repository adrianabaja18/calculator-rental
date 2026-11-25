import { RentalStatus } from '../enums';
import { isOpenAt, operatingMillisBetween, type OperatingCalendar } from './operating-hours';

/**
 * Rental transaction state machine (spec §11).
 *
 *  PENDING → PAYMENT_PENDING → PAID → DISPENSING → ACTIVE ⇄ OVERDUE → RETURNING → COMPLETED
 *     └──────────┴──────────────┴──────────┴─→ CANCELLED / FAILED
 *
 * Only these transitions are allowed; anything else is a bug or a
 * tampered request and is rejected.
 */
export const RENTAL_TRANSITIONS: Readonly<Record<RentalStatus, readonly RentalStatus[]>> = {
  [RentalStatus.PENDING]: [RentalStatus.PAYMENT_PENDING, RentalStatus.CANCELLED, RentalStatus.FAILED],
  [RentalStatus.PAYMENT_PENDING]: [RentalStatus.PAID, RentalStatus.CANCELLED, RentalStatus.FAILED],
  // Once paid, the student is owed a calculator: no CANCELLED, only FAILED (officer refunds).
  [RentalStatus.PAID]: [RentalStatus.DISPENSING, RentalStatus.FAILED],
  [RentalStatus.DISPENSING]: [RentalStatus.ACTIVE, RentalStatus.FAILED],
  // ACTIVE/OVERDUE → COMPLETED directly only through an officer's manual resolution.
  [RentalStatus.ACTIVE]: [RentalStatus.OVERDUE, RentalStatus.RETURNING, RentalStatus.COMPLETED],
  [RentalStatus.OVERDUE]: [RentalStatus.RETURNING, RentalStatus.COMPLETED],
  // A return can be abandoned (student walks away): back to ACTIVE or OVERDUE.
  [RentalStatus.RETURNING]: [RentalStatus.COMPLETED, RentalStatus.ACTIVE, RentalStatus.OVERDUE],
  [RentalStatus.COMPLETED]: [],
  [RentalStatus.CANCELLED]: [],
  [RentalStatus.FAILED]: [],
};

export function canTransition(from: RentalStatus, to: RentalStatus): boolean {
  return RENTAL_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RentalStatus,
    readonly to: RentalStatus,
  ) {
    super(`Rental cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: RentalStatus, to: RentalStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** due_at = rented_at + duration. Uses milliseconds, so it is time-zone safe. */
export function computeDueAt(rentedAt: Date, durationMinutes: number): Date {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError('Rental duration must be a positive whole number of minutes');
  }
  return new Date(rentedAt.getTime() + durationMinutes * 60_000);
}

/** Overdue the moment the current time passes due_at (grace only affects penalties). */
export function isOverdue(dueAt: Date | string | null, now: Date): boolean {
  if (!dueAt) return false;
  return now.getTime() > new Date(dueAt).getTime();
}

/** ACTIVE rentals past their due time are reported as OVERDUE (mirrors view v_rentals). */
export function effectiveRentalStatus(status: RentalStatus, dueAt: Date | string | null, now: Date): RentalStatus {
  return status === RentalStatus.ACTIVE && isOverdue(dueAt, now) ? RentalStatus.OVERDUE : status;
}

/** Whole minutes past due_at (0 if not overdue). */
export function overdueMinutes(dueAt: Date | string | null, now: Date): number {
  if (!dueAt || !isOverdue(dueAt, now)) return 0;
  return Math.floor((now.getTime() - new Date(dueAt).getTime()) / 60_000);
}

/**
 * Countdown shown on the Active Rentals page (spec §25), computed on the
 * client from due_at every second; nothing is written to the database.
 *   { overdue: false, text: '01:42:15' }  → "Due in 01:42:15"
 *   { overdue: true,  text: '00:32:16' }  → "Overdue by 00:32:16"
 * With an operating calendar that pauses outside hours, only operating time
 * counts and `paused` is true while the kiosk is closed.
 * Hours can exceed 24 (e.g. '26:05:00').
 */
export function rentalCountdown(
  dueAt: Date | string,
  now: Date,
  cal?: OperatingCalendar,
): { overdue: boolean; text: string; paused: boolean } {
  const due = new Date(dueAt);
  const overdue = now.getTime() > due.getTime();
  const pausing = cal?.pauseOutside === true;
  const ms = pausing
    ? overdue
      ? operatingMillisBetween(due, now, cal)
      : operatingMillisBetween(now, due, cal)
    : Math.abs(due.getTime() - now.getTime());
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return { overdue, text, paused: pausing && !isOpenAt(now, cal) };
}
