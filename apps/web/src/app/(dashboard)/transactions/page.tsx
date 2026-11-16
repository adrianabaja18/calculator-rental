import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Transaction History" };

export default async function TransactionHistoryPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Transaction History"
        description="Every rental ever made — nothing is overwritten or deleted."
      />
      <ComingSoon
        phase={5}
        features={[
          "Filters: date, student, calculator, locker, status, payment, overdue",
          "Search by transaction code",
          "Transaction detail view with its events",
        ]}
      />
    </>
  );
}
