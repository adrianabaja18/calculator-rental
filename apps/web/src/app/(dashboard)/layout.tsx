import { DashboardShell } from '@/components/layout/dashboard-shell';
import { requireAdmin } from '@/lib/auth/session';

/**
 * Every page inside app/(dashboard)/ requires an ACTIVE admin.
 * "(dashboard)" is a route group: it shares this layout without adding
 * "/dashboard" to the URLs (e.g. the Students page is just /students).
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <DashboardShell admin={{ email: admin.email, fullName: admin.fullName, role: admin.role }}>{children}</DashboardShell>
  );
}
