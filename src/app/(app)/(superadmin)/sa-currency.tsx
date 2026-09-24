/**
 * Super Admin shell wrapper for the shared Currency Settings screen.
 *
 * The SA shell renders its screens as TABS, so a child page has nothing to pop —
 * passing `backTo` gives the screen the explicit "← Platform" header action
 * required by the Platform hub contract, without a second navigation system.
 */
import CurrencySettings from '@/app/(app)/(superadmin)/currency';

export default function SuperAdminCurrency() {
  return <CurrencySettings backTo="/sa-platform" />;
}
