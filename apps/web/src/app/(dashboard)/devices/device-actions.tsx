'use client';

import { useActionState, useEffect } from 'react';
import { IDLE_RESULT } from '@/lib/action-result';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, TextArea } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/toast';
import { requestDeviceSync, requestEmergencyUnlock, syncLocalKioskClock } from './actions';

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

export function SyncNowButton({ deviceId, local }: { deviceId: string; local?: boolean }) {
  return (
    <ActionDialog
      triggerLabel={local ? 'Push cloud sync' : 'Sync now'}
      title={local ? 'Push outbox to cloud now?' : 'Sync the kiosk now?'}
      description={
        local
          ? 'Triggers an immediate outbound upload of pending SQLite changes to the online monitoring dashboard (if configured and reachable).'
          : 'The kiosk downloads the latest settings, lockers, calculators, student blocks and penalty waivers right away.'
      }
      submitLabel={local ? 'Push now' : 'Sync now'}
      action={requestDeviceSync}
      hidden={{ deviceId }}
    />
  );
}

/**
 * Lets an officer sync the Raspberry Pi's kiosk clock from their phone/laptop
 * browser when running offline without internet NTP or a DS3231 RTC module.
 */
export function SyncClockButton() {
  const [state, formAction, pending] = useActionState(syncLocalKioskClock, IDLE_RESULT);
  const toast = useToast();

  useEffect(() => {
    if (state.at === 0) return;
    toast(state.ok ? 'success' : 'error', state.message);
  }, [state, toast]);

  return (
    <form
      action={(fd) => {
        fd.set('browserIso', new Date().toISOString());
        formAction(fd);
      }}
    >
      <input type="hidden" name="browserIso" value="" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? 'Syncing clock…' : 'Sync clock from browser'}
      </button>
    </form>
  );
}
