import type { Metadata } from 'next';
import { AdminRole, hasRole, systemSettingsFromRow } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SettingsForm } from './settings-form';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const admin = await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { data: row, error } = await supabase.from('system_settings').select('*').eq('id', 1).single();
  if (error || !row) throw new Error('Failed to load settings');

  return (
    <>
      <PageHeader
        title="Settings"
        description={`Rental and penalty rules used by the kiosk. Last changed ${formatDateTime(row.updated_at)}.`}
      />
      <SettingsForm settings={systemSettingsFromRow(row)} canEdit={hasRole(admin.role, AdminRole.SUPER_ADMIN)} />
    </>
  );
}
