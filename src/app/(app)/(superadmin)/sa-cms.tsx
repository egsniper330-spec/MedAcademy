/**
 * Super Admin shell wrapper for the shared CMS screen.
 *
 * The SA shell renders its screens as TABS, so a child page has nothing to pop —
 * passing `backTo` gives the screen the explicit "← Platform" header action
 * required by the Platform hub contract, without a second navigation system.
 */
import CMSPagesScreen from '@/app/(app)/(admin)/cms';

export default function SuperAdminCMSPages() {
  return <CMSPagesScreen backTo="/sa-platform" />;
}
