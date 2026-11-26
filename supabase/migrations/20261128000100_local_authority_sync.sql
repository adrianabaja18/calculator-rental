-- =====================================================================
-- 0012 · Local Raspberry Pi Authority → Cloud Read-Only Sync
--
-- When the Raspberry Pi 4 runs both the kiosk and the local admin
-- dashboard against local SQLite, officer changes (blocking students,
-- waiving penalties, editing calculators/lockers, updating settings,
-- and audit logs) originate on the Pi and sync one-way up to Supabase
-- so the online dashboard serves as a live read-only monitor.
-- =====================================================================

-- Allow penalty waivers originating on the local Pi (where the officer
-- account lives in local SQLite rather than Supabase auth.users/profiles).
alter table public.penalties
  drop constraint if exists penalties_waived_is_settled,
  drop constraint if exists penalties_waiver_has_admin,
  add constraint penalties_waived_is_settled
    check (status <> 'WAIVED' or (calculated_amount - waived_amount - amount_paid = 0 and waive_reason is not null)),
  add constraint penalties_waiver_has_admin
    check (waived_amount = 0 or waive_reason is not null);

-- Idempotent sync key for local Pi audit log entries pushed via outbox.
alter table public.audit_logs
  add column if not exists sync_id uuid unique;

-- Update sync_penalty so local Pi waivers also flow up to Supabase while
-- still preserving any cloud waiver if present.
create or replace function public.sync_penalty(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id          uuid := (p ->> 'id')::uuid;
  v             public.penalties%rowtype;
  v_found       boolean;
  v_calc        numeric(10,2);
  v_waived      numeric(10,2);
  v_paid        numeric(10,2);
  v_due         numeric(10,2);
  v_status      public.penalty_status;
  v_paid_at     timestamptz;
  v_waived_at   timestamptz;
  v_reason      text;
begin
  select * into v from public.penalties where id = v_id for update;
  v_found := found;

  v_calc   := greatest(coalesce(v.calculated_amount, 0), public.sync_pesos(p, 'calculated_centavos'));
  v_waived := least(v_calc, greatest(coalesce(v.waived_amount, 0), public.sync_pesos(p, 'waived_centavos')));
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
  v_waived_at := case when v_waived > 0
                      then coalesce(v.waived_at, (p ->> 'waived_at')::timestamptz, (p ->> 'updated_at')::timestamptz, now())
                      else v.waived_at end;
  v_reason := case when v_waived > 0
                   then coalesce(v.waive_reason, nullif(p ->> 'waive_reason', ''), 'Waived on local kiosk dashboard')
                   else v.waive_reason end;

  if not v_found then
    insert into public.penalties (
      id, rental_transaction_id, student_id, reason, overdue_minutes,
      calculated_amount, waived_amount, amount_paid, status,
      calculated_at, paid_at, waived_at, waive_reason
    ) values (
      v_id, (p ->> 'rental_id')::uuid, (p ->> 'student_id')::uuid,
      coalesce((p ->> 'reason')::public.penalty_reason, 'OVERDUE'),
      coalesce((p ->> 'overdue_minutes')::integer, 0),
      v_calc, v_waived, v_paid, v_status,
      coalesce((p ->> 'calculated_at')::timestamptz, (p ->> 'updated_at')::timestamptz, now()),
      v_paid_at, v_waived_at, v_reason
    );
  else
    update public.penalties set
      overdue_minutes   = greatest(v.overdue_minutes, coalesce((p ->> 'overdue_minutes')::integer, 0)),
      calculated_amount = v_calc,
      waived_amount     = v_waived,
      amount_paid       = v_paid,
      status            = v_status,
      paid_at           = v_paid_at,
      waived_at         = v_waived_at,
      waive_reason      = v_reason
    where id = v_id;
  end if;
end;
$$;

-- Local Pi officer block/unblock on a student.
create or replace function public.sync_student_admin(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_status public.student_status := coalesce((p ->> 'status')::public.student_status, 'ACTIVE');
  v_reason text := nullif(p ->> 'blocked_reason', '');
begin
  if v_status = 'BLOCKED' and v_reason is null then
    v_reason := 'Blocked on local kiosk dashboard';
  end if;

  insert into public.students (
    id, student_number, full_name, course_program, status, blocked_reason,
    qr_identifier, last_transaction_at, created_at
  ) values (
    (p ->> 'id')::uuid, p ->> 'student_number', p ->> 'full_name', p ->> 'course_program',
    v_status, v_reason,
    p ->> 'qr_identifier', (p ->> 'last_transaction_at')::timestamptz,
    coalesce((p ->> 'created_at')::timestamptz, now())
  )
  on conflict (id) do update set
    full_name           = excluded.full_name,
    course_program      = excluded.course_program,
    status              = excluded.status,
    blocked_reason      = excluded.blocked_reason,
    last_transaction_at = greatest(public.students.last_transaction_at, excluded.last_transaction_at);
end;
$$;

-- Local Pi officer locker setup / maintenance updates.
create or replace function public.sync_locker(p_device_id uuid, p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.lockers (
    id, device_id, locker_number, name, hardware_channel, status, notes,
    lock_state, door_state, rfid_state, last_detected_rfid_uid, last_seen_at
  ) values (
    (p ->> 'id')::uuid,
    p_device_id,
    (p ->> 'locker_number')::integer,
    p ->> 'name',
    (p ->> 'hardware_channel')::smallint,
    coalesce((p ->> 'status')::public.locker_status, 'AVAILABLE'),
    p ->> 'notes',
    coalesce((p ->> 'lock_state')::public.lock_state, 'UNKNOWN'),
    coalesce((p ->> 'door_state')::public.door_state, 'UNKNOWN'),
    coalesce((p ->> 'rfid_state')::public.rfid_state, 'UNKNOWN'),
    p ->> 'last_detected_rfid_uid',
    (p ->> 'last_seen_at')::timestamptz
  )
  on conflict (id) do update set
    name                   = excluded.name,
    notes                  = excluded.notes,
    status                 = excluded.status,
    lock_state             = coalesce((p ->> 'lock_state')::public.lock_state, public.lockers.lock_state),
    door_state             = coalesce((p ->> 'door_state')::public.door_state, public.lockers.door_state),
    rfid_state             = coalesce((p ->> 'rfid_state')::public.rfid_state, public.lockers.rfid_state),
    last_detected_rfid_uid = coalesce(excluded.last_detected_rfid_uid, public.lockers.last_detected_rfid_uid),
    last_seen_at           = coalesce(excluded.last_seen_at, public.lockers.last_seen_at)
  where public.lockers.device_id = p_device_id;
end;
$$;

-- Local Pi officer calculator create/edit/maintenance updates.
create or replace function public.sync_calculator(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_id        uuid := (p ->> 'id')::uuid;
  v_locker_id uuid := (p ->> 'locker_id')::uuid;
  v_status    public.calculator_status := coalesce((p ->> 'status')::public.calculator_status, 'MAINTENANCE');
begin
  if v_locker_id is not null and not exists (select 1 from public.lockers where id = v_locker_id) then
    v_locker_id := null;
  end if;
  if v_status = 'AVAILABLE' and v_locker_id is null then
    v_status := 'MAINTENANCE';
  end if;

  -- Free locker_id if another calculator currently holds this locker in cloud copy.
  if v_locker_id is not null then
    update public.calculators set status = 'MAINTENANCE', locker_id = null
    where locker_id = v_locker_id and id <> v_id;
  end if;

  insert into public.calculators (
    id, code, model, rfid_uid, locker_id, status, condition, notes
  ) values (
    v_id,
    p ->> 'code',
    p ->> 'model',
    p ->> 'rfid_uid',
    v_locker_id,
    v_status,
    coalesce((p ->> 'condition')::public.calculator_condition, 'GOOD'),
    p ->> 'notes'
  )
  on conflict (id) do update set
    code      = excluded.code,
    model     = excluded.model,
    rfid_uid  = excluded.rfid_uid,
    locker_id = excluded.locker_id,
    status    = excluded.status,
    condition = excluded.condition,
    notes     = excluded.notes;
end;
$$;

-- Local Pi Super Admin settings updates.
create or replace function public.sync_settings(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.system_settings set
    rental_fee                   = coalesce((p ->> 'rentalFee')::numeric(10,2), rental_fee),
    rental_duration_minutes      = coalesce((p ->> 'rentalDurationMinutes')::integer, rental_duration_minutes),
    grace_period_minutes         = coalesce((p ->> 'gracePeriodMinutes')::integer, grace_period_minutes),
    penalty_enabled              = coalesce((p ->> 'penaltyEnabled')::boolean, penalty_enabled),
    penalty_type                 = coalesce((p ->> 'penaltyType')::public.penalty_type, penalty_type),
    penalty_amount               = coalesce((p ->> 'penaltyAmount')::numeric(10,2), penalty_amount),
    penalty_interval_minutes     = coalesce((p ->> 'penaltyIntervalMinutes')::integer, penalty_interval_minutes),
    penalty_steps                = coalesce(p -> 'penaltySteps', penalty_steps),
    max_penalty                  = case when p ? 'maxPenalty' then (p ->> 'maxPenalty')::numeric(10,2) else max_penalty end,
    unpaid_penalty_blocks_rental = coalesce((p ->> 'unpaidPenaltyBlocksRental')::boolean, unpaid_penalty_blocks_rental),
    accepted_coin_denominations  = case
      when jsonb_typeof(p -> 'acceptedCoinDenominations') = 'array'
        then array(select jsonb_array_elements_text(p -> 'acceptedCoinDenominations')::integer)
      else accepted_coin_denominations
    end,
    payment_timeout_seconds      = coalesce((p ->> 'paymentTimeoutSeconds')::integer, payment_timeout_seconds),
    removal_timeout_seconds      = coalesce((p ->> 'removalTimeoutSeconds')::integer, removal_timeout_seconds),
    return_timeout_seconds       = coalesce((p ->> 'returnTimeoutSeconds')::integer, return_timeout_seconds),
    allow_offline_returns        = coalesce((p ->> 'allowOfflineReturns')::boolean, allow_offline_returns),
    allow_offline_rentals        = coalesce((p ->> 'allowOfflineRentals')::boolean, allow_offline_rentals),
    operating_hours_start        = coalesce((p ->> 'operatingHoursStart')::time, operating_hours_start),
    operating_hours_end          = coalesce((p ->> 'operatingHoursEnd')::time, operating_hours_end),
    operating_days               = case
      when jsonb_typeof(p -> 'operatingDays') = 'array'
        then array(select jsonb_array_elements_text(p -> 'operatingDays')::smallint)
      else operating_days
    end,
    closed_dates                 = case
      when jsonb_typeof(p -> 'closedDates') = 'array'
        then array(select jsonb_array_elements_text(p -> 'closedDates')::date)
      else closed_dates
    end,
    pause_clock_outside_hours    = coalesce((p ->> 'pauseClockOutsideHours')::boolean, pause_clock_outside_hours)
  where id = 1;
end;
$$;

-- Local Pi audit logs synced to cloud audit_logs.
create or replace function public.sync_audit_log(p jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_actor_id uuid := null;
begin
  if (p ->> 'actor_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_actor_id := (p ->> 'actor_id')::uuid;
  end if;

  insert into public.audit_logs (
    sync_id, actor_type, actor_id, actor_label, action,
    target_type, target_id, previous_value, new_value, reason, created_at
  ) values (
    (p ->> 'id')::uuid,
    coalesce((p ->> 'actor_type')::public.actor_type, 'ADMIN'),
    v_actor_id,
    p ->> 'actor_label',
    p ->> 'action',
    p ->> 'target_type',
    p ->> 'target_id',
    p -> 'previous_value',
    p -> 'new_value',
    p ->> 'reason',
    coalesce((p ->> 'created_at')::timestamptz, now())
  )
  on conflict (sync_id) do nothing;
end;
$$;

-- Extend apply_kiosk_sync with the new local-authority entities.
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
        when 'student_admin'    then perform public.sync_student_admin(v_payload);
        when 'rental'           then perform public.sync_rental(p_device_id, v_payload);
        when 'payment'          then perform public.sync_payment(p_device_id, v_payload);
        when 'penalty'          then perform public.sync_penalty(v_payload);
        when 'coin_event'       then perform public.sync_coin_event(p_device_id, v_payload);
        when 'device_event'     then perform public.sync_device_event(p_device_id, v_payload);
        when 'locker_state'     then perform public.sync_locker_state(p_device_id, v_payload);
        when 'locker'           then perform public.sync_locker(p_device_id, v_payload);
        when 'calculator_state' then perform public.sync_calculator_state(v_payload);
        when 'calculator'       then perform public.sync_calculator(v_payload);
        when 'settings'         then perform public.sync_settings(v_payload);
        when 'audit_log'        then perform public.sync_audit_log(v_payload);
        else raise exception 'unknown entity "%"', v_entity;
      end case;
    exception when others then
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

revoke execute on function
  public.sync_student_admin(jsonb),
  public.sync_locker(uuid, jsonb),
  public.sync_calculator(jsonb),
  public.sync_settings(jsonb),
  public.sync_audit_log(jsonb),
  public.sync_penalty(jsonb),
  public.apply_kiosk_sync(uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  public.sync_student_admin(jsonb),
  public.sync_locker(uuid, jsonb),
  public.sync_calculator(jsonb),
  public.sync_settings(jsonb),
  public.sync_audit_log(jsonb),
  public.sync_penalty(jsonb),
  public.apply_kiosk_sync(uuid, jsonb)
to service_role;
