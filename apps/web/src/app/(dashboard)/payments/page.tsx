import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Payments"
        description="Rental and penalty payments received by the kiosk or recorded by officers."
      />
      <ComingSoon
        phase={6}
        features={[
          "Payment per transaction (required vs received)",
          "Coin events for troubleshooting",
          "Status: pending, partial, paid, cancelled, refunded",
          "Daily totals",
        ]}
      />
    </>
  );
}
