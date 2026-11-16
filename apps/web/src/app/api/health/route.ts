import { ErrorCode } from '@calc-rental/shared';
import { getHealthReport } from '@/lib/health';
import { jsonError, jsonOk } from '@/lib/http';

/**
 * GET /api/health
 *
 * Public, read-only liveness + dependency check.
 * - Used by the dashboard status page and the Raspberry Pi connectivity test.
 * - Returns HTTP 200 whenever the web app itself is running; `data.status`
 *   is "degraded" when a dependency (Supabase) is not OK.
 * - Never returns secrets or row data.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const report = await getHealthReport();
    return jsonOk(report, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/health] unexpected failure', error);
    return jsonError(ErrorCode.INTERNAL_ERROR, 'Health check failed unexpectedly.', 500);
  }
}
