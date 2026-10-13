/**
 * VIOLATION FIXTURE — params amending the verdict. `security.blocksLogin ||
 * params.blocksLogin` lets a crafted link turn a blocking verdict into a
 * non-blocking one (and the reverse), so a user can relax an enforcement decision
 * the server made. Params may fall back to the verdict; they may never amend it.
 *
 * EXPECTED: PARAM_AUTHORITY_OVERRIDE × 1
 */
import { useLocalSearchParams } from 'expo-router';
import { useSecurity } from '@/lib/SecurityContext';

export default function Override() {
  const security = useSecurity();
  const params   = useLocalSearchParams<{ blocksLogin: string }>();

  const blocksLogin = security.blocksLogin || params.blocksLogin === 'true';

  return blocksLogin;
}
