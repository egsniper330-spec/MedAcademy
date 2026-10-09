/**
 * roleRoutes — the single source of truth for "which dashboard belongs to
 * which authenticated role".
 *
 * WHY THIS EXISTS
 * ───────────────
 * Route selection by role was previously scattered and, in two places,
 * hardcoded to the STUDENT dashboard:
 *
 *   • `(auth)/force-password-change.tsx` did `router.replace('/dashboard')`
 *     unconditionally after a forced password change. The root layout's
 *     one-shot redirect guard had ALREADY been consumed while sending the
 *     user TO that screen, so nothing ever corrected it — a doctor who was
 *     force-changed landed on the student tab bar and stayed there.
 *
 *   • `(auth)/security-warning.tsx` defaulted its redirect to `'/dashboard'`,
 *     so a warning screen entered without an explicit redirect put any role
 *     on the student tabs.
 *
 * Centralising the mapping lets every call site resolve the destination from
 * the AUTHENTICATED PROFILE (backend-verified) instead of a literal, and lets
 * `useRoleTabGuard` enforce group membership from the same table so the two
 * can never disagree.
 *
 * INVARIANT
 * ─────────
 * Every path here must resolve OUTSIDE the group that would be wrong for the
 * role, and each must be the first visible entry of that role's registry
 * (`nativeTabRegistry.tsx`) so the guard lands on the intended initial tab.
 */

/** Role tab groups as they appear in the route tree under `src/app/(app)/`. */
export type RoleGroup = 'student' | 'doctor' | 'admin' | 'superadmin';

/** The authenticated role that owns each role tab group. */
export const GROUP_ROLE: Record<RoleGroup, string> = {
  student: 'student',
  doctor: 'doctor',
  admin: 'admin',
  superadmin: 'super_admin',
};

/**
 * Role → dashboard route (URL path; route groups are not part of URLs).
 *
 * `assistant` is deliberately absent: it has no tab group and the root layout
 * has never redirected it either, so inventing a destination here would change
 * existing behaviour. Callers get `null` and take no action.
 */
export const ROLE_DASHBOARD: Record<string, string> = {
  student: '/dashboard',
  doctor: '/dr-overview',
  admin: '/admin-overview',
  super_admin: '/sa-overview',
};

/**
 * Resolve the dashboard route for a backend-verified role.
 *
 * Returns `null` for an unknown/unmapped role so callers can distinguish
 * "route this user" from "no opinion" and avoid redirect loops.
 */
export function dashboardPathForRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return ROLE_DASHBOARD[role] ?? null;
}

/**
 * True when `role` is allowed to render the given role tab group.
 *
 * Used by `useRoleTabGuard`; also exported so tests can assert the mapping
 * independently of React.
 */
export function roleOwnsGroup(role: string | null | undefined, group: RoleGroup): boolean {
  if (!role) return false;
  return GROUP_ROLE[group] === role;
}
