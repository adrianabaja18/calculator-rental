import 'server-only';
import { ActorType } from '@calc-rental/shared';
import { writeLocalAuditLog } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  previousValue?: Json | null;
  newValue?: Json | null;
  reason?: string | null;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    if (isLocalBackend()) {
      writeLocalAuditLog(entry);
      return;
    }

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
