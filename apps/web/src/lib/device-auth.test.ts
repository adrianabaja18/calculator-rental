import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock('@/lib/http', () => ({ jsonError: () => new Response(null, { status: 401 }) }));

const { deviceSecretMatches, hashDeviceSecret } = await import('./device-auth');

describe('device secret check', () => {
  // Same value as the development seed (supabase/seed.sql) and apps/raspberry-pi/.env.example.
  const DEV_SECRET = 'dev-only-placeholder-secret-change-me';
  const DEV_HASH = 'ce6635e1cabf6cb97700d37d24c2e0f324e55a3c04453b81a65c3af50bec5f2e';

  it('hashes with SHA-256 like the seeded credential', () => {
    expect(hashDeviceSecret(DEV_SECRET)).toBe(DEV_HASH);
  });

  it('accepts the right secret and rejects anything else', () => {
    expect(deviceSecretMatches(DEV_SECRET, DEV_HASH)).toBe(true);
    expect(deviceSecretMatches('dev-only-placeholder-secret-change-ME', DEV_HASH)).toBe(false);
    expect(deviceSecretMatches(DEV_SECRET, 'not-a-hash')).toBe(false);
  });
});
