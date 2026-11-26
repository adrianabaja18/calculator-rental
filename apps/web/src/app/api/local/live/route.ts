import { NextResponse } from 'next/server';
import { getCurrentAdmin } from '@/lib/auth/session';
import { getLocalConfig, getLocalDb } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lightweight change-token endpoint for `LiveRefresh` when running locally
 * on the Raspberry Pi 4 (replaces Supabase Realtime WebSockets offline).
 */
export async function GET() {
  if (!isLocalBackend()) {
    return NextResponse.json({ token: 'cloud' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const admin = await getCurrentAdmin();
  if (!admin?.isActive) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const db = getLocalDb();
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_queue').get() as { s: number }).s;
  const cmdStamp = (
    db
      .prepare('SELECT COALESCE(MAX(COALESCE(completed_at, sent_at, requested_at)), \'\') AS t FROM device_commands')
      .get() as { t: string }
  ).t;
  const lockerStamp = (db.prepare('SELECT COALESCE(MAX(updated_at), \'\') AS t FROM lockers').get() as { t: string }).t;
  const beat = getLocalConfig(db, 'kiosk_heartbeat') ?? '';
  const scanStamp = (
    db.prepare(`SELECT COALESCE(MAX(COALESCE(consumed_at, submitted_at, created_at)), '') AS t FROM scan_sessions`).get() as { t: string }
  ).t;

  return NextResponse.json(
    { token: `${maxSeq}:${cmdStamp}:${lockerStamp}:${scanStamp}:${beat.length}:${beat.slice(0, 48)}` },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
