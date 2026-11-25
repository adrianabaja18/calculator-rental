-- =====================================================================
-- 0011 · Operating hours (team decision 2026-11-27)
--
-- The kiosk lends only during operating hours (default Mon–Fri 9:00 AM –
-- 5:00 PM, Philippine time, minus closed dates). With
-- pause_clock_outside_hours, rental time and late time count ONLY inside
-- them: rented Tue 3:00 PM for 3 h → due Wed 10:00 AM.
-- Replaces "overdue time keeps counting overnight" (migration 0006).
-- The same rule runs on the kiosk (packages/shared operating-hours.ts).
-- =====================================================================

alter table public.system_settings
  add column operating_hours_start     time       not null default '09:00',
  add column operating_hours_end       time       not null default '17:00',
  add column operating_days            smallint[] not null default '{1,2,3,4,5}',  -- ISO weekdays, 1 = Monday
  add column closed_dates              date[]     not null default '{}',          -- holidays / suspensions
  add column pause_clock_outside_hours boolean    not null default true,
  add constraint system_settings_hours_order check (operating_hours_end > operating_hours_start),
  add constraint system_settings_operating_days check (
    cardinality(operating_days) between 1 and 7 and operating_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
  );

-- ---------------------------------------------------------------------
-- Minutes between two moments that fall inside operating hours (all of
-- them when the clock doesn't pause). Mirrors operatingMinutesBetween().
-- ---------------------------------------------------------------------
create or replace function public.operating_minutes_between(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  s       public.system_settings%rowtype;
  v_day   date;
  v_open  timestamptz;
  v_close timestamptz;
  v_total double precision := 0;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return 0;
  end if;
  select * into s from public.system_settings where id = 1;
  if not found or not s.pause_clock_outside_hours then
    return floor(extract(epoch from (p_to - p_from)) / 60)::integer;
  end if;

  for v_day in
    select generate_series((p_from at time zone 'Asia/Manila')::date, (p_to at time zone 'Asia/Manila')::date, interval '1 day')::date
  loop
    continue when not (extract(isodow from v_day)::smallint = any (s.operating_days)) or v_day = any (s.closed_dates);
    v_open  := (v_day + s.operating_hours_start) at time zone 'Asia/Manila';
    v_close := (v_day + s.operating_hours_end)   at time zone 'Asia/Manila';
    v_total := v_total + greatest(0, extract(epoch from (least(v_close, p_to) - greatest(v_open, p_from))));
  end loop;
  return floor(v_total / 60)::integer;
end;
$$;

grant execute on function public.operating_minutes_between(timestamptz, timestamptz) to authenticated, service_role;
revoke execute on function public.operating_minutes_between(timestamptz, timestamptz) from anon;

-- ---------------------------------------------------------------------
-- v_rentals: "minutes late" now counts operating minutes only.
-- (Same columns as migration 0005; only overdue_minutes_now changed.)
-- ---------------------------------------------------------------------
create or replace view public.v_rentals
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
      then public.operating_minutes_between(r.due_at, now())
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
