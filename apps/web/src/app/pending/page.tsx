import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentAdmin } from '@/lib/auth/session';
import { signOut } from '@/lib/auth/actions';

export const metadata: Metadata = { title: 'Account pending' };

/** Shown to a signed-in user whose admin profile is not (or no longer) active. */
export default async function PendingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  if (admin.isActive) redirect('/dashboard');

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Account not active</h1>
        <p className="mt-2 text-sm text-slate-600">
          You are signed in as <strong>{admin.email}</strong>, but this account has not been activated (or was
          deactivated). Ask a Super Admin to activate it.
        </p>
        <form action={signOut} className="mt-6">
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
