-- =====================================================================
-- 0009 · Phase 12: kiosk → Supabase sync (outbox push)
--
-- The kiosk's SQLite database is the main operating database
-- (SQLite-first). Every local change is queued in its outbox and pushed
-- here IN ORDER through POST /api/device/sync, which calls
-- apply_kiosk_sync() with the service-role key.
--
-- Ownership rules (who wins when both sides changed something):
--   KIOSK owns   rentals, payments, coin events, device events,
--                student name/course (from the QR), penalty amounts and
--                coin payments, and the WORKFLOW statuses of lockers and
--                calculators (RESERVED, OPEN, RENTED, RETURNING ...).
--   OFFICERS own settings, locker/calculator details (number, name,
--                channel, code, RFID UID, assignment, condition), the
--                out-of-service statuses (locker MAINTENANCE; calculator
--                MAINTENANCE / MISSING / DISABLED), student status /
--                blocked reason, penalty waivers, and rentals they resolved.
--
-- Every item is applied in its own sub-transaction: a bad item is
-- reported back (the kiosk retries it with back-off) and nothing after it
-- is applied, so the order of events is never broken.
-- =====================================================================

alter table public.device_registry
  add column last_sync_at    timestamptz,   -- last successful push
  add column last_pull_at    timestamptz,   -- last successful pull of officer data
  add column last_sync_error text;          -- null when the last push succeeded

