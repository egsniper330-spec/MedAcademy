/**
 * Super Admin shell wrapper for the shared Notification Center screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import NotificationsCenterScreen from '@/app/(app)/(admin)/notifications-center';

export default function SuperAdminNotificationsCenter() {
  return <NotificationsCenterScreen backTo="/sa-platform" />;
}
