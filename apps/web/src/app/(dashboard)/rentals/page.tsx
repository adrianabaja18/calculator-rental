import type { Metadata } from 'next';
import { operatingCalendar } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { requireAdmin } from '@/lib/auth/session';
import { queryActiveRentals } from '@/lib/data/queries';
import { formatDateTime, formatPeso } from '@/lib/format';
import { toneFor } from '@/lib/status-tones';
import { Countdown } from './countdown';

export const metadata: Metadata = { title: 'Active Rentals' };

const LIVE_TABLES = ['rental_transactions', 'penalties'] as const;

export default async function ActiveRentalsPage() {
  await requireAdmin();
  const { rentals, settings } = await queryActiveRentals();
  const calendar = operatingCalendar(settings);
  const overdue = rentals.filter((r) => r.effective_status === 'OVERDUE').length;

  return (
    <>
      <PageHeader
        title="Active Rentals"
        description="Calculators currently out with students, soonest due first. Times are Philippine time."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />

      <TableCard
        footer={`${rentals.length} out${overdue ? ` · ${overdue} overdue` : ''} · Countdowns run in your browser; the due time stored in the database is the official one.`}
      >
        <thead>
          <tr>
            <Th>Student</Th>
            <Th>Course</Th>
            <Th>Calculator</Th>
            <Th>Locker</Th>
            <Th>Borrowed</Th>
            <Th>Due</Th>
            <Th>Time left</Th>
            <Th>Status</Th>
            <Th className="text-right">Paid</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rentals.length === 0 && (
            <EmptyRow
              colSpan={9}
              title="No calculators are out right now"
              hint="Active rentals appear here immediately."
            />
          )}
          {rentals.map((r) => (
            <tr key={r.id} className={r.effective_status === 'OVERDUE' ? 'bg-red-50/50' : 'hover:bg-slate-50'}>
              <Td>
                <div className="font-medium text-slate-900">{r.student_full_name}</div>
                <Sub>{r.student_number}</Sub>
              </Td>
              <Td>{r.student_course_program}</Td>
              <Td>
                {r.calculator_code}
                <Sub>{r.transaction_code}</Sub>
              </Td>
              <Td>{r.locker_name}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.rented_at)}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(r.due_at)}</Td>
              <Td>{r.due_at ? <Countdown dueAt={r.due_at} calendar={calendar} /> : '—'}</Td>
              <Td>
                <StatusBadge tone={toneFor(r.effective_status)}>{r.effective_status}</StatusBadge>
                {Number(r.penalty_amount_due) > 0 && <Sub>Penalty due {formatPeso(r.penalty_amount_due)}</Sub>}
              </Td>
              <Td className="text-right tabular-nums">{formatPeso(r.amount_paid)}</Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
