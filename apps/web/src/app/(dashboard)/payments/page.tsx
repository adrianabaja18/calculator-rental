import type { Metadata } from 'next';
import { PaymentStatus, PaymentType } from '@calc-rental/shared';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { queryPayments } from '@/lib/data/queries';
import { formatDateTime, formatPeso } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';

export const metadata: Metadata = { title: 'Payments' };

const PAGE_LIMIT = 200;
const LIVE_TABLES = ['payments'] as const;
const STATUSES = Object.values(PaymentStatus);
const TYPES = Object.values(PaymentType);

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const status = (STATUSES as string[]).includes(params.status ?? '') ? (params.status as PaymentStatus) : '';
  const type = (TYPES as string[]).includes(params.type ?? '') ? (params.type as PaymentType) : '';

  const payments = await queryPayments({ status, type, limit: PAGE_LIMIT });

  const collected = payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + Number(p.amount_received), 0);
  const over = payments.reduce((sum, p) => sum + Math.max(0, Number(p.amount_received) - Number(p.required_amount)), 0);

  return (
    <>
      <PageHeader
        title="Payments"
        description="Coin payments the kiosk received for rentals and penalties. The coin selector gives no change, so extra coins are recorded as overpaid."
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />
      <FilterBar
        status={status}
        statusOptions={STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
        extra={{ name: 'type', label: 'Payment type', allLabel: 'All types', value: type, options: TYPES.map((t) => ({ value: t, label: humanize(t) })) }}
      />
      <TableCard
        footer={`${payments.length} payment${payments.length === 1 ? '' : 's'} shown · collected ${formatPeso(collected)}${over > 0 ? ` · overpaid ${formatPeso(over)}` : ''}`}
      >
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Student</Th>
            <Th>For</Th>
            <Th>Status</Th>
            <Th className="text-right">Required</Th>
            <Th className="text-right">Received</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {payments.length === 0 && <EmptyRow colSpan={6} title="No payments match" hint="Payments appear as coins are accepted at the kiosk." />}
          {payments.map((p) => {
            const overpaid = Number(p.amount_received) - Number(p.required_amount);
            return (
              <tr key={p.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap">
                  {formatDateTime(p.created_at)}
                  {p.paid_at && <Sub>paid {formatDateTime(p.paid_at)}</Sub>}
                </Td>
                <Td>
                  {p.student_full_name ?? '—'}
                  <Sub>{p.student_number}</Sub>
                </Td>
                <Td>
                  {humanize(p.payment_type)} · {humanize(p.method)}
                  <Sub>{p.transaction_code}</Sub>
                </Td>
                <Td>
                  <StatusBadge tone={toneFor(p.status)}>{humanize(p.status)}</StatusBadge>
                </Td>
                <Td className="text-right tabular-nums">{formatPeso(p.required_amount)}</Td>
                <Td className="text-right tabular-nums">
                  {formatPeso(p.amount_received)}
                  {overpaid > 0 && <Sub>+{formatPeso(overpaid)} over</Sub>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
