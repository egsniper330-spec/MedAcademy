/**
 * useRoleTabGuard — keeps a role tab group rendered ONLY for its own role.
 *
 * WHY A GUARD INSIDE THE GROUP (not another root-level redirect)
 * ─────────────────────────────────────────────────────────────
 * `(app)/_layout.tsx` redirects to the role dashboard exactly ONCE per
 * identity (`hasNavigated.current = true` is set before it branches, so the
 * force-password-change and offline-cold-launch paths consume it without
 * navigating). Any later navigation that lands on a foreign role group — a
 * forced password change, a security-warning redirect, a deep link, a stale
 * restored navigation state — was therefore never corrected, and the wrong
 * role's bottom tabs stayed on screen until the user opened the drawer.
 *
 * Asserting membership from INSIDE each group closes that permanently: no
 * matter how a doctor reaches a `(student)` route, the group that is actually
 * mounted evicts it. It is race-free by construction — it depends only on the
 * backend-verified profile and the current pathname, not on event ordering
 * with the root bootstrap — and it re-evaluates on every profile change, so it
 * also covers refresh-token renewal, app restart, navigation reset and
 * impersonation swaps.
 *
 * TRUST MODEL
 * ───────────
 * The role comes from `useProfileStore` (populated by `getProfile`, a
 * server-side read of the authenticated account). It is never taken from a
 * route param, query string or navigation state, all of which are
 * client-controlled. This guard is a UX/consistency measure only — authorization
 * remains enforced server-side on every request.
 *
 * NON-GOALS
 * ─────────
 *  • Never evicts an offline cold-launch destination (`/offline-*`), which is a
 *    legitimate route inside the shell.
 *  • Never races the force-password-change flow — that screen is role-neutral
 *    and owned by the root layout.
 *  • Never redirects an unmapped role (e.g. `assistant`): `dashboardPathForRole`
 *    returns `null` and this hook takes no action, preserving existing
 *    behaviour rather than inventing a destination.
 */
import { useEffect } from 'react';
import { router, usePathname, type RelativePathString } from 'expo-router';
import { useProfileStore } from '@/lib/store';
import { dashboardPathForRole, GROUP_ROLE, type RoleGroup } from '@/lib/roleRoutes';

/**
 * Enforce that the mounted role tab group matches the authenticated role.
 *
 * @param group the role group this layout renders (e.g. `'doctor'`).
 */
export function useRoleTabGuard(group: RoleGroup): void {
  const profile = useProfileStore((s) => s.profile);
  const isProfileLoading = useProfileStore((s) => s.isProfileLoading);
  const pathname = usePathname();
  const expectedRole = GROUP_ROLE[group];

  useEffect(() => {
    // No authoritative profile yet → no opinion. Do not guess from route state.
    if (isProfileLoading || !profile) return;

    // The force-password-change screen is role-neutral and the root layout
    // owns routing to/from it; deferring here avoids fighting that flow.
    if ((profile as { force_password_change?: boolean }).force_password_change) return;

    // Offline cold-launch destinations are legitimate routes inside the shell.
    if (pathname?.startsWith('/offline-')) return;

    const role = profile.role;
    // Unmapped role → no destination we can justify taking the user to.
    if (!role || role === expectedRole) return;

    const dest = dashboardPathForRole(role);
    if (!dest || dest === pathname) return;

    router.replace(dest as RelativePathString);
  }, [profile, isProfileLoading, expectedRole, pathname]);
}

export default useRoleTabGuard;
