import type { Metadata } from 'next';
import { AdminRole, CalculatorStatus, hasRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { cleanSearch, formatDateTime } from '@/lib/format';
import { humanize, toneFor } from '@/lib/status-tones';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AddCalculatorButton, CalculatorRowActions, type LockerOption } from './calculator-actions';

export const metadata: Metadata = { title: 'Calculators' };

const STATUS_OPTIONS = Object.values(CalculatorStatus).map((s) => ({ value: s, label: humanize(s) }));

function nextCalculatorCode(codes: string[]): string {
  const highest = codes.reduce((max, code) => Math.max(max, Number(code.replace('CALC-', '')) || 0), 0);
  return `CALC-${String(highest + 1).padStart(3, '0')}`;
}

export default async function CalculatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const status = (Object.values(CalculatorStatus) as string[]).includes(params.status ?? '')
    ? (params.status as CalculatorStatus)
    : '';
  const canManage = hasRole(admin.role, AdminRole.OFFICER);

  const supabase = await createSupabaseServerClient();
  let query = supabase.from('v_calculators').select('*').order('code');
  if (q) query = query.or(`code.ilike.%${q}%,model.ilike.%${q}%,rfid_uid.ilike.%${q}%`);
  if (status) query = query.eq('status', status);

  const [{ data: calculators, error }, { data: lockers }, { data: allCodes }] = await Promise.all([
    query,
    supabase.from('v_lockers').select('id, locker_number, name, calculator_id').order('locker_number'),
    supabase.from('calculators').select('code'),
  ]);
  if (error) throw new Error('Failed to load calculators');

  const lockerOptions: LockerOption[] = (lockers ?? []).map((l) => ({
    id: l.id!,
    label: `${l.name} (#${l.locker_number})`,
    calculatorId: l.calculator_id,
  }));
  const columns = canManage ? 7 : 6;

  return (
    <>
      <PageHeader
        title="Calculators"
        description="Each calculator has a permanent RFID tag and normally lives in one locker."
        actions={
          canManage && (
            <AddCalculatorButton suggestedCode={nextCalculatorCode((allCodes ?? []).map((c) => c.code))} lockers={lockerOptions} />
          )
        }
      />
      <FilterBar q={q} status={status} statusOptions={STATUS_OPTIONS} placeholder="Code, model or RFID UID" />

      <TableCard footer={`${calculators.length} calculator${calculators.length === 1 ? '' : 's'}`}>
        <thead>
          <tr>
            <Th>Calculator</Th>
            <Th>RFID UID</Th>
            <Th>Locker</Th>
            <Th>Status</Th>
            <Th>Current borrower</Th>
            <Th>Last transaction</Th>
            {canManage && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {calculators.length === 0 && (
            <EmptyRow
              colSpan={columns}
              title={q || status ? 'No calculators match your filters' : 'No calculators yet'}
              hint={q || status ? 'Try a different search.' : 'Add the first calculator with "+ Add calculator".'}
            />
          )}
          {calculators.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50">
              <Td>
                <div className="font-medium text-slate-900">{c.code}</div>
                <Sub>{c.model}</Sub>
              </Td>
              <Td className="font-mono text-xs whitespace-nowrap">{c.rfid_uid}</Td>
              <Td>{c.locker_name ?? <span className="text-slate-400">None</span>}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge tone={toneFor(c.status)}>{c.status ?? ''}</StatusBadge>
                  {c.condition !== 'GOOD' && <StatusBadge tone={toneFor(c.condition)}>{c.condition ?? ''}</StatusBadge>}
                </div>
                {c.notes && <Sub>{c.notes}</Sub>}
              </Td>
              <Td>
                {c.borrower_full_name ? (
                  <>
                    <div>{c.borrower_full_name}</div>
                    <Sub>
                      {c.borrower_student_number} · due {formatDateTime(c.open_rental_due_at)}
                    </Sub>
                  </>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </Td>
              <Td>
                {formatDateTime(c.last_transaction_at)}
                <Sub>{c.rental_count} rental{c.rental_count === 1 ? '' : 's'}</Sub>
              </Td>
              {canManage && (
                <Td>
                  <CalculatorRowActions
                    lockers={lockerOptions}
                    calculator={{
                      id: c.id!,
                      code: c.code!,
                      model: c.model!,
                      rfidUid: c.rfid_uid!,
                      lockerId: c.locker_id,
                      condition: c.condition!,
                      notes: c.notes,
                      status: c.status!,
                      hasOpenRental: Boolean(c.open_rental_id),
                    }}
                  />
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
