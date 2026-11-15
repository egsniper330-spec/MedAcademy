export type StaffRole = 'doctor' | 'admin' | 'super_admin';
export type AppRole = StaffRole | 'student' | 'assistant';

export const STAFF_ROLES: readonly StaffRole[] = ['doctor', 'admin', 'super_admin'];
export const ADMIN_ROLES: readonly StaffRole[] = ['admin', 'super_admin'];
export const SUPER_ADMIN_ROLES: readonly StaffRole[] = ['super_admin'];

/** The server is authoritative; this is the UI's first-line gate only. */
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return role === 'doctor' || role === 'admin' || role === 'super_admin';
}

export function hasRole(role: string | null | undefined, allowed: readonly string[]): boolean {
  return Boolean(role) && allowed.includes(role as string);
}

export interface RouteRule {
  path: string;
  roles: readonly StaffRole[];
}

/** Central route matrix used by the router and by tests. */
export const ROUTE_RULES: readonly RouteRule[] = [
  { path: '/dashboard', roles: STAFF_ROLES },
  { path: '/courses', roles: STAFF_ROLES },
  { path: '/courses/:id', roles: STAFF_ROLES },
  { path: '/students', roles: ['doctor'] },
  { path: '/users', roles: ADMIN_ROLES },
  { path: '/academic', roles: ADMIN_ROLES },
  { path: '/devices', roles: ADMIN_ROLES },
  { path: '/credits', roles: STAFF_ROLES },
  { path: '/analytics', roles: ADMIN_ROLES },
  { path: '/audit', roles: ADMIN_ROLES },
  { path: '/pdf-checker', roles: STAFF_ROLES },
  { path: '/notifications', roles: STAFF_ROLES },
  { path: '/profile', roles: STAFF_ROLES },
  { path: '/branding', roles: SUPER_ADMIN_ROLES },
  { path: '/cms', roles: SUPER_ADMIN_ROLES },
  { path: '/feature-flags', roles: SUPER_ADMIN_ROLES },
  { path: '/app-updates', roles: SUPER_ADMIN_ROLES },
  { path: '/support', roles: SUPER_ADMIN_ROLES },
  { path: '/maintenance', roles: SUPER_ADMIN_ROLES },
  { path: '/security', roles: SUPER_ADMIN_ROLES },
  { path: '/system', roles: SUPER_ADMIN_ROLES },
];

export function allowedFor(path: string): readonly StaffRole[] {
  const rule = ROUTE_RULES.find((entry) => entry.path === path);
  return rule?.roles ?? SUPER_ADMIN_ROLES;
}

export function canAccessPath(role: string | null | undefined, path: string): boolean {
  if (!isStaffRole(role)) return false;
  return hasRole(role, allowedFor(path));
}

/** Admin accounts may not be modified by another Admin. */
export function canManageAccount(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): boolean {
  if (actorRole !== 'admin' && actorRole !== 'super_admin') return false;
  if (actorRole === 'super_admin') return true;
  return targetRole !== 'admin' && targetRole !== 'super_admin';
}
