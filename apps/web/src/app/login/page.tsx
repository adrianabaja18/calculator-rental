import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { APP_NAME } from '@calc-rental/shared';
import { safeNextPath } from '@/lib/auth/redirect';
import { getCurrentAdmin } from '@/lib/auth/session';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { getLocalDb } from '@/lib/local-db';
import { isDashboardReadOnly, isLocalBackend } from '@/lib/mode';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const local = isLocalBackend();

  // Ensure default local Super Admin is bootstrapped on first visit.
  if (local) {
    getLocalDb();
  }

  const current = await getCurrentAdmin();
  if (current?.isActive) {
    redirect(safeNextPath(next));
  }

  const configured = local ? true : Boolean(readPublicEnv() && readServerEnv());
  const readOnlyCloud = !local && isDashboardReadOnly();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-700 text-xl font-bold text-white">
            ₱
          </div>
          <h1 className="text-xl font-bold text-slate-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {local
              ? 'Local Raspberry Pi dashboard — sign in to continue'
              : readOnlyCloud
                ? 'Online monitoring dashboard (read-only) — sign in'
                : 'Officer dashboard — sign in to continue'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {!configured && (
            <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Supabase is not configured on this server. Copy <code>apps/web/.env.example</code> to{' '}
              <code>apps/web/.env.local</code> and fill it in, then restart.
            </div>
          )}
          <LoginForm next={next} />
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          {local
            ? 'Running locally on SQLite. Super Admins can manage officer accounts under Admin Accounts.'
            : 'Accounts are created by a Super Admin. Students don’t need an account — they use the kiosk.'}
        </p>
      </div>
    </main>
  );
}
