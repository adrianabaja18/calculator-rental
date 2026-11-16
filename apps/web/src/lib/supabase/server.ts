import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Supabase client for SERVER COMPONENTS, SERVER ACTIONS and ROUTE HANDLERS
 * acting ON BEHALF OF THE LOGGED-IN ADMIN.
 *
 * It reads the admin's auth session from cookies, so Row Level Security
 * still applies with that admin's identity.
 */
export async function createSupabaseServerClient() {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
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
          // Safe to ignore: src/proxy.ts refreshes the session cookies.
        }
      },
    },
  });
}
