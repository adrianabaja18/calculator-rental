import type { Metadata } from 'next';
import { HealthPanel } from '@/components/health-panel';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Dashboard' };

const SUMMARY_CARDS = [
  'Total Calculators',
  'Available',
  'Currently Rented',
  'Overdue',
  'Rentals Today',
  'Returns Today',
  'Income Today',
  'Outstanding Penalties',
];

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const admin = await requireAdmin();
  const { denied } = await searchParams;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Welcome${admin.fullName ? `, ${admin.fullName}` : ''}. Live figures appear here in Phase 8.`}
      />

      {denied && (
        <div role="alert" className="mb-6 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Your role doesn&apos;t have access to that page.
        </div>
      )}

      <section aria-label="Summary" className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SUMMARY_CARDS.map((title) => (
          <div key={title} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-medium text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-bold text-slate-300" aria-label="Not available yet">
              —
            </p>
          </div>
        ))}
      </section>

      <HealthPanel />
    </>
  );
}
