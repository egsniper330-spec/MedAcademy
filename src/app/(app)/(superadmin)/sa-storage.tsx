/**
 * Super Admin shell wrapper for the shared Storage screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import StorageMonitorScreen from '@/app/(app)/(admin)/storage';

export default function SuperAdminStorage() {
  return <StorageMonitorScreen backTo="/sa-content" />;
}
