import type { Metadata, Viewport } from 'next';
import { ScanClient } from './scan-client';

/** PUBLIC page for students (no login): scan your school ID with your phone. */
export const metadata: Metadata = { title: 'Scan your ID', robots: { index: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1d4ed8' };

export default function ScanPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-md bg-slate-50 px-4 pb-10 pt-6">
      <ScanClient />
    </main>
  );
}
