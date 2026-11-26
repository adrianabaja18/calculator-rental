import type { Metadata } from 'next';
import { AdminRole, EventSeverity, EventType } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { queryEventLogs } from '@/lib/data/queries';
import { cleanSearch, formatDateTime } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';

export const metadata: Metadata = { title: 'Event Logs' };

const PAGE_LIMIT = 200;
const LIVE_TABLES = ['device_events'] as const;
const SEVERITIES = Object.values(EventSeverity);
const TYPES = Object.values(EventType);

const rowTone: Record<string, string> = {
  CRITICAL: 'bg-red-50',
  ERROR: 'bg-red-50/60',
  WARNING: 'bg-amber-50/60',
};

export default async function EventLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; type?: string }>;
}) {
  await requireAdmin(AdminRole.VIEWER);
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const severity = (SEVERITIES as string[]).includes(params.status ?? '') ? (params.status as EventSeverity) : '';
  const type = (TYPES as string[]).includes(params.type ?? '') ? (params.type as EventType) : '';

  const events = await queryEventLogs({ q, severity, type, limit: PAGE_LIMIT });
  const problems = events.filter((e) => e.severity === 'ERROR' || e.severity === 'CRITICAL').length;

  return (
    <>
      <PageHeader
        title="Event Logs"
        description="Everything the kiosk recorded: scans, coins, unlocks, RFID checks, sync problems. Times are when it happened at the kiosk (Philippine time)."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />
      <FilterBar
        q={q}
        status={severity}
        statusOptions={SEVERITIES.map((s) => ({ value: s, label: humanize(s) }))}
        statusAllLabel="All severities"
        placeholder="Search messages"
        extra={{ name: 'type', label: 'Event type', allLabel: 'All event types', value: type, options: TYPES.map((t) => ({ value: t, label: humanize(t) })) }}
      />

      <TableCard
        footer={`${events.length} event${events.length === 1 ? '' : 's'}${problems ? ` · ${problems} error${problems === 1 ? '' : 's'}` : ''}${
          events.length === PAGE_LIMIT ? ` (latest ${PAGE_LIMIT} shown, refine the filters)` : ''
        }`}
      >
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Severity</Th>
            <Th>Event</Th>
            <Th>Message</Th>
            <Th>Locker</Th>
            <Th>Rental</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.length === 0 && (
            <EmptyRow
              colSpan={6}
              title={q || severity || type ? 'No events match your filters' : 'No events yet'}
              hint="Events appear as the kiosk operates."
            />
          )}
          {events.map((e) => (
            <tr key={e.id} className={rowTone[e.severity] ?? 'hover:bg-slate-50'}>
              <Td className="whitespace-nowrap">
                {formatDateTime(e.occurred_at)}
                {e.synced_at && <Sub>synced {formatDateTime(e.synced_at)}</Sub>}
              </Td>
              <Td>
                <StatusBadge tone={toneFor(e.severity)}>{humanize(e.severity)}</StatusBadge>
              </Td>
              <Td className="whitespace-nowrap">{humanize(e.event_type)}</Td>
              <Td>
                {e.message ?? '—'}
                {e.payload && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-slate-500">Details</summary>
                    <pre className="mt-1 max-w-md overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(e.payload, null, 2)}</pre>
                  </details>
                )}
              </Td>
              <Td>{e.locker_name ?? '—'}</Td>
              <Td className="whitespace-nowrap">{e.transaction_code ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
