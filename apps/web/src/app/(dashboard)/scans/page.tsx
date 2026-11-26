import type { Metadata } from 'next';
import { AdminRole, parseStudentQr } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { queryIdScans, type IdScanFilter, type IdScanRow } from '@/lib/data/queries';
import { cleanSearch, formatDateTime } from '@/lib/format';
import { isLocalBackend } from '@/lib/mode';

export const metadata: Metadata = { title: 'ID Scans' };

const PAGE_LIMIT = 200;
const LIVE_TABLES = ['scan_sessions'] as const;
const SHOW_OPTIONS: { value: Exclude<IdScanFilter, ''>; label: string }[] = [
  { value: 'USED', label: 'Used by the kiosk' },
  { value: 'NOT_USED', label: 'Sent, not used' },
  { value: 'NO_ID', label: 'Codes with no ID sent' },
];

/** What happened to a scan, in plain words. */
function outcome(s: IdScanRow): { label: string; tone: 'green' | 'amber' | 'gray' | 'blue' } {
  if (s.status === 'CONSUMED') return { label: 'Used by kiosk', tone: 'green' };
  if (s.qr_payload && s.status === 'SUBMITTED') return { label: 'Sent, waiting', tone: 'blue' };
  if (s.qr_payload) return { label: 'Sent, not used', tone: 'amber' };
  if (s.status === 'WAITING') return { label: 'Code on screen', tone: 'blue' };
  return { label: 'Code expired', tone: 'gray' };
}

export default async function IdScansPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireAdmin(AdminRole.VIEWER);
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const show = SHOW_OPTIONS.some((o) => o.value === params.status) ? (params.status as IdScanFilter) : '';
  const local = isLocalBackend();

  const scans = await queryIdScans({ q, show, limit: PAGE_LIMIT });

  return (
    <>
      <PageHeader
        title="ID Scans"
        description="Every school ID sent from a student's phone to the kiosk, with what the kiosk did with it. Times are Philippine time."
        actions={local ? <LiveRefresh tables={LIVE_TABLES} /> : undefined}
      />

      {!local && (
        <p role="note" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ID scans are stored on the Raspberry Pi only. Open the dashboard on the Pi (its network address) to see them.
        </p>
      )}

      <FilterBar
        q={q}
        status={show}
        statusOptions={SHOW_OPTIONS}
        statusAllLabel="All sent IDs"
        placeholder="Search name or student number"
      />

      <TableCard
        footer={`${scans.length} scan${scans.length === 1 ? '' : 's'}${scans.length === PAGE_LIMIT ? ` (latest ${PAGE_LIMIT} shown, refine the search)` : ''}`}
      >
        <thead>
          <tr>
            <Th>Sent</Th>
            <Th>Student</Th>
            <Th>Course</Th>
            <Th>Outcome</Th>
            <Th>Kiosk code</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {scans.length === 0 && (
            <EmptyRow
              colSpan={5}
              title={q || show ? 'No scans match your filters' : 'No IDs sent yet'}
              hint="Scans appear when students send their ID from the phone scan page."
            />
          )}
          {scans.map((s) => {
            const parsed = s.qr_payload ? parseStudentQr(s.qr_payload) : null;
            const student = parsed?.ok ? parsed.data : null;
            const { label, tone } = outcome(s);
            return (
              <tr key={s.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap">
                  {formatDateTime(s.submitted_at ?? s.created_at)}
                  {!s.submitted_at && <Sub>code shown, nothing sent</Sub>}
                </Td>
                <Td>
                  {student ? (
                    <>
                      <div className="font-medium text-slate-900">{student.fullName}</div>
                      <Sub>{student.studentNumber}</Sub>
                    </>
                  ) : s.qr_payload ? (
                    <span className="font-mono text-xs text-slate-600">{s.qr_payload.replace(/\t/g, ' · ')}</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </Td>
                <Td>{student?.courseProgram ?? '—'}</Td>
                <Td>
                  <StatusBadge tone={tone}>{label}</StatusBadge>
                  {s.consumed_at && <Sub>at {formatDateTime(s.consumed_at)}</Sub>}
                </Td>
                <Td className="font-mono">{s.code}</Td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
