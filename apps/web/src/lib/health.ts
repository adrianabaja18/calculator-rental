import 'server-only';
import {
  APP_VERSION,
  WEB_SERVICE_ID,
  type HealthReport,
  type ServiceCheck,
} from '@calc-rental/shared';
import { readPublicEnv } from '@/lib/env';
import { readServerEnv } from '@/lib/env.server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

const CHECK_TIMEOUT_MS = 5_000;

/** Rejects if `promise` takes longer than `ms`. */
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

/**
 * Checks that the public (anon/publishable) key can reach Supabase.
 * Calls the Auth service's health endpoint — it needs no tables, so it
 * works in Phase 1 before any migration exists.
 */
async function checkSupabasePublic(): Promise<ServiceCheck> {
  const env = readPublicEnv();
  if (!env) {
    return {
      status: 'not_configured',
      latencyMs: null,
      message: 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set in apps/web/.env.local.',
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
      message: 'Could not reach Supabase (network error or timeout). Check NEXT_PUBLIC_SUPABASE_URL and your internet connection.',
    };
  }
}

/**
 * Checks that the server-only service-role key is valid by calling an
 * admin-only Auth API (list at most 1 user). Only "ok"/"error" is reported —
 * no user data ever leaves this function.
 */
async function checkSupabaseAdmin(): Promise<ServiceCheck> {
  if (!readPublicEnv() || !readServerEnv()) {
    return {
      status: 'not_configured',
      latencyMs: null,
      message: 'SUPABASE_SERVICE_ROLE_KEY (and the public Supabase URL) must be set in apps/web/.env.local.',
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
      message: 'Could not reach Supabase with the service-role client (network error or timeout).',
    };
  }
}

export async function getHealthReport(): Promise<HealthReport> {
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
