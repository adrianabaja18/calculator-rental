'use client';

import { ADMIN_ROLE_LABEL, AdminRole } from '@calc-rental/shared';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, Select, TextInput } from '@/components/ui/form-field';
import { createAdminAction, resetAdminPasswordAction, updateAdminAction } from './actions';

const ROLE_OPTIONS = [
  { value: AdminRole.SUPER_ADMIN, label: ADMIN_ROLE_LABEL[AdminRole.SUPER_ADMIN] },
  { value: AdminRole.OFFICER, label: ADMIN_ROLE_LABEL[AdminRole.OFFICER] },
  { value: AdminRole.VIEWER, label: ADMIN_ROLE_LABEL[AdminRole.VIEWER] },
];

const ACTIVE_OPTIONS = [
  { value: 'true', label: 'Active (can sign in)' },
  { value: 'false', label: 'Deactivated (signed out immediately)' },
];

export function AddAdminButton() {
  return (
    <ActionDialog
      triggerLabel="+ Add account"
      triggerVariant="primary"
      title="Add local admin account"
      description="Creates an officer or viewer login stored locally in the Raspberry Pi SQLite database."
      submitLabel="Create account"
      action={createAdminAction}
    >
      <Field label="Email">
        <TextInput name="email" type="email" required placeholder="officer@calcrental.ph" />
      </Field>
      <Field label="Full name">
        <TextInput name="fullName" maxLength={100} placeholder="e.g. Maria Santos" />
      </Field>
      <Field label="Role">
        <Select name="role" defaultValue={AdminRole.OFFICER} options={ROLE_OPTIONS} />
      </Field>
      <Field label="Initial password" hint="At least 8 characters.">
        <TextInput name="password" type="password" required minLength={8} maxLength={200} />
      </Field>
    </ActionDialog>
  );
}

export function AdminRowActions({
  account,
  isSelf,
}: {
  account: { id: string; email: string; fullName: string | null; role: AdminRole; isActive: boolean };
  isSelf: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <ActionDialog
        triggerLabel="Edit"
        title={`Edit ${account.email}`}
        description={isSelf ? 'You cannot deactivate or lower your own Super Admin account.' : undefined}
        submitLabel="Save"
        action={updateAdminAction}
        hidden={{ adminId: account.id }}
      >
        <Field label="Full name">
          <TextInput name="fullName" defaultValue={account.fullName ?? ''} maxLength={100} />
        </Field>
        <Field label="Role">
          <Select name="role" defaultValue={account.role} options={ROLE_OPTIONS} disabled={isSelf} />
          {isSelf && <input type="hidden" name="role" value={account.role} />}
        </Field>
        <Field label="Status">
          <Select name="isActive" defaultValue={account.isActive ? 'true' : 'false'} options={ACTIVE_OPTIONS} disabled={isSelf} />
          {isSelf && <input type="hidden" name="isActive" value="true" />}
        </Field>
      </ActionDialog>

      <ActionDialog
        triggerLabel="Password"
        title={`Reset password for ${account.email}`}
        description="Sets a new password stored as a salted scrypt hash in SQLite."
        submitLabel="Update password"
        action={resetAdminPasswordAction}
        hidden={{ adminId: account.id }}
      >
        <Field label="New password" hint="At least 8 characters.">
          <TextInput name="newPassword" type="password" required minLength={8} maxLength={200} />
        </Field>
      </ActionDialog>
    </div>
  );
}
