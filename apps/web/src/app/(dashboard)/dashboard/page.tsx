import type { Metadata } from 'next';
import Link from 'next/link';
import { HealthPanel } from '@/components/health-panel';
import { LiveRefresh } from '@/components/live-refresh';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';
import { formatPeso } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Dashboard' };

const LIVE_TABLES = ['calculators', 'rental_transactions', 'payments', 'penalties'] as const;

type Tone = 'default' | 'green' | 'blue' | 'red';
const valueTone: Record<Tone, string> = {
  default: 'text-slate-900',
  green: 'text-emerald-700',
  blue: 'text-blue-700',
  red: 'text-red-700',
};

function Card({ title, value, href, tone = 'default' }: { title: string; value: string | number; href: string; tone?: Tone }) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
    >
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${valueTone[tone]}`}>{value}</p>
    </Link>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const admin = await requireAdmin();
  const { denied } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: s, error } = await supabase.from('v_dashboard_summary').select('*').single();
  if (error || !s) throw new Error('Failed to load dashboard summary');

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Welcome${admin.fullName ? `, ${admin.fullName}` : ''}. "Today" follows Philippine time.`}
        actions={<LiveRefresh tables={LIVE_TABLES} />}
      />

      {denied && (
        <div role="alert" className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Your role doesn&apos;t have access to that page.
        </div>
      )}

      <section aria-label="Summary" className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Total Calculators" value={s.total_calculators ?? 0} href="/calculators" />
        <Card title="Available" value={s.available_calculators ?? 0} href="/calculators?status=AVAILABLE" tone="green" />
        <Card title="Currently Rented" value={s.rented_calculators ?? 0} href="/rentals" tone="blue" />
        <Card title="Overdue" value={s.overdue_rentals ?? 0} href="/rentals" tone={s.overdue_rentals ? 'red' : 'default'} />
        <Card title="Rentals Today" value={s.rentals_today ?? 0} href="/transactions" />
        <Card title="Returns Today" value={s.returns_today ?? 0} href="/transactions" />
        <Card title="Income Today" value={formatPeso(s.income_today)} href="/payments" />
        <Card
          title="Outstanding Penalties"
          value={formatPeso(s.outstanding_penalties)}
          href="/penalties"
          tone={Number(s.outstanding_penalties) > 0 ? 'red' : 'default'}
        />
      </section>

      <HealthPanel />
    </>
  );
}
