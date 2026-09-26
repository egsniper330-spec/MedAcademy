/**
 * nativeTabRegistry — the ONE source of truth for every role's tab routes.
 *
 * WHY A REGISTRY
 * ──────────────
 * Each role directory has two bar surfaces that must stay in sync:
 *   • iOS    → native system tab bar (SwiftUI/UITabBar via
 *              @bottom-tabs/react-navigation; see RoleTabShell.ios.tsx).
 *   • Others → the existing JS Tabs + ResponsiveTabBar (see RoleTabShell.tsx).
 * Both shells consume this registry, so route lists, titles, order and
 * hidden flags can never drift between platforms.
 *
 * ICONS
 * ─────
 *  • icon     → lucide-react-native component, rendered by the JS bar
 *               (Android/web) exactly as before this change.
 *  • sfSymbol → SF Symbol name rendered by the NATIVE iOS bar. SF Symbols
 *               are the system idiom for native tab bars (the same glyphs
 *               seen in reference apps like WhatsApp/Telegram on iOS 26):
 *               the system renders selected/unselected states, sizes and
 *               dark/light adaptation itself — no custom icon layer.
 * Hidden routes need no icons (they have no bar item on any platform,
 * matching the original `href: null` screens).
 *
 * INVARIANTS (asserted by tests/navigationLiquidGlass.test.cjs)
 * ───────────
 *  1. Every route file in a role directory appears in that role's registry —
 *     an unregistered route would surface unconfigured in the native bar.
 *  2. Each role's dashboard is the FIRST visible entry (initial tab).
 *  3. At most 5 visible entries per role (original tab-bar contract).
 */

import type { SFSymbol } from 'sf-symbols-typescript';

export interface RoleTabDef {
  /** Route file name inside the role directory (no extension). */
  name: string;
  /** Bar / screen title — same strings as the original JS bar. */
  title: string;
  /**
   * lucide-react-native EXPORT NAME for the JS bar (Android/web), resolved
   * through the lucide namespace by RoleTabShell.tsx. A plain name keeps the
   * iOS bundle free of the lucide graph. Tests assert every name exists.
   */
  icon?: string;
  /** SF Symbol for the native iOS bar. Required for visible tabs. */
  sfSymbol?: SFSymbol;
  /** true → registered but no bar item (drawer-only screen). */
  hidden?: boolean;
}

/* ── Student ─────────────────────────────────────────────────────────── */
export const STUDENT_TABS: RoleTabDef[] = [
  { name: 'dashboard',  title: 'Home',       icon: 'LayoutDashboard', sfSymbol: 'house' },
  { name: 'explore',    title: 'Explore',    icon: 'Compass',         sfSymbol: 'safari' },
  { name: 'my-courses', title: 'My Courses', icon: 'BookOpen',        sfSymbol: 'book' },
  { name: 'profile',    title: 'Profile',    icon: 'UserCircle',      sfSymbol: 'person.crop.circle' },
];

/* ── Doctor ──────────────────────────────────────────────────────────── */
export const DOCTOR_TABS: RoleTabDef[] = [
  { name: 'dr-overview', title: 'Dashboard', icon: 'LayoutDashboard', sfSymbol: 'square.grid.2x2' },
  { name: 'courses',     title: 'Courses',   icon: 'BookOpen',        sfSymbol: 'book' },
  { name: 'students',    title: 'Students',  icon: 'Users',           sfSymbol: 'person.2' },
  { name: 'dr-earnings', title: 'Earnings',  icon: 'TrendingUp',      sfSymbol: 'chart.line.uptrend.xyaxis' },
  { name: 'dr-profile',  title: 'Profile',   icon: 'UserCircle',      sfSymbol: 'person.crop.circle' },
  // Drawer-only screens — registered, navigable, no bar item.
  { name: 'credits',              title: 'My Credits',     hidden: true },
  { name: 'create-student',       title: 'Create Student', hidden: true },
  { name: 'student-credentials',  title: 'Credentials',    hidden: true },
  { name: 'bulk-import-students', title: 'Bulk Import',    hidden: true },
  { name: 'video-library',        title: 'Video Library',  hidden: true },
];

/* ── Admin ───────────────────────────────────────────────────────────── */
export const ADMIN_TABS: RoleTabDef[] = [
  { name: 'admin-overview', title: 'Dashboard', icon: 'LayoutDashboard', sfSymbol: 'square.grid.2x2' },
  { name: 'users',          title: 'Users',     icon: 'Users',           sfSymbol: 'person.2' },
  { name: 'devices',        title: 'Devices',   icon: 'Smartphone',      sfSymbol: 'iphone' },
  { name: 'academic',       title: 'Academic',  icon: 'GraduationCap',   sfSymbol: 'graduationcap' },
  { name: 'audit',          title: 'Audit',     icon: 'Shield',          sfSymbol: 'checkmark.shield' },
  // Drawer-only screens — registered, navigable, no bar item.
  { name: 'bulk-import',            title: 'Bulk Import',        hidden: true },
  { name: 'notifications-center',   title: 'Notifications',      hidden: true },
  { name: 'global-search',          title: 'Search',             hidden: true },
  { name: 'reports',                title: 'Reports',            hidden: true },
  { name: 'storage',                title: 'Storage',            hidden: true },
  { name: 'video-monitor',          title: 'Video Monitor',      hidden: true },
  { name: 'video-health',           title: 'Video Health',       hidden: true },
  { name: 'video-settings',         title: 'Video Settings',     hidden: true },
  { name: 'cms',                    title: 'CMS Pages',          hidden: true },
  { name: 'admin-credits',          title: 'Credits',            hidden: true },
  { name: 'bulk-credits',           title: 'Bulk Credits',       hidden: true },
  { name: 'revenue-analytics',      title: 'Revenue Analytics',  hidden: true },
  { name: 'doctor-earnings',        title: 'Doctor Earnings',    hidden: true },
  { name: 'doctor-credit-timeline', title: 'Doctor Timeline',    hidden: true },
  { name: 'admin-settings',         title: 'Settings',           hidden: true },
  { name: 'system-providers',       title: 'System Diagnostics', hidden: true },
  { name: 'export-panel',           title: 'Export Center',      hidden: true },
  { name: 'enrollment-manager',     title: 'Enrollment Manager', hidden: true },
  { name: 'fraud-alerts',           title: 'Fraud Alerts',       hidden: true },
  { name: 'db-audit',               title: 'Database Integrity', hidden: true },
];

