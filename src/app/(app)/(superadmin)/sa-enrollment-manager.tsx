/**
 * Super Admin shell wrapper for the shared Enrollment Manager screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import EnrollmentManager from '@/app/(app)/(admin)/enrollment-manager';

export default function SuperAdminEnrollmentManager() {
  return <EnrollmentManager backTo="/sa-platform" />;
}
