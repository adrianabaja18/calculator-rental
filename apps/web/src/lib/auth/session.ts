import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminRole, hasRole } from '@calc-rental/shared';
import { readPublicEnv } from '@/lib/env';
import { LOCAL_SESSION_COOKIE, getLocalSessionAdmin } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface CurrentAdmin {
  id: string;
  email: string;
  fullName: string | null;
  role: AdminRole;
  isActive: boolean;
}

/** Returns the signed-in user's admin profile, or null if not signed in. */
export const getCurrentAdmin = cache(async (): Promise<CurrentAdmin | null> => {
  const cookieStore = await cookies();

  if (isLocalBackend()) {
    const rawToken = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
    const localAdmin = getLocalSessionAdmin(rawToken);
    if (!localAdmin) return null;
    return {
      id: localAdmin.id,
      email: localAdmin.email,
      fullName: localAdmin.full_name,
      role: localAdmin.role,
      isActive: localAdmin.is_active === 1,
    };
  }

  if (!readPublicEnv()) return null;

  const supabase = await createSupabaseServerClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (claimsError || !userId) return null;

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