-- ---------------------------------------------------------------------
-- Helpers: SQLite stores money as INTEGER centavos and booleans as 0/1.
-- ---------------------------------------------------------------------
create or replace function public.sync_pesos(p jsonb, key text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(coalesce((p ->> key)::numeric, 0) / 100, 2)
$$;

create or replace function public.sync_flag(p jsonb, key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((p ->> key)::integer, 0) = 1
$$;

-- ---------------------------------------------------------------------
-- One function per outbox entity.
-- ---------------------------------------------------------------------
create or replace function public.sync_student(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.students (
    id, student_number, full_name, course_program, status, blocked_reason,
    qr_identifier, last_transaction_at, created_at
  ) values (
    (p ->> 'id')::uuid, p ->> 'student_number', p ->> 'full_name', p ->> 'course_program',
    coalesce((p ->> 'status')::public.student_status, 'ACTIVE'), p ->> 'blocked_reason',
    p ->> 'qr_identifier', (p ->> 'last_transaction_at')::timestamptz,
    coalesce((p ->> 'created_at')::timestamptz, now())
  )
  on conflict (id) do update set
    -- name/course come from the student's latest ID scan; status stays with officers
    full_name           = excluded.full_name,
    course_program      = excluded.course_program,
    qr_identifier       = coalesce(excluded.qr_identifier, public.students.qr_identifier),
    last_transaction_at = greatest(public.students.last_transaction_at, excluded.last_transaction_at);
end;
$$;

create or replace function public.sync_rental(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_resolved uuid;
begin
  select r.resolved_by into v_resolved
  from public.rental_transactions r
  where r.id = (p ->> 'id')::uuid
  for update;
  -- An officer resolved this rental by hand: the kiosk's copy is out of date.
  if v_resolved is not null then
    return;
  end if;

  insert into public.rental_transactions (
    id, transaction_code, student_id, calculator_id, locker_id, device_id, status,
    rental_fee, amount_paid, rental_duration_minutes, settings_snapshot,
    reserved_at, payment_expires_at, paid_at, rented_at, due_at,
    return_started_at, returned_at, ended_at,
    was_overdue, overdue_minutes, rental_rfid_verified, return_rfid_verified, return_rfid_uid,
    failure_reason, created_at
  ) values (
    (p ->> 'id')::uuid, p ->> 'transaction_code', (p ->> 'student_id')::uuid,
    (p ->> 'calculator_id')::uuid, (p ->> 'locker_id')::uuid, p_device_id,
    (p ->> 'status')::public.rental_status,
    public.sync_pesos(p, 'rental_fee_centavos'), public.sync_pesos(p, 'amount_paid_centavos'),
    (p ->> 'rental_duration_minutes')::integer,
    coalesce((p ->> 'settings_snapshot')::jsonb, '{}'::jsonb),
    (p ->> 'reserved_at')::timestamptz, (p ->> 'payment_expires_at')::timestamptz,
    (p ->> 'paid_at')::timestamptz, (p ->> 'rented_at')::timestamptz, (p ->> 'due_at')::timestamptz,
    (p ->> 'return_started_at')::timestamptz, (p ->> 'returned_at')::timestamptz, (p ->> 'ended_at')::timestamptz,
    public.sync_flag(p, 'was_overdue'), coalesce((p ->> 'overdue_minutes')::integer, 0),
    public.sync_flag(p, 'rental_rfid_verified'), public.sync_flag(p, 'return_rfid_verified'),
    p ->> 'return_rfid_uid', p ->> 'failure_reason',
    coalesce((p ->> 'created_at')::timestamptz, now())
  )
  on conflict (id) do update set
    status               = excluded.status,
    amount_paid          = excluded.amount_paid,
    payment_expires_at   = excluded.payment_expires_at,
    paid_at              = excluded.paid_at,
    rented_at            = excluded.rented_at,
    due_at               = excluded.due_at,
    return_started_at    = excluded.return_started_at,
    returned_at          = excluded.returned_at,
    ended_at             = excluded.ended_at,
    was_overdue          = excluded.was_overdue,
    overdue_minutes      = excluded.overdue_minutes,
    rental_rfid_verified = excluded.rental_rfid_verified,
    return_rfid_verified = excluded.return_rfid_verified,
    return_rfid_uid      = excluded.return_rfid_uid,
    failure_reason       = excluded.failure_reason;
end;
$$;

create or replace function public.sync_payment(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.payments (
    id, rental_transaction_id, penalty_id, student_id, device_id, payment_type, method,
    required_amount, amount_received, status, session_id, paid_at, notes, created_at
  ) values (
    (p ->> 'id')::uuid, (p ->> 'rental_id')::uuid, (p ->> 'penalty_id')::uuid, (p ->> 'student_id')::uuid,
    p_device_id, (p ->> 'payment_type')::public.payment_type, (p ->> 'method')::public.payment_method,
    public.sync_pesos(p, 'required_centavos'), public.sync_pesos(p, 'received_centavos'),
    (p ->> 'status')::public.payment_status, (p ->> 'session_id')::uuid,
    (p ->> 'paid_at')::timestamptz, p ->> 'notes', coalesce((p ->> 'created_at')::timestamptz, now())
  )
  on conflict (id) do update set
    required_amount = excluded.required_amount,
    amount_received = excluded.amount_received,
    status          = excluded.status,
    paid_at         = excluded.paid_at,
    notes           = excluded.notes;
end;
$$;

-- Penalty amounts and coin payments come from the kiosk; waivers come from
-- officers. The two are merged so neither overwrites the other.
create or replace function public.sync_penalty(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id     uuid := (p ->> 'id')::uuid;
  v        public.penalties%rowtype;
  v_found  boolean;
  v_calc   numeric(10,2);
  v_waived numeric(10,2);
  v_paid   numeric(10,2);
  v_due    numeric(10,2);
  v_status public.penalty_status;
  v_paid_at timestamptz;
begin
  select * into v from public.penalties where id = v_id for update;
  v_found := found;

  v_calc   := greatest(coalesce(v.calculated_amount, 0), public.sync_pesos(p, 'calculated_centavos'));
  v_waived := coalesce(v.waived_amount, 0);
  v_paid   := greatest(0, least(greatest(coalesce(v.amount_paid, 0), public.sync_pesos(p, 'amount_paid_centavos')), v_calc - v_waived));
  v_due    := v_calc - v_waived - v_paid;
  v_status := case
    when v_due > 0 then case when v_paid > 0 or v_waived > 0 then 'PARTIAL' else 'UNPAID' end
    when v_waived > 0 then 'WAIVED'
    else 'PAID'
  end::public.penalty_status;
  v_paid_at := case when v_status = 'PAID'
                    then coalesce(v.paid_at, (p ->> 'paid_at')::timestamptz, (p ->> 'updated_at')::timestamptz, now())
                    else v.paid_at end;

  if not v_found then
    insert into public.penalties (
      id, rental_transaction_id, student_id, reason, overdue_minutes,
      calculated_amount, amount_paid, status, calculated_at, paid_at
    ) values (
      v_id, (p ->> 'rental_id')::uuid, (p ->> 'student_id')::uuid,
      coalesce((p ->> 'reason')::public.penalty_reason, 'OVERDUE'),
      coalesce((p ->> 'overdue_minutes')::integer, 0),
      v_calc, v_paid, v_status, coalesce((p ->> 'updated_at')::timestamptz, now()), v_paid_at
    );
  else
    update public.penalties set
      overdue_minutes   = greatest(v.overdue_minutes, coalesce((p ->> 'overdue_minutes')::integer, 0)),
      calculated_amount = v_calc,
      amount_paid       = v_paid,
      status            = v_status,
      paid_at           = v_paid_at
    where id = v_id;
  end if;
end;
$$;

create or replace function public.sync_coin_event(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.coin_events (id, device_id, payment_id, session_id, detected_value, pulse_count, occurred_at)
  values (
    (p ->> 'id')::uuid, p_device_id, (p ->> 'payment_id')::uuid, (p ->> 'session_id')::uuid,
    public.sync_pesos(p, 'value_centavos'), (p ->> 'pulse_count')::smallint, (p ->> 'occurred_at')::timestamptz
  )
  on conflict (id) do nothing;   -- coins are facts: a retried upload is a no-op
end;
$$;

create or replace function public.sync_device_event(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.device_events (id, device_id, locker_id, transaction_id, event_type, severity, message, payload, occurred_at)
  values (
    (p ->> 'id')::uuid, p_device_id, (p ->> 'locker_id')::uuid, (p ->> 'transaction_id')::uuid,
    (p ->> 'event_type')::public.device_event_type, (p ->> 'severity')::public.event_severity,
    p ->> 'message',
    case when jsonb_typeof(p -> 'payload') = 'object' then p -> 'payload' else '{}'::jsonb end,
    (p ->> 'occurred_at')::timestamptz
  )
  on conflict (id) do nothing;
end;
$$;

create or replace function public.sync_locker_state(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.lockers l set
    -- The kiosk's "AVAILABLE" never ends an officer's maintenance; any
    -- workflow status (the locker is actually in use) is always recorded.
    status = case
      when l.status = 'MAINTENANCE' and (p ->> 'status') = 'AVAILABLE' then l.status
      else (p ->> 'status')::public.locker_status
    end,
    lock_state             = coalesce((p ->> 'lock_state')::public.lock_state, l.lock_state),
    door_state             = coalesce((p ->> 'door_state')::public.door_state, l.door_state),
    rfid_state             = coalesce((p ->> 'rfid_state')::public.rfid_state, l.rfid_state),
    last_detected_rfid_uid = p ->> 'last_detected_rfid_uid',
    last_seen_at           = coalesce((p ->> 'last_seen_at')::timestamptz, l.last_seen_at)
  where l.id = (p ->> 'id')::uuid and l.device_id = p_device_id;
  if not found then
    raise exception 'locker % does not belong to this device', p ->> 'id';
  end if;
end;
$$;

create or replace function public.sync_calculator_state(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.calculators c set
    status = case
      when c.status in ('MAINTENANCE', 'MISSING', 'DISABLED') and (p ->> 'status') = 'AVAILABLE' then c.status
      else (p ->> 'status')::public.calculator_status
    end
  where c.id = (p ->> 'id')::uuid;
  if not found then
    raise exception 'calculator % not found', p ->> 'id';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- apply_kiosk_sync · applies a batch of outbox items IN ORDER.
-- items: [{ "seq": 12, "entity": "rental", "payload": {...} }, ...]
-- returns { appliedThroughSeq, applied, failure: null | { seq, entity, message } }
-- ---------------------------------------------------------------------
create or replace function public.apply_kiosk_sync(p_device_id uuid, p_items jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item    jsonb;
  v_seq     bigint;
  v_entity  text;
  v_payload jsonb;
  v_last    bigint := null;
  v_count   integer := 0;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'items must be a JSON array';
  end if;
  if not exists (select 1 from public.device_registry d where d.id = p_device_id and d.is_enabled) then
    raise exception 'unknown or disabled device';
  end if;

  for v_item in
    select e.value from jsonb_array_elements(p_items) with ordinality as e(value, idx) order by e.idx
  loop
    v_seq     := (v_item ->> 'seq')::bigint;
    v_entity  := v_item ->> 'entity';
    v_payload := v_item -> 'payload';
    begin
      case v_entity
        when 'student'          then perform public.sync_student(v_payload);
        when 'rental'           then perform public.sync_rental(p_device_id, v_payload);
        when 'payment'          then perform public.sync_payment(p_device_id, v_payload);
        when 'penalty'          then perform public.sync_penalty(v_payload);
        when 'coin_event'       then perform public.sync_coin_event(p_device_id, v_payload);
        when 'device_event'     then perform public.sync_device_event(p_device_id, v_payload);
        when 'locker_state'     then perform public.sync_locker_state(p_device_id, v_payload);
        when 'calculator_state' then perform public.sync_calculator_state(v_payload);
        else raise exception 'unknown entity "%"', v_entity;
      end case;
    exception when others then
      -- This item is rolled back; everything before it stays applied.
      return jsonb_build_object(
        'appliedThroughSeq', v_last,
        'applied', v_count,
        'failure', jsonb_build_object('seq', v_seq, 'entity', v_entity, 'message', sqlerrm)
      );
    end;
    v_last  := v_seq;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('appliedThroughSeq', v_last, 'applied', v_count, 'failure', null);
end;
$$;

-- Server only: called by the API with the service-role key, never by browsers.
revoke execute on function
  public.sync_pesos(jsonb, text), public.sync_flag(jsonb, text),
  public.sync_student(jsonb), public.sync_rental(uuid, jsonb), public.sync_payment(uuid, jsonb),
  public.sync_penalty(jsonb), public.sync_coin_event(uuid, jsonb), public.sync_device_event(uuid, jsonb),
  public.sync_locker_state(uuid, jsonb), public.sync_calculator_state(jsonb),
  public.apply_kiosk_sync(uuid, jsonb)
from public, anon, authenticated;
grant execute on function
  public.sync_pesos(jsonb, text), public.sync_flag(jsonb, text),
  public.sync_student(jsonb), public.sync_rental(uuid, jsonb), public.sync_payment(uuid, jsonb),
  public.sync_penalty(jsonb), public.sync_coin_event(uuid, jsonb), public.sync_device_event(uuid, jsonb),
  public.sync_locker_state(uuid, jsonb), public.sync_calculator_state(jsonb),
  public.apply_kiosk_sync(uuid, jsonb)
to service_role;
