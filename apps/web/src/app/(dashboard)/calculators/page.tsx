import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Calculators" };

export default async function CalculatorsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Calculators"
        description="Calculator inventory and RFID identities."
      />
      <ComingSoon
        phase={4}
        features={[
          "Code, model, RFID UID, assigned locker",
          "Status, condition, current borrower, last transaction",
          "Edit details, move to maintenance, reactivate (officers)",
        ]}
      />
    </>
  );
}
