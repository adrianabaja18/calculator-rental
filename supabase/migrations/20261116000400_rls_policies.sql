-- =====================================================================
-- 0004 · Row Level Security
--
-- Access model:
--   anon (public key, not logged in) ... NOTHING. Students never touch Supabase.
--   authenticated + ACTIVE profile .... READ operational data (dashboard, Realtime)
--   authenticated, inactive/no profile  NOTHING
--   service_role (server only) ........ everything (bypasses RLS)
--
-- ALL writes go through Next.js API routes, which validate input with Zod,
-- check the admin's role / device credential, then write with the
-- service-role client and record an audit log. The browser cannot write
-- directly even if someone edits requests by hand (Rule 15).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Role helper functions (SECURITY DEFINER so they can read profiles
-- without recursive RLS checks). Extend here when new roles are added.
-- ---------------------------------------------------------------------
create or replace function public.current_admin_role()
returns public.admin_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid() and p.is_active
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.current_admin_role() is not null
$$;

create or replace function public.is_officer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_admin_role() in ('SUPER_ADMIN', 'OFFICER'), false)
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_admin_role() = 'SUPER_ADMIN', false)
$$;

revoke execute on function public.current_admin_role(), public.is_admin(), public.is_officer(), public.is_super_admin() from anon;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.device_registry      enable row level security;
alter table public.device_credentials   enable row level security;
alter table public.lockers              enable row level security;
alter table public.calculators          enable row level security;
alter table public.students             enable row level security;
alter table public.system_settings      enable row level security;
alter table public.rental_transactions  enable row level security;
alter table public.penalties            enable row level security;
alter table public.payments             enable row level security;
alter table public.coin_events          enable row level security;
alter table public.device_events        enable row level security;
alter table public.audit_logs           enable row level security;
alter table public.api_idempotency_keys enable row level security;

-- ---------------------------------------------------------------------
-- Defence in depth: table privileges
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;
-- Secrets and request caches: server only.
revoke all on public.device_credentials, public.api_idempotency_keys from authenticated;

-- Tables created by FUTURE migrations start locked down too.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;

-- ---------------------------------------------------------------------
-- Read policies (SELECT only). `(select fn())` lets Postgres evaluate the
-- check once per query instead of once per row.
-- ---------------------------------------------------------------------
create policy "profiles: read own row or any if admin"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

create policy "device_registry: admins read" on public.device_registry
  for select to authenticated using ((select public.is_admin()));

create policy "lockers: admins read" on public.lockers
  for select to authenticated using ((select public.is_admin()));

create policy "calculators: admins read" on public.calculators
  for select to authenticated using ((select public.is_admin()));

create policy "students: admins read" on public.students
  for select to authenticated using ((select public.is_admin()));

create policy "system_settings: admins read" on public.system_settings
  for select to authenticated using ((select public.is_admin()));

create policy "rental_transactions: admins read" on public.rental_transactions
  for select to authenticated using ((select public.is_admin()));

create policy "penalties: admins read" on public.penalties
  for select to authenticated using ((select public.is_admin()));

create policy "payments: admins read" on public.payments
  for select to authenticated using ((select public.is_admin()));

create policy "coin_events: admins read" on public.coin_events
  for select to authenticated using ((select public.is_admin()));

create policy "device_events: admins read" on public.device_events
  for select to authenticated using ((select public.is_admin()));

create policy "audit_logs: officers read" on public.audit_logs
  for select to authenticated using ((select public.is_officer()));

-- device_credentials and api_idempotency_keys: RLS on, NO policies => service role only.
