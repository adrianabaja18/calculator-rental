import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="text-center">
        <p className="text-sm font-semibold text-blue-700">404</p>
        <h1 className="mt-1 text-xl font-bold text-slate-900">Page not found</h1>
        <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-blue-700 hover:underline">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
