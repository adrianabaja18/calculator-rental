import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/lib/env';

/**
 * Supabase client for SERVER COMPONENTS, SERVER ACTIONS and ROUTE HANDLERS
 * acting ON BEHALF OF THE LOGGED-IN ADMIN.
 *
 * It reads the admin's auth session from cookies, so Row Level Security
 * still applies with that admin's identity. Use this for anything an
 * officer does from the dashboard.
 */
export async function createSupabaseServerClient() {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore: the session-refresh proxy (Phase 3) writes them.
        }
      },
    },
  });
}
