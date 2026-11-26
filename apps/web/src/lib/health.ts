import 'server-only';
import {
  APP_VERSION,
  WEB_SERVICE_ID,
  type HealthReport,
  type ServiceCheck,
} from '@calc-rental/shared';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { getLocalDb, resolveLocalSqlitePath } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const CHECK_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function checkSupabasePublic(): Promise<ServiceCheck> {
  const env = readPublicEnv();
  if (!env) {
    return {
      status: 'not_configured',
      latencyMs: null,
      message: isLocalBackend()
        ? 'Running in local Raspberry Pi SQLite mode (cloud Supabase optional).'
        : 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set in apps/web/.env.local.',
    };
  }

  const started = performance.now();
  try {
    const response = await fetch(new URL('/auth/v1/health', env.NEXT_PUBLIC_SUPABASE_URL), {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - started);

    if (response.ok) {
      return { status: 'ok', latencyMs, message: 'Supabase reachable; public key accepted.' };
    }
    return {
      status: 'error',
      latencyMs,
      message:
        response.status === 401 || response.status === 403
          ? `Supabase rejected the public key (HTTP ${response.status}). Check NEXT_PUBLIC_SUPABASE_ANON_KEY.`
          : `Supabase responded with HTTP ${response.status}.`,
    };
  } catch {
    return {
      status: 'unreachable',
      latencyMs: null,
      message: 'Could not reach Supabase (offline or timeout). Local SQLite keeps running.',
    };
  }
}

async function checkSupabaseAdmin(): Promise<ServiceCheck> {
  if (!readPublicEnv() || !readServerEnv()) {
    return {
      status: 'not_configured',
      latencyMs: null,
      message: isLocalBackend()
        ? 'Local SQLite mode active; service-role key is only required on the online cloud deployment.'
        : 'SUPABASE_SERVICE_ROLE_KEY (and the public Supabase URL) must be set in apps/web/.env.local.',
    };
  }

  const started = performance.now();
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await withTimeout(
      admin.auth.admin.listUsers({ page: 1, perPage: 1 }),
      CHECK_TIMEOUT_MS,
    );
    const latencyMs = Math.round(performance.now() - started);

    if (error) {
      return {
        status: 'error',
        latencyMs,
        message: 'Supabase rejected the service-role key. Check SUPABASE_SERVICE_ROLE_KEY.',
      };
    }
    return { status: 'ok', latencyMs, message: 'Service-role key accepted (server-side only).' };
  } catch {
    return {
      status: 'unreachable',
      latencyMs: null,
      message: 'Could not reach Supabase with the service-role client (offline or timeout).',
    };
  }
}

function checkLocalSqlite(): ServiceCheck {
  const started = performance.now();
  try {
    const db = getLocalDb();
    const quick = db.pragma('quick_check', { simple: true });
    const version = db.pragma('user_version', { simple: true });
    const latencyMs = Math.round(performance.now() - started);
    if (quick !== 'ok') {
      return { status: 'error', latencyMs, message: `SQLite quick_check reported: ${String(quick)}` };
    }
    return {
      status: 'ok',
      latencyMs,
      message: `Local SQLite ready (v${String(version)}, WAL) at ${resolveLocalSqlitePath()}`,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: null,
      message: `Local SQLite failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  if (isLocalBackend()) {
    const localCheck = checkLocalSqlite();
    const cloudConfigured = Boolean(readPublicEnv() && readServerEnv());
    const [supabase, supabaseAdmin] = cloudConfigured
      ? await Promise.all([checkSupabasePublic(), checkSupabaseAdmin()])
      : [localCheck, { status: 'ok' as const, latencyMs: localCheck.latencyMs, message: 'Local admin authentication & SQLite store active.' }];

    return {
      service: WEB_SERVICE_ID,
      status: localCheck.status === 'ok' ? 'ok' : 'degraded',
      version: APP_VERSION,
      environment: `${process.env.NODE_ENV ?? 'development'}-local`,
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: { supabase, supabaseAdmin },
    };
  }

  const [supabase, supabaseAdmin] = await Promise.all([
    checkSupabasePublic(),
    checkSupabaseAdmin(),
  ]);

  const allOk = supabase.status === 'ok' && supabaseAdmin.status === 'ok';

  return {
    service: WEB_SERVICE_ID,
    status: allOk ? 'ok' : 'degraded',
    version: APP_VERSION,
    environment: process.env.NODE_ENV ?? 'development',
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: { supabase, supabaseAdmin },
  };
}
