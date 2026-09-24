/**
 * Super Admin shell wrapper for the shared Academic Structure screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import AcademicManagement from '@/app/(app)/(admin)/academic';

export default function SuperAdminAcademic() {
  return <AcademicManagement backTo="/sa-platform" />;
}
