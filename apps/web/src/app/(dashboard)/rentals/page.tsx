import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Active Rentals" };

export default async function ActiveRentalsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Active Rentals"
        description="Calculators currently out with students, with live due/overdue countdowns."
      />
      <ComingSoon
        phase={5}
        features={[
          "Student, student number and course",
          "Calculator and locker",
          "Borrowed at / due at (Philippine time)",
          "Live countdown or \"overdue by\" timer",
          "Status and amount paid",
        ]}
      />
    </>
  );
}
