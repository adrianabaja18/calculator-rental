/**
 * Domain enums shared by the web app, the Raspberry Pi and the database.
 *
 * Every object here MIRRORS a PostgreSQL enum type of the same snake_case name
 * in supabase/migrations/*_enums.sql. The database test suite
 * (supabase/tests/schema.test.ts) fails if the two ever drift apart.
 *
 * Usage:   if (rental.status === RentalStatus.ACTIVE) { ... }
 * Never compare against raw string literals scattered through the code.
 */

/** Helper: turns `{ A: 'A', B: 'B' }` into the union type `'A' | 'B'`. */
type ValueOf<T> = T[keyof T];

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------

/** DB: admin_role. Ordered from most to least privileged. */
export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN', // everything, incl. managing other admins and settings
  OFFICER: 'OFFICER', // day-to-day operations: maintenance, waivers, manual overrides
  VIEWER: 'VIEWER', // read-only dashboard access
} as const;
export type AdminRole = ValueOf<typeof AdminRole>;

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

/** DB: student_status. */
export const StudentStatus = {
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED', // manually blocked by an officer — cannot rent
  INACTIVE: 'INACTIVE', // e.g. graduated; kept for history
} as const;
export type StudentStatus = ValueOf<typeof StudentStatus>;

// ---------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------

/**
 * DB: calculator_status. Describes the ASSET, not the rental.
 * "Overdue" is a property of the rental transaction, so it is intentionally
 * NOT a calculator status (avoids duplicated status semantics).
 */
export const CalculatorStatus = {
  AVAILABLE: 'AVAILABLE',
  RENTED: 'RENTED',
  MAINTENANCE: 'MAINTENANCE',
  MISSING: 'MISSING',
  DISABLED: 'DISABLED',
} as const;
export type CalculatorStatus = ValueOf<typeof CalculatorStatus>;

/** DB: calculator_condition. */
export const CalculatorCondition = {
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  DAMAGED: 'DAMAGED',
} as const;
export type CalculatorCondition = ValueOf<typeof CalculatorCondition>;

// ---------------------------------------------------------------------------
// Lockers (logical workflow status + physical sensor states)
// ---------------------------------------------------------------------------

/** DB: locker_status. The locker's place in the borrow/return workflow. */
export const LockerStatus = {
  AVAILABLE: 'AVAILABLE', // calculator inside, ready to rent
  RESERVED: 'RESERVED', // held for a student who is paying
  OPEN: 'OPEN', // unlocked for dispensing; waiting for removal
  RENTED: 'RENTED', // calculator is out with a student (slot empty)
  RETURNING: 'RETURNING', // unlocked for a return; waiting for the calculator
  ERROR: 'ERROR', // inconsistency or hardware fault — never auto-assigned
  MAINTENANCE: 'MAINTENANCE',
  OFFLINE: 'OFFLINE', // its kiosk is not reporting
} as const;
export type LockerStatus = ValueOf<typeof LockerStatus>;

