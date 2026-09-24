/**
 * Super Admin shell wrapper for the shared Content Protection screen.
 *
 * The SA shell renders its screens as TABS, so a child page has nothing to pop —
 * passing `backTo` gives the screen the explicit "← Platform" header action
 * required by the Platform hub contract, without a second navigation system.
 */
import ContentProtectionPolicyScreen from '@/app/(app)/(superadmin)/content-protection';

export default function SuperAdminContentProtection() {
  return <ContentProtectionPolicyScreen backTo="/sa-platform" />;
}
