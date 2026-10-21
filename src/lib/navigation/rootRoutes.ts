/**
 * rootRoutes — which routes are PRIMARY destinations for a role.
 *
 * A primary destination is anything reachable from that role's drawer or bottom
 * tab bar. Those screens keep the main-navigation control (hamburger): the user
 * can still open the menu from them. Everything else (editors, detail pages,
 * reports, forms, hub sub-pages) is a nested screen whose expected control is
 * Back.
 *
 * This list is the CLASSIFICATION fallback only — the entry intent recorded by
 * the navigation that opened the screen wins (see navIntent.ts), so a primary
 * destination opened from a dashboard quick action still gets Back.
 *
 * The tab part is derived from nativeTabRegistry (single source of truth for
 * tab routes); the drawer-only part mirrors the paths declared in DrawerNav's
 * getNavSections(). tests/contextualBackNavigation.test.cjs asserts the doctor
 * paths stay in sync with both files.
 */
import {
  STUDENT_TABS,
  DOCTOR_TABS,
  ADMIN_TABS,
  SUPERADMIN_TABS,
} from '@/lib/nativeTabRegistry';
import { normalizeRoutePath } from '@/lib/navigation/navIntent';

export type NavRole = 'student' | 'doctor' | 'assistant' | 'admin' | 'super_admin';

const tabPaths = (tabs: { name: string; hidden?: boolean }[]): string[] =>
  tabs.filter((tab) => tab.hidden !== true).map((tab) => '/' + tab.name);

/** Drawer-only destinations (no bar item) per role. */
const DRAWER_ONLY: Record<NavRole, string[]> = {
  student: [
    '/offline-library',
    '/notifications',
    '/info/about',
    '/info/contact',
  ],
  doctor: [
    '/credits',
    '/notifications',
  ],
  // Assistants use the doctor shell.
  assistant: [
    '/credits',
    '/notifications',
  ],
  admin: [
    '/enrollment-manager',
    '/admin-credits',
    '/storage',
    '/ledger-dashboard',
    '/credit-history',
    '/bulk-credits',
    '/bulk-import',
    '/credit-analytics',
    '/revenue-analytics',
    '/enrollment-stats',
    '/fraud-alerts',
    '/global-search',
    '/notifications-center',
    '/cms',
    '/sa-audit',
    '/reports',
    '/admin-settings',
    '/notifications',
    '/my-devices',
  ],
  super_admin: [
    '/sa-analytics',
    '/sa-users',
    '/sa-finance',
    '/sa-redeem-codes',
    '/sa-content',
    '/sa-academic',
    '/health',
    '/sec-dashboard',
    '/sa-audit',
    '/sa-reports',
    '/sa-platform',
    '/app-updates',
    '/sa-global-search',
    '/edit-profile',
    '/security',
    '/notifications',
    '/my-devices',
  ],
};

const ROOTS: Record<NavRole, Set<string>> = {
  student: new Set([...tabPaths(STUDENT_TABS), ...DRAWER_ONLY.student].map(normalizeRoutePath)),
  doctor: new Set([...tabPaths(DOCTOR_TABS), ...DRAWER_ONLY.doctor].map(normalizeRoutePath)),
  assistant: new Set([...tabPaths(DOCTOR_TABS), ...DRAWER_ONLY.assistant].map(normalizeRoutePath)),
  admin: new Set([...tabPaths(ADMIN_TABS), ...DRAWER_ONLY.admin].map(normalizeRoutePath)),
  super_admin: new Set([...tabPaths(SUPERADMIN_TABS), ...DRAWER_ONLY.super_admin].map(normalizeRoutePath)),
};

const DASHBOARDS: Record<NavRole, string> = {
  student: '/(app)/(student)/dashboard',
  doctor: '/(app)/(doctor)/dr-overview',
  assistant: '/(app)/(doctor)/dr-overview',
  admin: '/(app)/(admin)/admin-overview',
  super_admin: '/(app)/(superadmin)/sa-overview',
};

function asRole(role: string | null | undefined): NavRole {
  const r = String(role ?? '');
  if (r === 'student' || r === 'doctor' || r === 'assistant' || r === 'admin' || r === 'super_admin') {
    return r;
  }
  return 'student';
}

/** True when the route is a primary drawer/tab destination for the role. */
export function isRootDestination(role: string | null | undefined, path: string | null | undefined): boolean {
  const key = normalizeRoutePath(path);
  if (!key) return false;
  return ROOTS[asRole(role)].has(key);
}

/** Safe, role-appropriate dashboard used when there is nothing to pop. */
export function dashboardFallback(role: string | null | undefined): string {
  return DASHBOARDS[asRole(role)];
}
