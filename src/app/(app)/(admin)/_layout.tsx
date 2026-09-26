/**
 * Admin RoleTabShell — (admin) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 *
 * NOTE: this role directory contains screen files that the previous JS-Tabs
 * layout never registered (fraud-alerts.tsx, db-audit.tsx). They are listed
 * as hidden drawer-only screens in the registry so every route stays
 * registered on every platform.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { ADMIN_TABS } from '@/lib/nativeTabRegistry';

export default function AdminTabLayout() {
  return <RoleTabShell tabs={ADMIN_TABS} initialRouteName="admin-overview" />;
}
