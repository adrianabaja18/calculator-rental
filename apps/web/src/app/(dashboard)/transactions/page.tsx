import type { Metadata } from 'next';
import { RentalStatus } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { queryTransactions } from '@/lib/data/queries';
import { cleanSearch, formatDateTime, formatPeso } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';

export const metadata: Metadata = { title: 'Transactions' };

const PAGE_LIMIT = 200;
const LIVE_TABLES = ['rental_transactions', 'penalties'] as const;
const STATUSES = Object.values(RentalStatus);

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const status = (STATUSES as string[]).includes(params.status ?? '') ? (params.status as RentalStatus) : '';

  const rentals = await queryTransactions({ q, status, limit: PAGE_LIMIT });

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Every rental the kiosk recorded, newest first, including cancelled and failed ones. Records are never deleted."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />
      <FilterBar
        q={q}
        status={status}
        statusOptions={STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
        placeholder="Code, student, student number or calculator"
      />
      <TableCard footer={`${rentals.length} transaction${rentals.length === 1 ? '' : 's'}${rentals.length === PAGE_LIMIT ? ` (latest ${PAGE_LIMIT} shown)` : ''}`}>
        <thead>
          <tr>
            <Th>Transaction</Th>
            <Th>Student</Th>
            <Th>Calculator</Th>
            <Th>Borrowed</Th>
            <Th>Due</Th>
            <Th>Returned</Th>
            <Th>Status</Th>
            <Th className="text-right">Fee paid</Th>
            <Th className="text-right">Penalty due</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rentals.length === 0 && (
            <EmptyRow colSpan={9} title={q || status ? 'No transactions match your filters' : 'No transactions yet'} hint="Rentals appear as students use the kiosk." />
          )}
          {rentals.map((r) => (
            <tr key={r.id} className={r.effective_status === 'OVERDUE' ? 'bg-red-50/50' : 'hover:bg-slate-50'}>
              <Td className="whitespace-nowrap">
                <div className="font-medium text-slate-900">{r.transaction_code}</div>
                <Sub>{formatDateTime(r.created_at)}</Sub>
              </Td>
              <Td>
                {r.student_full_name}
                <Sub>{r.student_number}</Sub>
              </Td>
              <Td className="whitespace-nowrap">
                {r.calculator_code}
                <Sub>{r.locker_name}</Sub>
              </Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.rented_at)}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.due_at)}</Td>
              <Td className="whitespace-nowrap">
                {formatDateTime(r.returned_at)}
                {r.was_overdue && <Sub>{r.overdue_minutes} min late</Sub>}
              </Td>
              <Td>
                <StatusBadge tone={toneFor(r.effective_status)}>{humanize(r.effective_status)}</StatusBadge>
                {r.failure_reason && <Sub>{humanize(r.failure_reason)}</Sub>}
              </Td>
              <Td className="text-right tabular-nums">{formatPeso(r.amount_paid)}</Td>
              <Td className={`text-right tabular-nums ${Number(r.penalty_amount_due) > 0 ? 'font-semibold text-red-700' : 'text-slate-400'}`}>
                {formatPeso(r.penalty_amount_due)}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
