'use client';

import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, TextArea } from '@/components/ui/form-field';
import { requestDeviceSync, requestEmergencyUnlock } from './actions';

export function EmergencyUnlockButton({ locker, online }: { locker: { id: string; name: string }; online: boolean }) {
  return (
    <ActionDialog
      triggerLabel="Emergency unlock"
      triggerVariant="danger"
      title={`Unlock ${locker.name}?`}
      description={
        <>
          The kiosk unlocks <strong>{locker.name}</strong> for 10 seconds, only if no student is using the kiosk at that
          moment. Use it to free a stuck calculator or check the locker. The request is logged with your name.
        </>
      }
      submitLabel="Unlock"
      danger
      action={requestEmergencyUnlock}
      hidden={{ lockerId: locker.id }}
      disabled={!online}
      disabledReason="The kiosk is offline, so it can't receive the command."
    >
      <Field label="Reason" hint="Saved in the audit log.">
        <TextArea name="reason" required minLength={3} maxLength={200} placeholder="e.g. Calculator stuck, student waiting" />
      </Field>
    </ActionDialog>
  );
}

export function SyncNowButton({ deviceId }: { deviceId: string }) {
  return (
    <ActionDialog
      triggerLabel="Sync now"
      title="Sync the kiosk now?"
      description="The kiosk downloads the latest settings, lockers, calculators, student blocks and penalty waivers right away instead of within the next minute."
      submitLabel="Sync now"
      action={requestDeviceSync}
      hidden={{ deviceId }}
    />
  );
}
