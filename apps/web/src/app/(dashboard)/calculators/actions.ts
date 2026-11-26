'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ActorType,
  AdminRole,
  CalculatorCodeSchema,
  CalculatorCondition,
  CalculatorStatus,
  OPEN_RENTAL_STATUSES,
  RfidUidSchema,
} from '@calc-rental/shared';
import { actionFail, actionFromDbError, actionFromZodError, actionOk, type ActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin, type CurrentAdmin } from '@/lib/auth/session';
import { enqueueLocalSync, getLocalDb } from '@/lib/local-db';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const READ_ONLY_MSG = 'The online monitoring dashboard is read-only. Edit calculators on the local Raspberry Pi dashboard.';
const OPEN_LIST = OPEN_RENTAL_STATUSES.map((s) => `'${s}'`).join(', ');

const UNIQUE_MESSAGES = {
  calculators_code_key: 'That calculator code is already used.',
  calculators_rfid_uid_key: 'That RFID tag is already assigned to another calculator.',
  calculators_locker_id_key: 'That locker already holds another calculator.',
};

function friendlySqliteUniqueError(error: unknown): ActionResult {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('calculators.code')) return actionFail(UNIQUE_MESSAGES.calculators_code_key);
  if (msg.includes('calculators.rfid_uid')) return actionFail(UNIQUE_MESSAGES.calculators_rfid_uid_key);
  if (msg.includes('calculators.locker_id')) return actionFail(UNIQUE_MESSAGES.calculators_locker_id_key);
  return actionFail('Could not save calculator due to a database constraint.');
}

const optionalUuid = z
  .string()
  .optional()
  .transform((v) => (v ? v : null))
  .pipe(z.uuid({ message: 'Choose a valid locker' }).nullable());

const DetailsSchema = z.object({
  model: z.string().trim().min(1, { message: 'Enter the model' }).max(100),
  rfidUid: RfidUidSchema,
  lockerId: optionalUuid,
  condition: z.enum(Object.values(CalculatorCondition) as [CalculatorCondition, ...CalculatorCondition[]]),
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),
});

function readDetails(formData: FormData) {
  return {
    model: formData.get('model'),
    rfidUid: formData.get('rfidUid'),
    lockerId: formData.get('lockerId') ?? undefined,
    condition: formData.get('condition'),
    notes: formData.get('notes') ?? undefined,
  };
}

async function hasOpenRental(calculatorId: string): Promise<boolean> {
  if (isLocalBackend()) {
    const db = getLocalDb();
    return Boolean(
      db.prepare(`SELECT 1 FROM rentals WHERE calculator_id = ? AND status IN (${OPEN_LIST})`).get(calculatorId),
    );
  }
  const db = createSupabaseAdminClient();
  const { count } = await db
    .from('rental_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('calculator_id', calculatorId)
    .in('status', [...OPEN_RENTAL_STATUSES]);
  return (count ?? 0) > 0;
}

function audit(admin: CurrentAdmin, action: string, id: string, previousValue: object | null, newValue: object, reason?: string) {
  return writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: admin.id,
    actorLabel: admin.email,
    action,
    targetType: 'calculator',
    targetId: id,
    previousValue: previousValue as never,
    newValue: newValue as never,
    reason,
  });
}

export async function createCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = DetailsSchema.extend({ code: CalculatorCodeSchema }).safeParse({
    ...readDetails(formData),
    code: formData.get('code'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);
  const input = parsed.data;

  const status =
    input.lockerId && input.condition !== CalculatorCondition.DAMAGED
      ? CalculatorStatus.AVAILABLE
      : CalculatorStatus.MAINTENANCE;

  if (isLocalBackend()) {
    const db = getLocalDb();
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO calculators (id, code, model, rfid_uid, locker_id, status, condition, notes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.code, input.model, input.rfidUid, input.lockerId, status, input.condition, input.notes, nowIso);
        const saved = db.prepare('SELECT * FROM calculators WHERE id = ?').get(id);
        enqueueLocalSync(db, 'calculator', id, saved);
      })();
    } catch (error) {
      return friendlySqliteUniqueError(error);
    }

    await audit(admin, 'CALCULATOR_CREATED', id, null, { ...input, status });
    revalidatePath('/calculators');
    revalidatePath('/lockers');
    return actionOk(
      `${input.code} added${status === CalculatorStatus.MAINTENANCE ? ' in MAINTENANCE (assign a locker to make it available)' : ''}.`,
    );
  }

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from('calculators')
    .insert({
      code: input.code,
      model: input.model,
      rfid_uid: input.rfidUid,
      locker_id: input.lockerId,
      condition: input.condition,
      notes: input.notes,
      status,
    })
    .select('id')
    .single();
  if (error) return actionFromDbError(error, UNIQUE_MESSAGES);

  await audit(admin, 'CALCULATOR_CREATED', data.id, null, { ...input, status });
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(
    `${input.code} added${status === CalculatorStatus.MAINTENANCE ? ' in MAINTENANCE (assign a locker to make it available)' : ''}.`,
  );
}