/* ── Super Admin ─────────────────────────────────────────────────────── */
export const SUPERADMIN_TABS: RoleTabDef[] = [
  { name: 'sa-overview',  title: 'Dashboard', icon: 'LayoutDashboard', sfSymbol: 'square.grid.2x2' },
  { name: 'sa-users',     title: 'Users',     icon: 'Users',           sfSymbol: 'person.2' },
  { name: 'sa-finance',   title: 'Finance',   icon: 'DollarSign',      sfSymbol: 'dollarsign.circle' },
  { name: 'sa-analytics', title: 'Analytics', icon: 'BarChart2',       sfSymbol: 'chart.bar' },
  { name: 'sa-platform',  title: 'Platform',  icon: 'Settings2',       sfSymbol: 'gearshape' },
  // Drawer-only screens — registered, navigable, no bar item.
  { name: 'sa-content',              title: 'Content & Media',        hidden: true },
  { name: 'sa-reports',              title: 'Reports & Logs',         hidden: true },
  { name: 'sa-redeem-codes',         title: 'Redeem Codes',           hidden: true },
  { name: 'sa-audit',                title: 'Audit Trail',            hidden: true },
  { name: 'health',                  title: 'System Health',          hidden: true },
  { name: 'sec-dashboard',           title: 'Security Dashboard',     hidden: true },
  { name: 'app-updates',             title: 'App Updates',            hidden: true },
  { name: 'feature-flags',           title: 'Feature Flags',          hidden: true },
  { name: 'maintenance',             title: 'Maintenance',            hidden: true },
  { name: 'branding',                title: 'Branding',               hidden: true },
  { name: 'revenue',                 title: 'Revenue',                hidden: true },
  { name: 'currency',                title: 'Currency',               hidden: true },
  { name: 'impersonation',           title: 'Impersonation',          hidden: true },
  { name: 'sec-diag',                title: 'Security Logs',          hidden: true },
  { name: 'sec-policies',            title: 'Security Policies',      hidden: true },
  { name: 'content-protection',      title: 'Content Protection',     hidden: true },
  { name: 'violation-management',    title: 'Violation Management',   hidden: true },
  { name: 'trash-bin',               title: 'Trash Bin',              hidden: true },
  { name: 'delete-permissions',      title: 'Delete Permissions',     hidden: true },
  { name: 'video-providers',         title: 'Video Providers',        hidden: true },
  { name: 'sa-doctor-earnings',      title: 'Doctor Earnings',        hidden: true },
  { name: 'sa-academic',             title: 'Academic Structure',     hidden: true },
  { name: 'sa-credits',              title: 'Credits',                hidden: true },
  { name: 'sa-currency',             title: 'Currency Settings',      hidden: true },
  { name: 'sa-bulk-credits',         title: 'Bulk Credits',           hidden: true },
  { name: 'sa-bulk-import',          title: 'Bulk Import',            hidden: true },
  { name: 'sa-courses',              title: 'Courses',                hidden: true },
  { name: 'sa-devices',              title: 'Devices',                hidden: true },
  { name: 'sa-notifications-center', title: 'Notifications',          hidden: true },
  { name: 'sa-global-search',        title: 'Global Search',          hidden: true },
  { name: 'sa-revenue-analytics',    title: 'Revenue Analytics',      hidden: true },
  { name: 'sa-doctor-credit-timeline', title: 'Doctor Credit Timeline', hidden: true },
  { name: 'sa-db-audit',             title: 'Database Integrity',     hidden: true },
  { name: 'sa-export-panel',         title: 'Reports & Export',       hidden: true },
  { name: 'sa-enrollment-manager',   title: 'Enrollment Manager',     hidden: true },
  { name: 'sa-system-providers',     title: 'System Diagnostics',     hidden: true },
  { name: 'sa-cms',                  title: 'CMS Pages',              hidden: true },
  { name: 'sa-video-library',        title: 'Video Library',          hidden: true },
  { name: 'sa-video-monitor',        title: 'Video Monitor',          hidden: true },
  { name: 'sa-video-health',         title: 'Video Health',           hidden: true },
  { name: 'sa-video-settings',       title: 'Video Settings',         hidden: true },
  { name: 'sa-support-settings',     title: 'Support Settings',       hidden: true },
  { name: 'sa-content-protection',   title: 'Watermark / DRM',        hidden: true },
  { name: 'sa-fraud-alerts',         title: 'Fraud Alerts',           hidden: true },
  { name: 'sa-admin-credits',        title: 'Admin Credits',          hidden: true },
  { name: 'sa-storage',              title: 'Storage',                hidden: true },
];

/**
 * True when the JS bar rendered this role's visible icons at `size - 2`
 * (the original per-role convention: student/doctor shrunk, admin/sa full).
 * Kept so the Android/web bar stays pixel-identical to pre-change behavior.
 */
export const ROLE_JS_ICON_SHRINK: Record<string, boolean> = {
  student: true,
  doctor: true,
  admin: false,
  superadmin: false,
};
