import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ADMIN_ROLE_LABEL, AdminRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { requireAdmin } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { listLocalAdmins } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { AddAdminButton, AdminRowActions } from './admin-actions';

export const metadata: Metadata = { title: 'Admin Accounts' };

export default async function AdminAccountsPage() {
  const currentAdmin = await requireAdmin(AdminRole.SUPER_ADMIN);
  if (!isLocalBackend()) redirect('/dashboard');

  const admins = listLocalAdmins();

  return (
    <>
      <PageHeader
        title="Admin Accounts"
        description="Local administrator, officer and viewer logins stored on this Raspberry Pi (works 100% offline)."
        actions={<AddAdminButton />}
      />

      <TableCard footer={`${admins.length} local account${admins.length === 1 ? '' : 's'} · Password hashes stay on this device and are never synced to the cloud.`}>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Last sign-in</Th>
            <Th>Created</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {admins.length === 0 && <EmptyRow colSpan={6} title="No local admin accounts" />}
          {admins.map((a) => {
            const active = a.is_active === 1;
            const isSelf = a.id === currentAdmin.id;
            return (
              <tr key={a.id} className="hover:bg-slate-50">
                <Td>
                  <div className="font-medium text-slate-900">
                    {a.full_name ?? a.email}
                    {isSelf && <span className="ml-2 text-xs font-normal text-blue-700">(you)</span>}
                  </div>
                  <Sub>{a.email}</Sub>
                </Td>
                <Td>
                  <StatusBadge tone={a.role === AdminRole.SUPER_ADMIN ? 'blue' : 'gray'}>
                    {ADMIN_ROLE_LABEL[a.role]}
                  </StatusBadge>
                </Td>
                <Td>
                  <StatusBadge tone={active ? 'green' : 'red'}>{active ? 'Active' : 'Inactive'}</StatusBadge>
                </Td>
                <Td className="whitespace-nowrap">{formatDateTime(a.last_login_at)}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(a.created_at)}</Td>
                <Td className="text-right">
                  <AdminRowActions
                    isSelf={isSelf}
                    account={{
                      id: a.id,
                      email: a.email,
                      fullName: a.full_name,
                      role: a.role,
                      isActive: active,
                    }}
                  />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
