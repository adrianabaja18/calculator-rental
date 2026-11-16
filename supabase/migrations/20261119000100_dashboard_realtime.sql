-- =====================================================================
-- 0008 · Phase 8: dashboard summary + Realtime
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_dashboard_summary · the 8 dashboard cards in one row.
-- "Today" = the current calendar day in the Philippines (Asia/Manila),
-- while all stored timestamps stay UTC.
-- Overdue is computed live from due_at (no scheduled job needed).
-- ---------------------------------------------------------------------
create view public.v_dashboard_summary
with (security_invoker = true)
as
with today as (
  select (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila') as start_utc
)
select
  (select count(*) from public.calculators where status <> 'DISABLED')::integer as total_calculators,
  (select count(*) from public.calculators where status = 'AVAILABLE')::integer  as available_calculators,
  (select count(*) from public.rental_transactions
     where status in ('ACTIVE', 'OVERDUE', 'RETURNING'))::integer                as rented_calculators,
  (select count(*) from public.rental_transactions
     where status in ('ACTIVE', 'OVERDUE', 'RETURNING') and due_at < now())::integer as overdue_rentals,
  (select count(*) from public.rental_transactions, today
     where rented_at >= today.start_utc)::integer                                as rentals_today,
  (select count(*) from public.rental_transactions, today
     where returned_at >= today.start_utc and status = 'COMPLETED')::integer     as returns_today,
  (select coalesce(sum(amount_received), 0) from public.payments, today
     where status = 'PAID' and paid_at >= today.start_utc)::numeric(10,2)        as income_today,
  (select coalesce(sum(calculated_amount - waived_amount - amount_paid), 0) from public.penalties
     where status in ('UNPAID', 'PARTIAL'))::numeric(10,2)                       as outstanding_penalties;

grant select on public.v_dashboard_summary to authenticated;
revoke all on public.v_dashboard_summary from anon;

-- ---------------------------------------------------------------------
-- Realtime: the dashboard is told when these tables change and refreshes
-- itself. Row Level Security still applies, so only active admins
-- receive changes.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.calculators,
  public.lockers,
  public.students,
  public.rental_transactions,
  public.payments,
  public.penalties,
  public.device_registry;