/** DB: lock_state. Solenoid lock as last reported by the Pi. */
export const LockState = {
  LOCKED: 'LOCKED',
  UNLOCKED: 'UNLOCKED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type LockState = ValueOf<typeof LockState>;

/** DB: door_state. UNKNOWN when no door sensor is installed. */
export const DoorState = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DoorState = ValueOf<typeof DoorState>;

/** DB: rfid_state. What the locker's RC522 reader currently sees. */
export const RfidState = {
  EXPECTED_TAG: 'EXPECTED_TAG', // the calculator assigned to this locker is present
  NO_TAG: 'NO_TAG',
  WRONG_TAG: 'WRONG_TAG', // some other tag (another calculator or random object)
  UNKNOWN: 'UNKNOWN', // reader not responding / not yet polled
} as const;
export type RfidState = ValueOf<typeof RfidState>;

/** DB: device_health. */
export const DeviceHealth = {
  OK: 'OK',
  DEGRADED: 'DEGRADED',
  FAULT: 'FAULT',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DeviceHealth = ValueOf<typeof DeviceHealth>;

/**
 * Kiosk connectivity as shown on the dashboard. NOT stored — derived from
 * device_registry.is_enabled + last_heartbeat_at (see view v_device_status).
 */
export const DeviceStatus = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  DISABLED: 'DISABLED',
  NEVER_SEEN: 'NEVER_SEEN',
} as const;
export type DeviceStatus = ValueOf<typeof DeviceStatus>;

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

/** DB: rental_status. Lifecycle of ONE rental transaction. */
export const RentalStatus = {
  PENDING: 'PENDING',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAID: 'PAID',
  DISPENSING: 'DISPENSING',
  ACTIVE: 'ACTIVE',
  OVERDUE: 'OVERDUE',
  RETURNING: 'RETURNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type RentalStatus = ValueOf<typeof RentalStatus>;

/**
 * Statuses in which a rental still "holds" its student, calculator and locker.
 * The database enforces at most ONE open rental per student, per calculator
 * and per locker using partial unique indexes over exactly this list.
 */
export const OPEN_RENTAL_STATUSES = [
  RentalStatus.PENDING,
  RentalStatus.PAYMENT_PENDING,
  RentalStatus.PAID,
  RentalStatus.DISPENSING,
  RentalStatus.ACTIVE,
  RentalStatus.OVERDUE,
  RentalStatus.RETURNING,
] as const satisfies readonly RentalStatus[];

/** Rentals where the calculator is physically with the student. */
export const OUTSTANDING_RENTAL_STATUSES = [
  RentalStatus.ACTIVE,
  RentalStatus.OVERDUE,
  RentalStatus.RETURNING,
] as const satisfies readonly RentalStatus[];

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** DB: payment_type. */
export const PaymentType = {
  RENTAL: 'RENTAL',
  PENALTY: 'PENALTY',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
} as const;
export type PaymentType = ValueOf<typeof PaymentType>;

/** DB: payment_status. */
export const PaymentStatus = {
  PENDING: 'PENDING',
  PARTIAL: 'PARTIAL',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = ValueOf<typeof PaymentStatus>;

/** DB: payment_method. */
export const PaymentMethod = {
  COIN: 'COIN',
  CASH: 'CASH',
  GCASH: 'GCASH',
  OTHER: 'OTHER',
} as const;
export type PaymentMethod = ValueOf<typeof PaymentMethod>;

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

/** DB: penalty_status. */
export const PenaltyStatus = {
  UNPAID: 'UNPAID',
  PARTIAL: 'PARTIAL',
  PAID: 'PAID',
  WAIVED: 'WAIVED',
} as const;
export type PenaltyStatus = ValueOf<typeof PenaltyStatus>;

/** DB: penalty_reason. */
export const PenaltyReason = {
  OVERDUE: 'OVERDUE',
  DAMAGE: 'DAMAGE',
  LOST: 'LOST',
  OTHER: 'OTHER',
} as const;
export type PenaltyReason = ValueOf<typeof PenaltyReason>;

/** DB: penalty_type. How the overdue penalty is calculated (system_settings). */
export const PenaltyType = {
  FLAT: 'FLAT', // one fixed amount once overdue (after grace)
  PER_INTERVAL: 'PER_INTERVAL', // amount per started interval, e.g. ₱5 per hour
  STEPPED: 'STEPPED', // tiered table, e.g. ≤1h ₱5, ≤3h ₱15, more ₱30
} as const;
export type PenaltyType = ValueOf<typeof PenaltyType>;

// ---------------------------------------------------------------------------
// Device events & audit
// ---------------------------------------------------------------------------

/** DB: device_event_type. Hardware/kiosk events logged for debugging. */
export const EventType = {
  QR_SCANNED: 'QR_SCANNED',
  QR_INVALID: 'QR_INVALID',
  COIN_INSERTED: 'COIN_INSERTED',
  COIN_UNATTRIBUTED: 'COIN_UNATTRIBUTED', // coin inserted while no payment was expected
  PAYMENT_COMPLETE: 'PAYMENT_COMPLETE',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  LOCKER_UNLOCK_REQUESTED: 'LOCKER_UNLOCK_REQUESTED',
  LOCKER_UNLOCKED: 'LOCKER_UNLOCKED',
  LOCKER_OPENED: 'LOCKER_OPENED',
  LOCKER_CLOSED: 'LOCKER_CLOSED',
  RFID_DETECTED: 'RFID_DETECTED',
  RFID_REMOVED: 'RFID_REMOVED',
  RFID_MISMATCH: 'RFID_MISMATCH',
  RENTAL_STARTED: 'RENTAL_STARTED',
  RETURN_STARTED: 'RETURN_STARTED',
  RETURN_VERIFIED: 'RETURN_VERIFIED',
  INVENTORY_MISMATCH: 'INVENTORY_MISMATCH',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_ONLINE: 'DEVICE_ONLINE',
  SYNC_FAILED: 'SYNC_FAILED',
  SYNC_SUCCESS: 'SYNC_SUCCESS',
  SYSTEM_ERROR: 'SYSTEM_ERROR',
} as const;
export type EventType = ValueOf<typeof EventType>;

/** DB: event_severity. */
export const EventSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
} as const;
export type EventSeverity = ValueOf<typeof EventSeverity>;

/** DB: actor_type. Who performed an audited action. */
export const ActorType = {
  ADMIN: 'ADMIN',
  DEVICE: 'DEVICE',
  SYSTEM: 'SYSTEM',
} as const;
export type ActorType = ValueOf<typeof ActorType>;

/**
 * Registry used by the schema test to compare every shared enum with its
 * PostgreSQL counterpart. Key = PostgreSQL type name.
 */
export const DB_ENUMS = {
  admin_role: AdminRole,
  student_status: StudentStatus,
  calculator_status: CalculatorStatus,
  calculator_condition: CalculatorCondition,
  locker_status: LockerStatus,
  lock_state: LockState,
  door_state: DoorState,
  rfid_state: RfidState,
  device_health: DeviceHealth,
  rental_status: RentalStatus,
  payment_type: PaymentType,
  payment_status: PaymentStatus,
  payment_method: PaymentMethod,
  penalty_status: PenaltyStatus,
  penalty_reason: PenaltyReason,
  penalty_type: PenaltyType,
  device_event_type: EventType,
  event_severity: EventSeverity,
  actor_type: ActorType,
} as const;
