/**
 * VIOLATION FIXTURE — route params handed INTO the security decision layer. The
 * decision engine must be fed device facts, never the URL: a caller can then
 * choose the input that produces the verdict they want.
 *
 * EXPECTED: PARAM_AUTHORITY_INTO_SECURITY_API × 1
 */
import { useLocalSearchParams } from 'expo-router';
import { applySecurityPolicy } from '@/lib/security';

export default function Fed() {
  const params = useLocalSearchParams<{ blocksLogin: string }>();

  applySecurityPolicy({ blockLogin: params.blocksLogin === 'true' });

  return null;
}
