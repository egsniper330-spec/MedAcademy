/**
 * Doctor RoleTabShell — (doctor) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { useRoleTabGuard } from '@/components/navigation/useRoleTabGuard';
import { DOCTOR_TABS } from '@/lib/nativeTabRegistry';

export default function DoctorTabLayout() {
  // Keep the (doctor) group rendered only for an authenticated doctor. Closes
  // the case where a doctor is navigated onto a foreign role group (forced
  // password change, security-warning redirect, deep link, restored state) and
  // would otherwise be shown the STUDENT bottom tabs — the root layout's
  // one-shot redirect is already consumed by then.
  useRoleTabGuard('doctor');
  return <RoleTabShell tabs={DOCTOR_TABS} initialRouteName="dr-overview" jsIconShrink />;
}
