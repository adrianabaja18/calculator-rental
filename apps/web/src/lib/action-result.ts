import type { z } from 'zod';

/**
 * What every dashboard Server Action returns, so forms and dialogs can show
 * a toast or inline errors the same way everywhere.
 * `at` changes on every call, so the UI can react even when the same
 * message comes back twice.
 */
export interface ActionResult {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
  at: number;
}

export const IDLE_RESULT: ActionResult = { ok: false, message: '', at: 0 };

export function actionOk(message: string): ActionResult {
  return { ok: true, message, at: Date.now() };
}

export function actionFail(message: string, fieldErrors?: Record<string, string>): ActionResult {
  return { ok: false, message, fieldErrors, at: Date.now() };
}

/** Turns a Zod error into a friendly ActionResult with one message per field. */
export function actionFromZodError(error: z.ZodError): ActionResult {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    fieldErrors[key] ??= issue.message;
  }
  return actionFail('Please fix the highlighted fields.', fieldErrors);
}

/** Maps common PostgreSQL errors (from Supabase) to messages an officer understands. */
export function actionFromDbError(
  error: { code?: string; message?: string; details?: string } | null,
  uniqueMessages: Record<string, string> = {},
): ActionResult {
  const text = `${error?.message ?? ''} ${error?.details ?? ''}`;
  if (error?.code === '23505') {
    for (const [constraint, message] of Object.entries(uniqueMessages)) {
      if (text.includes(constraint)) return actionFail(message);
    }
    return actionFail('That value is already used by another record.');
  }
  if (error?.code === '23514') return actionFail('That change breaks a data rule and was not saved.');
  if (error?.code === 'P0001') return actionFail(error.message ?? 'That change is not allowed.');
  return actionFail('The change could not be saved. Please try again.');
}
