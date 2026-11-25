-- =====================================================================
-- 0010 · Phase 13: monitoring and remote officer actions
--
-- device_commands · officer → kiosk instructions (emergency unlock, sync
-- now). The kiosk picks them up on its next sync (every ~10 s) and reports
-- the result. A command nobody picked up expires after 2 minutes, so a
-- kiosk that comes back online hours later never acts on a stale unlock.
-- =====================================================================

create table public.device_commands (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references public.device_registry (id) on delete cascade,
  command        text not null check (command in ('UNLOCK_LOCKER', 'REFRESH')),
  payload        jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  reason         text,
  status         text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'DONE', 'FAILED', 'EXPIRED')),
  requested_by   uuid references public.profiles (id) on delete restrict,
  requested_at   timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '2 minutes',
  sent_at        timestamptz,
  completed_at   timestamptz,
  result_message text,
  constraint device_commands_unlock_has_reason check (command <> 'UNLOCK_LOCKER' or reason is not null)
);
create index device_commands_open_idx   on public.device_commands (device_id, requested_at) where status in ('PENDING', 'SENT');
create index device_commands_recent_idx on public.device_commands (requested_at desc);

alter table public.device_commands enable row level security;
revoke all on public.device_commands from anon;
revoke insert, update, delete, truncate on public.device_commands from authenticated;
create policy "device_commands: admins read" on public.device_commands
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------
-- v_devices · device + derived connection status, including the sync
-- columns added in Phase 12 (v_device_status was created before them).
-- ---------------------------------------------------------------------
create view public.v_devices
with (security_invoker = true)
as
select
  d.*,
  case
    when not d.is_enabled                                    then 'DISABLED'
    when d.last_heartbeat_at is null                         then 'NEVER_SEEN'
    when d.last_heartbeat_at > now() - interval '90 seconds' then 'ONLINE'
    else 'OFFLINE'
  end as connection_status,
  case
    when d.last_heartbeat_at is null then null
    else floor(extract(epoch from (now() - d.last_heartbeat_at)))::integer
  end as seconds_since_heartbeat
from public.device_registry d;

grant select on public.v_devices to authenticated;
revoke all on public.v_devices from anon;

-- Live updates on the Devices and Event Logs pages.
alter publication supabase_realtime add table public.device_commands, public.device_events;
