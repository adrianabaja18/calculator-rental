'use client';

import { LockerStatus } from '@calc-rental/shared';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, TextArea, TextInput } from '@/components/ui/form-field';
import { endLockerMaintenance, setLockerMaintenance, updateLocker } from './actions';

export function LockerRowActions({
  locker,
}: {
  locker: { id: string; name: string; notes: string | null; status: string; hasOpenRental: boolean };
}) {
  return (
    <div className="flex justify-end gap-1.5">
      <ActionDialog
        triggerLabel="Edit"
        title={`Edit ${locker.name}`}
        submitLabel="Save changes"
        action={updateLocker}
        hidden={{ lockerId: locker.id }}
      >
        <Field label="Name">
          <TextInput name="name" required maxLength={50} defaultValue={locker.name} />
        </Field>
        <Field label="Notes">
          <TextArea name="notes" maxLength={500} defaultValue={locker.notes ?? ''} />
        </Field>
      </ActionDialog>

      {locker.status === LockerStatus.MAINTENANCE ? (
        <ActionDialog
          triggerLabel="End maintenance"
          title={`Put ${locker.name} back in service?`}
          description="The kiosk will use it again once its RFID reader sees the expected calculator and the lock is closed."
          submitLabel="Back in service"
          action={endLockerMaintenance}
          hidden={{ lockerId: locker.id }}
        />
      ) : (
        <ActionDialog
          triggerLabel="Maintenance"
          triggerVariant="danger"
          title={`Put ${locker.name} in maintenance?`}
          description="The kiosk will not assign this locker to any rental."
          submitLabel="Start maintenance"
          danger
          action={setLockerMaintenance}
          hidden={{ lockerId: locker.id }}
          disabled={locker.hasOpenRental}
          disabledReason="Part of an ongoing rental"
        >
          <Field label="Reason">
            <TextArea name="reason" required minLength={3} maxLength={200} placeholder="e.g. Solenoid not releasing" />
          </Field>
        </ActionDialog>
      )}

      <button
        type="button"
        disabled
        title="Emergency unlock needs the kiosk command channel (Phase 13)"
        className="cursor-not-allowed rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-slate-400"
      >
        Unlock
      </button>
    </div>
  );
}
