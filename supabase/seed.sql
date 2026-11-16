-- =====================================================================
-- DEVELOPMENT SEED DATA
--
-- Everything here is FAKE and for development/testing only:
-- fake students, fake RFID UIDs, and a placeholder device secret.
-- Safe to run more than once (ON CONFLICT DO NOTHING).
--
-- Business settings (₱5 fee, 2 hours, 10-min grace, ₱5/hour penalty,
-- unpaid penalty blocks rentals) are inserted by migration 0002 and are
-- edited from the dashboard Settings page — not here.
--
-- Fixed UUIDs make the seed predictable for tests and the simulator.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kiosk device
-- ---------------------------------------------------------------------
insert into public.device_registry (id, device_code, name, location, notes)
values (
  '00000000-0000-4000-8000-000000000001',
  'DEVICE-CALC-KIOSK-001',
  'Calculator Kiosk 001',
  'Development bench',
  'DEV SEED — prototype kiosk with 2 lockers'
)
on conflict (device_code) do nothing;

-- SHA-256 of the placeholder DEVICE_SECRET in apps/raspberry-pi/.env.example
-- ("dev-only-placeholder-secret-change-me"). DEVELOPMENT ONLY —
-- Phase 9 generates a real secret and replaces this hash.
insert into public.device_credentials (device_id, secret_hash)
values (
  '00000000-0000-4000-8000-000000000001',
  'ce6635e1cabf6cb97700d37d24c2e0f324e55a3c04453b81a65c3af50bec5f2e'
)
on conflict (device_id) do nothing;

-- ---------------------------------------------------------------------
-- Lockers (hardware_channel 1 = RFID reader #1 + relay #1, etc.)
-- rfid_state starts UNKNOWN, so neither locker is assignable until the
-- kiosk reports that it actually sees the expected tag.
-- ---------------------------------------------------------------------
insert into public.lockers (id, device_id, locker_number, name, hardware_channel)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 1, 'Locker 1', 1),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 2, 'Locker 2', 2)
on conflict (device_id, locker_number) do nothing;

-- ---------------------------------------------------------------------
-- Calculators (fake RFID UIDs — replace with your real RC522 tag UIDs)
-- ---------------------------------------------------------------------
insert into public.calculators (id, code, model, rfid_uid, locker_id, notes)
values
  ('00000000-0000-4000-8000-000000000201', 'CALC-001', 'Casio fx-991EX ClassWiz', '04-A1-B2-C3-D4',
   '00000000-0000-4000-8000-000000000101', 'DEV SEED — fake RFID UID'),
  ('00000000-0000-4000-8000-000000000202', 'CALC-002', 'Casio fx-991EX ClassWiz', '04-E5-F6-A7-B8',
   '00000000-0000-4000-8000-000000000102', 'DEV SEED — fake RFID UID')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Students (fake people; same shape as real school-ID QR data)
-- ---------------------------------------------------------------------
insert into public.students (id, student_number, full_name, course_program, status, blocked_reason, notes)
values
  ('00000000-0000-4000-8000-000000000301', '2022100001', 'JUAN DELA CRUZ', 'BSCpE', 'ACTIVE',  null, 'DEV SEED'),
  ('00000000-0000-4000-8000-000000000302', '2023100002', 'MARIA SANTOS',   'BSCE',  'ACTIVE',  null, 'DEV SEED'),
  ('00000000-0000-4000-8000-000000000303', '2024100003', 'PEDRO REYES',    'BSIT',  'ACTIVE',  null, 'DEV SEED'),
  ('00000000-0000-4000-8000-000000000304', '2022100004', 'ANA GARCIA',     'BSCpE', 'BLOCKED', 'DEV SEED: sample blocked account', 'DEV SEED'),
  ('00000000-0000-4000-8000-000000000305', '2025100005', 'CARLO MENDOZA',  'BSEE',  'ACTIVE',  null, 'DEV SEED')
on conflict (student_number) do nothing;
