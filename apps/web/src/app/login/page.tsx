import type { Metadata } from 'next';
import { APP_NAME } from '@calc-rental/shared';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const configured = Boolean(readPublicEnv() && readServerEnv());

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-700 text-xl font-bold text-white">
            ₱
          </div>
          <h1 className="text-xl font-bold text-slate-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-slate-600">Officer dashboard — sign in to continue</p>
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
          Accounts are created by a Super Admin. Students don&apos;t need an account — they use the kiosk.
        </p>
      </div>
    </main>
  );
}
