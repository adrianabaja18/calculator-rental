import 'server-only';
import { ActorType } from '@calc-rental/shared';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';

/**
 * Writes one row to the append-only audit_logs table (spec §30).
 *
 * Audit logging must never break the action being audited, so failures
 * are reported to the server log instead of thrown.
 */
export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  /** UPPER_SNAKE_CASE verb, e.g. LOGIN, SETTINGS_UPDATED, PENALTY_WAIVED */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  previousValue?: Json | null;
  newValue?: Json | null;
  reason?: string | null;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from('audit_logs').insert({
      actor_type: entry.actorType,
      actor_id: entry.actorId ?? null,
      actor_label: entry.actorLabel ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      previous_value: entry.previousValue ?? null,
      new_value: entry.newValue ?? null,
      reason: entry.reason ?? null,
    });
    if (error) console.error('[audit] failed to write audit log', { action: entry.action, error: error.message });
  } catch (error) {
    console.error('[audit] failed to write audit log', { action: entry.action, error });
  }
}

export { ActorType };
