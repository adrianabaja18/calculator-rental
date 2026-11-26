'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, PenaltyStatus } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { formatPeso } from '@/lib/format';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const WaiveSchema = z.object({
  penaltyId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

/**
 * Waives what is still owed on a penalty. Officers own waivers (sync
 * ownership rules): the kiosk keeps the amounts it collected and applies
 * the waiver on its next pull, so the student can borrow again.
 */
export async function waivePenalty(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  const parsed = WaiveSchema.safeParse({ penaltyId: formData.get('penaltyId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('penalties')
    .select('id, status, calculated_amount, waived_amount, amount_paid')
    .eq('id', parsed.data.penaltyId)
    .maybeSingle();
  if (!before) return actionFail('Penalty not found.');
  if (before.status !== PenaltyStatus.UNPAID && before.status !== PenaltyStatus.PARTIAL) {
    return actionFail(`This penalty is already ${before.status.toLowerCase()}.`);
  }

  const owed = Number(before.calculated_amount) - Number(before.waived_amount) - Number(before.amount_paid);
  const { error } = await db
    .from('penalties')
    .update({
      waived_amount: Number(before.waived_amount) + owed,
      waived_by: admin.id,
      waived_at: new Date().toISOString(),
      waive_reason: parsed.data.reason,
      status: PenaltyStatus.WAIVED,
    })
    .eq('id', before.id)
    .in('status', [PenaltyStatus.UNPAID, PenaltyStatus.PARTIAL]);
  if (error) return actionFromDbError(error);

  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'PENALTY_WAIVED',
    targetType: 'penalty',
    targetId: before.id,
    previousValue: { status: before.status, owed },
    newValue: { status: PenaltyStatus.WAIVED, waived: owed },
    reason: parsed.data.reason,
  });
  revalidatePath('/penalties');
  revalidatePath('/students');
  return actionOk(`${formatPeso(owed)} waived. The kiosk applies it on its next sync (within a minute).`);
}
