import { defineConfig } from 'vitest/config';

/**
 * One test runner for the whole monorepo.
 *   npm test          -> everything
 *   npm run test:db   -> database schema tests only
 */
export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/raspberry-pi/{src,scripts}/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'supabase/tests/**/*.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
