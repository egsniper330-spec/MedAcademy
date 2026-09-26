/**
 * Super Admin RoleTabShell — (superadmin) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { SUPERADMIN_TABS } from '@/lib/nativeTabRegistry';

export default function SuperAdminTabLayout() {
  return <RoleTabShell tabs={SUPERADMIN_TABS} initialRouteName="sa-overview" />;
}
