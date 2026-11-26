'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ActorType, AdminRole, PenaltyStatus } from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/session';
import { formatPeso } from '@/lib/format';
import { enqueueLocalSync, getLocalDb } from '@/lib/local-db';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const READ_ONLY_MSG = 'The online monitoring dashboard is read-only. Waive penalties on the local Raspberry Pi dashboard.';

const WaiveSchema = z.object({
  penaltyId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function waivePenalty(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = WaiveSchema.safeParse({ penaltyId: formData.get('penaltyId'), reason: formData.get('reason') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT * FROM penalties WHERE id = ?')
      .get(parsed.data.penaltyId) as
      | {
          id: string;
          status: PenaltyStatus;
          calculated_centavos: number;
          waived_centavos: number;
          amount_paid_centavos: number;
          amount_due_centavos: number;
        }
      | undefined;

    if (!before) return actionFail('Penalty not found.');
    if (before.status !== PenaltyStatus.UNPAID && before.status !== PenaltyStatus.PARTIAL) {
      return actionFail(`This penalty is already ${before.status.toLowerCase()}.`);
    }

    const owedCentavos = Math.max(0, before.calculated_centavos - before.waived_centavos - before.amount_paid_centavos);
    const nowIso = new Date().toISOString();
    const newWaivedCentavos = before.waived_centavos + owedCentavos;

    db.transaction(() => {
      db.prepare(
        `UPDATE penalties
         SET waived_centavos = ?, amount_due_centavos = 0, status = ?, waived_by = ?, waived_at = ?, waive_reason = ?, updated_at = ?
         WHERE id = ?`,
      ).run(newWaivedCentavos, PenaltyStatus.WAIVED, admin.id, nowIso, parsed.data.reason, nowIso, before.id);
      const updated = db.prepare('SELECT * FROM penalties WHERE id = ?').get(before.id);
      enqueueLocalSync(db, 'penalty', before.id, updated);
    })();

    const owedPesos = owedCentavos / 100;
    await writeAuditLog({
      actorType: ActorType.ADMIN,
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'PENALTY_WAIVED',
      targetType: 'penalty',
      targetId: before.id,
      previousValue: { status: before.status, owed: owedPesos },
      newValue: { status: PenaltyStatus.WAIVED, waived: owedPesos },
      reason: parsed.data.reason,
    });
    revalidatePath('/penalties');
    revalidatePath('/students');
    return actionOk(`${formatPeso(owedPesos)} waived immediately on the kiosk.`);
  }

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
  return actionOk(`${formatPeso(owed)} waived.`);
}
