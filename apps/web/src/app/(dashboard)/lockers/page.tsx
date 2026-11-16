import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Lockers" };

export default async function LockersPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Lockers"
        description="Physical lockers, their sensors and assigned calculators."
      />
      <ComingSoon
        phase={4}
        features={[
          "Status, lock/door/RFID state per locker",
          "Expected vs detected RFID tag",
          "Inventory mismatch warnings",
          "Emergency unlock (officers, confirmed and audited)",
        ]}
      />
    </>
  );
}
