/**
 * Student RoleTabShell — (student) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { STUDENT_TABS } from '@/lib/nativeTabRegistry';

export default function StudentTabLayout() {
  return <RoleTabShell tabs={STUDENT_TABS} initialRouteName="dashboard" jsIconShrink />;
}
