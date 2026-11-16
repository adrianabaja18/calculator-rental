import { AdminRole } from './enums';

/**
 * Admin role hierarchy. A higher rank includes every permission of the
 * lower ranks. To add a role (e.g. TREASURER), add it to the admin_role
 * enum (new migration) + AdminRole, then give it a rank here.
 */
export const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  [AdminRole.VIEWER]: 1,
  [AdminRole.OFFICER]: 2,
  [AdminRole.SUPER_ADMIN]: 3,
};

/** True when `role` is at least `minimum` (e.g. hasRole('OFFICER', 'VIEWER') === true). */
export function hasRole(role: AdminRole | null | undefined, minimum: AdminRole): boolean {
  if (!role) return false;
  return ADMIN_ROLE_RANK[role] >= ADMIN_ROLE_RANK[minimum];
}

export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  [AdminRole.SUPER_ADMIN]: 'Super Admin',
  [AdminRole.OFFICER]: 'Officer',
  [AdminRole.VIEWER]: 'Viewer',
};
