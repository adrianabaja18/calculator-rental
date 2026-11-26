import type { Metadata } from 'next';
import { headers } from 'next/headers';
import QRCode from 'qrcode';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { requireAdmin } from '@/lib/auth/session';
import { queryDeviceStatusPageData } from '@/lib/data/queries';
import { formatDateTime, formatRelative } from '@/lib/format';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { humanize, toneFor } from '@/lib/status-tones';
import { EmergencyUnlockButton, SyncClockButton, SyncNowButton } from './device-actions';

export const metadata: Metadata = { title: 'Device Status' };

const LIVE_TABLES = ['device_registry', 'lockers', 'device_commands'] as const;

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
  const local = isLocalBackend();
  const canAct = hasRole(admin.role, AdminRole.OFFICER) && !isDashboardReadOnly();

  const { devices, lockers, commands } = await queryDeviceStatusPageData();
  const scan = local ? await scanSticker() : null;

  return (
    <>
      <PageHeader
        title="Device Status"
        description={
          local
            ? 'Live local Raspberry Pi 4 kiosk status from SQLite. Emergency unlocks execute locally within ~1 second.'
            : 'Kiosk health from its heartbeat (every 30 s) and outbound cloud sync.'
        }
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />

      {devices.length === 0 && <p className="text-sm text-slate-600">No kiosk is registered yet.</p>}

      {devices.map((d) => {
        const online = d.connection_status === 'ONLINE';
        const syncError = d.last_sync_error;
        const failedItems = d.failed_items;
        const temp = d.cpu_temp_c;
        const drift = d.clock_drift_seconds;
        const deviceLockers = lockers.filter((l) => l.device_id === d.id);
        const waitingClock = d.kiosk_state === 'WAITING_FOR_CLOCK';

        return (
          <section key={d.id} className="mb-8">
            {local && waitingClock && (
              <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <strong>Kiosk waiting for clock sync:</strong> The Raspberry Pi booted without internet NTP. Click{' '}
                <strong>Sync clock from browser</strong> to set the kiosk time from your phone/laptop immediately.
              </div>
            )}

            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{d.name}</h2>
                <StatusBadge tone={toneFor(d.connection_status)}>{humanize(d.connection_status)}</StatusBadge>
                <StatusBadge tone={toneFor(d.health)}>{humanize(d.health)}</StatusBadge>
              </div>
              {canAct && (
                <div className="flex flex-wrap items-center gap-2">
                  {local && <SyncClockButton />}
                  <SyncNowButton deviceId={d.id} local={local} />
                </div>
              )}
            </div>

            <dl className="mb-4 grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Last heartbeat">{formatRelative(d.last_heartbeat_at)}</Stat>
              <Stat label="Kiosk state" warn={waitingClock}>{humanize(d.kiosk_state)}</Stat>
              <Stat label="Power">{d.kiosk_state === 'SLEEPING' ? 'Asleep (saving power)' : 'Awake'}</Stat>
              <Stat label="CPU temperature" warn={temp !== null && temp >= 75}>
                {temp === null ? '—' : `${temp.toFixed(1)} °C`}
              </Stat>
              <Stat label={local ? 'Kiosk clock' : 'Clock difference'} warn={!local && drift !== null && Math.abs(drift) > 120}>
                {local
                  ? (d.kiosk_now_iso ? formatDateTime(d.kiosk_now_iso) : '—')
                  : (drift === null ? '—' : `${drift > 0 ? '+' : ''}${drift} s`)}
              </Stat>
              <Stat label="Software">{d.software_version ?? '—'}</Stat>
              <Stat label="Waiting for cloud sync" warn={d.sync_queue_count > 100}>
                {d.sync_queue_count} change{d.sync_queue_count === 1 ? '' : 's'}
              </Stat>
              <Stat label="Last cloud upload">{formatRelative(d.last_sync_at)}</Stat>
              <Stat label="Mode">{local ? 'Local SQLite' : 'Cloud Monitor'}</Stat>
              <Stat label="Set aside (need an officer)" warn={failedItems > 0}>
                {failedItems}
              </Stat>
              <div className="col-span-2">
                <Stat label="Cloud sync note" warn={Boolean(syncError)}>
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
                        <EmergencyUnlockButton locker={{ id: l.id, name: l.name }} online={online} />
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
          {commands.length === 0 && <EmptyRow colSpan={5} title="No commands yet" />}
          {commands.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50">
              <Td>
                {formatDateTime(c.requested_at)}
                {c.payload.requestedBy && <Sub>{c.payload.requestedBy}</Sub>}
              </Td>
              <Td>{c.command === 'UNLOCK_LOCKER' ? `Unlock Locker ${c.payload.lockerNumber ?? '?'}` : 'Sync now'}</Td>
              <Td>{c.reason ?? '—'}</Td>
              <Td>
                <StatusBadge tone={toneFor(c.status)}>{humanize(c.status)}</StatusBadge>
              </Td>
              <Td>{c.result_message ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
      {scan && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold text-slate-900">Student scan page</h2>
          <div className="flex flex-wrap items-center gap-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            {/* SVG generated on the server from this dashboard's own address. */}
            <div className="h-40 w-40 shrink-0" dangerouslySetInnerHTML={{ __html: scan.svg }} />
            <div className="max-w-md text-sm text-slate-700">
              <p>
                Print this QR and stick it next to the kiosk LCD. Students on the kiosk Wi-Fi scan it to open{' '}
                <span className="font-mono text-slate-900">{scan.url}</span> and send their school ID.
              </p>
              {scan.isLocalhost && (
                <p role="alert" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
                  This link only works on the Pi itself. Open the dashboard from a phone or laptop using the Pi&apos;s network
                  address (e.g. http://192.168.1.50:3000), or set <code>SCAN_PAGE_URL</code>, then print the sticker.
                </p>
              )}
              <p className="mt-2 text-slate-500">
                Over plain http phones can take or upload a photo of the ID; the live camera view needs https.
              </p>
              <a
                href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(scan.svg)}`}
                download="kiosk-scan-qr.svg"
                className="mt-3 inline-block font-medium text-blue-700 underline underline-offset-2"
              >
                Download the QR (SVG)
              </a>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** The /scan link for the sticker: SCAN_PAGE_URL if set, else the address this dashboard was opened with. */
async function scanSticker() {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const url = process.env.SCAN_PAGE_URL?.trim() || `${proto}://${host}/scan`;
  const isLocalhost = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { url, svg, isLocalhost };
}
