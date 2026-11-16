import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdmin(AdminRole.VIEWER);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Rental and penalty rules used by the kiosk."
      />
      <ComingSoon
        phase={7}
        features={[
          "Rental fee, duration and grace period",
          "Penalty type, amount, interval, maximum",
          "Accepted coins and timeouts",
          "Offline policy",
          "Editing restricted to Super Admins, every change audited",
        ]}
      />
    </>
  );
}
