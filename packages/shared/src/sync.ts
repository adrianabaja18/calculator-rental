import { z } from 'zod';
import { apiResponseSchema } from './api';
import {
  CalculatorCondition,
  CalculatorStatus,
  DoorState,
  LockState,
  LockerStatus,
  PenaltyReason,
  PenaltyStatus,
  RfidState,
  StudentStatus,
} from './enums';

/**
 * Kiosk ↔ backend sync contract (Phase 12). SQLite-first:
 *
 *   PUSH  POST /api/device/sync         kiosk outbox → Supabase, in order
 *   PULL  GET  /api/device/sync?…       officer data → kiosk (settings, lockers,
 *                                       calculators, student status, penalty waivers)
 *
 * Ownership (what wins when both sides changed something) is documented in
 * supabase/migrations/20261127000100_kiosk_sync.sql and docs/architecture.md §3.9.
 */

export const SYNC_ENTITIES = [
  'student',
  'rental',
  'payment',
  'penalty',
  'coin_event',
  'device_event',
  'locker_state',
  'calculator_state',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/** Items per push request (keeps each request small on a slow network). */
export const SYNC_PUSH_MAX_ITEMS = 100;
/** Rows per page for incremental pulls (students, penalties). */
export const SYNC_PULL_PAGE_SIZE = 500;

/** Postgres timestamps arrive with an offset and microseconds ("…123456+00:00"). */
const timestamp = z.iso.datetime({ offset: true });
const money = z.coerce.number().nonnegative();

// ----------------------------------------------------------------- officer commands (Phase 13)
/**
 * Officer → kiosk instructions, delivered in the push reply (the kiosk syncs
 * every ~10 s) and answered in the next push. Unanswered ones expire after 2 min.
 *   UNLOCK_LOCKER  payload { lockerId }   emergency unlock (kiosk must be idle)
 *   REFRESH        payload {}             pull officer data now
 */
export const DEVICE_COMMANDS = ['UNLOCK_LOCKER', 'REFRESH'] as const;
export type DeviceCommandName = (typeof DEVICE_COMMANDS)[number];

export const DeviceCommandSchema = z.object({
  id: z.uuid(),
  command: z.enum(DEVICE_COMMANDS),
  payload: z.record(z.string(), z.unknown()),
  requestedAt: timestamp,
});
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

export const CommandResultSchema = z.object({
  id: z.uuid(),
  status: z.enum(['DONE', 'FAILED']),
  message: z.string().max(300),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ----------------------------------------------------------------- push
export const SyncItemSchema = z.object({
  seq: z.number().int().positive(),
  entity: z.enum(SYNC_ENTITIES),
  payload: z.record(z.string(), z.unknown()),
});
export type SyncItem = z.infer<typeof SyncItemSchema>;

export const SyncPushRequestSchema = z.object({
  items: z.array(SyncItemSchema).max(SYNC_PUSH_MAX_ITEMS),
  /** Results of commands received in an earlier reply. */
  commandResults: z.array(CommandResultSchema).max(20).default([]),
});
export type SyncPushRequest = z.input<typeof SyncPushRequestSchema>;

export const SyncPushReplySchema = z.object({
  /** Highest outbox seq now stored in Supabase (null = nothing applied). */
  appliedThroughSeq: z.number().int().nullable(),
  applied: z.number().int().nonnegative(),
  /** The first item that could not be applied; nothing after it was applied. */
  failure: z.object({ seq: z.number().int(), entity: z.string().nullable(), message: z.string() }).nullable(),
  serverTime: timestamp,
  /** Officer commands waiting for this kiosk. */
  commands: z.array(DeviceCommandSchema).default([]),
});
export type SyncPushReply = z.infer<typeof SyncPushReplySchema>;
export const SyncPushResponseSchema = apiResponseSchema(SyncPushReplySchema);

// ----------------------------------------------------------------- pull
export const PullLockerSchema = z.object({
  id: z.uuid(),
  locker_number: z.number().int().positive(),
  name: z.string(),
  hardware_channel: z.number().int().min(1).max(16),
  status: z.enum(LockerStatus),
});
export type PullLocker = z.infer<typeof PullLockerSchema>;

export const PullCalculatorSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  model: z.string(),
  rfid_uid: z.string(),
  locker_id: z.uuid().nullable(),
  status: z.enum(CalculatorStatus),
  condition: z.enum(CalculatorCondition),
});
export type PullCalculator = z.infer<typeof PullCalculatorSchema>;

export const PullStudentSchema = z.object({
  id: z.uuid(),
  student_number: z.string(),
  full_name: z.string(),
  course_program: z.string(),
  status: z.enum(StudentStatus),
  blocked_reason: z.string().nullable(),
  updated_at: timestamp,
});
export type PullStudent = z.infer<typeof PullStudentSchema>;

export const PullPenaltySchema = z.object({
  id: z.uuid(),
  rental_transaction_id: z.uuid(),
  student_id: z.uuid(),
  reason: z.enum(PenaltyReason),
  overdue_minutes: z.number().int().nonnegative(),
  calculated_amount: money,
  waived_amount: money,
  amount_paid: money,
  status: z.enum(PenaltyStatus),
  updated_at: timestamp,
});
export type PullPenalty = z.infer<typeof PullPenaltySchema>;

export const SyncPullReplySchema = z.object({
  serverTime: timestamp,
  /** The system_settings row (snake_case); parse with systemSettingsFromRow. */
  settings: z.record(z.string(), z.unknown()),
  /** All lockers of this kiosk and all calculators (small tables: always complete). */
  lockers: z.array(PullLockerSchema),
  calculators: z.array(PullCalculatorSchema),
  /** Students and penalties changed since the kiosk's cursors (one page). */
  students: z.array(PullStudentSchema),
  penalties: z.array(PullPenaltySchema),
  cursors: z.object({ students: timestamp.nullable(), penalties: timestamp.nullable() }),
  /** true = another page is waiting: pull again with the new cursors. */
  hasMore: z.boolean(),
});
export type SyncPullReply = z.infer<typeof SyncPullReplySchema>;
export const SyncPullResponseSchema = apiResponseSchema(SyncPullReplySchema);

// ----------------------------------------------------------------- heartbeat extras
/** What each locker's sensors report right now (sent with every heartbeat, not queued). */
export const LockerSensorReportSchema = z.object({
  id: z.uuid(),
  lockState: z.enum(LockState),
  doorState: z.enum(DoorState),
  rfidState: z.enum(RfidState),
  detectedRfidUid: z.string().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type LockerSensorReport = z.infer<typeof LockerSensorReportSchema>;

export const SyncStatusReportSchema = z.object({
  lastPushAt: z.iso.datetime().nullable(),
  lastPullAt: z.iso.datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  /** Outbox items given up on after too many attempts (need an officer). */
  failedItems: z.number().int().nonnegative(),
});
export type SyncStatusReport = z.infer<typeof SyncStatusReportSchema>;
