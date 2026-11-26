'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ActorType } from '@calc-rental/shared';
import { writeAuditLog } from '@/lib/audit';
import { safeNextPath } from '@/lib/auth/redirect';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { LOCAL_SESSION_COOKIE, revokeLocalSession, signInLocalAdmin } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface LoginState {
  error: string | null;
  fieldErrors?: { email?: string; password?: string };
  email?: string;
}

const LoginSchema = z.object({
  email: z.email({ message: 'Enter a valid email address' }).trim().toLowerCase(),
  password: z.string().min(1, { message: 'Enter your password' }).max(200),
  next: z.string().optional(),
});

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });
  const submittedEmail = String(formData.get('email') ?? '');
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error).fieldErrors;
    return {
      error: null,
      fieldErrors: { email: flat.email?.[0], password: flat.password?.[0] },
      email: submittedEmail,
    };
  }

  const { email, password, next } = parsed.data;

  if (isLocalBackend()) {
    const outcome = signInLocalAdmin(email, password);
    if (!outcome.ok) {
      if (outcome.reason === 'inactive') {
        await writeAuditLog({
          actorType: ActorType.ADMIN,
          actorId: outcome.admin.id,
          actorLabel: email,
          action: 'LOGIN_REJECTED_INACTIVE',
          targetType: 'local_admin',
          targetId: outcome.admin.id,
        });
        return {
          error: 'Your account has not been activated yet. Ask a Super Admin to activate it.',
          email: submittedEmail,
        };
      }
      return { error: 'Invalid email or password.', email: submittedEmail };
    }

    const cookieStore = await cookies();
    const useSecureCookie = process.env.APP_URL?.startsWith('https://') ?? false;
    cookieStore.set(LOCAL_SESSION_COOKIE, outcome.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: useSecureCookie,
      path: '/',
      expires: outcome.expiresAt,
    });

    await writeAuditLog({
      actorType: ActorType.ADMIN,
      actorId: outcome.admin.id,
      actorLabel: outcome.admin.email,
      action: 'LOGIN',
      targetType: 'local_admin',
      targetId: outcome.admin.id,
      newValue: { role: outcome.admin.role, mode: 'local' },
    });

    redirect(safeNextPath(next));
  }

  if (!readPublicEnv() || !readServerEnv()) {
    return { error: 'The server is not configured yet. Check apps/web/.env.local.' };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    const tooMany = error?.status === 429;
    return {
      error: tooMany ? 'Too many attempts. Wait a minute and try again.' : 'Invalid email or password.',
      email: submittedEmail,
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', data.user.id)
    .maybeSingle();

  if (!profile?.is_active) {
    await supabase.auth.signOut();
    await writeAuditLog({
      actorType: ActorType.ADMIN,
      actorId: data.user.id,
      actorLabel: email,
      action: 'LOGIN_REJECTED_INACTIVE',
      targetType: 'profile',
      targetId: data.user.id,
    });
    return {
      error: 'Your account has not been activated yet. Ask a Super Admin to activate it.',
      email: submittedEmail,
    };
  }

  const admin = createSupabaseAdminClient();
  await admin.from('profiles').update({ last_login_at: new Date().toISOString() }).eq('id', data.user.id);
  await writeAuditLog({
    actorType: ActorType.ADMIN,
    actorId: data.user.id,
    actorLabel: email,
    action: 'LOGIN',
    targetType: 'profile',
    targetId: data.user.id,
    newValue: { role: profile.role },
  });

  redirect(safeNextPath(next));
}

export async function signOut(): Promise<void> {
  if (isLocalBackend()) {
    const cookieStore = await cookies();
    const rawToken = cookieStore.get(LOCAL_SESSION_COOKIE)?.value;
    const admin = revokeLocalSession(rawToken);
    cookieStore.delete(LOCAL_SESSION_COOKIE);
    if (admin) {
      await writeAuditLog({
        actorType: ActorType.ADMIN,
        actorId: admin.id,
        actorLabel: admin.email,
        action: 'LOGOUT',
        targetType: 'local_admin',
        targetId: admin.id,
      });
    }
    redirect('/login');
  }

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (claims?.sub) {
    await writeAuditLog({
      actorType: ActorType.ADMIN,
      actorId: claims.sub,
      actorLabel: typeof claims.email === 'string' ? claims.email : null,
      action: 'LOGOUT',
      targetType: 'profile',
      targetId: claims.sub,
    });
  }
  await supabase.auth.signOut();
  redirect('/login');
}
