import 'server-only';
import { NextResponse } from 'next/server';
import { apiFailure, apiSuccess, type ErrorCode } from '@calc-rental/shared';

/**
 * Helpers so every route handler returns the same JSON envelope:
 *   { success, data, error }
 */

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(apiSuccess(data), init);
}

export function jsonError(code: ErrorCode, message: string, status: number, init?: ResponseInit) {
  return NextResponse.json(apiFailure(code, message), { ...init, status });
}
