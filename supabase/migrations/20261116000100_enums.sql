-- =====================================================================
-- 0001 · Enum types
-- Every enum MIRRORS an object in packages/shared/src/enums.ts.
-- To add a value later:  ALTER TYPE public.<type> ADD VALUE '<VALUE>';
-- (in a NEW migration — never edit this file after it has been pushed)
-- =====================================================================

-- Admin users ---------------------------------------------------------
create type public.admin_role as enum ('SUPER_ADMIN', 'OFFICER', 'VIEWER');

-- Students ------------------------------------------------------------
create type public.student_status as enum ('ACTIVE', 'BLOCKED', 'INACTIVE');

-- Calculators (asset status; "overdue" belongs to the rental) ----------
create type public.calculator_status as enum ('AVAILABLE', 'RENTED', 'MAINTENANCE', 'MISSING', 'DISABLED');
create type public.calculator_condition as enum ('GOOD', 'FAIR', 'DAMAGED');

-- Lockers: logical workflow status + physical sensor states -----------
create type public.locker_status as enum (
  'AVAILABLE', 'RESERVED', 'OPEN', 'RENTED', 'RETURNING', 'ERROR', 'MAINTENANCE', 'OFFLINE'
);
create type public.lock_state  as enum ('LOCKED', 'UNLOCKED', 'UNKNOWN');
create type public.door_state  as enum ('OPEN', 'CLOSED', 'UNKNOWN');
create type public.rfid_state  as enum ('EXPECTED_TAG', 'NO_TAG', 'WRONG_TAG', 'UNKNOWN');
create type public.device_health as enum ('OK', 'DEGRADED', 'FAULT', 'UNKNOWN');

-- Rentals -------------------------------------------------------------
create type public.rental_status as enum (
  'PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING',
  'ACTIVE', 'OVERDUE', 'RETURNING',
  'COMPLETED', 'CANCELLED', 'FAILED'
);

-- Payments ------------------------------------------------------------
create type public.payment_type   as enum ('RENTAL', 'PENALTY', 'MANUAL_ADJUSTMENT');
create type public.payment_status as enum ('PENDING', 'PARTIAL', 'PAID', 'CANCELLED', 'REFUNDED');
create type public.payment_method as enum ('COIN', 'CASH', 'GCASH', 'OTHER');

-- Penalties -----------------------------------------------------------
create type public.penalty_status as enum ('UNPAID', 'PARTIAL', 'PAID', 'WAIVED');
create type public.penalty_reason as enum ('OVERDUE', 'DAMAGE', 'LOST', 'OTHER');
create type public.penalty_type   as enum ('FLAT', 'PER_INTERVAL', 'STEPPED');

-- Device events & audit -----------------------------------------------
create type public.device_event_type as enum (
  'QR_SCANNED', 'QR_INVALID',
  'COIN_INSERTED', 'COIN_UNATTRIBUTED', 'PAYMENT_COMPLETE', 'PAYMENT_TIMEOUT',
  'LOCKER_UNLOCK_REQUESTED', 'LOCKER_UNLOCKED', 'LOCKER_OPENED', 'LOCKER_CLOSED',
  'RFID_DETECTED', 'RFID_REMOVED', 'RFID_MISMATCH',
  'RENTAL_STARTED', 'RETURN_STARTED', 'RETURN_VERIFIED',
  'INVENTORY_MISMATCH',
  'DEVICE_OFFLINE', 'DEVICE_ONLINE',
  'SYNC_FAILED', 'SYNC_SUCCESS',
  'SYSTEM_ERROR'
);
create type public.event_severity as enum ('INFO', 'WARNING', 'ERROR', 'CRITICAL');
create type public.actor_type     as enum ('ADMIN', 'DEVICE', 'SYSTEM');
