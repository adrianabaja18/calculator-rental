import type { Metadata } from 'next';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { requireAdmin } from '@/lib/auth/session';
import { formatDateTime, formatRelative } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { EmergencyUnlockButton, SyncNowButton } from './device-actions';

export const metadata: Metadata = { title: 'Device Status' };

const LIVE_TABLES = ['device_registry', 'lockers', 'device_commands'] as const;

/** What the kiosk reports in last_health with every heartbeat. */
interface KioskHealth {
  kioskState?: string;
  clockDriftSeconds?: number;
  sync?: { lastPushAt: string | null; lastPullAt: string | null; lastError: string | null; failedItems: number } | null;
}

function Stat({ label, children, warn = false }: { label: string; children: React.ReactNode; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${warn ? 'text-red-700' : 'text-slate-900'}`}>{children}</dd>
    </div>
  );
}

export default async function DeviceStatusPage() {
  const admin = await requireAdmin(AdminRole.VIEWER);
  const canAct = hasRole(admin.role, AdminRole.OFFICER);
  const supabase = await createSupabaseServerClient();

  const [devices, lockers, commands] = await Promise.all([
    supabase.from('v_devices').select('*').order('device_code'),
    supabase.from('v_lockers').select('*').order('locker_number'),
    supabase.from('device_commands').select('*').order('requested_at', { ascending: false }).limit(15),
  ]);
  if (devices.error || lockers.error || commands.error) throw new Error('Failed to load device status');

  return (
    <>
      <PageHeader
        title="Device Status"
        description="Kiosk health from its heartbeat (every 30 s) and sync. Sensor states are what the kiosk reported last."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />

      {devices.data.length === 0 && <p className="text-sm text-slate-600">No kiosk is registered yet.</p>}

      {devices.data.map((d) => {
        const health = (d.last_health ?? {}) as KioskHealth;
        const online = d.connection_status === 'ONLINE';
        const syncError = d.last_sync_error ?? health.sync?.lastError ?? null;
        const failedItems = health.sync?.failedItems ?? 0;
        const temp = d.cpu_temp_c === null ? null : Number(d.cpu_temp_c);
        const drift = health.clockDriftSeconds ?? null;
        const deviceLockers = lockers.data.filter((l) => l.device_id === d.id);

        return (
          <section key={d.id} className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{d.name}</h2>
                <StatusBadge tone={toneFor(d.connection_status)}>{humanize(d.connection_status)}</StatusBadge>
                <StatusBadge tone={toneFor(d.health)}>{humanize(d.health)}</StatusBadge>
              </div>
              {canAct && d.id && <SyncNowButton deviceId={d.id} />}
            </div>

            <dl className="mb-4 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Last heartbeat">{formatRelative(d.last_heartbeat_at)}</Stat>
              <Stat label="Kiosk state">{humanize(health.kioskState)}</Stat>
              <Stat label="Power">{health.kioskState === 'SLEEPING' ? 'Asleep (saving power)' : 'Awake'}</Stat>
              <Stat label="CPU temperature" warn={temp !== null && temp >= 75}>
                {temp === null ? '—' : `${temp.toFixed(1)} °C`}
              </Stat>
              <Stat label="Clock difference" warn={drift !== null && Math.abs(drift) > 120}>
                {drift === null ? '—' : `${drift > 0 ? '+' : ''}${drift} s`}
              </Stat>
              <Stat label="Software">{d.software_version ?? '—'}</Stat>
              <Stat label="Waiting to sync" warn={(d.sync_queue_count ?? 0) > 100}>
                {d.sync_queue_count ?? 0} change{d.sync_queue_count === 1 ? '' : 's'}
              </Stat>
              <Stat label="Last upload">{formatRelative(d.last_sync_at)}</Stat>
              <Stat label="Last download">{formatRelative(d.last_pull_at)}</Stat>
              <Stat label="Set aside (need an officer)" warn={failedItems > 0}>
                {failedItems}
              </Stat>
              <div className="col-span-2">
                <Stat label="Sync problem" warn={!!syncError}>
                  {syncError ?? 'None'}
                </Stat>
              </div>
            </dl>

            <TableCard footer={`${d.device_code}${d.location ? ` · ${d.location}` : ''}`}>
              <thead>
                <tr>
                  <Th>Locker</Th>
                  <Th>Status</Th>
                  <Th>Expected calculator</Th>
                  <Th>RFID reader sees</Th>
                  <Th>Lock</Th>
                  <Th>Door</Th>
                  <Th>Last reading</Th>
                  {canAct && <Th className="text-right">Actions</Th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deviceLockers.length === 0 && <EmptyRow colSpan={canAct ? 8 : 7} title="No lockers for this kiosk" />}
                {deviceLockers.map((l) => (
                  <tr key={l.id} className={l.has_inventory_mismatch ? 'bg-red-50/50' : 'hover:bg-slate-50'}>
                    <Td>
                      <div className="font-medium text-slate-900">{l.name}</div>
                      <Sub>Channel {l.hardware_channel}</Sub>
                    </Td>
                    <Td>
                      <StatusBadge tone={toneFor(l.status)}>{humanize(l.status)}</StatusBadge>
                    </Td>
                    <Td>
                      {l.calculator_code ?? <span className="text-slate-400">None</span>}
                      {l.expected_rfid_uid && <Sub>{l.expected_rfid_uid}</Sub>}
                    </Td>
                    <Td>
                      <StatusBadge tone={toneFor(l.rfid_state)}>{humanize(l.rfid_state)}</StatusBadge>
                      {l.last_detected_rfid_uid && <Sub>{l.last_detected_rfid_uid}</Sub>}
                    </Td>
                    <Td>
                      <StatusBadge tone={toneFor(l.lock_state)}>{humanize(l.lock_state)}</StatusBadge>
                    </Td>
                    <Td>
                      <StatusBadge tone={toneFor(l.door_state)}>{humanize(l.door_state)}</StatusBadge>
                    </Td>
                    <Td>{formatRelative(l.last_seen_at)}</Td>
                    {canAct && (
                      <Td className="text-right">
                        {l.id && l.name && <EmergencyUnlockButton locker={{ id: l.id, name: l.name }} online={online} />}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableCard>
          </section>
        );
      })}

      <h2 className="mb-3 text-lg font-semibold text-slate-900">Recent commands</h2>
      <TableCard footer="Commands the kiosk does not pick up within 2 minutes expire, so an old unlock never fires later.">
        <thead>
          <tr>
            <Th>Requested</Th>
            <Th>Command</Th>
            <Th>Reason</Th>
            <Th>Status</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {commands.data.length === 0 && <EmptyRow colSpan={5} title="No commands yet" />}
          {commands.data.map((c) => {
            const payload = (c.payload ?? {}) as { lockerNumber?: number; requestedBy?: string };
            return (
              <tr key={c.id} className="hover:bg-slate-50">
                <Td>
                  {formatDateTime(c.requested_at)}
                  {payload.requestedBy && <Sub>{payload.requestedBy}</Sub>}
                </Td>
                <Td>{c.command === 'UNLOCK_LOCKER' ? `Unlock Locker ${payload.lockerNumber ?? '?'}` : 'Sync now'}</Td>
                <Td>{c.reason ?? '—'}</Td>
                <Td>
                  <StatusBadge tone={toneFor(c.status)}>{humanize(c.status)}</StatusBadge>
                </Td>
                <Td>{c.result_message ?? '—'}</Td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
