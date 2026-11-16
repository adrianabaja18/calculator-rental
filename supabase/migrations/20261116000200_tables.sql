-- =====================================================================
-- 0002 · Tables
-- All timestamps are timestamptz (stored in UTC).
-- Money is numeric(10,2) — never floating point.
-- Historical tables (rentals, payments, penalties, coin events, audit)
-- are protected from DELETE by triggers in migration 0003.
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles · one row per dashboard user (linked 1:1 to Supabase Auth)
-- New auth users get an INACTIVE VIEWER profile (trigger in 0003);
-- a SUPER_ADMIN must activate them. Deactivate admins, don't delete them.
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  full_name     text,
  role          public.admin_role not null default 'VIEWER',
  is_active     boolean not null default false,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index profiles_email_lower_key on public.profiles (lower(email));

-- ---------------------------------------------------------------------
-- device_registry · each Raspberry Pi kiosk
-- Online/offline is DERIVED from last_heartbeat_at (view v_device_status).
-- ---------------------------------------------------------------------
create table public.device_registry (
  id                uuid primary key default gen_random_uuid(),
  device_code       text not null unique check (device_code ~ '^DEVICE-[A-Z0-9-]+$'),
  name              text not null check (length(name) between 1 and 100),
  location          text,
  is_enabled        boolean not null default true,
  software_version  text,
  last_heartbeat_at timestamptz,
  ip_address        inet,
  network_state     text,
  cpu_temp_c        numeric(5,2),
  sync_queue_count  integer not null default 0 check (sync_queue_count >= 0),
  local_db_ok       boolean,
  health            public.device_health not null default 'UNKNOWN',
  last_health       jsonb not null default '{}'::jsonb check (jsonb_typeof(last_health) = 'object'),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- device_credentials · SHA-256 hash of each device's secret.
-- Separate table so it can be locked away from every dashboard user
-- (RLS on, no policies, privileges revoked) while device_registry stays readable.
-- ---------------------------------------------------------------------
create table public.device_credentials (
  device_id   uuid primary key references public.device_registry (id) on delete cascade,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  rotated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- lockers · physical compartments. Add Locker 3+ by inserting rows —
-- no code changes. hardware_channel tells the Pi which RFID reader /
-- relay pair (configured on the Pi) belongs to this locker.
-- The assigned calculator is stored ONCE, on calculators.locker_id.
-- ---------------------------------------------------------------------
create table public.lockers (
  id                     uuid primary key default gen_random_uuid(),
  device_id              uuid not null references public.device_registry (id) on delete restrict,
  locker_number          integer not null check (locker_number > 0),
  name                   text not null check (length(name) between 1 and 50),
  hardware_channel       smallint not null check (hardware_channel between 1 and 16),
  status                 public.locker_status not null default 'AVAILABLE',
  lock_state             public.lock_state not null default 'UNKNOWN',
  door_state             public.door_state not null default 'UNKNOWN',
  rfid_state             public.rfid_state not null default 'UNKNOWN',
  last_detected_rfid_uid text check (last_detected_rfid_uid ~ '^[0-9A-F]{2}(-[0-9A-F]{2}){3,9}$'),
  last_seen_at           timestamptz,
  device_health          public.device_health not null default 'UNKNOWN',
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint lockers_device_number_key  unique (device_id, locker_number),
  constraint lockers_device_channel_key unique (device_id, hardware_channel)
);

-- ---------------------------------------------------------------------
-- calculators · inventory. Each has a permanent RFID identity (Rule 5)
-- and normally lives in exactly one locker (Rule 6).
-- ---------------------------------------------------------------------
create table public.calculators (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^CALC-[0-9]{3,}$'),
  model      text not null check (length(model) between 1 and 100),
  rfid_uid   text not null unique check (rfid_uid ~ '^[0-9A-F]{2}(-[0-9A-F]{2}){3,9}$'),
  locker_id  uuid unique references public.lockers (id) on delete set null,
  status     public.calculator_status not null default 'AVAILABLE',
  condition  public.calculator_condition not null default 'GOOD',
  notes      text,
  created_at timestamptz not null default now(),   -- "date added"
  updated_at timestamptz not null default now(),
  constraint calculators_available_needs_locker check (status <> 'AVAILABLE' or locker_id is not null)
);

-- ---------------------------------------------------------------------
-- students · created automatically on first QR scan. No passwords.
-- Only data printed on the school ID is stored.
-- (Strict 10-digit format is validated in packages/shared; the DB check
--  is deliberately looser so a format change needs no migration.)
-- ---------------------------------------------------------------------
create table public.students (
  id                  uuid primary key default gen_random_uuid(),
  student_number      text not null unique check (student_number ~ '^[0-9A-Za-z-]{4,20}$'),
  full_name           text not null check (length(full_name) between 2 and 100),
  course_program      text not null check (length(course_program) between 2 and 20),
  year_level          smallint check (year_level between 1 and 6),
  qr_identifier       text check (qr_identifier ~ '^[0-9a-f]{64}$'),  -- SHA-256 of the last raw QR payload
  status              public.student_status not null default 'ACTIVE',
  blocked_reason      text,
  notes               text,
  last_transaction_at timestamptz,
  created_at          timestamptz not null default now(),   -- "date first seen"
  updated_at          timestamptz not null default now(),
  constraint students_blocked_needs_reason check (status <> 'BLOCKED' or blocked_reason is not null)
);

-- ---------------------------------------------------------------------
-- system_settings · business rules, editable from the dashboard.
-- Exactly ONE row (id = 1). Typed columns + CHECKs instead of a
-- key/value table, so invalid settings cannot be stored at all.
-- ---------------------------------------------------------------------
create table public.system_settings (
  id                                 smallint primary key default 1 check (id = 1),
  rental_fee                         numeric(10,2) not null check (rental_fee > 0 and rental_fee = trunc(rental_fee)),
  rental_duration_minutes            integer not null check (rental_duration_minutes between 15 and 1440),
  grace_period_minutes               integer not null check (grace_period_minutes between 0 and 240),
  penalty_enabled                    boolean not null,
  penalty_type                       public.penalty_type not null,
  penalty_amount                     numeric(10,2) not null check (penalty_amount >= 0),
  penalty_interval_minutes           integer not null check (penalty_interval_minutes between 1 and 1440),
  penalty_steps                      jsonb not null default '[]'::jsonb check (jsonb_typeof(penalty_steps) = 'array'),
  max_penalty                        numeric(10,2) check (max_penalty is null or max_penalty >= penalty_amount),
  -- Rule 1 is fixed at one; the column exists so the rule is visible in Settings.
  max_concurrent_rentals_per_student smallint not null default 1 check (max_concurrent_rentals_per_student = 1),
  unpaid_penalty_blocks_rental       boolean not null,
  accepted_coin_denominations        integer[] not null
                                     check (cardinality(accepted_coin_denominations) >= 1
                                            and accepted_coin_denominations <@ array[1, 5, 10, 20]),
  payment_timeout_seconds            integer not null default 120 check (payment_timeout_seconds between 30 and 600),
  removal_timeout_seconds            integer not null default 60  check (removal_timeout_seconds between 15 and 300),
  return_timeout_seconds             integer not null default 90  check (return_timeout_seconds between 15 and 300),
  allow_offline_returns              boolean not null default true,
  allow_offline_rentals              boolean not null default false,
  updated_by                         uuid references public.profiles (id) on delete restrict,
  updated_at                         timestamptz not null default now(),
  constraint system_settings_stepped_needs_steps
    check (penalty_type <> 'STEPPED' or jsonb_array_length(penalty_steps) > 0),
  constraint system_settings_offline_rentals_need_offline_returns
    check (not allow_offline_rentals or allow_offline_returns)
);

-- Initial values from the project specification. These are DEVELOPMENT
-- defaults — officers edit them from the dashboard Settings page.
insert into public.system_settings (
  id, rental_fee, rental_duration_minutes, grace_period_minutes,
  penalty_enabled, penalty_type, penalty_amount, penalty_interval_minutes,
  penalty_steps, max_penalty, unpaid_penalty_blocks_rental, accepted_coin_denominations
) values (
  1, 5.00, 120, 10,
  true, 'PER_INTERVAL', 5.00, 60,
  '[]'::jsonb, null, true, array[1, 5, 10, 20]
);

-- ---------------------------------------------------------------------
-- rental_transactions · ONE row per rental, never overwritten (Rule 12).
-- ---------------------------------------------------------------------
create sequence public.rental_transaction_code_seq;

create table public.rental_transactions (
  id                      uuid primary key default gen_random_uuid(),
  transaction_code        text not null unique default (
                            'RNT-' || to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD') || '-'
                            || lpad(nextval('public.rental_transaction_code_seq')::text, 5, '0')
                          ),
  student_id              uuid not null references public.students (id) on delete restrict,
  calculator_id           uuid not null references public.calculators (id) on delete restrict,
  locker_id               uuid not null references public.lockers (id) on delete restrict,
  device_id               uuid references public.device_registry (id) on delete restrict,
  status                  public.rental_status not null default 'PENDING',

  rental_fee              numeric(10,2) not null check (rental_fee >= 0),
  amount_paid             numeric(10,2) not null default 0 check (amount_paid >= 0),
  rental_duration_minutes integer not null check (rental_duration_minutes > 0),
  -- Penalty rules in force when this rental started; later Settings changes
  -- don't retroactively change what this student owes.
  settings_snapshot       jsonb not null default '{}'::jsonb check (jsonb_typeof(settings_snapshot) = 'object'),

  reserved_at             timestamptz not null default now(),
  payment_expires_at      timestamptz,
  paid_at                 timestamptz,
  rented_at               timestamptz,   -- set by the SERVER when removal is confirmed
  due_at                  timestamptz,   -- rented_at + duration
  return_started_at       timestamptz,
  returned_at             timestamptz,
  ended_at                timestamptz,   -- when CANCELLED / FAILED

  was_overdue             boolean not null default false,
  overdue_minutes         integer not null default 0 check (overdue_minutes >= 0),

  rental_rfid_verified    boolean not null default false,   -- removal confirmed by RFID
  return_rfid_verified    boolean not null default false,   -- expected tag detected on return
  return_rfid_uid         text check (return_rfid_uid ~ '^[0-9A-F]{2}(-[0-9A-F]{2}){3,9}$'),
  return_verified_offline boolean not null default false,

  failure_reason          text,
  resolved_by             uuid references public.profiles (id) on delete restrict,  -- manual admin resolution
  resolution_note         text,

  -- Idempotency: a retried "start rental" or a re-synced offline return can't create duplicates.
  start_idempotency_key   uuid unique,
  return_client_ref       uuid unique,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint rentals_due_after_rent
    check (due_at is null or (rented_at is not null and due_at > rented_at)),
  constraint rentals_return_after_rent
    check (returned_at is null or (rented_at is not null and returned_at >= rented_at)),
  -- Rule 4 / payment bypass: nothing past PAID without full payment.
  constraint rentals_paid_in_full
    check (status not in ('PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')
           or amount_paid >= rental_fee),
  -- Rule 7: not ACTIVE until physical removal is confirmed.
  constraint rentals_active_requires_removal
    check (status not in ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')
           or (rented_at is not null and due_at is not null
               and (rental_rfid_verified or resolved_by is not null))),
  -- Rule 8: not COMPLETED until the expected RFID is verified (or an admin resolved it).
  constraint rentals_completed_requires_return_verification
    check (status <> 'COMPLETED'
           or (returned_at is not null and (return_rfid_verified or resolved_by is not null))),
  constraint rentals_verified_return_has_uid
    check (not return_rfid_verified or return_rfid_uid is not null),
  constraint rentals_resolution_has_note
    check (resolved_by is null or resolution_note is not null)
);

-- Rules 1 & 2 + race conditions: at most ONE open rental per student,
-- per calculator and per locker. If two students race for the last
-- calculator, the second INSERT fails with a unique violation.
-- (Status list = OPEN_RENTAL_STATUSES in packages/shared/src/enums.ts)
create unique index rentals_one_open_per_student on public.rental_transactions (student_id)
  where status in ('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING');
create unique index rentals_one_open_per_calculator on public.rental_transactions (calculator_id)
  where status in ('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING');
create unique index rentals_one_open_per_locker on public.rental_transactions (locker_id)
  where status in ('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING');

create index rentals_status_due_idx       on public.rental_transactions (status, due_at);
create index rentals_student_created_idx  on public.rental_transactions (student_id, created_at desc);
create index rentals_calculator_created_idx on public.rental_transactions (calculator_id, created_at desc);
create index rentals_created_idx          on public.rental_transactions (created_at desc);

-- ---------------------------------------------------------------------
-- penalties · separate from the rental fee; never deleted.
-- amount_due is computed by the database so it can't drift.
-- ---------------------------------------------------------------------
create table public.penalties (
  id                    uuid primary key default gen_random_uuid(),
  rental_transaction_id uuid not null references public.rental_transactions (id) on delete restrict,
  student_id            uuid not null references public.students (id) on delete restrict,
  reason                public.penalty_reason not null default 'OVERDUE',
  overdue_minutes       integer not null default 0 check (overdue_minutes >= 0),
  calculated_amount     numeric(10,2) not null check (calculated_amount >= 0),
  waived_amount         numeric(10,2) not null default 0 check (waived_amount >= 0),
  amount_paid           numeric(10,2) not null default 0 check (amount_paid >= 0),
  amount_due            numeric(10,2) generated always as (calculated_amount - waived_amount - amount_paid) stored,
  status                public.penalty_status not null default 'UNPAID',
  calculated_at         timestamptz not null default now(),
  paid_at               timestamptz,
  waived_at             timestamptz,
  waived_by             uuid references public.profiles (id) on delete restrict,
  waive_reason          text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint penalties_not_overcleared check (waived_amount + amount_paid <= calculated_amount),
  constraint penalties_open_has_balance check (status not in ('UNPAID', 'PARTIAL') or calculated_amount - waived_amount - amount_paid > 0),
  constraint penalties_paid_is_settled  check (status <> 'PAID'   or (calculated_amount - waived_amount - amount_paid = 0 and paid_at is not null)),
  constraint penalties_waived_is_settled check (status <> 'WAIVED' or (calculated_amount - waived_amount - amount_paid = 0 and waived_by is not null)),
  constraint penalties_waiver_has_admin  check (waived_amount = 0 or (waived_by is not null and waive_reason is not null))
);
create unique index penalties_one_overdue_per_rental on public.penalties (rental_transaction_id) where reason = 'OVERDUE';
create index penalties_student_open_idx on public.penalties (student_id) where status in ('UNPAID', 'PARTIAL');
create index penalties_created_idx on public.penalties (created_at desc);

-- ---------------------------------------------------------------------
-- payments · money received for a rental or a penalty.
-- ---------------------------------------------------------------------
create table public.payments (
  id                    uuid primary key default gen_random_uuid(),
  rental_transaction_id uuid references public.rental_transactions (id) on delete restrict,
  penalty_id            uuid references public.penalties (id) on delete restrict,
  student_id            uuid not null references public.students (id) on delete restrict,
  device_id             uuid references public.device_registry (id) on delete restrict,
  payment_type          public.payment_type not null,
  method                public.payment_method not null default 'COIN',
  required_amount       numeric(10,2) not null check (required_amount >= 0),
  amount_received       numeric(10,2) not null default 0 check (amount_received >= 0),  -- may exceed required: coin selectors give no change
  status                public.payment_status not null default 'PENDING',
  session_id            uuid unique,   -- coin payment session issued to the kiosk
  recorded_by           uuid references public.profiles (id) on delete restrict,  -- admin who recorded a non-coin payment
  paid_at               timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint payments_rental_has_rental   check (payment_type <> 'RENTAL'  or rental_transaction_id is not null),
  constraint payments_penalty_has_penalty check (payment_type <> 'PENALTY' or penalty_id is not null),
  constraint payments_paid_in_full        check (status <> 'PAID' or (amount_received >= required_amount and paid_at is not null)),
  constraint payments_manual_has_admin    check (method = 'COIN' or recorded_by is not null)
);
-- Rule 3: a rental has at most ONE live rental payment.
create unique index payments_one_live_rental_payment on public.payments (rental_transaction_id)
  where payment_type = 'RENTAL' and status <> 'CANCELLED';
create index payments_penalty_idx on public.payments (penalty_id) where penalty_id is not null;
create index payments_student_idx on public.payments (student_id, created_at desc);
create index payments_created_idx on public.payments (created_at desc);

-- ---------------------------------------------------------------------
-- coin_events · every coin the selector reported (hardware troubleshooting).
-- id is generated ON THE PI, so a retried upload is a no-op.
-- payment_id NULL = coin inserted while no payment was expected.
-- ---------------------------------------------------------------------
create table public.coin_events (
  id             uuid primary key,
  device_id      uuid not null references public.device_registry (id) on delete restrict,
  payment_id     uuid references public.payments (id) on delete restrict,
  session_id     uuid,
  detected_value numeric(10,2) not null check (detected_value > 0),
  pulse_count    smallint not null check (pulse_count between 1 and 100),
  occurred_at    timestamptz not null,               -- Pi clock
  received_at    timestamptz not null default now()  -- server clock
);
create index coin_events_payment_idx on public.coin_events (payment_id);
create index coin_events_device_time_idx on public.coin_events (device_id, occurred_at desc);

-- ---------------------------------------------------------------------
-- device_events · hardware/kiosk event log for debugging.
-- ---------------------------------------------------------------------
create table public.device_events (
  id             uuid primary key default gen_random_uuid(),  -- normally generated on the Pi
  device_id      uuid not null references public.device_registry (id) on delete restrict,
  locker_id      uuid references public.lockers (id) on delete restrict,
  transaction_id uuid references public.rental_transactions (id) on delete restrict,
  event_type     public.device_event_type not null,
  severity       public.event_severity not null default 'INFO',
  message        text,
  payload        jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  occurred_at    timestamptz not null,               -- Pi clock
  synced_at      timestamptz not null default now()  -- server clock
);
create index device_events_device_time_idx on public.device_events (device_id, occurred_at desc);
create index device_events_type_time_idx   on public.device_events (event_type, occurred_at desc);
create index device_events_transaction_idx on public.device_events (transaction_id) where transaction_id is not null;
create index device_events_problems_idx    on public.device_events (occurred_at desc) where severity in ('ERROR', 'CRITICAL');

-- ---------------------------------------------------------------------
-- audit_logs · append-only record of important admin/system actions.
-- No foreign keys on purpose: entries must survive anything.
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id             bigint generated always as identity primary key,
  actor_type     public.actor_type not null,
  actor_id       uuid,          -- profiles.id or device_registry.id
  actor_label    text,          -- email / device code at the time of the action
  action         text not null check (action ~ '^[A-Z][A-Z0-9_]+$'),   -- e.g. SETTINGS_UPDATED
  target_type    text,
  target_id      text,
  previous_value jsonb,
  new_value      jsonb,
  reason         text,
  created_at     timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_target_idx  on public.audit_logs (target_type, target_id);
create index audit_logs_actor_idx   on public.audit_logs (actor_id);

-- ---------------------------------------------------------------------
-- api_idempotency_keys · remembers responses to device requests so a
-- retried request (network timeout, Pi reboot) returns the SAME result
-- instead of e.g. opening a second locker.
-- ---------------------------------------------------------------------
create table public.api_idempotency_keys (
  device_id       uuid not null references public.device_registry (id) on delete cascade,
  idempotency_key uuid not null,
  endpoint        text not null,
  request_hash    text not null,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (device_id, idempotency_key)
);
create index api_idempotency_keys_created_idx on public.api_idempotency_keys (created_at);
