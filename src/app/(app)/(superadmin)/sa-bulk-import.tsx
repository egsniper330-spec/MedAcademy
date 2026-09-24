/**
 * Super Admin shell wrapper for the shared Bulk Import screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import BulkImportScreen from '@/app/(app)/(admin)/bulk-import';

export default function SuperAdminBulkImport() {
  return <BulkImportScreen backTo="/sa-platform" />;
}
