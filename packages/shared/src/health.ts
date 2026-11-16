import { z } from 'zod';
import { apiResponseSchema } from './api';

/**
 * Contract for GET /api/health.
 *
 * Shared so the web server (producer) and the Raspberry Pi test script
 * (consumer) can never disagree about the shape.
 */

export const ServiceCheckStatusSchema = z.enum([
  'ok', // dependency reachable and credentials accepted
  'not_configured', // environment variables missing
  'unreachable', // network error / timeout
  'error', // reachable, but rejected the request (e.g. wrong key)
]);
export type ServiceCheckStatus = z.infer<typeof ServiceCheckStatusSchema>;

export const ServiceCheckSchema = z.object({
  status: ServiceCheckStatusSchema,
  latencyMs: z.number().nonnegative().nullable(),
  message: z.string(),
});
export type ServiceCheck = z.infer<typeof ServiceCheckSchema>;

export const HealthReportSchema = z.object({
  service: z.string(),
  /** `ok` when every check passed; `degraded` when the web app runs but a dependency failed. */
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  environment: z.string(),
  /** Server time in UTC (ISO-8601). */
  serverTime: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    /** Public (anon / publishable) key can reach Supabase. */
    supabase: ServiceCheckSchema,
    /** Server-only service-role (secret) key is valid. */
    supabaseAdmin: ServiceCheckSchema,
  }),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

export const HealthResponseSchema = apiResponseSchema(HealthReportSchema);
