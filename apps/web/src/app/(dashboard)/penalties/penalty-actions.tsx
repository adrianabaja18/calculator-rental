'use client';

import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, TextArea } from '@/components/ui/form-field';
import { waivePenalty } from './actions';

export function WaivePenaltyButton({ penalty }: { penalty: { id: string; owed: string; studentName: string } }) {
  return (
    <ActionDialog
      triggerLabel="Waive"
      title="Waive this penalty?"
      description={
        <>
          <strong>{penalty.owed}</strong> owed by <strong>{penalty.studentName}</strong> will be cancelled. Coins already paid
          are kept. If unpaid penalties block borrowing, the student can borrow again after the kiosk&apos;s next sync.
        </>
      }
      submitLabel="Waive penalty"
      action={waivePenalty}
      hidden={{ penaltyId: penalty.id }}
    >
      <Field label="Reason" hint="Saved in the audit log.">
        <TextArea name="reason" required minLength={3} maxLength={200} placeholder="e.g. Kiosk was offline when the student came back" />
      </Field>
    </ActionDialog>
  );
}
