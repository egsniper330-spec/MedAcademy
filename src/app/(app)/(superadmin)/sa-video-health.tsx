/**
 * Super Admin shell wrapper for the shared Video Health screen.
 *
 * The SA shell renders its screens as TABS, so a child page has nothing to pop —
 * passing `backTo` gives the screen an explicit terminal fallback for the header
 * back arrow (used only when there is no history to pop, e.g. drawer entry).
 * Normal entry from a hub pops back to the hub that pushed it.
 */
import VideoHealthScreen from '@/app/(app)/(admin)/video-health';

export default function SuperAdminVideoHealth() {
  return <VideoHealthScreen backTo="/sa-content" />;
}
