import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Device Status" };

export default async function DeviceStatusPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Device Status"
        description="Kiosk health reported by the Raspberry Pi heartbeat."
      />
      <ComingSoon
        phase={13}
        features={[
          "Raspberry Pi online/offline and last heartbeat",
          "ESP32-CAM and coin selector status",
          "RFID reader and lock status per locker",
          "Sync queue size and latest errors",
        ]}
      />
    </>
  );
}
