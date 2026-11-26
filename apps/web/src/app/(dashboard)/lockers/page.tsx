import type { Metadata } from 'next';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { EmptyRow, Sub, TableCard, Td, Th } from '@/components/ui/data-table';
import { requireAdmin } from '@/lib/auth/session';
import { queryLockersPageData } from '@/lib/data/queries';
import { formatRelative } from '@/lib/format';
import { isDashboardReadOnly } from '@/lib/mode';
import { toneFor } from '@/lib/status-tones';
import { LockerRowActions } from './locker-actions';

export const metadata: Metadata = { title: 'Lockers' };

export default async function LockersPage() {
  const admin = await requireAdmin();
  const canManage = hasRole(admin.role, AdminRole.OFFICER) && !isDashboardReadOnly();

  const lockers = await queryLockersPageData();
  const mismatches = lockers.filter((l) => l.has_inventory_mismatch);
  const columns = canManage ? 7 : 6;

  return (
    <>
      <PageHeader
        title="Lockers"
        description="Database status next to what the kiosk's sensors physically report. A locker is lent out only when both agree."
      />

      {mismatches.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <strong>Inventory mismatch:</strong> {mismatches.map((l) => l.name).join(', ')}: the system expects a
          calculator here, but the RFID reader doesn&apos;t see the right tag. Check the locker physically.
        </div>
      )}

      <TableCard footer="Lock, door and RFID states are reported by the kiosk. They read UNKNOWN until the kiosk is running.">
        <thead>
          <tr>
            <Th>Locker</Th>
            <Th>Calculator (expected tag)</Th>
            <Th>Status</Th>
            <Th>Lock / Door</Th>
            <Th>RFID reader</Th>
            <Th>Kiosk</Th>
            {canManage && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lockers.length === 0 && <EmptyRow colSpan={columns} title="No lockers configured" />}
          {lockers.map((l) => (
            <tr key={l.id} className={l.has_inventory_mismatch ? 'bg-red-50/60' : 'hover:bg-slate-50'}>
              <Td>
                <div className="font-medium text-slate-900">{l.name}</div>
                <Sub>
                  #{l.locker_number} · channel {l.hardware_channel}
                </Sub>
                {l.notes && <Sub>{l.notes}</Sub>}
              </Td>
              <Td>
                {l.calculator_code ? (
                  <>
                    <div>{l.calculator_code}</div>
                    <Sub>
                      <span className="font-mono">{l.expected_rfid_uid}</span>
                    </Sub>
                  </>
                ) : (
                  <span className="text-slate-400">Empty slot</span>
                )}
              </Td>
              <Td>
                <StatusBadge tone={toneFor(l.status)}>{l.status}</StatusBadge>
                <Sub>{l.is_assignable ? 'Ready to lend' : 'Not lendable right now'}</Sub>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge tone={toneFor(l.lock_state)}>{l.lock_state}</StatusBadge>
                  <StatusBadge tone={toneFor(l.door_state)}>{l.door_state}</StatusBadge>
                </div>
              </Td>
              <Td>
                <StatusBadge tone={toneFor(l.rfid_state)}>{l.rfid_state}</StatusBadge>
                {l.last_detected_rfid_uid && (
                  <Sub>
                    sees <span className="font-mono">{l.last_detected_rfid_uid}</span>
                  </Sub>
                )}
              </Td>
              <Td>
                <StatusBadge tone={toneFor(l.device_connection_status)}>{l.device_connection_status}</StatusBadge>
                <Sub>
                  {l.device_code} · seen {formatRelative(l.last_seen_at)}
                </Sub>
              </Td>
              {canManage && (
                <Td>
                  <LockerRowActions
                    locker={{
                      id: l.id,
                      name: l.name,
                      notes: l.notes,
                      status: l.status,
                      hasOpenRental: l.has_open_rental,
                    }}
                  />
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
