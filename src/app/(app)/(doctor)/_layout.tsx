/**
 * Doctor RoleTabShell — (doctor) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { DOCTOR_TABS } from '@/lib/nativeTabRegistry';

export default function DoctorTabLayout() {
  return <RoleTabShell tabs={DOCTOR_TABS} initialRouteName="dr-overview" jsIconShrink />;
}
