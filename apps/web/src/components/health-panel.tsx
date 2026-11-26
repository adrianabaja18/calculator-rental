'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  HealthResponseSchema,
  formatPhilippineDateTime,
  type HealthReport,
  type ServiceCheck,
} from '@calc-rental/shared';
import { StatusBadge, type BadgeTone } from '@/components/status-badge';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: HealthReport; fetchedAt: Date };

const checkTone: Record<ServiceCheck['status'], BadgeTone> = {
  ok: 'green',
  not_configured: 'amber',
  unreachable: 'red',
  error: 'red',
};

const checkLabel: Record<ServiceCheck['status'], string> = {
  ok: 'OK',
  not_configured: 'Not configured',
  unreachable: 'Unreachable',
  error: 'Error',
};

/**
 * Calls GET /api/health from the browser and shows the result.
 * Proves three things at once: the page renders, the API route runs,
 * and the shared Zod contract validates the response.
 */
export function HealthPanel() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const parsed = HealthResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        setState({ kind: 'error', message: 'The health API returned an unexpected response shape.' });
        return;
      }
      if (!parsed.data.success) {
        setState({ kind: 'error', message: parsed.data.error.message });
        return;
      }
      setState({ kind: 'ready', report: parsed.data.data, fetchedAt: new Date() });
    } catch {
      setState({ kind: 'error', message: 'Could not reach /api/health. Is the dev server running?' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="health-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="health-heading" className="text-lg font-semibold text-slate-900">
          System check
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.kind === 'loading'}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.kind === 'loading' ? 'Checking…' : 'Run check again'}
        </button>
      </div>

      {state.kind === 'loading' && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500" role="status">
          Contacting <code className="font-mono">/api/health</code>…
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800" role="alert">
          {state.message}
        </div>
      )}

      {state.kind === 'ready' && <HealthDetails report={state.report} fetchedAt={state.fetchedAt} />}
    </section>
  );
}

function HealthDetails({ report, fetchedAt }: { report: HealthReport; fetchedAt: Date }) {
  const isLocal = report.environment.endsWith('-local');
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Web application">
          <StatusBadge tone="green">Running</StatusBadge>
          <p className="mt-2 text-sm text-slate-600">
            v{report.version} · {report.environment} · up {report.uptimeSeconds}s
          </p>
        </Card>

        <Card title="Health API">
          <StatusBadge tone={report.status === 'ok' ? 'green' : 'amber'}>
            {report.status === 'ok' ? 'All checks OK' : 'Degraded'}
          </StatusBadge>
          <p className="mt-2 text-sm text-slate-600">
            <code className="font-mono">GET /api/health</code> responded and passed schema validation.
          </p>
        </Card>

        <Card title="Server time">
          <p className="text-sm font-medium text-slate-900">
            {formatPhilippineDateTime(report.serverTime)} <span className="text-slate-500">(PH)</span>
          </p>
          <p className="mt-1 font-mono text-xs text-slate-500">{report.serverTime} (UTC, stored)</p>
        </Card>

        <CheckCard title={isLocal ? 'Primary database (Local SQLite)' : 'Supabase (public key)'} check={report.checks.supabase} />
        <CheckCard title={isLocal ? 'Admin auth (Local Raspberry Pi)' : 'Supabase (service role, server-only)'} check={report.checks.supabaseAdmin} />
      </div>

      <p className="text-xs text-slate-500">Last checked {formatPhilippineDateTime(fetchedAt)} (PH time)</p>
    </div>
  );
}

function CheckCard({ title, check }: { title: string; check: ServiceCheck }) {
  return (
    <Card title={title}>
      <div className="flex items-center gap-2">
        <StatusBadge tone={checkTone[check.status]}>{checkLabel[check.status]}</StatusBadge>
        {check.latencyMs !== null && <span className="text-xs text-slate-500">{check.latencyMs} ms</span>}
      </div>
      <p className="mt-2 text-sm text-slate-600">{check.message}</p>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-medium text-slate-500">{title}</h3>
      {children}
    </div>
  );
}
