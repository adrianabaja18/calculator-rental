import {
  DEVICE_ID_HEADER,
  ErrorCode,
  HealthResponseSchema,
  HeartbeatResponseSchema,
  SyncPullResponseSchema,
  SyncPushResponseSchema,
  type HealthReport,
  type HeartbeatReply,
  type HeartbeatRequest,
  type SyncPullReply,
  type SyncPushReply,
  type SyncPushRequest,
} from '@calc-rental/shared';
import type { z } from 'zod';

/**
 * Minimal HTTP client for talking to the Next.js backend.
 *
 * - Every request has a timeout (a hung network must never freeze the kiosk).
 * - Every response is validated against the shared Zod contract.
 * - Errors become values ({ ok: false, code }) instead of exceptions, so the
 *   state machine can decide what to show on the LCD.
 *
 * Device APIs send x-device-id + Bearer secret (spec §19); idempotency keys arrive with sync (Phase 12).
 */

export type BackendResult<T> =
  | { ok: true; data: T; latencyMs: number; httpStatus: number }
  | { ok: false; code: ErrorCode; message: string; latencyMs: number | null; httpStatus: number | null };

export interface BackendClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Needed for device APIs (heartbeat, sync); not for /api/health. */
  deviceId?: string;
  deviceSecret?: string;
}

export class BackendClient {
  constructor(private readonly options: BackendClientOptions) {}

  async getHealth(): Promise<BackendResult<HealthReport>> {
    return this.request('/api/health', HealthResponseSchema);
  }

  /** Tells the backend this kiosk is alive; the reply carries the server clock. */
  async heartbeat(beat: HeartbeatRequest): Promise<BackendResult<HeartbeatReply>> {
    return this.request('/api/device/heartbeat', HeartbeatResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.deviceHeaders() },
      body: JSON.stringify(beat),
    });
  }

  /** Phase 12: send outbox items (in order); the reply says how far Supabase got. */
  async syncPush(batch: SyncPushRequest): Promise<BackendResult<SyncPushReply>> {
    return this.request('/api/device/sync', SyncPushResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.deviceHeaders() },
      body: JSON.stringify(batch),
    });
  }

  /** Phase 12: officer data changed since the given cursors (null = everything). */
  async syncPull(cursors: { students: string | null; penalties: string | null }): Promise<BackendResult<SyncPullReply>> {
    const query = new URLSearchParams();
    if (cursors.students) query.set('students', cursors.students);
    if (cursors.penalties) query.set('penalties', cursors.penalties);
    const qs = query.toString();
    return this.request(`/api/device/sync${qs ? `?${qs}` : ''}`, SyncPullResponseSchema, {
      headers: this.deviceHeaders(),
    });
  }

  private deviceHeaders(): Record<string, string> {
    const { deviceId, deviceSecret } = this.options;
    if (!deviceId || !deviceSecret) throw new Error('Device credentials are not configured');
    return { [DEVICE_ID_HEADER]: deviceId, Authorization: `Bearer ${deviceSecret}` };
  }

  private async request<T>(
    pathname: string,
    responseSchema: z.ZodType<
      | { success: true; data: T; error: null }
      | { success: false; data: null; error: { code: string; message: string } }
    >,
    init: RequestInit = {},
  ): Promise<BackendResult<T>> {
    const url = new URL(pathname, this.options.baseUrl);
    const started = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        code: ErrorCode.NETWORK_OFFLINE,
        message: timedOut
          ? `Backend did not respond within ${this.options.timeoutMs} ms (${url.origin}).`
          : `Cannot connect to backend at ${url.origin}.`,
        latencyMs: null,
        httpStatus: null,
      };
    }

    const latencyMs = Math.round(performance.now() - started);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        code: ErrorCode.INTERNAL_ERROR,
        message: `Backend returned non-JSON content (HTTP ${response.status}). Is BACKEND_URL pointing at the web app?`,
        latencyMs,
        httpStatus: response.status,
      };
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        code: ErrorCode.INTERNAL_ERROR,
        message: `Backend response did not match the expected contract (HTTP ${response.status}).`,
        latencyMs,
        httpStatus: response.status,
      };
    }

    if (!parsed.data.success) {
      const knownCode = (Object.values(ErrorCode) as string[]).includes(parsed.data.error.code)
        ? (parsed.data.error.code as ErrorCode)
        : ErrorCode.INTERNAL_ERROR;
      return {
        ok: false,
        code: knownCode,
        message: parsed.data.error.message,
        latencyMs,
        httpStatus: response.status,
      };
    }

    return { ok: true, data: parsed.data.data, latencyMs, httpStatus: response.status };
  }
}
