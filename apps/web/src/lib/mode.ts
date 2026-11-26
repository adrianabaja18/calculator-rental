/**
 * Deployment mode helpers (safe in both Server and Client Components).
 *
 * - `local`    (default on Raspberry Pi 4 & local development):
 *              Both `apps/raspberry-pi` and `apps/web` read/write the local
 *              SQLite database (`SQLITE_PATH`). Full admin login and officer
 *              actions work 100% offline.
 * - `supabase` (online cloud dashboard, e.g. Vercel):
 *              Reads from Cloud Supabase for online monitoring (read-only by
 *              default) while `/api/device/*` receives outbound sync pushes
 *              from the Raspberry Pi.
 *
 * Note: `process.env.NEXT_PUBLIC_*` references are written out literally so
 * Next.js can inline them into client bundles.
 */

export type DataBackend = 'local' | 'supabase';

export function getDataBackend(): DataBackend {
  const explicit = process.env.NEXT_PUBLIC_DATA_BACKEND?.trim().toLowerCase();
  if (explicit === 'local') return 'local';
  if (explicit === 'supabase') return 'supabase';
  return process.env.NEXT_PUBLIC_SUPABASE_URL ? 'supabase' : 'local';
}

export function isLocalBackend(): boolean {
  return getDataBackend() === 'local';
}

/**
 * Online (`supabase`) dashboard is read-only monitoring by default; local Pi
 * dashboard (`local`) has full read/write authority.
 */
export function isDashboardReadOnly(): boolean {
  if (isLocalBackend()) return false;
  return process.env.NEXT_PUBLIC_CLOUD_ALLOW_WRITES !== 'true';
}
