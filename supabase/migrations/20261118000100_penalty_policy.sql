-- =====================================================================
-- 0007 · Overdue penalty policy decided by the team on 2026-11-18:
--   ₱10 for every STARTED 1.5 hours late (half of the ₱20 / 3 h rental),
--   10-minute grace period, penalty paid before the return locker opens.
--   1 h late → ₱10 · 2 h → ₱20 · 3 h → ₱20 · 4 h → ₱30
-- Officers can change it later on the dashboard Settings page.
-- =====================================================================
update public.system_settings
set penalty_enabled          = true,
    penalty_type             = 'PER_INTERVAL',
    penalty_amount           = 10.00,
    penalty_interval_minutes = 90,
    grace_period_minutes     = 10
where id = 1;
