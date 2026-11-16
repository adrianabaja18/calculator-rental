import type { ErrorCode } from '../errors';

/**
 * Result of a business rule: either OK (with optional data) or a refusal
 * with a machine-readable code (for the LCD / API) and a human message
 * (for logs and the dashboard). Rules never throw for expected outcomes.
 */
export type RuleResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: ErrorCode; message: string };

export function refuse(code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } {
  return { ok: false, code, message };
}