export async function updateCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = DetailsSchema.extend({ calculatorId: z.uuid() }).safeParse({
    ...readDetails(formData),
    calculatorId: formData.get('calculatorId'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);
  const input = parsed.data;

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT id, code, model, rfid_uid, locker_id, condition, notes, status FROM calculators WHERE id = ?')
      .get(input.calculatorId) as
      | {
          id: string;
          code: string;
          model: string;
          rfid_uid: string;
          locker_id: string | null;
          condition: CalculatorCondition;
          notes: string | null;
          status: CalculatorStatus;
        }
      | undefined;
    if (!before) return actionFail('Calculator not found.');

    const identityChanged = before.rfid_uid !== input.rfidUid || before.locker_id !== input.lockerId;
    if (identityChanged && (await hasOpenRental(before.id))) {
      return actionFail(`${before.code} is out with a student. Change its RFID tag or locker after it is returned.`);
    }
    if (before.status === CalculatorStatus.AVAILABLE && !input.lockerId) {
      return actionFail('An available calculator must stay in a locker. Move it to maintenance first.');
    }
    if (before.status === CalculatorStatus.AVAILABLE && input.condition === CalculatorCondition.DAMAGED) {
      return actionFail('A damaged calculator cannot stay available. Move it to maintenance first.');
    }

    const nowIso = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE calculators SET model = ?, rfid_uid = ?, locker_id = ?, condition = ?, notes = ?, updated_at = ? WHERE id = ?`,
        ).run(input.model, input.rfidUid, input.lockerId, input.condition, input.notes, nowIso, before.id);
        const saved = db.prepare('SELECT * FROM calculators WHERE id = ?').get(before.id);
        enqueueLocalSync(db, 'calculator', before.id, saved);
      })();
    } catch (error) {
      return friendlySqliteUniqueError(error);
    }

    const changes = {
      model: input.model,
      rfid_uid: input.rfidUid,
      locker_id: input.lockerId,
      condition: input.condition,
      notes: input.notes,
    };
    await audit(admin, 'CALCULATOR_UPDATED', before.id, before, changes);
    revalidatePath('/calculators');
    revalidatePath('/lockers');
    return actionOk(`${before.code} updated immediately on the kiosk.`);
  }

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('calculators')
    .select('id, code, model, rfid_uid, locker_id, condition, notes, status')
    .eq('id', input.calculatorId)
    .maybeSingle();
  if (!before) return actionFail('Calculator not found.');

  const identityChanged = before.rfid_uid !== input.rfidUid || before.locker_id !== input.lockerId;
  if (identityChanged && (await hasOpenRental(before.id))) {
    return actionFail(`${before.code} is out with a student. Change its RFID tag or locker after it is returned.`);
  }
  if (before.status === CalculatorStatus.AVAILABLE && !input.lockerId) {
    return actionFail('An available calculator must stay in a locker. Move it to maintenance first.');
  }
  if (before.status === CalculatorStatus.AVAILABLE && input.condition === CalculatorCondition.DAMAGED) {
    return actionFail('A damaged calculator cannot stay available. Move it to maintenance first.');
  }

  const changes = {
    model: input.model,
    rfid_uid: input.rfidUid,
    locker_id: input.lockerId,
    condition: input.condition,
    notes: input.notes,
  };
  const { error } = await db.from('calculators').update(changes).eq('id', before.id);
  if (error) return actionFromDbError(error, UNIQUE_MESSAGES);

  await audit(admin, 'CALCULATOR_UPDATED', before.id, before, changes);
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(`${before.code} updated.`);
}

const StatusChangeSchema = z.object({
  calculatorId: z.uuid(),
  reason: z.string().trim().min(3, { message: 'Give a reason (at least 3 characters)' }).max(200),
});

export async function moveCalculatorToMaintenance(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = StatusChangeSchema.safeParse({
    calculatorId: formData.get('calculatorId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT id, code, status FROM calculators WHERE id = ?')
      .get(parsed.data.calculatorId) as { id: string; code: string; status: CalculatorStatus } | undefined;
    if (!before) return actionFail('Calculator not found.');
    if (before.status === CalculatorStatus.MAINTENANCE) return actionFail(`${before.code} is already in maintenance.`);
    if (before.status === CalculatorStatus.RENTED || (await hasOpenRental(before.id))) {
      return actionFail(`${before.code} is out with a student. Move it to maintenance after it is returned.`);
    }

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE calculators SET status = ?, updated_at = ? WHERE id = ?').run(
        CalculatorStatus.MAINTENANCE,
        nowIso,
        before.id,
      );
      enqueueLocalSync(db, 'calculator', before.id, db.prepare('SELECT * FROM calculators WHERE id = ?').get(before.id));
    })();

    await audit(admin, 'CALCULATOR_MAINTENANCE', before.id, { status: before.status }, { status: CalculatorStatus.MAINTENANCE }, parsed.data.reason);
    revalidatePath('/calculators');
    revalidatePath('/lockers');
    return actionOk(`${before.code} moved to maintenance. The kiosk will not lend it out.`);
  }

  const db = createSupabaseAdminClient();
  const { data: before } = await db.from('calculators').select('id, code, status').eq('id', parsed.data.calculatorId).maybeSingle();
  if (!before) return actionFail('Calculator not found.');
  if (before.status === CalculatorStatus.MAINTENANCE) return actionFail(`${before.code} is already in maintenance.`);
  if (before.status === CalculatorStatus.RENTED || (await hasOpenRental(before.id))) {
    return actionFail(`${before.code} is out with a student. Move it to maintenance after it is returned.`);
  }

  const { error } = await db.from('calculators').update({ status: CalculatorStatus.MAINTENANCE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await audit(admin, 'CALCULATOR_MAINTENANCE', before.id, { status: before.status }, { status: CalculatorStatus.MAINTENANCE }, parsed.data.reason);
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(`${before.code} moved to maintenance. The kiosk will not lend it out.`);
}

export async function reactivateCalculator(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireAdmin(AdminRole.OFFICER);
  if (isDashboardReadOnly()) return actionFail(READ_ONLY_MSG);

  const parsed = z.object({ calculatorId: z.uuid() }).safeParse({ calculatorId: formData.get('calculatorId') });
  if (!parsed.success) return actionFromZodError(parsed.error);

  if (isLocalBackend()) {
    const db = getLocalDb();
    const before = db
      .prepare('SELECT id, code, status, locker_id, condition FROM calculators WHERE id = ?')
      .get(parsed.data.calculatorId) as
      | { id: string; code: string; status: CalculatorStatus; locker_id: string | null; condition: CalculatorCondition }
      | undefined;
    if (!before) return actionFail('Calculator not found.');
    if (before.status === CalculatorStatus.AVAILABLE || before.status === CalculatorStatus.RENTED) {
      return actionFail(`${before.code} is already in service.`);
    }
    if (!before.locker_id) return actionFail(`Assign ${before.code} to a locker first (Edit).`);
    if (before.condition === CalculatorCondition.DAMAGED) {
      return actionFail(`${before.code} is marked DAMAGED. Change its condition first (Edit).`);
    }

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE calculators SET status = ?, updated_at = ? WHERE id = ?').run(
        CalculatorStatus.AVAILABLE,
        nowIso,
        before.id,
      );
      enqueueLocalSync(db, 'calculator', before.id, db.prepare('SELECT * FROM calculators WHERE id = ?').get(before.id));
    })();

    await audit(admin, 'CALCULATOR_REACTIVATED', before.id, { status: before.status }, { status: CalculatorStatus.AVAILABLE });
    revalidatePath('/calculators');
    revalidatePath('/lockers');
    return actionOk(`${before.code} is available again.`);
  }

  const db = createSupabaseAdminClient();
  const { data: before } = await db
    .from('calculators')
    .select('id, code, status, locker_id, condition')
    .eq('id', parsed.data.calculatorId)
    .maybeSingle();
  if (!before) return actionFail('Calculator not found.');
  if (before.status === CalculatorStatus.AVAILABLE || before.status === CalculatorStatus.RENTED) {
    return actionFail(`${before.code} is already in service.`);
  }
  if (!before.locker_id) return actionFail(`Assign ${before.code} to a locker first (Edit).`);
  if (before.condition === CalculatorCondition.DAMAGED) {
    return actionFail(`${before.code} is marked DAMAGED. Change its condition first (Edit).`);
  }

  const { error } = await db.from('calculators').update({ status: CalculatorStatus.AVAILABLE }).eq('id', before.id);
  if (error) return actionFromDbError(error);

  await audit(admin, 'CALCULATOR_REACTIVATED', before.id, { status: before.status }, { status: CalculatorStatus.AVAILABLE });
  revalidatePath('/calculators');
  revalidatePath('/lockers');
  return actionOk(`${before.code} is available again.`);
}
