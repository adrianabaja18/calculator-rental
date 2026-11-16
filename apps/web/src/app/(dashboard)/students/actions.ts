'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, StudentStatus } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Officer actions on students. Each one:
 *   1. re-checks the admin's role on the server (requireAdmin),
 *   2. validates the form with Zod,
 *   3. writes with the service-role client (dashboard users are read-only in RLS),
 *   4. records an audit log entry with the before/after values.
 * Under SQLite-first, the kiosk picks up the new status on its next sync.
 */

const BlockSchema = z.object({
  studentId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function blockStudent(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = BlockSchema.safeParse({ studentId: formData.get('studentId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('students')
    .select('id, full_name, student_number, status, blocked_reason')
    .eq('id', parsed.data.studentId)
    .maybeSingle();
  if (!before) return actionFail('Student not found.');
  if (before.status === StudentStatus.BLOCKED) return actionFail(`${before.full_name} is already blocked.`);

  const { error } = await db
    .from('students')
    .update({ status: StudentStatus.BLOCKED, blocked_reason: parsed.data.reason })
    .eq('id', before.id);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'STUDENT_BLOCKED',
    targetType: 'student',
    targetId: before.id,
    previousValue: { status: before.status, blocked_reason: before.blocked_reason },
    newValue: { status: StudentStatus.BLOCKED, blocked_reason: parsed.data.reason },
    reason: parsed.data.reason,
  });

  revalidatePath('/students');
  return actionOk(`${before.full_name} (${before.student_number}) is now blocked.`);
}

const UnblockSchema = z.object({ studentId: z.uuid() });

export async function unblockStudent(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = UnblockSchema.safeParse({ studentId: formData.get('studentId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('students')
    .select('id, full_name, student_number, status, blocked_reason')
    .eq('id', parsed.data.studentId)
    .maybeSingle();
  if (!before) return actionFail('Student not found.');
  if (before.status !== StudentStatus.BLOCKED) return actionFail(`${before.full_name} is not blocked.`);

  const { error } = await db
    .from('students')
    .update({ status: StudentStatus.ACTIVE, blocked_reason: null })
    .eq('id', before.id);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'STUDENT_UNBLOCKED',
    targetType: 'student',
    targetId: before.id,
    previousValue: { status: before.status, blocked_reason: before.blocked_reason },
    newValue: { status: StudentStatus.ACTIVE, blocked_reason: null },
  });

  revalidatePath('/students');
  return actionOk(`${before.full_name} (${before.student_number}) is unblocked.`);
}
