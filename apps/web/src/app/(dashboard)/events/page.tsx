import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Event Logs" };

export default async function EventLogsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Event Logs"
        description="Hardware and kiosk events for debugging."
      />
      <ComingSoon
        phase={13}
        features={[
          "QR scans, coins, unlocks, RFID detections",
          "Filter by type, severity, locker, transaction",
          "Errors and critical events highlighted",
        ]}
      />
    </>
  );
}
