import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * One test runner for the whole monorepo.
 *   npm test          -> everything
 *   npm run test:db   -> database schema tests only
 */
export default defineConfig({
  resolve: {
    conditions: ['react-server', 'node', 'import'],
    alias: {
      '@': path.resolve(rootDir, 'apps/web/src'),
    },
  },
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
