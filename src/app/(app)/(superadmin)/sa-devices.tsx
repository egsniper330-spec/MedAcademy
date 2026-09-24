/**
 * Super Admin shell wrapper for the shared Device Management screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop (this screen is reachable from /sa-platform and /sa-overview).
 */
import AdminDevices from '@/app/(app)/(admin)/devices';

export default function SuperAdminDevices() {
  return <AdminDevices backTo="/sa-platform" />;
}
