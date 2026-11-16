'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ActorType } from '@calc-rental/shared';
import { writeAuditLog } from '@/lib/audit';
import { safeNextPath } from '@/lib/auth/redirect';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Server Actions for signing in and out. They run ONLY on the server;
 * the browser just posts the form.
 */

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
  if (!readPublicEnv() || !readServerEnv()) {
    return { error: 'The server is not configured yet. Check apps/web/.env.local.' };
  }

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
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // Same message for "no such user" and "wrong password": don't reveal which emails exist.
    const tooMany = error?.status === 429;
    return {
      error: tooMany ? 'Too many attempts. Wait a minute and try again.' : 'Invalid email or password.',
      email: submittedEmail,
    };
  }

  // Signed in with Supabase — but is this person an ACTIVE admin?
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
