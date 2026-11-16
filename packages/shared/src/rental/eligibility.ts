import { RentalStatus, StudentStatus } from '../enums';
import { ErrorCode } from '../errors';
import { refuse, type RuleResult } from './result';

/**
 * Borrowing eligibility (spec §5 steps 10–11).
 * Pure function: the kiosk gathers the facts from SQLite, this decides.
 */
export interface EligibilityInput {
  /** null = first-time student (will be registered) — always eligible. */
  student: { status: StudentStatus } | null;
  /** The student's current open rental, if any (any status PENDING..RETURNING). */
  openRental: { status: RentalStatus } | null;
  /** Sum of the student's UNPAID/PARTIAL penalty balances. */
  unpaidPenaltyTotal: number;
  settings: { unpaidPenaltyBlocksRental: boolean };
}

export function checkBorrowEligibility(input: EligibilityInput): RuleResult {
  const { student, openRental, unpaidPenaltyTotal, settings } = input;

  if (student?.status === StudentStatus.BLOCKED) {
    return refuse(ErrorCode.STUDENT_NOT_ALLOWED, 'This account is blocked. Please see an officer.');
  }
  if (student?.status === StudentStatus.INACTIVE) {
    return refuse(ErrorCode.STUDENT_NOT_ALLOWED, 'This account is inactive. Please see an officer.');
  }

  // Rule 1: at most one rental at a time.
  if (openRental) {
    const overdue = openRental.status === RentalStatus.OVERDUE;
    return refuse(
      ErrorCode.ACTIVE_RENTAL_EXISTS,
      overdue
        ? 'You have an overdue calculator. Return it first.'
        : 'You already have a calculator rental. Return it first.',
    );
  }

  if (settings.unpaidPenaltyBlocksRental && unpaidPenaltyTotal > 0) {
    return refuse(ErrorCode.UNPAID_PENALTY, 'You have an unpaid penalty. Please settle it with an officer first.');
  }

  return { ok: true };
}
