import type { Metadata } from 'next';
import { AdminRole, StudentStatus, formatPhilippineDateTime, hasRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { queryStudents } from '@/lib/data/queries';
import { cleanSearch, formatPeso } from '@/lib/format';
import { isDashboardReadOnly } from '@/lib/mode';
import { humanize, toneFor } from '@/lib/status-tones';
import { StudentRowActions } from './student-actions';

export const metadata: Metadata = { title: 'Students' };

const PAGE_LIMIT = 200;
const STATUS_OPTIONS = Object.values(StudentStatus).map((s) => ({ value: s, label: humanize(s) }));

export default async function StudentsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const status = (Object.values(StudentStatus) as string[]).includes(params.status ?? '')
    ? (params.status as StudentStatus)
    : '';
  const canManage = hasRole(admin.role, AdminRole.OFFICER) && !isDashboardReadOnly();

  const students = await queryStudents({ q, status, limit: PAGE_LIMIT });
  const columns = canManage ? 8 : 7;

  return (
    <>
      <PageHeader
        title="Students"
        description="Students are registered automatically the first time they scan their school ID at the kiosk."
      />
      <FilterBar q={q} status={status} statusOptions={STATUS_OPTIONS} placeholder="Name, student number or course" />

      <TableCard
        footer={`${students.length} student${students.length === 1 ? '' : 's'}${
          students.length === PAGE_LIMIT ? ` (first ${PAGE_LIMIT} shown, refine your search)` : ''
        }`}
      >
        <thead>
          <tr>
            <Th>Student</Th>
            <Th>Course</Th>
            <Th>Current rental</Th>
            <Th className="text-right">Rentals</Th>
            <Th className="text-right">Overdue</Th>
            <Th className="text-right">Unpaid penalties</Th>
            <Th>Status</Th>
            {canManage && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {students.length === 0 && (
            <EmptyRow
              colSpan={columns}
              title={q || status ? 'No students match your filters' : 'No students yet'}
              hint={q || status ? 'Try a different search.' : 'Students appear after their first scan at the kiosk.'}
            />
          )}
          {students.map((s) => (
            <tr key={s.id} className="hover:bg-slate-50">
              <Td>
                <div className="font-medium text-slate-900">{s.full_name}</div>
                <Sub>{s.student_number}</Sub>
              </Td>
              <Td>{s.course_program}</Td>
              <Td>
                {s.open_rental_id ? (
                  <>
                    <StatusBadge tone={toneFor(s.open_rental_status)}>{s.open_rental_status ?? ''}</StatusBadge>
                    <Sub>
                      {s.open_rental_calculator_code}
                      {s.open_rental_due_at && ` · due ${formatPhilippineDateTime(s.open_rental_due_at)}`}
                    </Sub>
                  </>
                ) : (
                  <span className="text-slate-400">None</span>
                )}
              </Td>
              <Td className="text-right tabular-nums">{s.rental_count}</Td>
              <Td className={`text-right tabular-nums ${s.overdue_count ? 'font-semibold text-red-700' : ''}`}>
                {s.overdue_count}
              </Td>
              <Td className="text-right tabular-nums">
                {Number(s.unpaid_penalty_total) > 0 ? (
                  <span className="font-semibold text-red-700">{formatPeso(s.unpaid_penalty_total)}</span>
                ) : (
                  <span className="text-slate-400">{formatPeso(0)}</span>
                )}
              </Td>
              <Td>
                <StatusBadge tone={toneFor(s.status)}>{s.status}</StatusBadge>
                {s.blocked_reason && <Sub>{s.blocked_reason}</Sub>}
              </Td>
              {canManage && (
                <Td className="text-right">
                  <StudentRowActions
                    student={{
                      id: s.id,
                      fullName: s.full_name,
                      studentNumber: s.student_number,
                      status: s.status,
                      blockedReason: s.blocked_reason,
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
