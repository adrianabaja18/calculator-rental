-- =====================================================================
-- 0006 · Phase 4: current pricing + read-only views for the admin pages
-- =====================================================================

-- ---------------------------------------------------------------------
-- Pricing decided by the team on 2026-11-17 (may change; officers will
-- edit it from the Settings page in Phase 7):
--   ₱20 rental for 3 hours, then ₱20 for every hour overdue.
--   Overdue time keeps counting while the kiosk is switched off overnight.
-- The 10-minute grace period from the original spec is kept.
-- ---------------------------------------------------------------------
update public.system_settings
set rental_fee               = 20.00,
    rental_duration_minutes  = 180,
    penalty_enabled          = true,
    penalty_type             = 'PER_INTERVAL',
    penalty_amount           = 20.00,
    penalty_interval_minutes = 60
where id = 1;

-- ---------------------------------------------------------------------
-- v_students · student + current rental + history counts + unpaid penalties
-- ---------------------------------------------------------------------
create view public.v_students
with (security_invoker = true)
as
select
  s.*,
  o.id               as open_rental_id,
  o.transaction_code as open_rental_code,
  o.status           as open_rental_status,
  o.due_at           as open_rental_due_at,
  c.code             as open_rental_calculator_code,
  coalesce(h.rental_count, 0)::integer  as rental_count,
  coalesce(h.overdue_count, 0)::integer as overdue_count,
  coalesce(p.unpaid_penalty_total, 0)::numeric(10,2) as unpaid_penalty_total,
  coalesce(p.unpaid_penalty_count, 0)::integer       as unpaid_penalty_count
from public.students s
left join lateral (
  select r.id, r.transaction_code, r.status, r.due_at, r.calculator_id
  from public.rental_transactions r
  where r.student_id = s.id
    and r.status in ('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING')
  limit 1
) o on true
left join public.calculators c on c.id = o.calculator_id
left join lateral (
  select
    count(*) filter (where r.status in ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')) as rental_count,
    count(*) filter (
      where r.was_overdue
         or (r.status in ('ACTIVE', 'OVERDUE', 'RETURNING') and r.due_at is not null and now() > r.due_at)
    ) as overdue_count
  from public.rental_transactions r
  where r.student_id = s.id
) h on true
left join lateral (
  select
    sum(pe.calculated_amount - pe.waived_amount - pe.amount_paid) as unpaid_penalty_total,
    count(*) as unpaid_penalty_count
  from public.penalties pe
  where pe.student_id = s.id and pe.status in ('UNPAID', 'PARTIAL')
) p on true;

-- ---------------------------------------------------------------------
-- v_calculators · calculator + its locker + current borrower + usage
-- ---------------------------------------------------------------------
create view public.v_calculators
with (security_invoker = true)
as
select
  c.*,
  l.locker_number,
  l.name   as locker_name,
  l.status as locker_status,
  o.id               as open_rental_id,
  o.transaction_code as open_rental_code,
  o.status           as open_rental_status,
  o.due_at           as open_rental_due_at,
  s.id               as borrower_id,
  s.full_name        as borrower_full_name,
  s.student_number   as borrower_student_number,
  u.last_transaction_at,
  coalesce(u.rental_count, 0)::integer as rental_count
from public.calculators c
left join public.lockers l on l.id = c.locker_id
left join lateral (
  select r.id, r.transaction_code, r.status, r.due_at, r.student_id
  from public.rental_transactions r
  where r.calculator_id = c.id
    and r.status in ('PENDING', 'PAYMENT_PENDING', 'PAID', 'DISPENSING', 'ACTIVE', 'OVERDUE', 'RETURNING')
  limit 1
) o on true
left join public.students s on s.id = o.student_id
left join lateral (
  select
    max(r.created_at) as last_transaction_at,
    count(*) filter (where r.status in ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')) as rental_count
  from public.rental_transactions r
  where r.calculator_id = c.id
) u on true;

grant select on public.v_students, public.v_calculators to authenticated;
revoke all on public.v_students, public.v_calculators from anon;
