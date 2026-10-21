/**
 * sa-enrollment-stats.tsx — Super Admin entry for the shared enrollment
 * statistics screen.
 *
 * Admin and Super Admin read the same server-side aggregates (both roles may
 * view platform-wide analytics), so this is a thin wrapper: only the back-arrow
 * fallback differs (`sa-analytics` here, the admin dashboard on the admin side).
 */
import EnrollmentStatsScreen from '@/app/(app)/(hubs)/enrollment-stats';

export default function SuperAdminEnrollmentStats() {
  return <EnrollmentStatsScreen backTo="/sa-analytics" />;
}
