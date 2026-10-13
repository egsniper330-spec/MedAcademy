/**
 * VALID FIXTURE — regression pin for two false-positive classes the guard must
 * never grow back:
 *
 *   1. display state computed FROM an already-vetted value
 *      (`findingCount = threats.length`) is not itself a param derivation;
 *   2. combining that vetted value with the authoritative verdict
 *      (`!blocksLogin && security.evaluating`) is not an override — the same
 *      guarded value is being used on both sides, not a raw param.
 *
 * A guard that flags this is noise, and noise gets ignored or deleted — which is
 * how the real defect would slip through.
 *
 * EXPECTED: no violations.
 */
import { useLocalSearchParams } from 'expo-router';
import { useSecurity } from '@/lib/SecurityContext';

export default function VettedValueDownstream() {
  const security = useSecurity();
  const params   = useLocalSearchParams<{ threats: string; blocksLogin: string }>();

  const threats     = security.hasVerdict ? security.threats     : JSON.parse(params.threats ?? '[]');
  const blocksLogin = security.hasVerdict ? security.blocksLogin : params.blocksLogin === 'true';

  const findingCount = Array.isArray(threats) ? threats.length : 0;
  const hasFindings  = findingCount > 0;
  const checkPending = !hasFindings && !blocksLogin && (security.evaluating || !security.hasVerdict);

  return { findingCount, hasFindings, checkPending };
}
