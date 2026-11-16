import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_LOGIN, safeNextPath } from './redirect';

describe('safeNextPath', () => {
  it.each(['/dashboard', '/rentals', '/students?status=BLOCKED', '/calculators/abc-123'])('keeps internal path %s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'dashboard',
    '//evil.com',
    '/\\evil.com',
    'https://evil.com',
    'javascript:alert(1)',
    '/login',
    '/api/health',
    '/rentals<script>',
  ])('falls back to the dashboard for %s', (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_AFTER_LOGIN);
  });
});
