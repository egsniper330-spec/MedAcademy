/**
 * Super Admin shell wrapper for the shared Video Monitor screen.
 *
 * The SA shell renders its screens as TABS, so a child page has nothing to pop —
 * passing `backTo` gives the screen the explicit "← Platform" header action
 * required by the Platform hub contract, without a second navigation system.
 */
import VideoMonitorScreen from '@/app/(app)/(hubs)/video-monitor';

export default function SuperAdminVideoMonitor() {
  return <VideoMonitorScreen backTo="/sa-platform" />;
}
