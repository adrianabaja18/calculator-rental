-- =====================================================================
-- 0003 · Functions & triggers
-- All functions pin search_path = '' and use schema-qualified names
-- (Supabase security best practice).
-- =====================================================================

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'device_registry', 'lockers', 'calculators', 'students',
    'system_settings', 'rental_transactions', 'penalties', 'payments'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Auto-create a profile for every new Supabase Auth user.
-- New users are INACTIVE VIEWERs: they can't see anything until a
-- SUPER_ADMIN activates them (public sign-up is also disabled).
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- History protection (Rules 12 & 13).
-- These rows can be corrected by status changes, but never deleted —
-- not even with the service-role key, because triggers still run.
-- ---------------------------------------------------------------------
create or replace function public.prevent_history_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Deleting rows from %.% is not allowed: historical records must be kept',
    tg_table_schema, tg_table_name
    using errcode = 'P0001', hint = 'Change the status (e.g. CANCELLED, WAIVED) instead of deleting.';
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['rental_transactions', 'payments', 'penalties', 'coin_events', 'audit_logs']
  loop
    execute format(
      'create trigger %I before delete on public.%I for each row execute function public.prevent_history_delete()',
      t || '_prevent_delete', t
    );
  end loop;
end;
$$;

-- Audit log entries are append-only: no UPDATE either.
create or replace function public.prevent_audit_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'P0001';
end;
$$;

create trigger audit_logs_prevent_update
  before update on public.audit_logs
  for each row execute function public.prevent_audit_update();
