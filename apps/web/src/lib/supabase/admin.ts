import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getPublicEnv } from '@/lib/env';
import { getServerEnv } from '@/lib/env.server';

/**
 * PRIVILEGED Supabase client using the service-role (secret) key.
 * It BYPASSES Row Level Security.
 *
 * Use ONLY inside server code that has already done its own authorization:
 *   - device API routes (after the Raspberry Pi's credential is verified)
 *   - trusted server-side jobs (e.g. overdue processing)
 *
 * Never import this from a Client Component (`server-only` enforces that),
 * and never return raw results to an unauthenticated caller.
 */
export function createSupabaseAdminClient() {
  const publicEnv = getPublicEnv();
  const serverEnv = getServerEnv();

  return createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
