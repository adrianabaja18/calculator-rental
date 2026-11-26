'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, StudentStatus } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { enqueueLocalSync, getLocalDb } from '@/lib/local-db';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const READ_ONLY_MSG = 'The online monitoring dashboard is read-only. Block or unblock students on the local Raspberry Pi dashboard.';

const BlockSchema = z.object({
  studentId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function blockStudent(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = BlockSchema.safeParse({ studentId: formData.get('studentId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT id, full_name, student_number, status, blocked_reason FROM students WHERE id = ?')
      .get(parsed.data.studentId) as
      | { id: string; full_name: string; student_number: string; status: StudentStatus; blocked_reason: string | null }
      | undefined;
    if (!before) return actionFail('Student not found.');
    if (before.status === StudentStatus.BLOCKED) return actionFail(`${before.full_name} is already blocked.`);

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE students SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?').run(
        StudentStatus.BLOCKED,
        parsed.data.reason,
        nowIso,
        before.id,
      );
      enqueueLocalSync(db, 'student_admin', before.id, db.prepare('SELECT * FROM students WHERE id = ?').get(before.id));
    })();

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
    return actionOk(`${before.full_name} (${before.student_number}) is now blocked on the kiosk.`);
  }

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
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = UnblockSchema.safeParse({ studentId: formData.get('studentId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT id, full_name, student_number, status, blocked_reason FROM students WHERE id = ?')
      .get(parsed.data.studentId) as
      | { id: string; full_name: string; student_number: string; status: StudentStatus; blocked_reason: string | null }
      | undefined;
    if (!before) return actionFail('Student not found.');
    if (before.status !== StudentStatus.BLOCKED) return actionFail(`${before.full_name} is not blocked.`);

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE students SET status = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?').run(
        StudentStatus.ACTIVE,
        nowIso,
        before.id,
      );
      enqueueLocalSync(db, 'student_admin', before.id, db.prepare('SELECT * FROM students WHERE id = ?').get(before.id));
    })();

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
