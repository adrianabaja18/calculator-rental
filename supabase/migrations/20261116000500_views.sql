-- =====================================================================
-- 0005 · Read-only views for the API and dashboard
-- security_invoker = true  ->  the CALLER's RLS applies (a view must
-- never become a back door around Row Level Security).
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_rentals · rentals with LIVE overdue status.
-- A rental is overdue the moment now() > due_at, whether or not any
-- scheduled job has run yet and whether or not the dashboard is open.
-- ---------------------------------------------------------------------
create view public.v_rentals
with (security_invoker = true)
as
select
  r.*,
  case
    when r.status = 'ACTIVE' and r.due_at is not null and now() > r.due_at then 'OVERDUE'::public.rental_status
    else r.status
  end as effective_status,
  (r.status in ('ACTIVE', 'OVERDUE', 'RETURNING') and r.due_at is not null and now() > r.due_at) as is_overdue_now,
  case
    when r.status in ('ACTIVE', 'OVERDUE', 'RETURNING') and r.due_at is not null and now() > r.due_at
      then floor(extract(epoch from (now() - r.due_at)) / 60)::integer
    else 0
  end as overdue_minutes_now,
  s.student_number,
  s.full_name       as student_full_name,
  s.course_program  as student_course_program,
  c.code            as calculator_code,
  c.model           as calculator_model,
  l.locker_number,
  l.name            as locker_name,
  coalesce(p.penalty_due, 0)::numeric(10,2) as penalty_amount_due
from public.rental_transactions r
join public.students    s on s.id = r.student_id
join public.calculators c on c.id = r.calculator_id
join public.lockers     l on l.id = r.locker_id
left join lateral (
  select sum(pe.calculated_amount - pe.waived_amount - pe.amount_paid) as penalty_due
  from public.penalties pe
  where pe.rental_transaction_id = r.id
) p on true;

-- ---------------------------------------------------------------------
-- v_device_status · connectivity derived from the heartbeat.
-- Heartbeat every 30 s; OFFLINE after 90 s of silence (3 missed beats).
-- Keep in sync with DEVICE_OFFLINE_AFTER_SECONDS in packages/shared.
-- ---------------------------------------------------------------------
create view public.v_device_status
with (security_invoker = true)
as
select
  d.*,
  case
    when not d.is_enabled                              then 'DISABLED'
    when d.last_heartbeat_at is null                   then 'NEVER_SEEN'
    when d.last_heartbeat_at > now() - interval '90 seconds' then 'ONLINE'
    else 'OFFLINE'
  end as connection_status,
  case
    when d.last_heartbeat_at is null then null
    else floor(extract(epoch from (now() - d.last_heartbeat_at)))::integer
  end as seconds_since_heartbeat
from public.device_registry d;

-- ---------------------------------------------------------------------
-- v_lockers · locker + its assigned calculator + whether it may be
-- assigned to a new rental right now.
--
-- is_assignable requires the DATABASE state *and* the PHYSICAL state to
-- agree (spec §5.14): a locker whose reader doesn't see the expected tag
-- is never handed out, even if the database says AVAILABLE.
-- ---------------------------------------------------------------------
create view public.v_lockers
with (security_invoker = true)
as
select
  l.*,
  d.device_code,
  ds.connection_status as device_connection_status,
  c.id       as calculator_id,
  c.code     as calculator_code,
  c.model    as calculator_model,
  c.rfid_uid as expected_rfid_uid,
  c.status   as calculator_status,
  (
    l.status = 'AVAILABLE'
    and c.status = 'AVAILABLE'
    and l.rfid_state = 'EXPECTED_TAG'
    and l.last_detected_rfid_uid = c.rfid_uid
    and l.lock_state = 'LOCKED'
    and ds.connection_status = 'ONLINE'
  ) as is_assignable,
  (
    (l.status = 'AVAILABLE' or c.status = 'AVAILABLE')
    and l.rfid_state in ('NO_TAG', 'WRONG_TAG')
  ) as has_inventory_mismatch
from public.lockers l
join public.device_registry d  on d.id = l.device_id
join public.v_device_status ds on ds.id = l.device_id
left join public.calculators c on c.locker_id = l.id;

grant select on public.v_rentals, public.v_device_status, public.v_lockers to authenticated;
revoke all on public.v_rentals, public.v_device_status, public.v_lockers from anon;
