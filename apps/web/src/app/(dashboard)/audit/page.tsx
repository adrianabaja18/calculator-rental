import type { Metadata } from 'next';
import { AdminRole } from '@calc-rental/shared';
import { ComingSoon } from '@/components/coming-soon';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: "Audit Log" };

export default async function AuditLogPage() {
  await requireAdmin(AdminRole.OFFICER);

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Record of important actions taken by officers and the system."
      />
      <ComingSoon
        phase={13}
        features={[
          "Who did what, to what, and when",
          "Previous and new values",
          "Logins, settings changes, waivers, manual overrides",
        ]}
      />
    </>
  );
}
