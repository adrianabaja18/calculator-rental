import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Penalties" };

export default async function PenaltiesPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Penalties"
        description="Overdue and other penalties, tracked separately from rental fees."
      />
      <ComingSoon
        phase={7}
        features={[
          "Student, rental, reason and amount",
          "Paid / unpaid / waived / partial",
          "Record payment and waive (officers, with audit log)",
        ]}
      />
    </>
  );
}
