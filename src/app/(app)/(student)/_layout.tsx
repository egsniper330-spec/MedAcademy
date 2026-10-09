/**
 * Student RoleTabShell — (student) role's tab layout content.
 *
 * iOS  → native system tab bar / Liquid Glass (RoleTabShell.ios.tsx)
 * Else → JS Tabs + ResponsiveTabBar (RoleTabShell.tsx) — unchanged behavior.
 */
import RoleTabShell from '@/components/navigation/RoleTabShell';
import { useRoleTabGuard } from '@/components/navigation/useRoleTabGuard';
import { STUDENT_TABS } from '@/lib/nativeTabRegistry';

export default function StudentTabLayout() {
  // Only an authenticated student renders the student bottom tabs — a doctor,
  // admin or super admin routed here by a redirect/param/deep link is evicted
  // to their own dashboard instead of seeing Home/Explore/My Courses/Profile.
  useRoleTabGuard('student');
  return <RoleTabShell tabs={STUDENT_TABS} initialRouteName="dashboard" jsIconShrink />;
}
