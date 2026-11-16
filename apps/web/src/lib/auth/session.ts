import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Data Access Layer for authentication — the REAL security check.
 *
 * src/proxy.ts only does a fast, optimistic "is there a session cookie?"
 * redirect. Every protected page, Server Action and admin API must call
 * requireAdmin() here, which:
 *   1. verifies the JWT with Supabase (getClaims), and
 *   2. loads the admin's profile from the database (role + is_active).
 *
 * `cache()` makes it run at most once per request even if many
 * components ask for the current admin.
 */

export interface CurrentAdmin {
  id: string;
  email: string;
  fullName: string | null;
  role: AdminRole;
  isActive: boolean;
}

/** Returns the signed-in user's admin profile, or null if not signed in. */
export const getCurrentAdmin = cache(async (): Promise<CurrentAdmin | null> => {
  const supabase = await createSupabaseServerClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || !userId) return null;

  // RLS lets every signed-in user read their OWN profile row.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) {
    return {
      id: userId,
      email: typeof claimsData.claims.email === 'string' ? claimsData.claims.email : '',
      fullName: null,
      role: AdminRole.VIEWER,
      isActive: false,
    };
  }

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    isActive: profile.is_active,
  };
});

/**
 * Guard for pages, layouts and Server Actions.
 *  - not signed in             -> /login
 *  - signed in but not active  -> /pending
 *  - role below `minimumRole`  -> /dashboard?denied=1
 */
export async function requireAdmin(minimumRole: AdminRole = AdminRole.VIEWER): Promise<CurrentAdmin> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  if (!admin.isActive) redirect('/pending');
  if (!hasRole(admin.role, minimumRole)) redirect('/dashboard?denied=1');
  return admin;
}
