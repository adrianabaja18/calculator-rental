import { APP_NAME } from '@calc-rental/shared';
import { HealthPanel } from '@/components/health-panel';

/**
 * Phase 1 landing page: confirms the web application is running.
 * Phase 3 replaces this with the login screen + dashboard shell.
 */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6">
      <header className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-700">CPE 411 · Phase 1</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{APP_NAME}</h1>
        <p className="max-w-2xl text-slate-600">
          The admin dashboard is running. This page checks that the backend API works and
          that the server can reach Supabase with both the public and the server-only keys.
        </p>
      </header>

      <HealthPanel />
    </main>
  );
}
