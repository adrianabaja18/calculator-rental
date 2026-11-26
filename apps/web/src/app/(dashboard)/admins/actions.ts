'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole } from '@calc-rental/shared';
import { actionFail, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import {
  LOCAL_SESSION_COOKIE,
  createLocalAdminAccount,
  resetLocalAdminPassword,
  updateLocalAdminAccount,
} from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';

const ROLES = [AdminRole.SUPER_ADMIN, AdminRole.OFFICER, AdminRole.VIEWER] as const;

const CreateAdminSchema = z.object({
  email: z.email({ message: 'Enter a valid email address' }).trim().toLowerCase(),
  fullName: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : null)),
  role: z.enum(ROLES),
  password: z.string().min(8, { message: 'Password must be at least 8 characters' }).max(200),
});

export async function createAdminAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireAdmin(AdminRole.SUPER_ADMIN);
  if (!isLocalBackend()) return actionFail('Admin management here is only for local Raspberry Pi accounts.');

  const parsed = CreateAdminSchema.safeParse({
    email: formData.get('email'),
    fullName: formData.get('fullName') ?? undefined,
    role: formData.get('role'),
    password: formData.get('password'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const created = createLocalAdminAccount(parsed.data);
  if (!created.ok) return actionFail(created.message);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: actor.id,
    actorLabel: actor.email,
    action: 'ADMIN_CREATED',
    targetType: 'local_admin',
    targetId: created.id,
    newValue: { email: parsed.data.email, fullName: parsed.data.fullName, role: parsed.data.role, isActive: true },
  });
  revalidatePath('/admins');
  return actionOk(`Account ${parsed.data.email} created.`);
}

const UpdateAdminSchema = z.object({
  adminId: z.uuid(),
  fullName: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : null)),
  role: z.enum(ROLES),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true'),
});

export async function updateAdminAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireAdmin(AdminRole.SUPER_ADMIN);
  if (!isLocalBackend()) return actionFail('Admin management here is only for local Raspberry Pi accounts.');

  const parsed = UpdateAdminSchema.safeParse({
    adminId: formData.get('adminId'),
    fullName: formData.get('fullName') ?? undefined,
    role: formData.get('role'),
    isActive: formData.get('isActive'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const updated = updateLocalAdminAccount({
    id: parsed.data.adminId,
    fullName: parsed.data.fullName,
    role: parsed.data.role,
    isActive: parsed.data.isActive,
    actorId: actor.id,
  });
  if (!updated.ok) return actionFail(updated.message);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: actor.id,
    actorLabel: actor.email,
    action: 'ADMIN_UPDATED',
    targetType: 'local_admin',
    targetId: parsed.data.adminId,
    previousValue: {
      fullName: updated.before.full_name,
      role: updated.before.role,
      isActive: updated.before.is_active === 1,
    },
    newValue: {
      fullName: parsed.data.fullName,
      role: parsed.data.role,
      isActive: parsed.data.isActive,
    },
  });
  revalidatePath('/admins');
  return actionOk(`Account ${updated.before.email} updated.`);
}

const ResetPasswordSchema = z.object({
  adminId: z.uuid(),
  newPassword: z.string().min(8, { message: 'Password must be at least 8 characters' }).max(200),
});

export async function resetAdminPasswordAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireAdmin(AdminRole.SUPER_ADMIN);
  if (!isLocalBackend()) return actionFail('Admin management here is only for local Raspberry Pi accounts.');

  const parsed = ResetPasswordSchema.safeParse({
    adminId: formData.get('adminId'),
    newPassword: formData.get('newPassword'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const cookieStore = await cookies();
  const currentToken = parsed.data.adminId === actor.id ? cookieStore.get(LOCAL_SESSION_COOKIE)?.value : null;

  const outcome = resetLocalAdminPassword({
    id: parsed.data.adminId,
    newPassword: parsed.data.newPassword,
    keepToken: currentToken,
  });
  if (!outcome.ok) return actionFail(outcome.message);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: actor.id,
    actorLabel: actor.email,
    action: 'ADMIN_PASSWORD_RESET',
    targetType: 'local_admin',
    targetId: parsed.data.adminId,
    newValue: { email: outcome.email },
  });
  revalidatePath('/admins');
  return actionOk(`Password updated for ${outcome.email}.`);
}
