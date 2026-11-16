'use client';

import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';

/**
 * Supabase client for CLIENT COMPONENTS (runs in the officer's browser).
 *
 * Uses only the public anon/publishable key; every query is restricted by
 * Row Level Security policies (Phase 2/3). Used for admin login and
 * Supabase Realtime subscriptions on the dashboard (Phase 8).
 */
export function createSupabaseBrowserClient() {
  const env = getPublicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
