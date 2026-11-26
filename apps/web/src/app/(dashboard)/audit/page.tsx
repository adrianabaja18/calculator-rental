import type { Metadata } from 'next';
import { ActorType, AdminRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { FilterBar } from '@/components/ui/filter-bar';
import { requireAdmin } from '@/lib/auth/session';
import { cleanSearch, formatDateTime } from '@/lib/format';
import { humanize } from '@/lib/status-tones';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Audit Logs' };

const PAGE_LIMIT = 200;
const ACTORS = Object.values(ActorType);

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="mt-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      <pre className="max-w-md overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  await requireAdmin(AdminRole.OFFICER);
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const actor = (ACTORS as string[]).includes(params.status ?? '') ? (params.status as ActorType) : '';

  const supabase = await createSupabaseServerClient();
  let query = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(PAGE_LIMIT);
  if (q) query = query.or(`action.ilike.%${q.replace(/ /g, '_')}%,actor_label.ilike.%${q}%,target_type.ilike.%${q}%,reason.ilike.%${q}%`);
  if (actor) query = query.eq('actor_type', actor);
  const { data: logs, error } = await query;
  if (error) throw new Error('Failed to load audit logs');

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Every important officer and system action: who did what, when, and why. Entries can never be edited or deleted."
      />
      <FilterBar
        q={q}
        status={actor}
        statusOptions={ACTORS.map((a) => ({ value: a, label: humanize(a) }))}
        statusAllLabel="All actors"
        placeholder="Action, email, target or reason"
      />
      <TableCard footer={`${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}${logs.length === PAGE_LIMIT ? ` (latest ${PAGE_LIMIT} shown)` : ''}`}>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Who</Th>
            <Th>Action</Th>
            <Th>Target</Th>
            <Th>Reason</Th>
            <Th>Change</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {logs.length === 0 && <EmptyRow colSpan={6} title={q || actor ? 'No entries match your filters' : 'No audit entries yet'} />}
          {logs.map((log) => (
            <tr key={log.id} className="hover:bg-slate-50">
              <Td className="whitespace-nowrap">{formatDateTime(log.created_at)}</Td>
              <Td>
                {log.actor_label ?? '—'}
                <Sub>{humanize(log.actor_type)}</Sub>
              </Td>
              <Td>
                <StatusBadge tone="blue">{humanize(log.action)}</StatusBadge>
              </Td>
              <Td>
                {log.target_type ? humanize(log.target_type) : '—'}
                {log.target_id && <Sub>{log.target_id}</Sub>}
              </Td>
              <Td>{log.reason ?? '—'}</Td>
              <Td>
                {log.previous_value || log.new_value ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-slate-500">Show</summary>
                    <Json label="Before" value={log.previous_value} />
                    <Json label="After" value={log.new_value} />
                  </details>
                ) : (
                  '—'
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
