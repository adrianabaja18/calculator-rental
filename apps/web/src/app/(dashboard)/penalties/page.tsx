import type { Metadata } from 'next';
import { AdminRole, PenaltyStatus, hasRole } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { formatDateTime, formatPeso } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { WaivePenaltyButton } from './penalty-actions';

export const metadata: Metadata = { title: 'Penalties' };

const PAGE_LIMIT = 200;
const LIVE_TABLES = ['penalties'] as const;
const STATUSES = Object.values(PenaltyStatus);

export default async function PenaltiesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const admin = await requireAdmin();
  const canWaive = hasRole(admin.role, AdminRole.OFFICER);
  const params = await searchParams;
  const status = (STATUSES as string[]).includes(params.status ?? '') ? (params.status as PenaltyStatus) : '';

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('penalties')
    .select('*, students(full_name, student_number), rental_transactions(transaction_code)')
    .order('created_at', { ascending: false })
    .limit(PAGE_LIMIT);
  if (status) query = query.eq('status', status);
  const { data: penalties, error } = await query;
  if (error) throw new Error('Failed to load penalties');

  const outstanding = penalties.reduce((sum, p) => sum + Number(p.amount_due), 0);
  const columns = canWaive ? 8 : 7;

  return (
    <>
      <PageHeader
        title="Penalties"
        description="Late-return fees. Students pay them in coins at the kiosk before the return locker opens; officers can waive what is still owed."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />
      <FilterBar status={status} statusOptions={STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
      <TableCard footer={`${penalties.length} penalt${penalties.length === 1 ? 'y' : 'ies'} shown · still owed ${formatPeso(outstanding)}`}>
        <thead>
          <tr>
            <Th>Calculated</Th>
            <Th>Student</Th>
            <Th>Rental</Th>
            <Th className="text-right">Late by</Th>
            <Th className="text-right">Amount</Th>
            <Th className="text-right">Paid / waived</Th>
            <Th>Status</Th>
            {canWaive && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {penalties.length === 0 && <EmptyRow colSpan={columns} title="No penalties match" hint="Late returns create penalties at the kiosk." />}
          {penalties.map((p) => {
            const open = p.status === PenaltyStatus.UNPAID || p.status === PenaltyStatus.PARTIAL;
            const late = `${Math.floor(p.overdue_minutes / 60)} h ${p.overdue_minutes % 60} min`;
            return (
              <tr key={p.id} className={open ? 'bg-red-50/40' : 'hover:bg-slate-50'}>
                <Td className="whitespace-nowrap">{formatDateTime(p.calculated_at)}</Td>
                <Td>
                  {p.students?.full_name ?? '—'}
                  <Sub>{p.students?.student_number}</Sub>
                </Td>
                <Td className="whitespace-nowrap">{p.rental_transactions?.transaction_code ?? '—'}</Td>
                <Td className="text-right tabular-nums">{late}</Td>
                <Td className="text-right tabular-nums">{formatPeso(p.calculated_amount)}</Td>
                <Td className="text-right tabular-nums">
                  {formatPeso(p.amount_paid)}
                  {Number(p.waived_amount) > 0 && <Sub>waived {formatPeso(p.waived_amount)}</Sub>}
                </Td>
                <Td>
                  <StatusBadge tone={toneFor(p.status)}>{humanize(p.status)}</StatusBadge>
                  {p.waive_reason && <Sub>{p.waive_reason}</Sub>}
                </Td>
                {canWaive && (
                  <Td className="text-right">
                    {open && (
                      <WaivePenaltyButton
                        penalty={{ id: p.id, owed: formatPeso(p.amount_due), studentName: p.students?.full_name ?? 'this student' }}
                      />
                    )}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
