import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Students" };

export default async function StudentsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Students"
        description="Students registered automatically from their school-ID QR code."
      />
      <ComingSoon
        phase={4}
        features={[
          "Name, student number, course",
          "Current rental, rental count, overdue count",
          "Unpaid penalties",
          "Block / unblock with reason (officers)",
        ]}
      />
    </>
  );
}
