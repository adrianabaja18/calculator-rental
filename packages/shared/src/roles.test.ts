import { describe, expect, it } from 'vitest';
import { AdminRole } from './enums';
import { hasRole } from './roles';

describe('hasRole', () => {
  it('lets higher roles do everything lower roles can', () => {
    expect(hasRole(AdminRole.SUPER_ADMIN, AdminRole.OFFICER)).toBe(true);
    expect(hasRole(AdminRole.SUPER_ADMIN, AdminRole.VIEWER)).toBe(true);
    expect(hasRole(AdminRole.OFFICER, AdminRole.VIEWER)).toBe(true);
    expect(hasRole(AdminRole.OFFICER, AdminRole.OFFICER)).toBe(true);
  });

  it('blocks lower roles from higher permissions', () => {
    expect(hasRole(AdminRole.VIEWER, AdminRole.OFFICER)).toBe(false);
    expect(hasRole(AdminRole.OFFICER, AdminRole.SUPER_ADMIN)).toBe(false);
  });

  it('treats a missing role as no permission', () => {
    expect(hasRole(null, AdminRole.VIEWER)).toBe(false);
    expect(hasRole(undefined, AdminRole.VIEWER)).toBe(false);
  });
});
