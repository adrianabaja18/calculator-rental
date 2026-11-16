'use client';

import { useEffect } from 'react';

/** Error state for dashboard pages. Shows a friendly message, never server details. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6">
      <h2 className="text-base font-semibold text-red-900">Something went wrong loading this page</h2>
      <p className="mt-1 text-sm text-red-800">
        Please try again. If it keeps happening, report it with this reference: <code>{error.digest ?? 'n/a'}</code>
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
      >
        Try again
      </button>
    </div>
  );
}
