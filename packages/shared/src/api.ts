import { z } from 'zod';
import type { ErrorCode } from './errors';

/**
 * Consistent JSON envelope returned by EVERY API endpoint.
 *
 * Success: { "success": true,  "data": {...}, "error": null }
 * Failure: { "success": false, "data": null,  "error": { "code": "...", "message": "..." } }
 */

export interface ApiError {
  code: ErrorCode;
  message: string;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(data: T): ApiSuccess<T> {
  return { success: true, data, error: null };
}

export function apiFailure(code: ErrorCode, message: string): ApiFailure {
  return { success: false, data: null, error: { code, message } };
}

/** Runtime validator for the error part of the envelope. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/**
 * Builds a Zod schema for an API response whose `data` matches `dataSchema`.
 * Used by API clients (Raspberry Pi, dashboard) to validate what the server sent
 * instead of trusting it blindly.
 */
export function apiResponseSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data: dataSchema, error: z.null() }),
    z.object({ success: z.literal(false), data: z.null(), error: ApiErrorSchema }),
  ]);
}
