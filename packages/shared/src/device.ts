import { z } from 'zod';
import { apiResponseSchema } from './api';
import { LockerSensorReportSchema, SyncStatusReportSchema } from './sync';

/**
 * Kiosk ↔ backend contract for device APIs (spec §19, §32).
 *
 * Every device request carries:
 *   x-device-id:   DEVICE-CALC-KIOSK-001
 *   authorization: Bearer <device secret>   (server stores only its SHA-256)
 */
export const DEVICE_ID_HEADER = 'x-device-id';

/** A kiosk clock further off than this from the server is reported. */
export const MAX_CLOCK_DRIFT_SECONDS = 120;

export const HeartbeatRequestSchema = z.object({
  softwareVersion: z.string().min(1).max(40),
  kioskState: z.string().min(1).max(40),
  syncQueueCount: z.number().int().nonnegative(),
  localDbOk: z.boolean(),
  cpuTempC: z.number().min(-40).max(150).nullable(),
  /** Kiosk clock when sent, to detect drift (no RTC on the Pi). */
  sentAt: z.iso.datetime(),
  /** Phase 12: live sensor state of each locker (not queued: only the latest matters). */
  lockers: z.array(LockerSensorReportSchema).max(16).optional(),
  /** Phase 12: outbox health, shown on the Devices page. */
  sync: SyncStatusReportSchema.optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const HeartbeatReplySchema = z.object({
  deviceCode: z.string(),
  serverTime: z.iso.datetime(),
  /** kiosk clock − server clock, in seconds (positive = kiosk ahead). */
  clockDriftSeconds: z.number(),
});
export type HeartbeatReply = z.infer<typeof HeartbeatReplySchema>;

export const HeartbeatResponseSchema = apiResponseSchema(HeartbeatReplySchema);
