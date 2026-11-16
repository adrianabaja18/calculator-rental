'use client';

import { StudentStatus } from '@calc-rental/shared';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, TextArea } from '@/components/ui/form-field';
import { blockStudent, unblockStudent } from './actions';

export function StudentRowActions({
  student,
}: {
  student: { id: string; fullName: string; studentNumber: string; status: string; blockedReason: string | null };
}) {
  if (student.status === StudentStatus.BLOCKED) {
    return (
      <ActionDialog
        triggerLabel="Unblock"
        title="Unblock student?"
        description={
          <>
            <strong>{student.fullName}</strong> ({student.studentNumber}) will be able to borrow again.
            {student.blockedReason && <span className="mt-1 block">Blocked because: {student.blockedReason}</span>}
          </>
        }
        submitLabel="Unblock"
        action={unblockStudent}
        hidden={{ studentId: student.id }}
      />
    );
  }

  return (
    <ActionDialog
      triggerLabel="Block"
      triggerVariant="danger"
      title="Block student?"
      description={
        <>
          <strong>{student.fullName}</strong> ({student.studentNumber}) won&apos;t be able to borrow until unblocked. A
          calculator they already have can still be returned.
        </>
      }
      submitLabel="Block student"
      danger
      action={blockStudent}
      hidden={{ studentId: student.id }}
    >
      <Field label="Reason" hint="Saved in the audit log and shown to other officers.">
        <TextArea name="reason" required minLength={3} maxLength={200} placeholder="e.g. Repeatedly late returns" />
      </Field>
    </ActionDialog>
  );
}
