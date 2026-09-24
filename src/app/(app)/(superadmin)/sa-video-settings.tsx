/**
 * Super Admin shell wrapper for the shared Video Settings screen.
 *
 * `backTo` is the terminal fallback for the header back arrow when there is no
 * history to pop; hub entry pops back to the pushing hub.
 */
import VideoSettingsScreen from '@/app/(app)/(admin)/video-settings';

export default function SuperAdminVideoSettings() {
  return <VideoSettingsScreen backTo="/sa-content" />;
}
