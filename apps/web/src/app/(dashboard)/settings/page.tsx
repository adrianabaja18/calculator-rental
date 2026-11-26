import type { Metadata } from 'next';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';
import { querySystemSettings } from '@/lib/data/queries';
import { formatDateTime } from '@/lib/format';
import { isDashboardReadOnly } from '@/lib/mode';
import { SettingsForm } from './settings-form';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const admin = await requireAdmin();
  const { settings, updatedAt } = await querySystemSettings();
  const canEdit = hasRole(admin.role, AdminRole.SUPER_ADMIN) && !isDashboardReadOnly();

  return (
    <>
      <PageHeader
        title="Settings"
        description={`Rental and penalty rules used by the kiosk.${updatedAt ? ` Last changed ${formatDateTime(updatedAt)}.` : ''}`}
      />
      <SettingsForm settings={settings} canEdit={canEdit} />
    </>
  );
}
